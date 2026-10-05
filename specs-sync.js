// specs-sync.js
// Shared Combisteel helpers + specs sync into Shopify rich text metafields
//   custom.product_features       (rich text)
//   custom.product_specification  (rich text)

const COMBISTEEL_URL = 'https://pim.combisteel.com/pimcore-graphql-webservices/Combisteel';
const COMBISTEEL_ASSET_BASE = 'https://pim.combisteel.com';
const FEATURES_KEY = 'product_features';
const SPEC_KEY = 'product_specification';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- English labels (by Combisteel attribute code) ----------
// Codes not listed here are skipped, so customers never see Dutch labels.
const LABEL_EN = {
  '6018': 'Width (mm)', '6021': 'Depth (mm)', '6024': 'Height (mm)', '6025': 'Length (mm)',
  '6039': 'Gross weight (kg)', '6042': 'Net weight (kg)',
  '6027': 'Material', '6028': 'Interior material', '6030': 'Colour', '6031': 'RAL colour',
  '6057': 'Voltage (V)', '6060': 'Frequency (Hz)', '6061': 'Current (A)',
  '6069': 'Electrical power (kW)', '6072': 'Gas power (kW)', '6063': 'Gas connection',
  '6066': 'Gas type', '6762': 'Gas consumption (kWh)', '6073': 'Type', '6074': 'Model',
  '6053': 'Cable length (mm)', '6054': 'Plug fitted', '6035': 'Dismountable',
  '6075': 'Air outlet (mm)', '6077': 'Tap connection', '6078': 'Water connection (inch)',
  '6081': 'Water inlet temperature (°C)', '6084': 'Drain connection (mm)',
  '6087': 'Water pressure min/max (bar)', '6093': 'Oven power (kW)',
  '6100': 'Pump capacity (L/min)', '6117': 'Refrigerant', '6118': 'Refrigerant quantity (g)',
  '6126': 'Fan power (W)', '6134': 'Tank size W×D×H (mm)', '6141': 'Burner power (kW)',
  '6144': 'Hob power / layout (kW)', '6147': 'Cooking zone power (kW)',
  '6150': 'Capacity per cycle', '6153': 'Capacity per hour', '6156': 'Airflow (m³/h)',
  '6180': 'Temperature range (°C)', '6192': 'Freezing capacity (kg/24h)',
  '6201': 'Max ice production (kg/24h)', '6207': 'Boiler power (kW)',
  '6210': 'Boiler capacity (L)', '6216': 'Number of burners', '6219': 'Number of elements',
  '6222': 'Wok / soup burners', '6228': 'Baskets per hour', '6231': 'Number of baskets',
  '6240': 'Number of grids', '6245': 'Number of pizzas', '6246': 'Pizza size (cm)',
  '6252': 'Max grid load (kg)', '6253': 'Max shelf load (kg)', '6258': 'Number of shelves',
  '6261': 'Number of bottles', '6263': 'Number of cans', '6270': 'Rinse temperature (°C)',
  '6273': 'Speed (rpm)', '6276': 'Blade diameter (mm)', '6279': 'Cutting thickness (mm)',
  '6282': 'Filling capacity (L)', '6291': 'Max weight (kg)',
  '6303': 'Built-in width (mm)', '6306': 'Built-in depth (mm)', '6309': 'Built-in height (mm)',
  '6312': 'Gross capacity (L)', '6315': 'Net capacity (L)', '6318': 'GN capacity',
  '6319': 'EN capacity', '6324': 'Fridge capacity (L)', '6327': 'Freezer capacity (L)',
  '6333': 'Oven chamber W×D×H (mm)', '6336': 'Oven capacity (L)',
  '6342': 'Adjustable feet height (mm)', '6349': 'Capacity (L)',
  '6354': 'Internal dimensions W×D×H (mm)', '6357': 'Grid size W×D (mm)',
  '6366': 'Basket size W×D×H (mm)', '6372': 'Reservoir capacity (L)',
  '6375': 'Storage bin capacity (kg)', '6381': 'Cooking surface W×D (mm)',
  '6383': 'Cooking surface', '6385': 'Tilting', '6390': 'Fat pan capacity (L)',
  '6396': 'Baking plate W×D (mm)', '6402': 'Top size W×D (mm)',
  '6411': 'Sink bowl W×D×H (mm)', '6414': 'Diameter (mm)', '6417': 'Working height (mm)',
  '6419': 'Max GN pan depth (mm)', '6420': 'Height with door open (mm)',
  '6426': 'Water bath capacity (L)', '6432': 'Wash tank capacity (L)',
  '6436': 'Self-closing door', '6438': 'Depth with door open (mm)',
  '6441': 'Basket size W×D×H (mm)', '6447': 'Chamber size W×D×H (mm)',
  '6462': 'Controls', '6468': 'Convection function', '6471': 'Grill function',
  '6474': 'Steam function', '6475': 'Defrost function', '6477': 'Humidity injection',
  '6480': 'Oven type', '6483': 'Core temperature probe', '6486': 'Double glazing',
  '6492': 'Timer', '6495': 'Temperature display', '6498': 'Lighting',
  '6510': 'Number of wash tanks', '6513': 'Dry-run protection', '6516': 'Booster pump',
  '6522': 'Wash programmes', '6534': 'Condenser cooling', '6537': 'Cooling type',
  '6538': 'Heating type', '6540': 'Lockable', '6543': 'Thermostat range (°C)',
  '6549': 'Freezer compartment', '6552': 'Mobile (castors)', '6555': 'Piezo ignition',
  '6561': 'Base material', '6567': 'Tap', '6571': 'Waste hole', '6580': 'Number of doors',
  '6583': 'Number of drawers', '6594': 'Number of levels', '6609': 'Bottom grid',
  '6615': 'Display', '6616': 'Winter control', '6618': 'Indicator light',
  '6624': 'Door hinge', '6627': 'Reversible door', '6636': 'Noise level (dB)',
  '6654': 'Defrost system', '6655': 'Condensate evaporation', '6657': 'Ice cube size (mm)',
  '6665': 'Climate class', '6666': 'Max ambient temperature (°C)',
  '6672': 'Compressor type', '6675': 'Insulation thickness (mm)', '6714': 'Drain tap',
  '6720': 'Fat collection tray', '6723': 'Heating', '6726': 'Operating pressure (bar)',
  '6735': 'Cycle time (sec)', '6741': 'Wash temperature (°C)', '6742': 'Walls',
  '6747': 'IP rating', '6758': 'Energy class', '6759': 'Energy class',
  '6765': 'Energy consumption (kWh/24h)', '6768': 'Water consumption (L/h)',
  '6769': 'Water consumption (L/cycle)',
};

