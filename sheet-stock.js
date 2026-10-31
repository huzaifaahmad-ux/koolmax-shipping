// sheet-stock.js
// Google Sheet ("Main Sheet") -> Shopify stock for Koolmax's own products.
//
// Live updates ONLY when the dashboard mode is "Live" (and SHEET_SYNC_DISABLED is not true).
//  - Validate: reads the live Main Sheet, checks every approved mapping (label, size header, value),
//    resolves each exact Shopify SKU to its variant, inventory item and locations.
//  - Dry run: plans exactly what a live sync would write (on_hand), nothing written.
//  - Live: writes on_hand for the 80 approved SKUs at SHEET_STOCK_LOCATION_ID, one SKU per call,
//    each guarded by changeFromQuantity. Unusual runs are held for approval.
//  This sync only touches non-Combisteel products, so it never overlaps the Combisteel stock sync.
//
// Railway variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON  service account key (the whole JSON, or base64 of it)
//   GOOGLE_SHEET_ID              the Live Stock spreadsheet id
//   SHEET_STOCK_LOCATION_ID      Shopify location for Koolmax stock (number or gid://shopify/Location/...)
//   (Railway Volume)             attach one to the service; state and run history are kept there
//   SHEET_SYNC_DISABLED=true     optional kill switch: the scheduler never runs
//   SHEET_SYNC_MAX_CHANGES / SHEET_SYNC_MAX_TO_ZERO   optional mass-change guard limits (25 / 10)
//
// Mapping: sheet-stock-map.json (approved list; Shopify SKUs are exact, spaces kept).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const core = require('./specs-sync');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'sheet-stock-map.json'), 'utf8'));
const TAB = CONFIG.sheetTab || 'Main Sheet';
const RANGE = CONFIG.readRange || 'A1:J300';
const MAX_FAIL_SHARE = 0.2;   // more than 20% of mappings failing = sheet layout probably changed

// ---------- Google auth (service account, no extra packages) ----------
let token = null;
function serviceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set in Railway');
  let sa;
  try { sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file)'); }
  if (!sa.client_email || !sa.private_key) throw new Error('Service account JSON is missing client_email or private_key');
  return { email: sa.client_email, key: sa.private_key.replace(/\\n/g, '\n') };
}
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function googleToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const { email, key } = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${json.error_description || json.error || res.status}`);
  token = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return token.value;
}

async function sheetsGet(urlPath) {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID is not set in Railway');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}${urlPath}`, {
    headers: { authorization: `Bearer ${await googleToken()}` },
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 404) {
    throw new Error(`Google Sheet not accessible (${res.status}). Share the sheet with ${safeEmail()} as Viewer.`);
  }
  if (!res.ok) throw new Error(`Google Sheets error ${res.status}: ${json.error?.message || ''}`);
  return json;
}
function safeEmail() { try { return serviceAccount().email; } catch { return 'the service account'; } }

// Reads ONLY the Main Sheet tab, after checking it is the first tab
async function readMainSheet() {
  const meta = await sheetsGet('?fields=properties.title,sheets.properties(sheetId,title,index)');
  const tabs = (meta.sheets || []).map(s => s.properties).sort((a, b) => a.index - b.index);
  const first = tabs[0];
  // Compare ignoring case and extra spaces (the live tab is called "Main Sheet " with a trailing space)
  const loose = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!first || loose(first.title) !== loose(TAB)) {
    throw new Error(`Stopped: the first tab is "${first?.title || 'none'}", expected "${TAB}". Nothing was read.`);
  }
  const range = `'${first.title.replace(/'/g, "''")}'!${RANGE}`;   // exact live tab name, spaces kept
  const data = await sheetsGet(`/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS`);
  return { title: meta.properties?.title, tab: { title: first.title, gid: first.sheetId }, tabs: tabs.map(t => t.title), rows: data.values || [] };
}

// ---------- cell helpers ----------
const colIndex = letter => letter.toUpperCase().charCodeAt(0) - 65;
const colLetter = i => String.fromCharCode(65 + i);
const parseCell = ref => { const m = /^([A-Z])(\d+)$/i.exec(ref); return { col: colIndex(m[1]), row: parseInt(m[2], 10) }; };
const cellAt = (rows, col, row) => (rows[row - 1] || [])[col];

