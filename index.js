const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());

// ─────────────────────────────────────────────────────────────
// HADFIELDS RATES (ex-VAT, £)
// ─────────────────────────────────────────────────────────────
const RATES = {
  G1: { delivery: 60.89, positioned: 63.94, installed: 91.05 },
  G2: { delivery: 71.02, positioned: 82.52, installed: 106.53 },
  G3: { delivery: 113.68, positioned: 125.01, installed: 184.48 },
  G4: { delivery: 149.17, positioned: 170.47, installed: 243.98 },
  G5: { delivery: 284.13, positioned: 312.54, installed: 410.61 },
};

// ─────────────────────────────────────────────────────────────
// SKU → GROUP MAPPING
// ─────────────────────────────────────────────────────────────
const SKU_GROUP = {
  'KMC200G':              'G1',
  'KMF200G':              'G1',
  'KMF200':               'G1',
  'KMC200':               'G1',
  'KMC200S':              'G1',
  'KMC400':               'G2',
  'KMC400S':              'G2',
  'KMC600':               'G2',
  'KMC600S':              'G2',
  'KMF400':               'G2',
  'KMF400S':              'G2',
  'KMF600':               'G2',
  'KMF600S':              'G2',
  'KMCF230W':             'G2',
  'KMCF370W':             'G2',
  'KMCF550W':             'G3',
  'KMCF650W':             'G3',
  'KMCF230S':             'G2',
  'KMCF550S':             'G3',
  'KMCF370S':             'G3',
  'KMCF650S':             'G3',
  'KMF500IC':             'G3',
  'KMF400IC':             'G3',
  'KMF300IC':             'G2',
  'KMF200IC':             'G2',
  'KMC1SS':               'G3',
  'KMF1SS':               'G3',
  'KMC2SS':               'G4',
  'KMF2SS':               'G4',
  'KMC2DS':               'G2',
  'KMC 3DS':              'G3',
  'KMC 4DS':              'G3',
  'KMF 2DS':              'G3',
  'KMF 3DS':              'G3',
  'KMC902':               'G2',
  'KMC903':               'G3',
  'KMC700':               'G3',
  'KMC1300':              'G3',
  'KMC2000':              'G3',
  'KMC3000':              'G4',
  'KMF700 GREY':          'G3',
  'KMF700':               'G3',
  'KMF1300':              'G3',
  'KMF1300 BLACK':        'G3',
  'KMF2000':              'G3',
  'KMF2000 GREY':         'G3',
  'KMF3000':              'G4',
  'KMF3000 GREY':         'G4',
  'KMBC2H':               'G3',
  'KMBC3H':               'G3',
  'KMBC2SL':              'G3',
  'KMBC3SL':              'G3',
  'KOOLMAX NICE 1250':    'G5',
  'KOOLMAX NICE 1875':    'G5',
  'KOOLMAX NICE 2500':    'G5',
  'KOOLMAX NICE 1000':    'G5',
  'FRIGUS 2500 OPEN BLACK': 'G5',
  'FRIGUS 1875 OPEN BLACK': 'G4',
  'FRIGUS 1250 OPEN BLACK': 'G3',
  'FRIGUS 2500 OPEN WHITE': 'G5',
  'FRIGUS 1875 OPEN WHITE': 'G4',
  'FRIGUS 1250 OPEN WHITE': 'G3',
  'OASIS 2500 FGD BLACK': 'G5',
  'OASIS 2500 FGD WHITE': 'G5',
  'OASIS 1875 FGD BLACK': 'G4',
  'OASIS 1875 FGD WHITE': 'G4',
  'OASIS 1250 FGD WHITE': 'G3',
  'OASIS 1250 FGD BLACK': 'G3',
  'VIANDE 1250':          'G3',
  'VIANDE 1875':          'G4',
  'VIANDE 2500':          'G5',
};

// ─────────────────────────────────────────────────────────────
// POSTCODE HELPERS
// ─────────────────────────────────────────────────────────────

// Postcodes beyond Glasgow/Edinburgh — Hadfields POA (no online rate)
const POA_PREFIXES = [
  'IV','KW','HS','ZE','GY','JE','IM',       // Highlands, Islands, Channel Islands, IoM
  'PA20','PA21','PA22','PA23','PA24','PA25',
  'PA26','PA27','PA28','PA29','PA30','PA31',
  'PA32','PA33','PA34','PA35','PA36','PA37',
  'PA38','PA39','PA40','PA41','PA42','PA43',
  'PA44','PA45','PA46','PA47','PA48','PA49',
  'PA60','PA61','PA62','PA63','PA64','PA65',
  'PA66','PA67','PA68','PA69','PA70','PA71',
  'PA72','PA73','PA74','PA75','PA76','PA77',
  'PA78',
  'PH15','PH16','PH17','PH18','PH19','PH20',
  'PH21','PH22','PH23','PH24','PH25','PH26',
  'PH30','PH31','PH32','PH33','PH34','PH35',
  'PH36','PH37','PH38','PH39','PH40','PH41',
  'PH42','PH43','PH44','PH49','PH50',
  'KA27','KA28',                             // Arran & Millport
  'FK17','FK18','FK19','FK20','FK21',        // Scottish Highlands fringe
  'DD8','DD9','DD10',                        // Far NE Scotland
  'AB33','AB34','AB35','AB36','AB37','AB38',
  'AB41','AB42','AB43','AB44','AB45','AB51',
  'AB52','AB53','AB54','AB55','AB56',
];

