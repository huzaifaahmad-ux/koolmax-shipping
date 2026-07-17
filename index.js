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
// HADFIELDS BASE RATES (ex-VAT, £)
// ─────────────────────────────────────────────────────────────
const RATES = {
  G1: { positioned: 63.94,  collection: 30.45  },
  G2: { positioned: 82.52,  collection: 35.51  },
  G3: { positioned: 125.01, collection: 56.84  },
  G4: { positioned: 170.47, collection: 74.59  },
  G5: { positioned: 312.54, collection: 213.10 },
};

const POSITIONED_EXTRA          = 13.00;
const UPLIFTED_EXTRA            = 15.00;
const SPECIAL_DELIVERY_PER_ITEM = 70.00;

// ─────────────────────────────────────────────────────────────
// SKU → GROUP MAPPING
// ─────────────────────────────────────────────────────────────
const SKU_GROUP = {
  // G1
  'KMC200G':'G1','KMF200G':'G1','KMF200':'G1','KMC200':'G1','KMC200S':'G1',
  // G2
  'KMC400':'G2','KMC400S':'G2','KMC600':'G2','KMC600S':'G2',
  'KMF400':'G2','KMF400S':'G2','KMF600':'G2','KMF600S':'G2',
  'KMCF230W':'G2','KMCF370W':'G2','KMCF230S':'G2',
  'KMF300IC':'G2','KMF200IC':'G2','KMC2DS':'G2','KMC902':'G2',
  // G3
  'KMCF550W':'G3','KMCF650W':'G3','KMCF550S':'G3','KMCF370S':'G3','KMCF650S':'G3',
  'KMF500IC':'G3','KMF400IC':'G3','KMC1SS':'G3','KMF1SS':'G3',
  'KMC 3DS':'G3','KMC 4DS':'G3','KMF 2DS':'G3','KMF 3DS':'G3',
  'KMC903':'G3','KMC700':'G3','KMC1300':'G3','KMC2000':'G3',
  'KMF700':'G3','KMF700 GREY':'G3','KMF1300':'G3','KMF1300 BLACK':'G3',
  'KMF2000':'G3','KMF2000 GREY':'G3',
  'KMBC2H':'G3','KMBC3H':'G3','KMBC2SL':'G3','KMBC3SL':'G3',
  'FRIGUS 1250 OPEN BLACK':'G3','FRIGUS 1250 OPEN WHITE':'G3',
  'OASIS 1250 FGD WHITE':'G3','OASIS 1250 FGD BLACK':'G3','VIANDE 1250':'G3',
  // G4
  'KMC2SS':'G4','KMF2SS':'G4','KMC3000':'G4','KMF3000':'G4','KMF3000 GREY':'G4',
  'FRIGUS 1875 OPEN BLACK':'G4','FRIGUS 1875 OPEN WHITE':'G4',
  'OASIS 1875 FGD BLACK':'G4','OASIS 1875 FGD WHITE':'G4','VIANDE 1875':'G4',
  // G5
  'KOOLMAX NICE 1000':'G5','KOOLMAX NICE 1250':'G5',
  'KOOLMAX NICE 1875':'G5','KOOLMAX NICE 2500':'G5',
  'FRIGUS 2500 OPEN BLACK':'G5','FRIGUS 2500 OPEN WHITE':'G5',
  'OASIS 2500 FGD BLACK':'G5','OASIS 2500 FGD WHITE':'G5','VIANDE 2500':'G5',
  // Combisteel numeric SKUs
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
  '7527.0035':'G1','7527.0045':'G1','7081.0005':'G2',
  '7081.0025':'G3','7081.0030':'G3','7081.0040':'G3',
  '7450.1300':'G3','7450.1305':'G3','7450.1310':'G3',
  '7453.0008':'G1','7453.0010':'G1','7453.0012':'G1',
  '7453.0014':'G1','7453.0016':'G1','7453.0020':'G1',
  '7476.0150':'G1','7489.5205':'G1','7489.5215':'G1',
  '7489.5217':'G2','7455.1300':'G1','7527.0005':'G1',
  '7527.0030':'G1','7527.0040':'G2','7527.0050':'G2',
  '7013.2570':'G1','7013.2575':'G1','7450.0552':'G1',
  '7450.0551':'G1','7950.5300':'G1','7450.0530':'G1',
  '7450.0550':'G1','7950.5305':'G1','7090.0200':'G3',
  '7090.0205':'G3','7090.0210':'G4','7486.0070':'G3',
  '7486.0075':'G4','7486.0080':'G4','7486.0085':'G4',
  '7080.0005':'G3','7080.0010':'G3','7080.0015':'G3',
  '7350.0005':'G4','7350.0010':'G3','7350.0015':'G4',
  '7350.0020':'G3','7350.0030':'G3','7450.0800':'G3',
  '7450.0805':'G4','7450.0810':'G4','7450.0815':'G4',
  '7450.0820':'G3','7450.0825':'G3','7450.0830':'G3',
  '7450.0835':'G4','7450.0840':'G3','7450.0845':'G3',
  '7486.0090':'G2','7486.0095':'G3','7487.0015':'G3',
  '7487.0020':'G3','7487.0025':'G3','7489.5385':'G3',
  '7489.5395':'G3','7489.5450':'G3','7489.5455':'G3',
  '7489.5460':'G3','7489.5465':'G3','7489.5470':'G3',
};

