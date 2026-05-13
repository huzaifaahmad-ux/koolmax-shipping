const express = require('express');
const bodyParser = require('body-parser');
const app = express();
 
app.use(bodyParser.json());
 
// ─────────────────────────────────────────────────────────────
// HADFIELDS RATES (ex-VAT, £)
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
// ─────────────────────────────────────────────────────────────
const SKU_GROUP = {
  'KMC200G':'G1','KMF200G':'G1','KMF200':'G1','KMC200':'G1','KMC200S':'G1',
  'KMC400':'G2','KMC400S':'G2','KMC600':'G2','KMC600S':'G2',
  'KMF400':'G2','KMF400S':'G2','KMF600':'G2','KMF600S':'G2',
  'KMCF230W':'G2','KMCF370W':'G2','KMCF550W':'G3','KMCF650W':'G3',
  'KMCF230S':'G2','KMCF550S':'G3','KMCF370S':'G3','KMCF650S':'G3',
  'KMF500IC':'G3','KMF400IC':'G3','KMF300IC':'G2','KMF200IC':'G2',
  'KMC1SS':'G3','KMF1SS':'G3','KMC2SS':'G4','KMF2SS':'G4',
  'KMC2DS':'G2','KMC 3DS':'G3','KMC 4DS':'G3','KMF 2DS':'G3','KMF 3DS':'G3',
  'KMC902':'G2','KMC903':'G3','KMC700':'G3','KMC1300':'G3','KMC2000':'G3',
  'KMC3000':'G4','KMF700 GREY':'G3','KMF700':'G3','KMF1300':'G3',
  'KMF1300 BLACK':'G3','KMF2000':'G3','KMF2000 GREY':'G3',
  'KMF3000':'G4','KMF3000 GREY':'G4',
  'KMBC2H':'G3','KMBC3H':'G3','KMBC2SL':'G3','KMBC3SL':'G3',
  'KOOLMAX NICE 1250':'G5','KOOLMAX NICE 1875':'G5',
  'KOOLMAX NICE 2500':'G5','KOOLMAX NICE 1000':'G5',
  'FRIGUS 2500 OPEN BLACK':'G5','FRIGUS 1875 OPEN BLACK':'G4',
  'FRIGUS 1250 OPEN BLACK':'G3','FRIGUS 2500 OPEN WHITE':'G5',
  'FRIGUS 1875 OPEN WHITE':'G4','FRIGUS 1250 OPEN WHITE':'G3',
  'OASIS 2500 FGD BLACK':'G5','OASIS 2500 FGD WHITE':'G5',
  'OASIS 1875 FGD BLACK':'G4','OASIS 1875 FGD WHITE':'G4',
  'OASIS 1250 FGD WHITE':'G3','OASIS 1250 FGD BLACK':'G3',
  'VIANDE 1250':'G3','VIANDE 1875':'G4','VIANDE 2500':'G5',
};
 
// ─────────────────────────────────────────────────────────────
// SPECIAL POSTCODES
// AB, IV1-3, PH8-10, PH15-18
// IV4-36, IV63, IV99, KW1-14, PH19-41, PH49-50
// HS, IV, KA, KW, PA, PH, ZE
// ─────────────────────────────────────────────────────────────
const SPECIAL_RANGES = {
  'AB': [[1,99]],
  'HS': [[1,99]],
  'KA': [[1,99]],
  'KW': [[1,99]],
  'PA': [[1,99]],
  'ZE': [[1,99]],
  'IV': [[1,3],[4,36],[63,63],[99,99]],
  'PH': [[8,10],[15,18],[19,41],[49,50]],
};
 
function parsePostcode(postcode) {
  if (!postcode) return { alpha: '', number: 0 };
  const outward = postcode.toUpperCase().trim().split(' ')[0];
  const match = outward.match(/^([A-Z]{1,2})(\d+)/);
  if (!match) return { alpha: '', number: 0 };
  return { alpha: match[1], number: parseInt(match[2], 10) };
}
 
function isSpecialPostcode(postcode) {
  const { alpha, number } = parsePostcode(postcode);
  if (!alpha || !SPECIAL_RANGES[alpha]) return false;
  return SPECIAL_RANGES[alpha].some(([min, max]) => number >= min && number <= max);
}
 