const norm = s => String(s ?? '').toUpperCase()
  .replace(/[\u2010-\u2015\u2212]/g, '-')     // fancy dashes -> -
  .replace(/\s*-\s*/g, '-')
  .replace(/\s+/g, ' ').trim();
function tokenRe(tok) {
  const t = norm(tok).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?');
  return new RegExp(`(?:^|[^A-Z0-9])${t}(?![A-Z0-9])`);
}
function labelMatches(text, m) {
  const t = norm(text);
  return (m.match || []).every(tok => tokenRe(tok).test(t)) && !(m.exclude || []).some(tok => tokenRe(tok).test(t));
}
const rowLabel = (rows, row, cols) => cols.map(c => cellAt(rows, colIndex(c), row)).filter(v => v != null && v !== '').join(' ');

// Size header ("2.5m", "1.875 M", "2500") in the same column, searching upwards
function sizeValue(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*m(?:tr|etres?|eters?)?$/.exec(s);
  if (m) return parseFloat(m[1]);
  if (/^\d{4}$/.test(s)) { const n = parseInt(s, 10); if (n >= 1000 && n <= 4000) return n / 1000; }
  return null;
}
function findSizeHeader(rows, col, fromRow) {
  for (let r = fromRow - 1; r >= Math.max(1, fromRow - 40); r--) {
    const v = cellAt(rows, col, r);
    const size = sizeValue(v);
    if (size != null) return { row: r, text: String(v), size };
  }
  return null;
}

