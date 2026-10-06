// importer.js
// Koolmax product importer: Combisteel SKU -> Shopify product (English, EUR->GBP formula price,
// features/specification metafields, SEO, category, stock, shipping group).
// Mount in index.js:  app.use('/admin', importer.router)

const express = require('express');
const path = require('path');
const core = require('./specs-sync');
// Optional modules: if a file is missing the dashboard still starts, with simpler fallbacks.
function optionalRequire(name, fallback) {
  try { return require(name); }
  catch (e) { console.log(`[importer] ${name} not loaded, using fallback:`, e.message.split('\n')[0]); return fallback; }
}
const metaCopy = optionalRequire('./meta-copy', {
  templateMetaDescription: title => (/^combisteel\b/i.test(title) ? title : `Combisteel ${title}`) + ' for professional commercial kitchens.',
  aiMetaDescription: async () => { throw new Error('meta-copy.js is not uploaded'); },
});
const images = optionalRequire('./image-optimizer', {
  prepareMedia: async (urls, { alt }) => ({ media: urls.map(u => ({ originalSource: u, mediaContentType: 'IMAGE', alt })), report: [] }),
});

// ---------- Settings you may want to change ----------
// Price formula: Combisteel EUR price -> GBP -> minus 47% -> plus 30%
const PRICE_DISCOUNT = 0.47;    // -47%
const PRICE_MARKUP = 0.30;      // then +30%
const CATEGORY_NAME_FIELD = 'name';   // field name on Combisteel object_Category (check in Postman)
const MAX_SKUS_PER_REQUEST = 50;

const round2 = n => Math.round(n * 100) / 100;

function finalPrice(apiPriceEur, eurToGbp) {
  const gbp = apiPriceEur * eurToGbp;
  return round2(gbp * (1 - PRICE_DISCOUNT) * (1 + PRICE_MARKUP));
}

// EUR -> GBP rate.
// If PRICE_EUR_TO_GBP is set in Railway (e.g. 0.86) that fixed rate is used.
// Otherwise the daily European Central Bank rate is fetched (Frankfurter API, free, no key), cached 12 hours.
let fxCache = null;
async function getEurToGbp() {
  const fixed = parseFloat(process.env.PRICE_EUR_TO_GBP);
  if (fixed > 0) return { rate: fixed, source: 'Fixed rate (PRICE_EUR_TO_GBP)' };
  if (fxCache && Date.now() - fxCache.time < 12 * 3600 * 1000) return fxCache;
  for (const url of [
    'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=GBP',
    'https://api.frankfurter.app/latest?from=EUR&to=GBP',
  ]) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      const rate = json?.rates?.GBP;
      if (rate > 0) {
        fxCache = { rate, source: `ECB rate ${json.date}`, time: Date.now() };
        return fxCache;
      }
    } catch (e) { /* try next */ }
  }
  if (fxCache) return fxCache;   // stale rate is better than none
  throw new Error('EUR to GBP rate unavailable. Set PRICE_EUR_TO_GBP in Railway, for example 0.86');
}

// Shipping group suggestion from weight / height / model. Always shown for review before saving.
function suggestGroup({ weight, height, model }) {
  if (weight == null || isNaN(weight)) return null;
  const freestanding = model === 'Staand model';
  let g;
  if (weight <= 62 && !freestanding) g = 1;
  else if (weight <= 180) g = 2;
  else if (weight <= 300) g = 3;
  else if (weight <= 450) g = 4;
  else g = 5;
  if (height && height > 2000 && g < 3) g = 3;
  return 'G' + g;
}

// ---------- Text helpers ----------
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cleanTitle(node) {
  const base = (node.descriptionEn || node.description || node.title || '').trim();
  const words = base.split(/\s+/).filter(Boolean).map(w => {
    if (/\d/.test(w)) return w.toUpperCase();
    if (/^(GN|LED|LCD|AISI|UK|EU|XL|XXL|HC|BBQ)$/i.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ').replace(/-([a-z])/g, (m, c) => '-' + c.toUpperCase());
  return words.replace(/^combisteel\s+/i, '');      // product title without brand
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,\s–-]+$/, '') + '…';
}

function highlights(raw) {
  const out = [];
  if (raw['6069']) out.push(`${core.translateValue(raw['6069'])} kW`);
  if (raw['6072']) out.push(`${core.translateValue(raw['6072'])} kW gas`);
  if (raw['6074']) out.push(core.translateValue(raw['6074']).toLowerCase());
  if (raw['6318']) out.push(`${raw['6318']} capacity`);
  if (raw['6312']) out.push(`${core.translateValue(raw['6312'])} L`);
  if (raw['6057']) out.push(`${raw['6057']} V`);
  return out;
}

// URL handle from the meta title: "Combisteel Base 600 Electric Bain-Marie" -> "combisteel-base-600-electric-bain-marie"
function slugify(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d)\/(\d)/g, '$1-$2')          // 1/2GN -> 1-2gn
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255)
    .replace(/-+$/, '');
}

