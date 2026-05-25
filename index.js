const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());

// ─────────────────────────────────────────────────────────────
// HADFIELDS BASE RATES (ex-VAT, £) — per unit
// ─────────────────────────────────────────────────────────────
const RATES = {
  G1: { positioned: 63.94,  collection: 30.45  },
  G2: { positioned: 82.52,  collection: 35.51  },
  G3: { positioned: 125.01, collection: 56.84  },
  G4: { positioned: 170.47, collection: 74.59  },
  G5: { positioned: 312.54, collection: 213.10 },
};

// ─────────────────────────────────────────────────────────────
// EXTRAS (per unit)
// ─────────────────────────────────────────────────────────────
const POSITIONED_EXTRA          = 13.00; // £3 original + £10 new
const UPLIFTED_EXTRA            = 15.00; // £5 original + £10 new
const SPECIAL_DELIVERY_PER_ITEM = 70.00; // £70 per product on special postcodes

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
  'OASIS 1250 FGD WHITE':'G3','OASIS 1250 FGD BLACK':'G3',
  'VIANDE 1250':'G3',
  // G4
  'KMC2SS':'G4','KMF2SS':'G4','KMC3000':'G4','KMF3000':'G4','KMF3000 GREY':'G4',
  'FRIGUS 1875 OPEN BLACK':'G4','FRIGUS 1875 OPEN WHITE':'G4',
  'OASIS 1875 FGD BLACK':'G4','OASIS 1875 FGD WHITE':'G4',
  'VIANDE 1875':'G4',
  // G5
  'KOOLMAX NICE 1000':'G5','KOOLMAX NICE 1250':'G5',
  'KOOLMAX NICE 1875':'G5','KOOLMAX NICE 2500':'G5',
  'FRIGUS 2500 OPEN BLACK':'G5','FRIGUS 2500 OPEN WHITE':'G5',
  'OASIS 2500 FGD BLACK':'G5','OASIS 2500 FGD WHITE':'G5',
  'VIANDE 2500':'G5',
};

// ─────────────────────────────────────────────────────────────
// SPECIAL POSTCODE RANGES
// ─────────────────────────────────────────────────────────────
const SPECIAL_RANGES = {
  'AB': [[1, 99]],
  'HS': [[1, 99]],
  'IV': [[1, 99]],
  'KA': [[1, 99]],
  'KW': [[1, 99]],
  'PA': [[1, 99]],
  'PH': [[8, 10], [15, 18], [19, 41], [49, 50]],
  'ZE': [[1, 99]],
};

function parsePostcode(p) {
  const clean = (p || '').toUpperCase().replace(/\s+/g, '');
  const m = clean.match(/^([A-Z]{1,2})(\d{1,2})/);
  return m ? { alpha: m[1], number: parseInt(m[2]) } : { alpha: '', number: 0 };
}

function isSpecial(postcode) {
  const { alpha, number } = parsePostcode(postcode);
  if (!alpha || !SPECIAL_RANGES[alpha]) return false;
  return SPECIAL_RANGES[alpha].some(([a, b]) => number >= a && number <= b);
}

function toPence(pounds) {
  return Math.round(pounds * 100);
}

// ─────────────────────────────────────────────────────────────
// CALCULATE TOTALS
// items = [{ sku, quantity }, ...]
// Logic: per-unit price × quantity, summed across all items/groups
// ─────────────────────────────────────────────────────────────
function calculateTotals(items) {
  let positionedTotal = 0;
  let upliftedTotal   = 0;
  let totalQty        = 0;

  for (const item of items) {
    const sku = (item.sku || '').trim();
    const qty = item.quantity || 1;
    totalQty += qty;

    const group = SKU_GROUP[sku];
    if (!group || !RATES[group]) {
      console.warn(`Unknown SKU: "${sku}" — defaulting to G3`);
      const r = RATES['G3'];
      positionedTotal += (r.positioned + POSITIONED_EXTRA) * qty;
      upliftedTotal   += (r.collection + UPLIFTED_EXTRA)   * qty;
      continue;
    }

    const r = RATES[group];
    positionedTotal += (r.positioned + POSITIONED_EXTRA) * qty;
    upliftedTotal   += (r.collection + UPLIFTED_EXTRA)   * qty;
  }

  return { positionedTotal, upliftedTotal, totalQty };
}

// ─────────────────────────────────────────────────────────────
// /rates ENDPOINT
// ─────────────────────────────────────────────────────────────
app.post('/rates', (req, res) => {
  try {
    const { rate } = req.body || {};
    const items       = (rate && rate.items) || [];
    const destination = (rate && rate.destination) || {};
    const postcode    = destination.postal_code || '';

    const special = isSpecial(postcode);
    const { positionedTotal, upliftedTotal, totalQty } = calculateTotals(items);
    const combinedTotal = positionedTotal + upliftedTotal;

    let rates = [];

    if (special) {
      // ── SPECIAL CODES — 4 options ─────────────────
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
          description:  'Delivered, unpacked, positioned, and We will uplift/remove the existing like-for-like and dispose.',
        },
      ];
    } else {
      // ── STANDARD UK — 4 options ───────────────────
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
          description:  'Delivered, unpacked, positioned, and We will uplift/remove the existing like-for-like and dispose.',
        },
      ];
    }

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
