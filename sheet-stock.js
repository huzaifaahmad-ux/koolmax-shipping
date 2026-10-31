// sheet-stock.js
// Google Sheet ("Main Sheet") -> Shopify stock for Koolmax's own products.
//
// PHASE 0: READ-ONLY VALIDATION. This file never writes to Shopify and never runs on a schedule.
// It reads the live Main Sheet, checks every approved mapping (label, size header, value),
// resolves each exact Shopify SKU to its variant, inventory item and locations, and reports
// what WOULD be written. Writing comes in a later phase, only after approval.
//
// Railway variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON  service account key (the whole JSON, or base64 of it)
//   GOOGLE_SHEET_ID              the Live Stock spreadsheet id
//   SHEET_STOCK_LOCATION_ID      optional: Shopify location for Koolmax stock (gid://shopify/Location/...)
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

// ---------- routes (mounted inside the password-protected /admin/api) ----------
function createRouter() {
  const router = express.Router();
  let running = null;
  let last = null;

  router.get('/api/sheet-stock/config', (req, res) => res.json({ tab: TAB, range: RANGE, quantityTarget: CONFIG.quantityTarget, mappings: CONFIG.mappings }));

  router.post('/api/sheet-stock/validate', async (req, res) => {
    if (running) return res.status(409).json({ error: 'A validation is already running, try again in a moment' });
    running = validate();
    try { last = await running; res.json(last); }
    catch (e) { res.status(500).json({ error: e.message }); }
    finally { running = null; }
  });

  router.get('/api/sheet-stock/last', (req, res) => res.json({ report: last }));
  return router;
}

module.exports = { createRouter, validate, parseQty, labelMatches, checkSheet, sizeValue };
