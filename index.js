const express    = require('express');
const bodyParser = require('body-parser');
const https      = require('https');
const app        = express();

app.use(bodyParser.json());

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const COMBISTEEL_URL     = 'https://pim.combisteel.com/pimcore-graphql-webservices/Combisteel';
const COMBISTEEL_API_KEY = process.env.COMBISTEEL_API_KEY || 'feed23626ace249b399514a2fc4396187b27';
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE_URL    || '';
const SHOPIFY_TOKEN      = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_VERSION    = process.env.SHOPIFY_API_VERSION  || '2025-01';
const SHOPIFY_LOCATION   = process.env.SHOPIFY_LOCATION_ID  || '';

// ─────────────────────────────────────────────────────────────
// HADFIELDS RATES
// ─────────────────────────────────────────────────────────────
const RATES = {
  G1: { positioned: 63.94,  installed: 91.05,  collection: 30.45  },
  G2: { positioned: 82.52,  installed: 106.53, collection: 35.51  },
  G3: { positioned: 125.01, installed: 184.48, collection: 56.84  },
  G4: { positioned: 170.47, installed: 243.98, collection: 74.59  },
  G5: { positioned: 312.54, installed: 410.61, collection: 213.10 },
};

const UPLIFTED_EXTRA        = 5.00;
const SPECIAL_DELIVERY_RATE = 70.00;
const POSITIONED_EXTRA      = 3.00;
const INSTALLED_EXTRA       = 3.00;

// ─────────────────────────────────────────────────────────────
// SKU → GROUP MAPPING
// All SKUs here — Koolmax format AND Combisteel numeric format
// ─────────────────────────────────────────────────────────────
const SKU_GROUP = {
  // ── Koolmax SKUs ──────────────────────────────────────────
  'KMC200G':'G1','KMF200G':'G1','KMF200':'G1','KMC200':'G1','KMC200S':'G1',
  'KMC400':'G2','KMC400S':'G2','KMC600':'G2','KMC600S':'G2',
  'KMF400':'G2','KMF400S':'G2','KMF600':'G2','KMF600S':'G2',
  'KMCF230W':'G2','KMCF370W':'G2','KMCF230S':'G2',
  'KMF300IC':'G2','KMF200IC':'G2','KMC2DS':'G2','KMC902':'G2',
  'KMCF550W':'G3','KMCF650W':'G3','KMCF550S':'G3','KMCF370S':'G3','KMCF650S':'G3',
  'KMF500IC':'G3','KMF400IC':'G3','KMC1SS':'G3','KMF1SS':'G3',
  'KMC 3DS':'G3','KMC 4DS':'G3','KMF 2DS':'G3','KMF 3DS':'G3',
  'KMC903':'G3','KMC700':'G3','KMC1300':'G3','KMC2000':'G3',
  'KMF700':'G3','KMF700 GREY':'G3','KMF1300':'G3','KMF1300 BLACK':'G3',
  'KMF2000':'G3','KMF2000 GREY':'G3',
  'KMBC2H':'G3','KMBC3H':'G3','KMBC2SL':'G3','KMBC3SL':'G3',
  'FRIGUS 1250 OPEN BLACK':'G3','FRIGUS 1250 OPEN WHITE':'G3',
  'OASIS 1250 FGD WHITE':'G3','OASIS 1250 FGD BLACK':'G3','VIANDE 1250':'G3',
  'KMC2SS':'G4','KMF2SS':'G4','KMC3000':'G4','KMF3000':'G4','KMF3000 GREY':'G4',
  'FRIGUS 1875 OPEN BLACK':'G4','FRIGUS 1875 OPEN WHITE':'G4',
  'OASIS 1875 FGD BLACK':'G4','OASIS 1875 FGD WHITE':'G4','VIANDE 1875':'G4',
  'KOOLMAX NICE 1000':'G5','KOOLMAX NICE 1250':'G5',
  'KOOLMAX NICE 1875':'G5','KOOLMAX NICE 2500':'G5',
  'FRIGUS 2500 OPEN BLACK':'G5','FRIGUS 2500 OPEN WHITE':'G5',
  'OASIS 2500 FGD BLACK':'G5','OASIS 2500 FGD WHITE':'G5','VIANDE 2500':'G5',

  // ── Combisteel numeric SKUs ───────────────────────────────
  '7455.1305':'G1','7527.0010':'G1','7455.1315':'G1',
  '7527.0020':'G1','7453.0004':'G1','7453.0006':'G1',
  '7455.2212':'G2','7455.2242':'G2','7455.2104':'G2',
  '7455.2244':'G2','7455.2214':'G2',
  '7081.0010':'G2','7081.0015':'G2','7081.0020':'G2',
  '7453.0002':'G2','7455.1310':'G2','7527.0015':'G2',
  '7455.1320':'G2','7527.0025':'G2',
  '7455.2200':'G3','7455.2230':'G3','7455.2215':'G3',
  '7455.2245':'G3','7455.2420':'G3','7455.2425':'G3',
  '7455.2235':'G4','7455.2205':'G4','7455.2410':'G4',
  '7455.2415':'G4','7455.2250':'G4','7455.2220':'G4',
  '7455.2435':'G4','7455.2430':'G4','7455.2520':'G4',
  '7455.2530':'G4','7072.0105':'G4','7072.0020':'G4','7455.2675':'G4',
  '7455.2240':'G5','7455.2210':'G5','7455.2416':'G5',
  '7455.2417':'G5','7455.2445':'G5','7455.2440':'G5',
  '7455.2525':'G5','7455.2535':'G5','7072.0115':'G5',
};