// ─────────────────────────────────────────────────────────────
// SPECIAL POSTCODES
// ─────────────────────────────────────────────────────────────
const SPECIAL_RANGES = {
  'AB': [[1,99]],
  'HS': [[1,99]],
  'IV': [[1,99]],
  'KA': [[1,99]],
  'KW': [[1,99]],
  'PA': [[1,99]],
  'PH': [[8,10],[15,18],[19,41],[49,50]],
  'ZE': [[1,99]],
};

function parsePostcode(p) {
  const outward = (p || '').toUpperCase().trim().split(' ')[0];
  const m = outward.match(/^([A-Z]{1,2})(\d+)/);
  return m ? { alpha: m[1], number: parseInt(m[2], 10) } : { alpha: '', number: 0 };
}

function isSpecial(postcode) {
  const { alpha, number } = parsePostcode(postcode);
  if (!alpha || !SPECIAL_RANGES[alpha]) return false;
  return SPECIAL_RANGES[alpha].some(([a, b]) => number >= a && number <= b);
}

function toPence(pounds) { return Math.round(pounds * 100); }

// ─────────────────────────────────────────────────────────────
// CALCULATE TOTALS — per unit × quantity for all items
// ─────────────────────────────────────────────────────────────
function calculateTotals(items) {
  let positionedTotal = 0;
  let upliftedTotal   = 0;
  let totalQty        = 0;

  for (const item of items) {
    const sku = (item.sku || '').trim();
    const qty = item.quantity || 1;
    totalQty += qty;

    const group = SKU_GROUP[sku] || 'G3';
    if (!SKU_GROUP[sku]) console.warn(`Unknown SKU: "${sku}" — defaulting to G3`);

    const r = RATES[group];
    positionedTotal += (r.positioned + POSITIONED_EXTRA) * qty;
    upliftedTotal   += (r.collection + UPLIFTED_EXTRA)   * qty;
  }

  return { positionedTotal, upliftedTotal, combinedTotal: positionedTotal + upliftedTotal, totalQty };
}