// ---------- quantity rules (approved) ----------
// negative -> 0; blank / error / text / decimal -> skipped (never turned into 0); 0 stays 0
function parseQty(v) {
  if (v === undefined || v === null || v === '') return { ok: false, reason: 'blank cell' };
  if (typeof v === 'boolean') return { ok: false, reason: 'not a number' };
  let n = null;
  if (typeof v === 'number') n = v;
  else {
    const s = String(v).trim();
    if (/^#/.test(s)) return { ok: false, reason: `sheet error ${s}` };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: `not a number ("${s.slice(0, 30)}")` };
    n = parseFloat(s);
  }
  if (!Number.isFinite(n)) return { ok: false, reason: 'not a number' };
  if (!Number.isInteger(n)) return { ok: false, reason: `decimal value ${n}` };
  return { ok: true, qty: Math.max(0, n), negative: n < 0 };
}

// ---------- validate one mapping against the sheet ----------
function checkSheet(rows, m) {
  const { col, row } = parseCell(m.cell);
  const out = { cell: m.cell, usedCell: null, labelFound: '', label: 'mismatch', size: null, raw: null, qty: null, problems: [], warnings: [] };
  const findRows = () => {
    const hits = [];
    for (let r = 1; r <= rows.length; r++) if (labelMatches(rowLabel(rows, r, m.labelCols), m)) hits.push(r);
    return hits;
  };

  let useRow = null;
  out.labelFound = rowLabel(rows, row, m.labelCols);
  if (labelMatches(out.labelFound, m)) {
    out.label = 'ok'; useRow = row;
  } else {
    const hits = findRows();
    if (hits.length === 1) {
      out.label = 'moved';
      out.movedTo = `${colLetter(col)}${hits[0]}`;
      out.movedLabel = rowLabel(rows, hits[0], m.labelCols);
      out.problems.push(`Label not at ${m.cell}; found once at row ${hits[0]} ("${out.movedLabel}"). Approve the new cell before it is used.`);
    } else if (hits.length > 1) {
      out.label = 'ambiguous';
      out.problems.push(`Label not at ${m.cell}; matches ${hits.length} rows (${hits.join(', ')}).`);
    } else {
      out.label = 'not found';
      out.problems.push(`Label "${m.source}" not found at ${m.cell} or anywhere in the sheet.`);
    }
  }

  if (useRow) {
    const others = findRows().filter(r => r !== useRow);
    if (m.uniqueInSheet && others.length) {
      out.problems.push(`More than one ${m.match.join(' ')} row in the sheet (rows ${[useRow, ...others].join(', ')}). Skipped until the right row is confirmed.`);
    } else if (others.length) {
      out.warnings.push(`Same label also on row(s) ${others.join(', ')}; the approved cell ${m.cell} is used.`);
    }
    if (m.size) {
      const h = findSizeHeader(rows, col, useRow);
      const want = parseFloat(m.size);
      out.size = h ? `${h.text} (row ${h.row})` : 'not found';
      if (!h) out.warnings.push(`No size header found above ${m.cell}; expected ${m.size}.`);
      else if (Math.abs(h.size - want) > 0.001) out.problems.push(`Column ${colLetter(col)} header is "${h.text}", expected ${m.size}.`);
    }
    out.usedCell = `${colLetter(col)}${useRow}`;
    out.raw = cellAt(rows, col, useRow) ?? null;
    const q = parseQty(out.raw);
    if (q.ok) { out.qty = q.qty; if (q.negative) out.warnings.push(`Negative value ${out.raw} becomes 0.`); }
    else out.problems.push(`Value skipped: ${q.reason}.`);
  }
  return out;
}

// ---------- Shopify lookups (read-only) ----------
let withLocationNames = true;
const variantQuery = names => `
  query($q: String!) {
    productVariants(first: 15, query: $q) {
      nodes {
        id sku title
        product { id title vendor status }
        inventoryItem {
          id tracked
          inventoryLevels(first: 20) {
            nodes {
              location { id ${names ? 'name' : ''} }
              quantities(names: ["available", "on_hand", "committed"]) { name quantity }
            }
          }
        }
      }
    }
  }`;
async function searchVariants(q) {
  try { return (await core.shopifyQuery(variantQuery(withLocationNames), { q })).productVariants.nodes; }
  catch (e) {
    if (withLocationNames && /access|denied|scope|location/i.test(e.message)) {
      withLocationNames = false;
      return (await core.shopifyQuery(variantQuery(false), { q })).productVariants.nodes;
    }
    throw e;
  }
}
const squash = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

async function resolveSku(sku) {
  const out = { found: false, problems: [], warnings: [] };
  const nodes = await searchVariants(`sku:"${sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  const exact = nodes.filter(v => v.sku === sku);
  if (!exact.length) {
    // help the reviewer: same SKU apart from spacing / case
    let near = nodes.filter(v => squash(v.sku) === squash(sku));
    if (!near.length && /\s{2,}/.test(sku)) near = (await searchVariants(`sku:"${squash(sku)}"`)).filter(v => squash(v.sku) === squash(sku));
    out.problems.push(near.length
      ? `Not found with this exact SKU. Shopify has ${near.map(v => `"${v.sku}"`).join(', ')} (different spacing/case). SKUs are not changed automatically.`
      : 'SKU not found in Shopify.');
    return out;
  }
  if (exact.length > 1) {
    out.problems.push(`Duplicate: ${exact.length} variants have this exact SKU (${exact.map(v => v.product.title).join(' | ')}).`);
    return out;
  }
  const v = exact[0];
  out.found = true;
  out.variantId = v.id;
  out.product = v.product.title + (v.title && v.title !== 'Default Title' ? ` / ${v.title}` : '');
  out.vendor = v.product.vendor;
  out.status = v.product.status;
  out.inventoryItemId = v.inventoryItem?.id;
  out.tracked = !!v.inventoryItem?.tracked;
  out.levels = (v.inventoryItem?.inventoryLevels?.nodes || []).map(l => ({
    locationId: l.location.id,
    location: l.location.name || l.location.id.split('/').pop(),
    ...Object.fromEntries(l.quantities.map(q => [q.name, q.quantity])),
  }));
  // The Combisteel stock sync only touches vendor "Combisteel" products (Combisteel SKUs look like 7178.0100).
  // SKU_GROUP is the shipping-group list for ALL products, so it is NOT used here.
  if (/^combisteel$/i.test(out.vendor || '') || /^\d+\.\d+$/.test(sku)) out.problems.push('Belongs to the Combisteel stock sync; this sync will never touch it.');
  if (!out.tracked) out.problems.push('Inventory tracking is off for this variant.');
  if (!out.levels.length) out.problems.push('Not stocked at any location.');
  return out;
}

async function listLocations() {
  try {
    const d = await core.shopifyQuery('{ locations(first: 50) { nodes { id name isActive } } }');
    return { ok: true, locations: d.locations.nodes };
  } catch (e) {
    return { ok: false, error: /access|denied|scope/i.test(e.message) ? 'read_locations scope missing on the Shopify app' : e.message.slice(0, 200), locations: [] };
  }
}

// ---------- full validation run (read-only) ----------
async function runLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function validate() {
  const startedAt = new Date();
  const sheet = await readMainSheet();
  const locs = await listLocations();
  const rawLoc = (process.env.SHEET_STOCK_LOCATION_ID || '').trim();
  const targetId = rawLoc ? (/^\d+$/.test(rawLoc) ? `gid://shopify/Location/${rawLoc}` : rawLoc) : null;
  const target = targetId ? (locs.locations.find(l => l.id === targetId) || { id: targetId, name: null }) : null;

  const items = await runLimited(CONFIG.mappings, 4, async m => {
    const s = checkSheet(sheet.rows, m);
    let sh;
    try { sh = await resolveSku(m.sku); }
    catch (e) { sh = { found: false, problems: [`Shopify lookup failed: ${e.message.slice(0, 160)}`], warnings: [] }; }

    const problems = [...s.problems, ...sh.problems];
    const warnings = [...s.warnings, ...sh.warnings];
    let current = null;
    if (sh.found && target) {
      const lvl = sh.levels.find(l => l.locationId === target.id);
      if (!lvl) problems.push(`Not stocked at the target location${target.name ? ` (${target.name})` : ''}.`);
      else current = lvl;
    }
    const ready = !problems.length && s.qty != null && sh.found;
    return {
      sku: m.sku, group: m.group, source: m.source, note: m.note || null,
      cell: m.cell, usedCell: s.usedCell, movedTo: s.movedTo || null,
      labelFound: s.labelFound, labelCheck: s.label, sizeHeader: s.size,
      sheetValue: s.raw, proposedOnHand: s.qty,
      shopify: sh.found ? { product: sh.product, vendor: sh.vendor, status: sh.status, variantId: sh.variantId, inventoryItemId: sh.inventoryItemId, levels: sh.levels } : null,
      currentAtTarget: current,
      change: current && s.qty != null ? s.qty - (current.on_hand ?? 0) : null,
      status: ready ? 'ready' : 'blocked',
      problems, warnings,
    };
  });

  const labelFails = items.filter(i => i.labelCheck !== 'ok').length;
  const layoutAlarm = labelFails / items.length > MAX_FAIL_SHARE;
  return {
    mode: 'read-only validation (no Shopify writes)',
    ranAt: startedAt.toISOString(),
    tookMs: Date.now() - startedAt,
    sheet: { title: sheet.title, tab: sheet.tab, allTabs: sheet.tabs, rowsRead: sheet.rows.length, range: RANGE },
    serviceAccount: safeEmail(),
    locations: locs,
    targetLocation: target,
    layoutAlarm: layoutAlarm ? `${labelFails} of ${items.length} labels did not match at their cells. The sheet layout may have changed; a live sync would stop here.` : null,
    summary: {
      total: items.length,
      ready: items.filter(i => i.status === 'ready').length,
      blocked: items.filter(i => i.status === 'blocked').length,
      withWarnings: items.filter(i => i.warnings.length).length,
      labelOk: items.filter(i => i.labelCheck === 'ok').length,
      moved: items.filter(i => i.labelCheck === 'moved').length,
      shopifyFound: items.filter(i => i.shopify).length,
    },
    items,
  };
}

// =====================================================================
// SYNC: dry run or live, state, schedule
// =====================================================================

// ---------- persistent state (Railway Volume) ----------
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached to the service.
const DATA_DIR = process.env.SHEET_STOCK_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PERSISTENT = !!(process.env.SHEET_STOCK_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const STATE_FILE = path.join(DATA_DIR, 'sheet-stock-state.json');
const RUNS_FILE = path.join(DATA_DIR, 'sheet-stock-runs.json');
const KEEP_RUNS = 40;
const INTERVALS = [1, 2, 3, 4, 6, 12];          // hours
// Mass-change guard: a normal day moves a handful of SKUs. If one run would change far more,
// it is held for review (in live mode) instead of being written. Not applied to the first (baseline) run.
const GUARD_MAX_CHANGES = parseInt(process.env.SHEET_SYNC_MAX_CHANGES, 10) || 25;
const GUARD_MAX_TO_ZERO = parseInt(process.env.SHEET_SYNC_MAX_TO_ZERO, 10) || 10;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);           // atomic: never leaves a half-written file
}
const state = Object.assign(
  { settings: { enabled: false, intervalHours: 1, mode: 'dry' }, dry: { lastSeen: {} }, live: { lastApplied: {} }, lastRunAt: null, lastSuccessAt: null },
  readJson(STATE_FILE, {}),
);
state.dry = state.dry || { lastSeen: {} };
state.live = state.live || { lastApplied: {} };
if (!['dry', 'live'].includes(state.settings.mode)) state.settings.mode = 'dry';
let runs = readJson(RUNS_FILE, []);
const saveState = () => writeJson(STATE_FILE, state);
const saveRuns = () => writeJson(RUNS_FILE, runs.slice(0, KEEP_RUNS));
const liveBlocked = () => process.env.SHEET_SYNC_DISABLED === 'true';

// ---------- plan ----------
// on_hand rules (approved): sheet = physical warehouse stock.
//  - first run for a SKU: baseline, set on_hand = sheet (Shopify was stale)
//  - sheet value unchanged since the last run: do nothing, so Shopify's own sales stay deducted
//  - sheet value changed: set on_hand = new sheet value, guarded by changeFromQuantity
function planItem(item, memory) {
  const base = {
    sku: item.sku, group: item.group, cell: item.usedCell || item.cell, labelFound: item.labelFound,
    sheetValue: item.sheetValue, qty: item.proposedOnHand,
    onHand: item.currentAtTarget?.on_hand ?? null, available: item.currentAtTarget?.available ?? null, committed: item.currentAtTarget?.committed ?? null,
    product: item.shopify?.product || null, inventoryItemId: item.shopify?.inventoryItemId || null,
    problems: item.problems, warnings: item.warnings,
  };
  if (item.status !== 'ready') return { ...base, action: 'skip', reason: item.problems.join(' ') || 'Not ready' };
  const last = memory[item.sku];
  let action, reason;
  if (!last) { action = 'set'; reason = 'First run: baseline, sheet value applied once'; }
  else if (last.value === item.proposedOnHand) { action = 'none'; reason = `Sheet unchanged since ${new Date(last.at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}; Shopify sales kept`; }
  else { action = 'set'; reason = `Sheet changed ${last.value} → ${item.proposedOnHand}`; }
  if (action === 'set' && base.onHand === item.proposedOnHand) { action = 'none'; reason += ' (Shopify already matches)'; }
  return { ...base, action, reason, baseline: !last, toZero: action === 'set' && item.proposedOnHand === 0 && (base.onHand ?? 0) > 0 };
}

// ---------- the Shopify write ----------
// API 2026-01+: changeFromQuantity + @idempotent key (required from 2026-04).
// Older versions: compareQuantity (the same safety check, older name).
const apiVersion = () => process.env.SHOPIFY_API_VERSION || '';
const modernApi = () => apiVersion() >= '2026-01';
const SET_MUTATION = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta } }
    userErrors { code field message }
  }
}`;
const SET_MUTATION_LEGACY = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta } }
    userErrors { code field message }
  }
}`;
function setInput(runId, p, locationId, from) {
  const modern = modernApi();
  return {
    name: 'on_hand',
    reason: 'correction',
    referenceDocumentUri: `gid://koolmax-sheet-sync/SyncRun/${runId}`,
    ...(modern ? {} : { ignoreCompareQuantity: false }),
    quantities: [{
      inventoryItemId: p.inventoryItemId, locationId, quantity: p.qty,
      ...(modern ? { changeFromQuantity: from } : { compareQuantity: from }),   // write only if Shopify still has this value
    }],
  };
}
const idemKey = (runId, sku, attempt) => `sheet-${runId}-${crypto.createHash('sha1').update(sku).digest('hex').slice(0, 12)}-${attempt}`;