// ─────────────────────────────────────────────────────────────
// Extract only Combisteel-format SKUs (numeric with dots)
// These are the only ones we sync stock for
// ─────────────────────────────────────────────────────────────
function getCombisteelSkus() {
  return Object.keys(SKU_GROUP).filter(sku => /^\d+\.\d+$/.test(sku));
}

// ─────────────────────────────────────────────────────────────
// SPECIAL POSTCODES
// ─────────────────────────────────────────────────────────────
const SPECIAL_RANGES = {
  'AB':[[1,99]],'HS':[[1,99]],'KA':[[1,99]],
  'KW':[[1,99]],'PA':[[1,99]],'ZE':[[1,99]],
  'IV':[[1,3],[4,36],[63,63],[99,99]],
  'PH':[[8,10],[15,18],[19,41],[49,50]],
};

function parsePostcode(p) {
  if (!p) return { alpha:'', number:0 };
  const outward = p.toUpperCase().trim().split(' ')[0];
  const m = outward.match(/^([A-Z]{1,2})(\d+)/);
  return m ? { alpha:m[1], number:parseInt(m[2],10) } : { alpha:'', number:0 };
}

function isSpecialPostcode(p) {
  const { alpha, number } = parsePostcode(p);
  if (!alpha || !SPECIAL_RANGES[alpha]) return false;
  return SPECIAL_RANGES[alpha].some(([a,b]) => number>=a && number<=b);
}

function getHighestGroup(items) {
  const order = ['G1','G2','G3','G4','G5'];
  let highest = 'G1';
  for (const item of items) {
    const sku = (item.sku||'').toUpperCase().trim();
    const g   = SKU_GROUP[sku]||null;
    if (g && order.indexOf(g) > order.indexOf(highest)) highest = g;
  }
  return highest;
}

function toPence(pounds) { return Math.round(pounds*100); }