// ─────────────────────────────────────────────────────────────
// SHIPPING ENDPOINT
// ─────────────────────────────────────────────────────────────
app.post('/rates', (req, res) => {
  try {
    const { rate } = req.body || {};
    const items       = (rate && rate.items)       || [];
    const destination = (rate && rate.destination) || {};
    const postcode    = destination.postal_code    || '';

    const special = isSpecial(postcode);
    const { positionedTotal, upliftedTotal, combinedTotal, totalQty } = calculateTotals(items);

    let rates = [];

    if (special) {
      rates = [
        {
          service_name: 'Delivery Only',
          service_code: 'DELIVERY_SPECIAL',
          total_price:  toPence(SPECIAL_DELIVERY_PER_ITEM * totalQty),
          currency:     'GBP',
          description:  'Delivered into premises. Unit remains on pallet. £70 per product.',
        },
        {
          service_name: 'Unpacked & Positioned',
          service_code: 'POSITIONED',
          total_price:  toPence(positionedTotal),
          currency:     'GBP',
          description:  'Delivered, unpacked and positioned in your desired location.',
        },
        {
          service_name: 'Uplift/Removal',
          service_code: 'UPLIFTED',
          total_price:  toPence(upliftedTotal),
          currency:     'GBP',
          description:  'We will uplift/remove the existing like-for-like and dispose.',
        },
        {
          service_name: 'Unpacked & Positioned + Uplift/Removal',
          service_code: 'POSITIONED_UPLIFTED',
          total_price:  toPence(combinedTotal),
          currency:     'GBP',
          description:  'Delivered, unpacked, positioned, and we will uplift/remove the existing like-for-like and dispose.',
        },
      ];
    } else {
      rates = [
        {
          service_name: 'Delivery Only',
          service_code: 'DELIVERY_FREE',
          total_price:  0,
          currency:     'GBP',
          description:  'Delivered into premises. Unit remains on pallet.',
        },
        {
          service_name: 'Unpacked & Positioned',
          service_code: 'POSITIONED',
          total_price:  toPence(positionedTotal),
          currency:     'GBP',
          description:  'Delivered, unpacked and positioned in your desired location.',
        },
        {
          service_name: 'Uplift/Removal',
          service_code: 'UPLIFTED',
          total_price:  toPence(upliftedTotal),
          currency:     'GBP',
          description:  'We will uplift/remove the existing like-for-like and dispose.',
        },
        {
          service_name: 'Unpacked & Positioned + Uplift/Removal',
          service_code: 'POSITIONED_UPLIFTED',
          total_price:  toPence(combinedTotal),
          currency:     'GBP',
          description:  'Delivered, unpacked, positioned, and we will uplift/remove the existing like-for-like and dispose.',
        },
      ];
    }

    return res.json({ rates });

  } catch (err) {
    console.error('Shipping rate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
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

function shopifyGraphQL(query) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  return graphqlRequest(url, query, {
    'Content-Type':           'application/json',
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
  });
}

// ─────────────────────────────────────────────────────────────
// COMBISTEEL SKUs (numeric dot format only)
// ─────────────────────────────────────────────────────────────
function getCombisteelSkus() {
  return Object.keys(SKU_GROUP).filter(sku => /^\d+\.\d+$/.test(sku));
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — Build Shopify SKU → inventoryItemId map
// ─────────────────────────────────────────────────────────────
async function buildShopifySkuMap(targetSkus) {
  const skuMap = {};
  const skuSet = new Set(targetSkus);
  let cursor   = null;
  let hasNext  = true;
  let page     = 0;

  console.log(`[Shopify] Building SKU map for ${targetSkus.length} target SKUs...`);

  while (hasNext) {
    page++;
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      products(first: 250, query: "vendor:Combisteel"${afterClause}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            title
            variants(first: 10) {
              edges {
                node {
                  sku
                  inventoryItem { id }
                }
              }
            }
          }
        }
      }
    }`;

    const data = await shopifyGraphQL(query);

    if (!data?.data?.products) {
      console.error(`[Shopify] Bad response page ${page}:`, JSON.stringify(data).substring(0,200));
      break;
    }

    const { edges, pageInfo } = data.data.products;
    console.log(`[Shopify] Page ${page}: ${edges.length} products`);

    for (const productEdge of edges) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const sku = (variantEdge.node.sku || '').trim();
        if (skuSet.has(sku) && variantEdge.node.inventoryItem?.id) {
          skuMap[sku] = variantEdge.node.inventoryItem.id;
          console.log(`[Shopify] ✅ Mapped: ${sku}`);
        }
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor;
    await delay(300);
  }

  console.log(`[Shopify] Map complete — ${Object.keys(skuMap).length} / ${targetSkus.length} found`);
  return skuMap;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — Fetch stock from Combisteel (target SKUs only)
// ─────────────────────────────────────────────────────────────
async function fetchCombisteelStock(targetSkus) {
  const skuSet   = new Set(targetSkus);
  const matched  = [];
  let after      = 0;
  const pageSize = 1000;

  console.log(`[Combisteel] Fetching stock for ${targetSkus.length} target SKUs...`);

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
      if (skuSet.has(sku)) {
        matched.push({ sku, quantity: parseInt(edge.node.stock, 10) || 0 });
      }
    }

    const fetched = after + edges.length;
    console.log(`[Combisteel] Scanned ${fetched}/${totalCount} — matched ${matched.length}`);

    if (matched.length === targetSkus.length) {
      console.log('[Combisteel] All target SKUs found — stopping early');
      break;
    }
    if (fetched >= totalCount) break;
    after += pageSize;
  }

  return matched;
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — Update inventory in Shopify
// ─────────────────────────────────────────────────────────────
async function updateShopifyStock(inventoryItemId, quantity) {
  const mutation = `mutation {
    inventorySetQuantities(input: {
      reason: "correction"
      name: "available"
      ignoreCompareQuantity: true
      quantities: [{
        inventoryItemId: "${inventoryItemId}"
        locationId: "${SHOPIFY_LOCATION}"
        quantity: ${quantity}
      }]
    }) {
      userErrors { field message }
    }
  }`;

  const data = await shopifyGraphQL(mutation);

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
  console.log(`\n[${new Date().toISOString()}] ════ Sync Start ════`);
  let updated=0, skipped=0, errors=0;

  try {
    const targetSkus = getCombisteelSkus();
    console.log(`[Sync] ${targetSkus.length} target SKUs`);

    const skuMap   = await buildShopifySkuMap(targetSkus);
    const products = await fetchCombisteelStock(targetSkus);

    for (const product of products) {
      try {
        const invId = skuMap[product.sku];
        if (!invId) { skipped++; continue; }

        const ok = await updateShopifyStock(invId, product.quantity);
        if (ok) { console.log(`✅ ${product.sku} → qty:${product.quantity}`); updated++; }
        else    { console.log(`❌ ${product.sku} → failed`); errors++; }
        await delay(300);
      } catch (err) {
        console.error(`❌ ${product.sku}:`, err.message);
        errors++;
      }
    }

    console.log(`\n[${new Date().toISOString()}] ════ Sync Done ════`);
    console.log(`✅ Updated:${updated} | ⏭ Skipped:${skipped} | ❌ Errors:${errors}\n`);

  } catch (err) {
    console.error('[Sync] Fatal error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// MANUAL SYNC TRIGGER
// ─────────────────────────────────────────────────────────────
app.get('/sync-stock', async (req, res) => {
  res.json({ message:'Sync started — check Railway logs', skus: getCombisteelSkus() });
  runCombisteelStockSync();
});

// ─────────────────────────────────────────────────────────────
// DEBUG
// ─────────────────────────────────────────────────────────────
app.get('/debug-skus', async (req, res) => {
  try {
    const shopData = await shopifyGraphQL(`{ shop { name myshopifyDomain } }`);
    if (!shopData?.data?.shop) {
      return res.json({ error:'Connection failed', raw: shopData });
    }

    const found  = [];
    let cursor   = null;
    let hasNext  = true;

    while (hasNext) {
      const after = cursor ? `, after: "${cursor}"` : '';
      const query = `{
        products(first: 250, query: "vendor:Combisteel"${after}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              title
              variants(first: 10) {
                edges { node { sku inventoryItem { id } } }
              }
            }
          }
        }
      }`;

      const data = await shopifyGraphQL(query);
      if (!data?.data?.products) break;

      const { edges, pageInfo } = data.data.products;
      for (const pe of edges) {
        for (const ve of pe.node.variants.edges) {
          found.push({
            sku:   ve.node.sku || '(blank)',
            title: pe.node.title,
            invId: ve.node.inventoryItem?.id || 'missing',
          });
        }
      }

      hasNext = pageInfo.hasNextPage;
      cursor  = pageInfo.endCursor;
      await delay(200);
    }

    const targets = getCombisteelSkus();
    const matched = targets.filter(t => found.some(f => f.sku === t));

    return res.json({
      shop:             shopData.data.shop,
      combisteelTotal:  found.length,
      combisteelSkus:   found,
      ourTargetSkus:    targets,
      matchedSkus:      matched,
      matchCount:       `${matched.length} / ${targets.length}`,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
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
  setTimeout(() => {
    runCombisteelStockSync();
    setInterval(runCombisteelStockSync, 60 * 60 * 1000);
  }, 30000);
  console.log('[Scheduler] Stock sync every 1 hour\n');
});