// Preview of the calls (dry runs)
function buildPayload(runId, plan, locationId) {
  const sets = plan.filter(p => p.action === 'set');
  return {
    apiVersion: apiVersion(),
    mutation: modernApi() ? SET_MUTATION : SET_MUTATION_LEGACY,
    batches: sets.map(p => ({ sku: p.sku, ...(modernApi() ? { idempotencyKey: idemKey(runId, p.sku, 1) } : {}), input: setInput(runId, p, locationId, p.onHand) })),
  };
}

async function readOnHand(inventoryItemId, locationId) {
  const d = await core.shopifyQuery(`query($id: ID!, $loc: ID!) {
    inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["on_hand"]) { name quantity } } }
  }`, { id: inventoryItemId, loc: locationId });
  return d.inventoryItem?.inventoryLevel?.quantities?.find(q => q.name === 'on_hand')?.quantity ?? null;
}

// One SKU per call, so one problem never blocks the others.
async function writeItem(runId, p, locationId) {
  let from = p.onHand;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const vars = modernApi()
      ? { input: setInput(runId, p, locationId, from), idempotencyKey: idemKey(runId, p.sku, attempt) }
      : { input: setInput(runId, p, locationId, from) };
    let d;
    try { d = await core.shopifyQuery(modernApi() ? SET_MUTATION : SET_MUTATION_LEGACY, vars); }
    catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
    const r = d.inventorySetQuantities;
    if (!r.userErrors.length) return { ok: true, before: from, after: p.qty };
    const text = r.userErrors.map(e => `${e.code || ''} ${e.message}`).join(' ');
    // Shopify's quantity moved between our read and our write (e.g. a sale): read it again and retry once.
    if (attempt === 1 && /compare|change.?from|stale|mismatch/i.test(text)) {
      try { from = await readOnHand(p.inventoryItemId, locationId); } catch (e) { return { ok: false, error: 'Re-read failed: ' + e.message }; }
      if (from === p.qty) return { ok: true, before: from, after: from, note: 'Already matched after re-read' };
      continue;
    }
    return { ok: false, error: r.userErrors.map(e => e.message).join('; ') };
  }
  return { ok: false, error: 'Shopify quantity kept changing; will retry next run' };
}