// ─────────────────────────────────────────────────────────────
// SHIPPING ENDPOINT
// ─────────────────────────────────────────────────────────────
app.post('/rates', (req, res) => {
  try {
    const { rate } = req.body;
    const { destination, items } = rate;
    const postcode = destination.postal_code || '';
    const country  = (destination.country||'').toUpperCase();

    if (country !== 'GB' && country !== 'UK') return res.json({ rates:[] });

    const group      = getHighestGroup(items);
    const groupRates = RATES[group];
    const special    = isSpecialPostcode(postcode);

    const deliveryOnly = special
      ? { service_name:'Delivery Only', service_code:'DELIVERY_SPECIAL', total_price:toPence(SPECIAL_DELIVERY_RATE), currency:'GBP', description:'Delivered into premises. Unit remains on pallet/packaging.' }
      : { service_name:'Delivery Only', service_code:`DELIVERY_FREE_${group}`, total_price:0, currency:'GBP', description:'Delivered into premises. Unit remains on pallet/packaging.' };

    return res.json({ rates:[
      deliveryOnly,
      { service_name:`Unpacked & Positioned — ${group}`,             service_code:`POSITIONED_${group}`, total_price:toPence(groupRates.positioned+POSITIONED_EXTRA), currency:'GBP', description:'Delivered, unpacked and positioned in your desired location.' },
      { service_name:`Unpacked, Positioned & Installed — ${group}`,  service_code:`INSTALLED_${group}`,  total_price:toPence(groupRates.installed+INSTALLED_EXTRA),  currency:'GBP', description:'Fully installed including levelling and removal of laser film where applicable.' },
      { service_name:`Uplifted Removal — ${group}`,                  service_code:`UPLIFTED_${group}`,   total_price:toPence(groupRates.collection+UPLIFTED_EXTRA),  currency:'GBP', description:'We collect your old unit and deliver the new one.' },
    ]});
  } catch (err) {
    console.error('Shipping error:', err);
    return res.status(500).json({ error:'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GRAPHQL HELPER
// ─────────────────────────────────────────────────────────────
function graphqlRequest(url, query, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify({ query });
    const parsed = new URL(url);
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   'POST',
      headers:  { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0,300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// STEP 1 — Build Shopify SKU map
// Only fetches variants whose SKU is in our Combisteel list
// ─────────────────────────────────────────────────────────────
async function buildShopifySkuMap(targetSkus) {
  const skuMap  = {};
  const skuSet  = new Set(targetSkus);
  let cursor    = null;
  let hasNext   = true;
  let pageCount = 0;

  console.log(`[Shopify] Building SKU map for ${targetSkus.length} target SKUs...`);

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      productVariants(first: 250${afterClause}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            inventoryItem { id }
          }
        }
      }
    }`;

    const url  = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
    const data = await graphqlRequest(url, query, {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    });

    if (!data?.data?.productVariants) {
      console.error('[Shopify] Bad response on page', pageCount + 1);
      break;
    }

    const { edges, pageInfo } = data.data.productVariants;

    for (const edge of edges) {
      const sku = (edge.node.sku || '').trim();
      // Only store SKUs we actually care about
      if (skuSet.has(sku) && edge.node.inventoryItem?.id) {
        skuMap[sku] = edge.node.inventoryItem.id;
      }
    }

    pageCount++;
    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor;
    await delay(300);
  }

  console.log(`[Shopify] Map built — found ${Object.keys(skuMap).length} / ${targetSkus.length} target SKUs in Shopify`);
  return skuMap;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — Fetch stock from Combisteel
// Only keeps SKUs that are in our target list
// ─────────────────────────────────────────────────────────────
async function fetchCombisteelStock(targetSkus) {
  const skuSet   = new Set(targetSkus);
  const matched  = [];
  let after      = 0;
  const pageSize = 1000;

  console.log(`[Combisteel] Fetching stock — looking for ${targetSkus.length} SKUs...`);

  while (true) {
    const query = `{ getProductListing(first: ${pageSize}, after: ${after}) { totalCount edges { node { sku stock } } } }`;
    const data  = await graphqlRequest(COMBISTEEL_URL, query, {
      'Content-Type': 'application/json',
      'X-API-Key':    COMBISTEEL_API_KEY,
    });

    if (!data?.data?.getProductListing) {
      console.error('[Combisteel] Bad response at offset', after);
      break;
    }

    const { edges, totalCount } = data.data.getProductListing;

    for (const edge of edges) {
      const sku = (edge.node.sku || '').trim();
      // Only keep SKUs we care about
      if (skuSet.has(sku)) {
        matched.push({ sku, quantity: parseInt(edge.node.stock, 10) || 0 });
      }
    }

    const fetched = after + edges.length;
    console.log(`[Combisteel] Scanned ${fetched} / ${totalCount} — matched ${matched.length} so far`);

    // Stop early if we already found all target SKUs
    if (matched.length === targetSkus.length) {
      console.log('[Combisteel] All target SKUs found — stopping early');
      break;
    }

    if (fetched >= totalCount) break;
    after += pageSize;
  }

  console.log(`[Combisteel] Done — matched ${matched.length} / ${targetSkus.length} target SKUs`);
  return matched;
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — Update stock in Shopify
// ─────────────────────────────────────────────────────────────
async function updateShopifyStock(inventoryItemId, quantity) {
  const mutation = `mutation {
    inventorySetQuantities(input: {
      reason: "correction"
      name: "available"
      quantities: [{
        inventoryItemId: "${inventoryItemId}"
        locationId: "${SHOPIFY_LOCATION}"
        quantity: ${quantity}
      }]
    }) {
      userErrors { field message }
    }
  }`;

  const url  = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  const data = await graphqlRequest(url, mutation, {
    'Content-Type':           'application/json',
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
  });

  if (!data?.data?.inventorySetQuantities) {
    console.error('[Shopify] Bad mutation response');
    return false;
  }

  const errors = data.data.inventorySetQuantities.userErrors;
  if (errors.length) { console.error('[Shopify] userErrors:', errors); return false; }
  return true;
}

// ─────────────────────────────────────────────────────────────
// MAIN SYNC
// ─────────────────────────────────────────────────────────────
async function runCombisteelStockSync() {
  console.log(`\n[${new Date().toISOString()}] ════ Combisteel Stock Sync Start ════`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  try {
    // Get list of Combisteel-format SKUs from our mapping
    const targetSkus = getCombisteelSkus();
    console.log(`[Sync] Target SKUs to sync: ${targetSkus.length}`);
    console.log(`[Sync] SKUs: ${targetSkus.join(', ')}`);

    // Step 1 — Build Shopify inventory map (only for our target SKUs)
    const skuMap = await buildShopifySkuMap(targetSkus);

    // Step 2 — Fetch stock from Combisteel (only our target SKUs)
    const products = await fetchCombisteelStock(targetSkus);

    // Step 3 — Update each matched product in Shopify
    for (const product of products) {
      try {
        const invId = skuMap[product.sku];

        if (!invId) {
          console.log(`⏭  ${product.sku} → in Combisteel but not found in Shopify`);
          skipped++;
          continue;
        }

        const ok = await updateShopifyStock(invId, product.quantity);
        if (ok) {
          console.log(`✅ ${product.sku} → qty: ${product.quantity}`);
          updated++;
        } else {
          console.log(`❌ ${product.sku} → update failed`);
          errors++;
        }

        await delay(300);

      } catch (err) {
        console.error(`❌ ${product.sku}:`, err.message);
        errors++;
      }
    }

    console.log(`\n[${new Date().toISOString()}] ════ Sync Complete ════`);
    console.log(`✅ Updated: ${updated} | ⏭  Skipped: ${skipped} | ❌ Errors: ${errors}\n`);

  } catch (err) {
    console.error('[Sync] Fatal error (shipping unaffected):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// MANUAL TRIGGER
// ─────────────────────────────────────────────────────────────
app.get('/sync-stock', async (req, res) => {
  const targetSkus = getCombisteelSkus();
  res.json({
    message:     'Stock sync started — check Railway logs',
    targetSkus:  targetSkus.length,
    skus:        targetSkus,
  });
  runCombisteelStockSync();
});


//test code from here
app.get('/debug-skus', async (req, res) => {
  try {
    // First test basic connection
    const testQuery = `{ shop { name myshopifyDomain } }`;
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
    
    const testData = await graphqlRequest(url, testQuery, {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    });

    // If shop query fails return raw response
    if (!testData?.data?.shop) {
      return res.json({
        error: 'Shop query failed',
        rawResponse: testData,
        storeUrl: SHOPIFY_STORE,
        tokenPrefix: SHOPIFY_TOKEN.substring(0, 10) + '...',
      });
    }

    // Shop connected — now fetch variants
    const variantQuery = `{ productVariants(first: 10) { edges { node { sku product { title vendor } } } } }`;
    const variantData  = await graphqlRequest(url, variantQuery, {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    });

    return res.json({
      shop:        testData.data.shop,
      storeUrl:    SHOPIFY_STORE,
      tokenPrefix: SHOPIFY_TOKEN.substring(0, 10) + '...',
      variantSample: variantData,
    });

  } catch (err) {
    res.status(500).json({
      error:       err.message,
      storeUrl:    SHOPIFY_STORE,
      tokenPrefix: SHOPIFY_TOKEN ? SHOPIFY_TOKEN.substring(0, 10) + '...' : 'NOT SET',
    });
  }
});



// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Koolmax Shipping + Stock Sync — OK'));

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nKoolmax service running on port ${PORT}`);
  console.log(`Combisteel SKUs to sync: ${getCombisteelSkus().length}`);
  // Run 30s after startup then every hour
  setTimeout(() => {
    runCombisteelStockSync();
    setInterval(runCombisteelStockSync, 60 * 60 * 1000);
  }, 30000);
  console.log('[Scheduler] Stock sync every 1 hour\n');
});