// Aberdeen surcharge postcodes AB1–AB32
const ABERDEEN_PREFIXES = [
  'AB1','AB2','AB3','AB4','AB5','AB6','AB7','AB8','AB9',
  'AB10','AB11','AB12','AB13','AB14','AB15','AB16','AB17',
  'AB18','AB19','AB20','AB21','AB22','AB23','AB24','AB25',
  'AB30','AB31','AB32',
];

// London congestion zone postcodes (partial list — key central areas)
const LONDON_CONGESTION = [
  'EC1','EC2','EC3','EC4',
  'WC1','WC2',
  'W1','SW1','SE1',
  'E1','N1',
];

function getPostcodePrefix(postcode) {
  if (!postcode) return '';
  const clean = postcode.toUpperCase().replace(/\s+/g, '');
  // Extract outward code (e.g. "BL3", "AB12", "SW1A")
  const match = clean.match(/^([A-Z]{1,2}[0-9]{1,2}[A-Z]?)/);
  return match ? match[1] : clean.substring(0, 4);
}

function getAlphaPrefix(postcode) {
  const clean = postcode.toUpperCase().replace(/\s+/g, '');
  const match = clean.match(/^([A-Z]{1,2})/);
  return match ? match[1] : '';
}

function isPOA(postcode) {
  const full = postcode.toUpperCase().replace(/\s+/g, '');
  const prefix = getPostcodePrefix(postcode);
  const alpha = getAlphaPrefix(postcode);
  return POA_PREFIXES.some(p => full.startsWith(p) || prefix === p || alpha === p);
}

function isAberdeen(postcode) {
  const prefix = getPostcodePrefix(postcode);
  return ABERDEEN_PREFIXES.some(p => prefix.startsWith(p));
}

function isLondonCongestion(postcode) {
  const prefix = getPostcodePrefix(postcode);
  return LONDON_CONGESTION.some(p => prefix.startsWith(p));
}

// ─────────────────────────────────────────────────────────────
// DETERMINE HIGHEST GROUP IN CART
// ─────────────────────────────────────────────────────────────
function getHighestGroup(items) {
  const groupOrder = ['G1','G2','G3','G4','G5'];
  let highest = 'G1';
  for (const item of items) {
    const sku = (item.sku || '').toUpperCase().trim();
    const group = SKU_GROUP[sku] || SKU_GROUP[item.sku] || null;
    if (group && groupOrder.indexOf(group) > groupOrder.indexOf(highest)) {
      highest = group;
    }
  }
  return highest;
}

// ─────────────────────────────────────────────────────────────
// CONVERT £ to pence (Shopify uses pence)
// ─────────────────────────────────────────────────────────────
function toPence(pounds) {
  return Math.round(pounds * 100);
}

// ─────────────────────────────────────────────────────────────
// CARRIER SERVICE ENDPOINT
// ─────────────────────────────────────────────────────────────
app.post('/rates', (req, res) => {
  try {
    const { rate } = req.body;
    const { destination, items } = rate;
    const postcode = destination.postal_code || '';
    const country  = (destination.country || '').toUpperCase();

    // Only serve UK
    if (country !== 'GB' && country !== 'UK') {
      return res.json({ rates: [] });
    }

    // Check if POA area
    if (isPOA(postcode)) {
      return res.json({
        rates: [{
          service_name: 'Contact Us for Delivery Quote',
          service_code:  'POA',
          total_price:   0,
          currency:      'GBP',
          description:   'Your postcode is outside our standard delivery zone. Please call us on 01204 XXXXXX for a quote.',
        }]
      });
    }

    // Get highest group in cart
    const group = getHighestGroup(items);
    const groupRates = RATES[group];

    // Calculate surcharges
    let surcharge = 0;
    const surchargeNotes = [];

    if (isAberdeen(postcode)) {
      surcharge += 65.71;
      surchargeNotes.push('Aberdeen surcharge included');
    }

    if (isLondonCongestion(postcode)) {
      surcharge += 10.85;
      surchargeNotes.push('London congestion charge included');
    }

    const note = surchargeNotes.length > 0
      ? ` (${surchargeNotes.join(', ')})`
      : '';

    const rates = [
      {
        service_name:  `Delivery Only — ${group}${note}`,
        service_code:  `HADFIELDS_DELIVERY_${group}`,
        total_price:   toPence(groupRates.delivery + surcharge),
        currency:      'GBP',
        description:   'Delivered into premises. Unit remains on pallet/packaging.',
        min_delivery_date: null,
        max_delivery_date: null,
      },
      {
        service_name:  `Unpacked & Positioned — ${group}${note}`,
        service_code:  `HADFIELDS_POSITIONED_${group}`,
        total_price:   toPence(groupRates.positioned + surcharge),
        currency:      'GBP',
        description:   'Delivered, unpacked and positioned in your desired location.',
      },
      {
        service_name:  `Unpacked, Positioned & Installed — ${group}${note}`,
        service_code:  `HADFIELDS_INSTALLED_${group}`,
        total_price:   toPence(groupRates.installed + surcharge),
        currency:      'GBP',
        description:   'Fully installed including levelling and removal of laser film where applicable.',
      },
    ];

    return res.json({ rates });

  } catch (err) {
    console.error('Shipping rate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/', (req, res) => res.send('Koolmax Shipping Service — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Koolmax shipping service running on port ${PORT}`));