// ---------- run ----------
let running = null;           // one job at a time (validate or sync)
async function exclusive(fn) {
  if (running) { const e = new Error(`Busy: a ${running} is already running, try again in a moment`); e.status = 409; throw e; }
  running = fn.name || 'job';
  try { return await fn(); } finally { running = null; }
}

async function runSync({ trigger = 'manual', mode = state.settings.mode, force = false } = {}) {
  const id = Date.now().toString(36);
  const started = new Date();
  const run = { id, mode, trigger, startedAt: started.toISOString(), finishedAt: null, result: 'running', message: '', summary: null, guard: null, items: [], payload: null };
  state.lastRunAt = started.toISOString();
  try {
    if (mode === 'live' && liveBlocked()) throw new Error('Live updates are switched off (SHEET_SYNC_DISABLED=true). Nothing written.');
    const report = await validate();
    run.targetLocation = report.targetLocation;
    if (!report.targetLocation) throw new Error('SHEET_STOCK_LOCATION_ID is not set');
    if (report.layoutAlarm) throw new Error(`Stopped: ${report.layoutAlarm} Nothing written.`);

    const memory = mode === 'live' ? state.live.lastApplied : state.dry.lastSeen;
    const plan = report.items.map(i => planItem(i, memory));
    const sets = plan.filter(p => p.action === 'set');
    const nonBaseline = sets.filter(p => !p.baseline);
    const toZero = nonBaseline.filter(p => p.toZero);
    if (nonBaseline.length > GUARD_MAX_CHANGES || toZero.length > GUARD_MAX_TO_ZERO) {
      run.guard = `Unusual run: ${nonBaseline.length} SKUs changed in the sheet${toZero.length ? `, ${toZero.length} would drop to 0` : ''} (limits ${GUARD_MAX_CHANGES} / ${GUARD_MAX_TO_ZERO}).`;
    }
    run.items = plan;
    const now = () => new Date().toISOString();
    const counts = () => ({
      total: plan.length,
      set: plan.filter(p => ['set', 'updated', 'failed', 'held'].includes(p.action)).length,
      baseline: plan.filter(p => p.baseline && ['set', 'updated', 'failed', 'held'].includes(p.action)).length,
      changed: nonBaseline.length,
      updated: plan.filter(p => p.action === 'updated').length,
      failed: plan.filter(p => p.action === 'failed').length,
      held: plan.filter(p => p.action === 'held').length,
      none: plan.filter(p => p.action === 'none').length,
      skip: plan.filter(p => p.action === 'skip').length,
      toZero: sets.filter(p => p.qty === 0 && (p.onHand ?? 0) > 0).length,
      onHandBefore: plan.reduce((a, p) => a + (p.onHand ?? 0), 0),
      onHandAfter: plan.reduce((a, p) => a + (['set', 'updated'].includes(p.action) ? p.qty : (p.onHand ?? 0)), 0),
    });

    if (mode === 'dry') {
      run.payload = buildPayload(id, plan, report.targetLocation.id);
      for (const p of plan) if (p.qty != null && p.action !== 'skip') memory[p.sku] = { value: p.qty, at: now() };
      run.summary = counts();
      run.result = 'ok';
      run.message = `Dry run: would update ${sets.length} (${run.summary.baseline} first-run, ${nonBaseline.length} sheet changes), ${run.summary.none} unchanged, ${run.summary.skip} skipped. Nothing written.`;
    } else if (run.guard && !force) {
      // LIVE, unusual run: write nothing, wait for approval in the dashboard
      for (const p of sets) { p.action = 'held'; p.reason += ' (held: unusual run)'; }
      run.summary = counts();
      run.result = 'held';
      run.message = `Held: ${run.guard} Nothing written. Check the sheet, then press "Apply anyway" if it is correct.`;
    } else {
      // LIVE: write each changed SKU, 2 at a time
      await runLimited(sets, 2, async p => {
        const w = await writeItem(id, p, report.targetLocation.id);
        p.write = w;
        if (w.ok) { p.action = 'updated'; memory[p.sku] = { value: p.qty, at: now() }; }
        else { p.action = 'failed'; p.problems = [...p.problems, `Shopify: ${w.error}`]; }   // not remembered: retried next run
      });
      // Remember the sheet value for unchanged rows too (incl. "Shopify already matches"), so a later Shopify sale is never mistaken for a sheet change
      for (const p of plan) if (p.action === 'none' && p.qty != null && memory[p.sku]?.value !== p.qty) memory[p.sku] = { value: p.qty, at: now() };
      run.summary = counts();
      run.result = run.summary.failed ? 'partial' : 'ok';
      run.message = `Updated ${run.summary.updated} in Shopify${run.summary.failed ? `, ${run.summary.failed} failed (retried next run)` : ''}, ${run.summary.none} unchanged, ${run.summary.skip} skipped.${force && run.guard ? ' Applied after approval.' : ''}`;
    }
    if (run.result !== 'held') state.lastSuccessAt = now();
  } catch (e) {
    run.result = 'failed';
    run.message = e.message;
  }
  run.finishedAt = new Date().toISOString();
  run.tookMs = Date.now() - started;
  runs.unshift(run);
  runs = runs.slice(0, KEEP_RUNS);
  try { saveState(); saveRuns(); } catch (e) { console.log('[sheet-stock] could not save state:', e.message); }
  console.log(`[sheet-stock] ${run.trigger} ${run.mode} run ${run.result}: ${run.message}`);
  return run;
}