function buildSeo(title, raw, seed = title) {
  const brandTitle = /^combisteel\b/i.test(title) ? title : `Combisteel ${title}`;
  const seoTitle = truncate(brandTitle, 60);
  const seoDescription = metaCopy.templateMetaDescription(title, raw, seed);
  return { seoTitle, seoDescription, handle: slugify(seoTitle) };
}

function buildDescriptionHtml(title, raw) {
  const h = highlights(raw);
  return `<p>${escapeHtml(title)}${h.length ? ' – ' + escapeHtml(h.join(', ')) : ''}.</p>`;
}

// Combisteel long description -> safe HTML for Shopify.
// HTML is kept (minus scripts, styles, iframes and event handlers); plain text gets paragraphs and line breaks.
function formatLongDescription(text) {
  if (!text || !String(text).trim()) return null;
  let s = String(text).trim();
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s.replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
         .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
         .replace(/javascript:/gi, '');
    return s;
  }
  return s.split(/\n\s*\n/)
    .map(par => `<p>${escapeHtml(par.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function productDescription(node, title, raw) {
  const long = formatLongDescription(node.longDescriptionEn);
  return { html: long || buildDescriptionHtml(title, raw), source: long ? 'combisteel' : 'generated' };
}

// ---------- Shopify helpers ----------
const storeAdmin = () => `https://${process.env.SHOPIFY_STORE_URL}/admin`;
const numericId = gid => String(gid).split('/').pop();

async function findShopifySku(sku) {
  const data = await core.shopifyQuery(`
    query($q: String!) {
      productVariants(first: 1, query: $q) { nodes { sku product { id title } } }
    }`, { q: `sku:"${sku}"` });
  const v = data.productVariants.nodes.find(n => (n.sku || '').trim() === sku);
  return v ? { productId: v.product.id, title: v.product.title, adminUrl: `${storeAdmin()}/products/${numericId(v.product.id)}` } : null;
}

async function searchTaxonomy(q) {
  if (!q || !q.trim()) return [];
  const data = await core.shopifyQuery(`
    query($q: String!) {
      taxonomy { categories(first: 8, search: $q) { nodes { id fullName } } }
    }`, { q: q.trim() });
  return data.taxonomy.categories.nodes;
}

let categoryFieldWarned = false;
async function getPimCategory(sku) {
  try {
    const data = await core.combisteelQuery(`
      query($filter: String) {
        getProductListing(first: 1, filter: $filter) {
          edges { node { category { ... on object_Category { id ${CATEGORY_NAME_FIELD} } } } }
        }
      }`, { filter: JSON.stringify({ sku }) });
    const cats = data.getProductListing.edges[0]?.node?.category || [];
    const names = cats.map(c => c && c[CATEGORY_NAME_FIELD]).filter(Boolean);
    return names.length ? core.translateValue(names[names.length - 1]) : null;
  } catch (e) {
    if (!categoryFieldWarned) {
      console.log('[importer] Combisteel category lookup failed. Check CATEGORY_NAME_FIELD:', e.message);
      categoryFieldWarned = true;
    }
    return null;
  }
}

async function suggestCategories(pimCategory, title) {
  const words = title.replace(/^Combisteel\s+/i, '').split(' ').filter(w => !/\d/.test(w));
  const queries = [pimCategory, words.slice(-2).join(' '), words.slice(-1).join(' ')]
    .filter(Boolean).map(s => s.replace(/-/g, ' '));
  const seen = new Map();
  for (const q of [...new Set(queries)]) {
    try {
      for (const c of await searchTaxonomy(q)) if (!seen.has(c.id)) seen.set(c.id, c);
    } catch (e) { /* ignore */ }
    if (seen.size >= 5) break;
  }
  return [...seen.values()].slice(0, 8);
}

// ---------- Dynamic shipping groups (product metafield custom.shipping_group) ----------
const dynamicGroups = {};
function getDynamicGroup(sku) { return dynamicGroups[sku] || null; }

async function loadCatalog(skuGroup) {
  const rows = [];
  let after = null;
  do {
    const data = await core.shopifyQuery(`
      query($after: String) {
        products(first: 100, after: $after, query: "vendor:Combisteel") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status
            shippingGroup: metafield(namespace: "custom", key: "shipping_group") { value }
            variants(first: 20) { nodes { sku inventoryQuantity price } }
          }
        }
      }`, { after });
    for (const p of data.products.nodes) {
      const metaGroup = p.shippingGroup?.value || null;
      for (const v of p.variants.nodes) {
        const sku = (v.sku || '').trim();
        if (!sku) continue;
        if (metaGroup) dynamicGroups[sku] = metaGroup;
        rows.push({
          sku, title: p.title, status: p.status, stock: v.inventoryQuantity, price: v.price,
          group: skuGroup[sku] || metaGroup || null,
          groupSource: skuGroup[sku] ? 'code' : (metaGroup ? 'metafield' : 'missing'),
          adminUrl: `${storeAdmin()}/products/${numericId(p.id)}`,
        });
      }
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return rows;
}

// ---------- Preview one SKU ----------
async function previewSku(sku, attrMap, skuGroup, fx) {
  const out = { sku };
  const node = await core.getPimProduct(sku);
  if (!node) return { ...out, error: 'SKU not found in Combisteel PIM' };

  const { features, specification, raw } = core.decodeSpecs(node, attrMap);
  const title = cleanTitle(node);
  const weight = node.grossWeight ?? (raw['6039'] ? parseFloat(raw['6039'].replace(',', '.')) : null);
  const height = raw['6024'] ? parseFloat(raw['6024']) : node.height;
  const pimCategory = await getPimCategory(sku);
  const categoryOptions = await suggestCategories(pimCategory, title);
  const exists = await findShopifySku(sku);
  const suggested = suggestGroup({ weight, height, model: raw['6074'] });

  const desc = productDescription(node, title, raw);

  return {
    ...out,
    exists,
    title,
    descriptionHtml: desc.html,
    descriptionSource: desc.source,
    apiPrice: node.price,
    price: node.price != null ? finalPrice(node.price, fx.rate) : null,
    stock: node.stock ?? 0,
    weight,
    images: core.imageUrls(node),
    pimCategory,
    categoryOptions,
    categoryId: categoryOptions[0]?.id || null,
    group: skuGroup[sku] || suggested,
    groupSource: skuGroup[sku] ? 'code' : (suggested ? 'suggested' : 'none'),
    ...buildSeo(title, raw, sku),
    features,
    specification,
  };
}

// ---------- Create one product ----------
async function createProduct(item, attrMap) {
  const sku = String(item.sku).trim();
  if (await findShopifySku(sku)) return { sku, error: 'Already exists in Shopify, skipped' };

  const node = await core.getPimProduct(sku);
  if (!node) return { sku, error: 'SKU not found in Combisteel PIM' };
  const { features, specification, raw } = core.decodeSpecs(node, attrMap);

  const title = (item.title || cleanTitle(node)).trim();
  const price = Number(item.price);
  if (!price || price <= 0) return { sku, error: 'Price missing, enter a price and try again' };

  const metafields = [];
  if (features.length) metafields.push({ namespace: 'custom', key: core.FEATURES_KEY, type: 'rich_text_field', value: core.buildRichText(features, { featureStyle: true }) });
  if (specification.length) metafields.push({ namespace: 'custom', key: core.SPEC_KEY, type: 'rich_text_field', value: core.buildRichText(specification) });
  if (item.group) metafields.push({ namespace: 'custom', key: 'shipping_group', type: 'single_line_text_field', value: item.group });

  const product = {
    title,
    descriptionHtml: (item.descriptionHtml && item.descriptionHtml.trim()) || productDescription(node, title, raw).html,
    vendor: 'Combisteel',
    status: item.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
    handle: slugify(item.handle || item.seoTitle || buildSeo(title, raw, sku).seoTitle),
    seo: { title: item.seoTitle || buildSeo(title, raw, sku).seoTitle, description: item.seoDescription || buildSeo(title, raw, sku).seoDescription },
    metafields,
  };
  if (item.categoryId) product.category = item.categoryId;

  // Images: download, convert to WebP under the size limit, upload to Shopify
  const { media, report: imageReport } = await images.prepareMedia(core.imageUrls(node), {
    alt: title,
    baseName: product.handle || slugify(title),
  });

  // 1. Product
  const createQuery = `
    mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id handle variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message }
      }
    }`;
  let created = await core.shopifyQuery(createQuery, { product, media });
  // If the URL is already used by another product, let Shopify pick a free one (adds -1, -2 ...)
  const warnings = [];
  for (const im of imageReport) {
    if (im.error) warnings.push(`Image ${im.file} not converted (${im.error}), original used`);
    else if (im.reason === 'over max') warnings.push(`Image ${im.file} is ${im.kb} KB, could not get under the maximum`);
    else if (im.reason === 'under min') warnings.push(`Image ${im.file} is ${im.kb} KB at maximum quality (simple image, cannot reach the minimum)`);
  }
  if (created.productCreate.userErrors.some(e => /handle/i.test(e.message + (e.field || '')))) {
    warnings.push(`URL "${product.handle}" was taken, Shopify picked another one`);
    delete product.handle;
    created = await core.shopifyQuery(createQuery, { product, media });
  }
  const pc = created.productCreate;
  if (pc.userErrors.length) return { sku, error: 'Create failed: ' + pc.userErrors.map(e => e.message).join('; ') };
  const productId = pc.product.id;
  const variant = pc.product.variants.nodes[0];

  // 2. SKU + price
  const upd = await core.shopifyQuery(`
    mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`, { productId, variants: [{ id: variant.id, price: price.toFixed(2), inventoryItem: { sku, tracked: true } }] });
  if (upd.productVariantsBulkUpdate.userErrors.length) {
    warnings.push('Price/SKU: ' + upd.productVariantsBulkUpdate.userErrors.map(e => e.message).join('; '));
  }

  // 3. Stock at location
  const locationId = process.env.SHOPIFY_LOCATION_ID;
  try {
    await core.shopifyQuery(`
      mutation($id: ID!, $loc: ID!) {
        inventoryActivate(inventoryItemId: $id, locationId: $loc) { userErrors { message } }
      }`, { id: variant.inventoryItem.id, loc: locationId });
    const inv = await core.shopifyQuery(`
      mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { field message } }
      }`, { input: {
        name: 'available', reason: 'correction', ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId, quantity: node.stock ?? 0 }],
      } });
    if (inv.inventorySetQuantities.userErrors.length) {
      warnings.push('Stock: ' + inv.inventorySetQuantities.userErrors.map(e => e.message).join('; '));
    }
  } catch (e) {
    warnings.push('Stock: ' + e.message);
  }

  if (item.group) dynamicGroups[sku] = item.group;

  return {
    sku, ok: true, title, handle: pc.product.handle, images: imageReport, price, stock: node.stock ?? 0, group: item.group || null,
    adminUrl: `${storeAdmin()}/products/${numericId(productId)}`, warnings,
  };
}

// ---------- Router ----------
function createImporter({ skuGroup = {} } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

  router.use('/api', (req, res, next) => {
    const pass = process.env.DASHBOARD_PASSWORD;
    if (!pass || req.get('x-dashboard-key') !== pass) return res.status(401).json({ error: 'Wrong password' });
    next();
  });

  const parseSkus = list => [...new Set((list || []).map(s => String(s).trim()).filter(Boolean))];

  router.post('/api/preview', async (req, res) => {
    const skus = parseSkus(req.body.skus);
    if (!skus.length) return res.status(400).json({ error: 'Add at least one SKU' });
    if (skus.length > MAX_SKUS_PER_REQUEST) return res.status(400).json({ error: `Max ${MAX_SKUS_PER_REQUEST} SKUs at a time` });
    try {
      const attrMap = await core.getAttributeMap();
      const fx = await getEurToGbp();
      const results = [];
      for (const sku of skus) {
        try { results.push(await previewSku(sku, attrMap, skuGroup, fx)); }
        catch (e) { results.push({ sku, error: e.message }); }
        await core.sleep(150);
      }
      res.json({ results, formula: { rate: fx.rate, source: fx.source, discount: PRICE_DISCOUNT, markup: PRICE_MARKUP } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/create', async (req, res) => {
    const items = (req.body.items || []).filter(i => i && i.sku);
    if (!items.length) return res.status(400).json({ error: 'Select at least one product' });
    try {
      const attrMap = await core.getAttributeMap();
      const results = [];
      for (const item of items) {
        try { results.push(await createProduct(item, attrMap)); }
        catch (e) { results.push({ sku: item.sku, error: e.message }); }
        await core.sleep(300);
      }
      console.log('[importer] Created:', results.filter(r => r.ok).map(r => r.sku));
      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Optional: rewrite one meta description with the Claude API, in the copywriter's style
  router.post('/api/meta-ai', async (req, res) => {
    const sku = String(req.body.sku || '').trim();
    const title = String(req.body.title || '').trim();
    if (!sku || !title) return res.status(400).json({ error: 'SKU and title are required' });
    try {
      const attrMap = await core.getAttributeMap();
      const node = await core.getPimProduct(sku);
      if (!node) return res.status(404).json({ error: 'SKU not found in Combisteel PIM' });
      const { specification } = core.decodeSpecs(node, attrMap);
      res.json({ seoDescription: await metaCopy.aiMetaDescription(title, {}, specification) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/taxonomy', async (req, res) => {
    try { res.json({ results: await searchTaxonomy(req.query.q) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/products', async (req, res) => {
    try { res.json({ results: await loadCatalog(skuGroup) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return {
    router,
    getDynamicGroup,
    loadDynamicGroups: () => loadCatalog(skuGroup).then(r => r.length).catch(e => console.log('[importer] group load failed:', e.message)),
  };
}

module.exports = { createImporter, finalPrice, getEurToGbp, suggestGroup };