// Codes that go into "product_features"; everything else goes into "product_specification".
const FEATURE_CODES = new Set([
  '6073', '6074', '6027', '6028', '6030', '6462', '6468', '6471', '6474', '6475', '6477',
  '6480', '6483', '6486', '6492', '6495', '6498', '6513', '6516', '6534', '6537', '6538',
  '6540', '6549', '6552', '6555', '6561', '6567', '6571', '6383', '6385', '6609', '6615',
  '6616', '6618', '6624', '6627', '6654', '6655', '6714', '6720', '6723', '6742', '6054',
  '6035', '6436',
]);

// ---------- English values for dropdown options ----------
const VALUE_EN = {
  'Ja': 'Yes', 'Nee': 'No', 'Optioneel': 'Optional', 'Nvt.': 'N/A',
  'Elektrisch': 'Electric', 'Stoom': 'Steam', 'Hout gestookt': 'Wood-fired', 'Inductie': 'Induction',
  'Tafelmodel': 'Countertop', 'Staand model': 'Freestanding', 'Inbouw model': 'Built-in',
  'Draaiknop': 'Rotary knob', 'Druktoets': 'Push button', 'Digitaal': 'Digital',
  'Handmatig': 'Manual', 'Slidebediening': 'Slide control',
  'Staal': 'Steel', 'Gietijzer': 'Cast iron', 'Gietaluminium': 'Cast aluminium',
  'Gegoten aluminium': 'Cast aluminium', 'Kunststof': 'Plastic', 'ABS kunststof': 'ABS plastic',
  'Hardglas': 'Tempered glass', 'Verchroomd staal': 'Chrome-plated steel',
  'Gepoedercoat staal': 'Powder-coated steel', 'Gegalvaniseerd staal': 'Galvanised steel',
  'Geëmailleerd staal': 'Enamelled steel', 'Kunststof wit': 'White plastic',
  'Wit': 'White', 'Zwart': 'Black', 'Zilver': 'Silver', 'Grijs': 'Grey', 'Rood': 'Red',
  'Blauw': 'Blue', 'Groen': 'Green', 'Geel': 'Yellow', 'Oranje': 'Orange', 'Bruin': 'Brown',
  'Statisch': 'Static', 'statisch': 'Static', 'Geforceerd': 'Fan-assisted',
  'Statisch met ventilator': 'Static with fan', 'convectie': 'Convection',
  'Automatisch': 'Automatic', 'Links': 'Left', 'Rechts': 'Right',
  'Links en Rechts': 'Left and right', 'Midden': 'Centre', 'Onderzijde': 'Bottom',
  'Gebogen': 'Curved', 'Recht': 'Straight', 'Glad': 'Smooth', 'Geribd': 'Ribbed',
  'Glad/geribd': 'Smooth/ribbed', 'Verchroomd glad': 'Chrome, smooth',
  'Verchroomd geribd': 'Chrome, ribbed', 'Verchr.glad/geribd': 'Chrome, smooth/ribbed',
  'Lucht': 'Air', 'Enkelwandig': 'Single-walled', 'Dubbelwandig': 'Double-walled',
  'Inclusief': 'Included', 'Exclusief': 'Not included',
  'Handmatige kanteling': 'Manual tilting', 'Automatische kanteling': 'Automatic tilting',
  'Aardgas G20': 'Natural gas G20', 'Aardgas G25': 'Natural gas G25',
  'Propaan G31': 'Propane G31', 'Butaan G30': 'Butane G30',
  'Propaan/Butaan G31+G30': 'Propane/Butane G31+G30',
  'Geen energielabel nodig': 'No energy label required',
  '1 Gats': 'Single hole', '2 Gats': 'Two holes',
};