// ─────────────────────────────────────────────────────────────
// GET HIGHEST GROUP IN CART
// ─────────────────────────────────────────────────────────────
function getHighestGroup(items) {
  const order = ['G1','G2','G3','G4','G5'];
  let highest = 'G1';
  for (const item of items) {
    const sku   = (item.sku || '').toUpperCase().trim();
    const group = SKU_GROUP[sku] || null;
    if (group && order.indexOf(group) > order.indexOf(highest)) {
      highest = group;
    }
  }
  return highest;
}
 
function toPence(pounds) {
  return Math.round(pounds * 100);
}
 
// ─────────────────────────────────────────────────────────────
// CARRIER SERVICE ENDPOINT
// ─────────────────────────────────────────────────────────────
app.post('/rates', (req, res) => {
  try {
    const { rate }           = req.body;
    const { destination, items } = rate;
    const postcode           = destination.postal_code || '';
    const country            = (destination.country || '').toUpperCase();
 
    if (country !== 'GB' && country !== 'UK') {
      return res.json({ rates: [] });
    }
 
    const group      = getHighestGroup(items);
    const groupRates = RATES[group];
    const special    = isSpecialPostcode(postcode);
 
    let rates = [];
 
    if (special) {
      // ── SPECIAL CODE POSTCODES — 4 options ──────────────────
      rates = [
        {
          service_name: 'Delivery Only',
          service_code: 'DELIVERY_SPECIAL',
          total_price:  toPence(SPECIAL_DELIVERY_RATE),
          currency:     'GBP',
          description:  'Delivered into premises. Unit remains on pallet/packaging.',
        },
        {
          service_name: `Unpacked & Positioned — ${group}`,
          service_code: `POSITIONED_${group}`,
          total_price:  toPence(groupRates.positioned + POSITIONED_EXTRA),
          currency:     'GBP',
          description:  'Delivered, unpacked and positioned in your desired location.',
        },
        {
          service_name: `Unpacked, Positioned & Installed — ${group}`,
          service_code: `INSTALLED_${group}`,
          total_price:  toPence(groupRates.installed + INSTALLED_EXTRA),
          currency:     'GBP',
          description:  'Fully installed including levelling and removal of laser film where applicable.',
        },
        {
          service_name: `Uplift/Removal — ${group}`,
          service_code: `UPLIFTED_${group}`,
          total_price:  toPence(groupRates.collection + UPLIFTED_EXTRA),
          currency:     'GBP',
          description:  'We will uplift/remove the existing like-for-like and dispose.',
        },
      ];
 
    } else {
      // ── STANDARD UK POSTCODES — 4 options (Delivery Only FREE + preselected) ──
      rates = [
        {
          service_name: 'Delivery Only',
          service_code: `DELIVERY_FREE_${group}`,
          total_price:  0,
          currency:     'GBP',
          description:  'Delivered into premises. Unit remains on pallet/packaging.',
        },
        {
          service_name: `Unpacked & Positioned — ${group}`,
          service_code: `POSITIONED_${group}`,
          total_price:  toPence(groupRates.positioned + POSITIONED_EXTRA),
          currency:     'GBP',
          description:  'Delivered, unpacked and positioned in your desired location.',
        },
        {
          service_name: `Unpacked, Positioned & Installed — ${group}`,
          service_code: `INSTALLED_${group}`,
          total_price:  toPence(groupRates.installed + INSTALLED_EXTRA),
          currency:     'GBP',
          description:  'Fully installed including levelling and removal of laser film where applicable.',
        },
        {
          service_name: `Uplift/Removal — ${group}`,
          service_code: `UPLIFTED_${group}`,
          total_price:  toPence(groupRates.collection + UPLIFTED_EXTRA),
          currency:     'GBP',
          description:  'We will uplift/remove the existing like-for-like and dispose.',
        },
      ];
    }
 
    return res.json({ rates });
 
  } catch (err) {
    console.error('Shipping rate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
 
app.get('/', (req, res) => res.send('Koolmax Shipping Service — OK'));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Koolmax shipping service running on port ${PORT}`));
// PH8-10 fix already in ranges above