// ---------- scheduler ----------
function nextRunAt() {
  if (!state.settings.enabled || liveBlocked()) return null;
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  return new Date(Math.max(Date.now(), last + state.settings.intervalHours * 3600e3)).toISOString();
}
let schedulerStarted = false;
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => {
    const due = nextRunAt();
    if (!due || running || Date.parse(due) > Date.now()) return;
    exclusive(function scheduledSync() { return runSync({ trigger: 'schedule' }); }).catch(e => console.log('[sheet-stock] scheduled run skipped:', e.message));
  }, 60 * 1000).unref();
}

const runSummary = r => ({ id: r.id, mode: r.mode, trigger: r.trigger, startedAt: r.startedAt, result: r.result, message: r.message, summary: r.summary, guard: r.guard, tookMs: r.tookMs });

// ---------- routes (mounted inside the password-protected /admin/api) ----------
function createRouter() {
  const router = express.Router();
  let last = null;
  startScheduler();

  router.get('/api/sheet-stock/config', (req, res) => res.json({ tab: TAB, range: RANGE, quantityTarget: CONFIG.quantityTarget, mappings: CONFIG.mappings }));

  router.post('/api/sheet-stock/validate', async (req, res) => {
    try { last = await exclusive(function validation() { return validate(); }); res.json(last); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  router.get('/api/sheet-stock/last', (req, res) => res.json({ report: last }));

  router.post('/api/sheet-stock/dry-run', async (req, res) => {
    try { res.json(await exclusive(function dryRun() { return runSync({ trigger: 'manual', mode: 'dry' }); })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Run now in the current mode. force: apply a run the guard held back.
  router.post('/api/sheet-stock/sync', async (req, res) => {
    try { res.json(await exclusive(function sync() { return runSync({ trigger: req.body?.force ? 'manual (approved)' : 'manual', force: !!req.body?.force }); })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.get('/api/sheet-stock/status', (req, res) => res.json({
    mode: state.settings.mode, settings: state.settings, intervals: INTERVALS, apiVersion: apiVersion(), liveMemory: Object.keys(state.live.lastApplied).length,
    disabledByEnv: process.env.SHEET_SYNC_DISABLED === 'true',
    persistent: PERSISTENT, dataDir: DATA_DIR,
    running, lastRunAt: state.lastRunAt, lastSuccessAt: state.lastSuccessAt, nextRunAt: nextRunAt(),
    guard: { maxChanges: GUARD_MAX_CHANGES, maxToZero: GUARD_MAX_TO_ZERO },
    runs: runs.map(runSummary),
    latest: runs[0] || null,
  }));

  router.get('/api/sheet-stock/runs/:id', (req, res) => {
    const r = runs.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Run not found' });
    res.json(r);
  });

  router.post('/api/sheet-stock/settings', (req, res) => {
    const { enabled, intervalHours, mode } = req.body || {};
    if (enabled !== undefined) state.settings.enabled = !!enabled;
    if (mode !== undefined) {
      if (!['dry', 'live'].includes(mode)) return res.status(400).json({ error: 'Mode must be dry or live' });
      state.settings.mode = mode;
    }
    if (intervalHours !== undefined) {
      const h = Number(intervalHours);
      if (!INTERVALS.includes(h)) return res.status(400).json({ error: `Interval must be one of ${INTERVALS.join(', ')} hours` });
      state.settings.intervalHours = h;
    }
    try { saveState(); } catch (e) { return res.status(500).json({ error: 'Could not save settings: ' + e.message }); }
    res.json({ settings: state.settings, nextRunAt: nextRunAt() });
  });

  // Start the dry-run memory again (next dry run is a baseline). Live memory is never touched here.
  router.post('/api/sheet-stock/reset-dry', (req, res) => {
    state.dry.lastSeen = {};
    try { saveState(); } catch (e) {}
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createRouter, validate, runSync, planItem, buildPayload, writeItem, parseQty, labelMatches, checkSheet, sizeValue };