function translateValue(v) {
  let s = String(v).trim();
  if (VALUE_EN[s]) return VALUE_EN[s];
  if (/^\d+,\d+$/.test(s)) return s.replace(',', '.');           // 1,5 -> 1.5
  s = s.replace(/^(Rvs|RVS|R\.v\.s)\b/, 'Stainless steel');         // Rvs 18/10 -> Stainless steel 18/10
  s = s.replace(/^Ja, /, 'Yes, ')
       .replace(/\bdigitaal\b/i, 'digital').replace(/\banoloog\b/i, 'analogue')
       .replace(/\bdimbaar\b/i, 'dimmable').replace(/\bHalogeen\b/, 'halogen');
  return s;
}

// ---------- API helpers ----------
async function combisteelQuery(query, variables = {}) {
  const res = await fetch(`${COMBISTEEL_URL}?apikey=${process.env.COMBISTEEL_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

async function shopifyQuery(query, variables = {}) {
  const url = `https://${process.env.SHOPIFY_STORE_URL}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

// ---------- Combisteel attribute lookup (cached 6 hours) ----------
let attrCache = null;
let attrCacheTime = 0;
async function getAttributeMap() {
  if (attrCache && Date.now() - attrCacheTime < 6 * 3600 * 1000) return attrCache;
  const data = await combisteelQuery(`{
    getAttributeListing(first: 1000) {
      edges { node { name type options { value title } } }
    }
  }`);
  const map = {};
  for (const { node } of data.getAttributeListing.edges) {
    map[node.name] = {
      type: node.type,
      options: Object.fromEntries((node.options || []).map(o => [o.value, o.title])),
    };
  }
  attrCache = map;
  attrCacheTime = Date.now();
  return map;
}

// ---------- One product from Combisteel ----------
async function getPimProduct(sku) {
  const data = await combisteelQuery(`
    query($filter: String) {
      getProductListing(first: 1, filter: $filter) {
        edges { node {
          sku title description price stock grossWeight width height
          defaultImage { fullpath }
          extraImages { image { fullpath } }
          technicalSpecification {
            features {
              ... on csFeatureInput  { name text }
              ... on csFeatureSelect { name selection }
            }
          }
        } }
      }
    }`, { filter: JSON.stringify({ sku }) });
  return data.getProductListing.edges[0]?.node || null;
}

// Decode specs -> { features: [[label, value]], specification: [[label, value]], raw: { code: value } }
function decodeSpecs(node, attrMap) {
  const features = [];
  const specification = [];
  const raw = {};
  for (const group of node.technicalSpecification || []) {
    for (const f of group.features || []) {
      const rawVal = f.text ?? f.selection;
      if (rawVal == null || String(rawVal).trim() === '') continue;
      const decoded = f.selection != null ? (attrMap[f.name]?.options?.[rawVal] ?? null) : rawVal;
      if (decoded == null || String(decoded).trim() === '') continue;
      raw[f.name] = String(decoded).trim();

      const label = LABEL_EN[f.name];
      if (!label) continue;
      const value = translateValue(decoded);

      if (FEATURE_CODES.has(f.name)) {
        if (value === 'No' || value === 'N/A') continue;      // only positive features
        features.push([label, value]);
      } else {
        specification.push([label, value]);
      }
    }
  }
  return { features, specification, raw };
}

function imageUrls(node) {
  const urls = [];
  if (node.defaultImage?.fullpath) urls.push(COMBISTEEL_ASSET_BASE + node.defaultImage.fullpath);
  for (const img of node.extraImages || []) {
    if (img?.image?.fullpath) urls.push(COMBISTEEL_ASSET_BASE + img.image.fullpath);
  }
  return [...new Set(urls)];
}

// ---------- Shopify rich text JSON ----------
function buildRichText(pairs, { featureStyle = false } = {}) {
  return JSON.stringify({
    type: 'root',
    children: [{
      type: 'list',
      listType: 'unordered',
      children: pairs.map(([label, value]) => ({
        type: 'list-item',
        children: featureStyle && value === 'Yes'
          ? [{ type: 'text', value: label.replace(/\s*\(.*\)$/, '') }]
          : [
              { type: 'text', value: `${label}: `, bold: true },
              { type: 'text', value: String(value) },
            ],
      })),
    }],
  });
}

// ---------- Bulk specs sync for existing products ----------
// By default only product_specification is overwritten, so hand-written
// product_features on existing products are not touched.
async function syncSpecs({ includeFeatures = false } = {}) {
  console.log('[specs] Starting specs sync');
  const attrMap = await getAttributeMap();

  const skuToProduct = {};
  let after = null;
  do {
    const data = await shopifyQuery(`
      query($after: String) {
        products(first: 100, after: $after, query: "vendor:Combisteel") {
          pageInfo { hasNextPage endCursor }
          edges { node { id variants(first: 20) { edges { node { sku } } } } }
        }
      }`, { after });
    for (const { node } of data.products.edges) {
      for (const v of node.variants.edges) {
        const sku = (v.node.sku || '').trim();
        if (sku) skuToProduct[sku] = node.id;
      }
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  const metafields = [];
  const notFound = [];
  for (const sku of Object.keys(skuToProduct)) {
    try {
      const node = await getPimProduct(sku);
      if (!node) { notFound.push(sku); continue; }
      const { features, specification } = decodeSpecs(node, attrMap);
      if (specification.length) metafields.push({
        ownerId: skuToProduct[sku], namespace: 'custom', key: SPEC_KEY,
        type: 'rich_text_field', value: buildRichText(specification),
      });
      if (includeFeatures && features.length) metafields.push({
        ownerId: skuToProduct[sku], namespace: 'custom', key: FEATURES_KEY,
        type: 'rich_text_field', value: buildRichText(features, { featureStyle: true }),
      });
    } catch (e) {
      console.log(`[specs] Error for ${sku}:`, e.message);
    }
    await sleep(200);
  }

  for (let i = 0; i < metafields.length; i += 25) {
    const data = await shopifyQuery(`
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`, { metafields: metafields.slice(i, i + 25) });
    if (data.metafieldsSet.userErrors.length) {
      console.log('[specs] metafieldsSet errors:', JSON.stringify(data.metafieldsSet.userErrors));
    }
    await sleep(500);
  }
  console.log(`[specs] Done. Metafields written: ${metafields.length}`);
  if (notFound.length) console.log('[specs] Not in Combisteel PIM:', notFound);
  return { written: metafields.length, notFound };
}

module.exports = {
  syncSpecs,
  combisteelQuery, shopifyQuery, getAttributeMap, getPimProduct,
  decodeSpecs, imageUrls, buildRichText, translateValue,
  FEATURES_KEY, SPEC_KEY, sleep,
};
