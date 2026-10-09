// description-copy.js
// Product descriptions in the Koolmax copywriter's style.
//
// Three sources, in this order:
//   1. Saved:    the SKU has a copywriter description in description-examples.json -> used as is
//   2. Template: free, instant, built from the Combisteel specs using the copywriter's structure
//   3. AI:       Claude API rewrite, using the copywriter's descriptions as style examples
//                (needs ANTHROPIC_API_KEY; model ANTHROPIC_DESC_MODEL, default claude-sonnet-5-5)
//
// The copywriter's structure (from 38 descriptions):
//   problem the kitchen faces (2-3 sentences, often a question)
//   -> "The Combisteel <name> was designed to ..." (the answer)
//   -> each spec followed by why it matters in a working kitchen
//   -> power supply / ready to use, and who it is for
//   One paragraph, 170-250 words, UK English, "you / your team / your kitchen".
//
// To teach it more styles, add descriptions to description-examples.json: { "sku", "category", "text" }.

const fs = require('fs');
const path = require('path');

let EXAMPLES = [];
try { EXAMPLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'description-examples.json'), 'utf8')); }
catch (e) { console.log('[descriptions] description-examples.json not loaded:', e.message); }
const SAVED = new Map(EXAMPLES.map(e => [String(e.sku).trim(), e.text]));

// ---------- small helpers ----------
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = n => (Number.isInteger(n) && n >= 0 && n <= 12 ? WORDS[n] : String(n));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const num = v => {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const fmt = n => (n == null ? '' : Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const pick = (arr, seed, salt = 0) => arr[(hash(seed) + salt * 7) % arr.length];
const toHtml = text => String(text).trim().split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join('');

// ---------- category ----------
const CATEGORY_RULES = [
  ['wok', /wok/],
  ['induction', /induct/],
  ['fryer', /fryer|friteuse/],
  ['hotcupboard', /heated cupboard|hot cupboard|heated cabinet|warming cabinet|plate warmer|heated pass/],
  ['pasta', /pasta/],
  ['bainmarie', /bain.?marie/],
  ['griddle', /griddle|fry.?top|plancha|chargrill|grill/],
  ['boiling', /boiling pan|kettle|bratt/],
  ['oven', /oven|combi|convection/],
  ['range', /cooker|range|stove|burner|hob/],
  ['refrigeration', /fridge|freezer|refrigerat|chiller|cool|ice/],
  ['warewash', /dish.?wash|glass.?wash|pass.?through dish|utensil wash/],
];
function categoryFor(title) {
  const t = title.toLowerCase();
  return (CATEGORY_RULES.find(([, re]) => re.test(t)) || ['generic'])[0];
}

// ---------- facts from Combisteel specs (raw = attribute code -> value) ----------
function facts(title, raw = {}) {
  const t = title.toLowerCase();
  const sel = v => String(v || '').toLowerCase();
  const fuel = /induct/.test(t) || sel(raw['6073']) === 'inductie' ? 'induction'
    : /propane/.test(t) ? 'propane'
    : /\bgas\b/.test(t) || sel(raw['6073']) === 'gas' || raw['6072'] ? 'gas'
    : 'electric';
  const modelRaw = raw['6074'] || '';
  const model = /tafel/i.test(modelRaw) || /table.?top|countertop/.test(t) ? 'tabletop'
    : /staand/i.test(modelRaw) || /freestanding/.test(t) ? 'freestanding'
    : /inbouw|drop.?in/i.test(modelRaw + ' ' + t) ? 'drop-in' : null;

  // "2x15L", "2 x 12.5L", "15L"
  const multi = t.match(/(\d)\s*x\s*(\d+(?:[.,]\d+)?)\s*l\b/);
  const single = t.match(/(\d+(?:[.,]\d+)?)\s*(?:l|ltr|litres?|liters?)\b/);
  const litres = multi ? num(multi[2]) : single ? num(single[1])
    : num(raw['6349']) ?? num(raw['6312']) ?? num(raw['6315']) ?? num(raw['6426']);
  const tanks = multi ? parseInt(multi[1], 10) : num(raw['6510']) || (/twin|double/.test(t) ? 2 : 1);

  // "2x9kW" = per tank/zone; otherwise total
  const kwEachTitle = t.match(/\d\s*x\s*(\d+(?:[.,]\d+)?)\s*kw/);
  const wattsTitle = num((t.match(/(\d{3,5})\s*w\b/) || [])[1]);
  const kwTitle = num((t.match(/(\d+(?:[.,]\d+)?)\s*kw\b/) || [])[1]);
  const kw = num(raw['6069']) ?? num(raw['6072']) ?? (kwEachTitle ? null : kwTitle) ?? (wattsTitle ? wattsTitle / 1000 : null);

  const zonesTitle = num((t.match(/(\d)\s*(?:pl|hobs?|zones?|plates?)\b/) || [])[1]);
  const zones = zonesTitle || num(raw['6216']) || num(raw['6219']) || null;

  const material = sel(raw['6027']);
  return {
    fuel, model, litres, tanks,
    kw, kwEach: kwEachTitle ? num(kwEachTitle[1]) : null, watts: wattsTitle,
    zones, zoneKw: num(raw['6147']),
    baskets: num(raw['6231']),
    doors: num(raw['6580']), drawers: num(raw['6583']), shelves: num(raw['6258']),
    tempRange: raw['6543'] || raw['6180'] || null,
    drainTap: /^(ja|yes)$/i.test(raw['6714'] || ''),
    fatTray: /^(ja|yes)$/i.test(raw['6720'] || ''),
    width: num(raw['6018']), depth: num(raw['6021']),
    weight: num(raw['6042']) ?? num(raw['6039']),
    volt: raw['6057'] ? String(raw['6057']).replace(/\s*v$/i, '') : null,
    stainless: /rvs|roestvrij|stainless|aisi|inox/.test(material) || !material,
    aisi: (material.match(/aisi\s*\d{3}/) || [])[0]?.toUpperCase() || null,
  };
}

// ---------- copy banks (from the copywriter’s descriptions) ----------
// {hooks: problem openings, answer: what the product was designed to do, close: final line}
const BANKS = {
  fryer: {
    hooks: f => f.tanks > 1 ? [
      'Frying two completely different menu items in the same tank always ends the same way: the flavours bleed into each other and neither dish tastes the way it should. No one wants chips that taste of fish, and that one small mistake can cost you a returning customer.',
      'Once your kitchen gets busy enough, one tank stops being a fryer and starts being a bottleneck, with every order queuing behind a single tank of oil. When the tickets are stacking up, waiting for one batch to finish before you start the next simply isn’t an option.',
    ] : [
      'If you have ever watched a queue build while your fryer struggles to bring the oil back to temperature, you know how quickly a service falls apart. Every minute spent waiting for the oil to recover is a minute your customers spend waiting for their food.',
      'Your fried food is only as good as the oil temperature behind it. Drop a full load of cold chips into a fryer that is too small or too weak, and the temperature crashes, leaving you with a pale, greasy batch instead of a crisp one.',
    ],
    answer: f => f.tanks > 1
      ? 'keep every menu item tasting exactly the way it should, with separate oil for each product and no waiting on one tank'
      : 'keep your oil hot and your fried food crisp and consistent, batch after batch, even when the orders keep coming',
    close: f => f.tanks > 1
      ? 'If you want a fryer that keeps service fast and flavours perfectly separated, this is the upgrade your kitchen needs.'
      : 'If you want a fryer that keeps up with demand and speeds up service without any delay, this is the one for your kitchen.',
  },
  induction: {
    hooks: f => f.zones > 1 ? [
      'When the orders start piling up and every pan on your line is already in use, one cooking zone simply isn’t enough. You need more cooking capacity, but you can’t afford to give up valuable kitchen space to get it.',
      'A fixed kitchen layout can put a hard limit on your cooking capacity, and that becomes a real problem when your orders keep growing. What you need is more cooking power without asking your kitchen for more room.',
    ] : [
      'What are you going to do when your main range is busy with a big order and a dish comes in that needs fast, intense heat? Waiting for the range to free up leaves your customer waiting too, and that’s how good service turns into a complaint.',
      'A full-size cooking range handles most of the work in a commercial kitchen, but it rarely gives you the quick heat you need when service suddenly gets slammed. You need something that has your back in those busy moments.',
    ],
    answer: f => f.zones > 1
      ? 'give you more powerful cooking zones without taking over your kitchen'
      : 'give you fast, reliable heat whenever you need to get a pan hot quickly',
    close: f => f.zones > 1
      ? 'This is the cooking station that lets you make the best use of every inch of your kitchen.'
      : 'It’s a simple way to add extra cooking power whenever the kitchen gets busy.',
  },
  wok: {
    hooks: () => [
      'The quality of wok cooking depends on that fierce, instant heat that sears the ingredients before they can soften or start to steam. Gentle heat simply doesn’t work, which is why the wrong equipment can change the whole character of a dish.',
      'To give your customers a real wok-style dish, you need fierce heat that cooks ingredients quickly while keeping their texture, flavour and character intact. That’s only possible with a cooker that delivers instant heat and responds the moment you adjust it.',
    ],
    answer: () => 'give you the fierce, instant heat that keeps wok cooking fast, hot and full of flavour',
    close: () => 'A wok cooker that finally respects the way wok cooking is meant to work.',
  },
  hotcupboard: {
    hooks: () => [
      'Once a dish is prepared, it isn’t always served straight away. Maybe the rest of the order isn’t ready yet, or the table is still being cleared, and the kitchen needs somewhere to hold finished food without it losing its heat and freshness.',
      'Everyone talks about cooking the perfect dish, but no one talks about what happens once it’s plated. Even a few minutes waiting for the rest of the table can cost a dish the heat, texture and freshness your chef worked so hard to create.',
    ],
    answer: () => 'hold your freshly cooked dishes at the right temperature until the whole order is ready to go out',
    close: () => 'If you want every dish to reach the table as fresh and appetising as when it left the kitchen, this is a must-have for your pass.',
  },
  pasta: {
    hooks: () => [
      'Pasta orders never arrive one at a time. When the tickets start stacking up, a pot of water on a busy range can’t keep up, and every minute spent waiting for the water to come back to the boil holds up the whole service.',
    ],
    answer: () => 'keep pasta service fast and steady, portion after portion',
    close: () => 'If pasta is a big part of your menu, this is the cooker that keeps it moving.',
  },
  bainmarie: {
    hooks: () => [
      'Sauces, sides and garnishes need to be ready the second a plate is called, but leaving them on the stove dries them out and takes up burners you need for cooking. You need somewhere to hold them hot without overcooking them.',
    ],
    answer: () => 'keep sauces and sides at serving temperature, ready to plate without drying out',
    close: () => 'For a pass that never waits on a sauce, this is a reliable addition to your line.',
  },
  griddle: {
    hooks: () => [
      'Burgers, steaks and breakfasts all come down to one thing: even, reliable heat across the whole plate. When one side of your griddle runs cooler than the other, your team ends up chasing hot spots instead of cooking to order.',
    ],
    answer: () => 'give you even, powerful heat across the plate so you can sear and cook to order at speed',
    close: () => 'If you want a griddle that keeps up with a busy grill section, this is the one to go for.',
  },
  boiling: {
    hooks: () => [
      'Large batches of stock, soup and sauce take time, and cooking them in pots on the range ties up burners and risks scorching on the bottom. When volume grows, you need a dedicated way to cook big batches evenly.',
    ],
    answer: () => 'cook large batches evenly without scorching or sticking',
    close: () => 'For kitchens that cook in volume, this is a dependable way to have big batches ready on time.',
  },
  oven: {
    hooks: () => [
      'Consistency is everything when you’re roasting and baking for a full dining room. An oven that heats unevenly gives you one perfect tray and one that needs to go back in, and that costs you time you don’t have during service.',
    ],
    answer: () => 'deliver consistent results tray after tray, even during your busiest service',
    close: () => 'If you want an oven your team can rely on every single service, this is the one for your kitchen.',
  },
  range: {
    hooks: () => [
      'Your range is the heart of your kitchen, and when it can’t keep enough pans on the go, everything else slows down with it. When orders grow, you need dependable heat for every pan on the line.',
    ],
    answer: () => 'give you dependable heat for every pan on the line, so several dishes can cook at once',
    close: () => 'If you want a cooking station that keeps up with your kitchen, this is a solid choice.',
  },
  refrigeration: {
    hooks: () => [
      'Every trip to the walk-in during service is time your team isn’t cooking. Ingredients need to be cold, organised and within arm’s reach, or the line slows down just when it needs to move fastest.',
    ],
    answer: () => 'keep your ingredients chilled, organised and close to hand during service',
    close: () => 'For reliable cold storage that keeps your stock fresh and your team moving, this is a smart choice.',
  },
  warewash: {
    hooks: () => [
      'Clean plates, glasses and utensils are the one thing a busy service can’t run out of. When washing falls behind, everything else stops with it.',
    ],
    answer: () => 'keep clean crockery and glassware moving through even the busiest service',
    close: () => 'If you want washing that never holds up the pass, this is the one to choose.',
  },
  generic: {
    hooks: () => [
      'In a busy commercial kitchen, every piece of equipment has to earn its place. Anything that slows your team down or takes up more space than it’s worth quickly becomes a problem during service.',
    ],
    answer: () => 'keep up with the demands of a busy commercial kitchen without slowing your team down',
    close: () => 'If you want equipment you can rely on every service, this is a solid choice for your kitchen.',
  },
};

// ---------- fact sentences (each fact followed by why it matters) ----------
function factSentences(cat, f, seed) {
  const out = [];
  const powerWord = f.fuel === 'gas' || f.fuel === 'propane' ? 'gas' : 'electric';

  if (cat === 'fryer') {
    if (f.tanks > 1 && f.litres) out.push(`It gives you ${word(f.tanks)} separate ${fmt(f.litres)}-litre tanks, so you can fry your chips in one and your fish in the other without the flavours mixing.`);
    else if (f.litres) out.push(`It gives you a generous ${fmt(f.litres)}-litre tank, so you can drop bigger batches and still get an even, reliable result every time.`);
    if (f.kwEach && f.tanks > 1) out.push(`Each tank has its own ${fmt(f.kwEach)}kW ${powerWord === 'gas' ? 'burner' : 'heating element'}, so the oil comes back to frying temperature quickly and you can control both sides independently.`);
    else if (f.kw) out.push(`With ${fmt(f.kw)}kW of ${powerWord} power, the oil recovers its temperature quickly after a full drop, so the next batch is ready before your customers start waiting.`);
    if (f.baskets) out.push(f.baskets > 1
      ? `${cap(word(f.baskets))} baskets let you run separate orders side by side instead of waiting for one to finish.`
      : 'One basket keeps things simple, so you can focus on one batch at a time.');
    if (f.tempRange) out.push(`The thermostat lets you set the oil anywhere within ${f.tempRange}°C, so delicate items and crispy chips each fry at the temperature they need.`);
    if (f.drainTap) out.push('A drain valve lets you empty the oil safely at the end of the day without lifting a heavy pot.');
  } else if (cat === 'induction' || cat === 'wok') {
    const zoneKw = f.zoneKw || f.kwEach || (f.zones > 1 && f.kw ? f.kw / f.zones : null);
    if (f.zones > 1) {
      out.push(`It gives you ${word(f.zones)} independent induction zones${zoneKw ? `, each delivering ${fmt(zoneKw)}kW` : ''}, so you can adjust the heat on one pan without affecting the others.`);
    } else if (f.watts || f.kw) {
      const p = f.watts ? `${f.watts}W` : `${fmt(f.kw)}kW`;
      out.push(cat === 'wok'
        ? `With ${p} of power, it gives wok cooking the fast, responsive heat it actually needs, so food sears instead of stewing.`
        : `With up to ${p} of power, it heats the pan in seconds, and because induction puts the energy straight into the cookware, very little is wasted.`);
    }
    out.push(pick([
      'Because it’s induction, there’s no open flame, the heat responds the moment you change the setting, and more of the energy goes into your pan rather than your kitchen.',
      'Induction heat responds instantly when you adjust it, so your team gets exact control the moment it’s needed, without waiting for an element to catch up.',
    ], seed, 3));
  } else if (cat === 'hotcupboard') {
    if (f.shelves || f.doors) out.push(`It has ${f.shelves ? `${word(f.shelves)} spacious shelf${f.shelves > 1 ? 'ves' : ''}` : 'a spacious holding area'}${f.doors ? ` behind ${word(f.doors)} door${f.doors > 1 ? 's' : ''}` : ''}, keeping finished dishes warm and moist until the rest of the order is ready.`);
    if (f.kw) out.push(`Its ${fmt(f.kw)}kW heating element keeps food at serving temperature without drying it out or cooking it further.`);
    if (f.tempRange) out.push(`You can set the temperature within ${f.tempRange}°C to suit what you’re holding.`);
  } else {
    if (f.litres) out.push(`With a capacity of ${fmt(f.litres)} litres, it handles the volume a busy service demands.`);
    if (f.zones > 1 && cat === 'range') out.push(`${cap(word(f.zones))} cooking positions let your team keep several dishes on the go at once.`);
    if (f.doors) out.push(`${cap(word(f.doors))} door${f.doors > 1 ? 's' : ''}${f.drawers ? ` and ${word(f.drawers)} drawer${f.drawers > 1 ? 's' : ''}` : ''} keep everything organised and easy to reach.`);
    else if (f.drawers) out.push(`${cap(word(f.drawers))} drawer${f.drawers > 1 ? 's' : ''} keep everything organised and close to hand.`);
    if (f.kw) out.push(`With ${fmt(f.kw)}kW of ${powerWord} power, it keeps up with the pace of service without slowing down.`);
    if (f.tempRange) out.push(`The ${f.tempRange}°C temperature range lets you set exactly the conditions you need.`);
    if (f.drainTap) out.push('A drain tap makes emptying and cleaning quick at the end of the day.');
  }

  // footprint
  if (f.width) {
    const where = f.model === 'tabletop' ? 'sits neatly on your workbench without needing any floor space'
      : f.model === 'drop-in' ? 'drops into your existing worktop without changing your kitchen layout'
      : f.width >= 1000 ? 'gives you serious capacity in a footprint that still works in a busy kitchen'
      : 'fits into a tight kitchen line without wasting valuable space';
    out.push(`At ${f.width <= 450 ? 'just ' : ''}${fmt(f.width)}mm wide${f.depth ? ` and ${fmt(f.depth)}mm deep` : ''}, it ${where}.`);
  } else if (f.model === 'tabletop') out.push('It sits on your workbench, so you never have to give up floor space to get it.');
  // weight (only worth saying when it’s light)
  if (f.weight && f.weight <= 35) out.push(`It weighs only around ${fmt(Math.round(f.weight))}kg, so anyone on your team can move or reposition it easily.`);
  // build
  if (f.stainless) out.push(pick([
    `Its ${f.aisi ? f.aisi + ' ' : ''}stainless-steel body stands up to the knocks and spills of daily commercial service, and the smooth surface wipes down quickly at the end of a shift.`,
    `The ${f.aisi ? f.aisi + ' ' : ''}stainless-steel construction is built to take the daily punishment of a busy kitchen, and it’s quick for your team to clean when the rush is over.`,
  ], seed, 5));
  return out;
}

function supplySentence(f, seed) {
  if (f.fuel === 'propane') return 'It runs on bottled propane, so you can set it up wherever you need it without a mains gas line.';
  if (f.fuel === 'gas') return 'It runs on gas, which takes the pressure off your electrical supply so the rest of your kitchen equipment keeps running smoothly.';
  if (f.volt) {
    const v = String(f.volt).split(/[\/-]/)[0];
    return v === '230'
      ? pick(['It runs on a standard 230V supply, so you can plug it in and get to work without any special wiring.',
              'All you need is a standard 230V supply. Plug it in and it’s ready to go.'], seed, 9)
      : `Connect it to a ${v}V supply and it’s ready to work the day it arrives.`;
  }
  return null;
}

// ---------- 1. saved copywriter description ----------
function savedDescription(sku) {
  const text = SAVED.get(String(sku || '').trim());
  return text ? toHtml(text) : null;
}

// ---------- 2. template ----------
function templateDescription({ sku, title, raw = {} }) {
  const name = /^combisteel\b/i.test(title) ? title : `Combisteel ${title}`;
  const cat = categoryFor(title);
  const bank = BANKS[cat] || BANKS.generic;
  const f = facts(title, raw);
  const seed = sku || title;

  const parts = [
    pick(bank.hooks(f), seed),
    `The ${name} was ${pick(['designed', 'built'], seed, 1)} to ${bank.answer(f)}.`,
    ...factSentences(cat, f, seed),
    supplySentence(f, seed),
    bank.close(f),
  ].filter(Boolean);
  return toHtml(parts.join(' '));
}

// ---------- 3. AI (Claude API) ----------
function chooseExamples(cat, sku, count = 4) {
  const others = EXAMPLES.filter(e => String(e.sku) !== String(sku));
  const same = others.filter(e => e.category === cat);
  const rest = others.filter(e => e.category !== cat);
  const rot = (arr, n) => { const s = hash(sku || '') % (arr.length || 1); return [...arr.slice(s), ...arr.slice(0, s)].slice(0, n); };
  const picked = [...rot(same, Math.min(3, count)), ...rot(rest, count)].slice(0, count);
  return picked;
}

const STYLE_GUIDE = `How Koolmax’s copywriter writes product descriptions:
- One flowing paragraph of 170 to 250 words. UK English. No headings, bullet points, emojis or exclamation marks.
- Written to the buyer: "you", "your team", "your kitchen", "your customers".
- Opens with 2 or 3 sentences about a real problem the kitchen faces that this product solves (orders piling up, no floor space, flavours mixing, food going cold at the pass, oil slow to recover). A rhetorical question is welcome.
- Then names the product in full, "The Combisteel <name>", and says it was designed or built to solve that problem.
- Then goes through 4 to 7 concrete facts from the product data. Every fact is followed straight away by why it matters in a working kitchen.
- Typical facts: capacity, power, number of tanks / zones / baskets / doors, independent controls, width and depth, weight when it’s light, stainless-steel build and easy cleaning, power supply.
- Ends with the power supply or "ready to use" line and/or one sentence saying who this product is for.
- Confident and practical, never salesy. No price, no store name, no delivery, warranty or certification claims.`;

function allowedNumbers(...texts) {
  const set = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = parseFloat(m[0].replace(',', '.'));
    set.add(n); set.add(n * 1000); set.add(n / 1000);     // kW <-> W
  }
  return set;
}

async function callClaude(model, system, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 900, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Claude API error ${res.status}`);
    err.status = res.status; err.type = json?.error?.type;
    throw err;
  }
  return (json.content || []).map(c => c.text || '').join('').trim();
}

async function aiDescription({ sku, title, specification = [], features = [], longDescription = '' }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY isn’t set in Railway');
  const name = /^combisteel\b/i.test(title) ? title : `Combisteel ${title}`;
  const cat = categoryFor(title);
  const examples = chooseExamples(cat, sku);
  const specText = specification.map(([l, v]) => `- ${l}: ${v}`).join('\n') || '- (no specs)';
  const featText = features.map(([l, v]) => `- ${v === 'Yes' ? l : `${l}: ${v}`}`).join('\n') || '- (none)';
  const original = String(longDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500);

  const system = 'You are the senior copywriter for Koolmax, a UK supplier of commercial catering equipment. You write Shopify product descriptions that sell by showing chefs and kitchen owners how a product solves a real problem in their kitchen.';
  const prompt = `${STYLE_GUIDE}

Here are descriptions the copywriter wrote. Match this voice, structure and length. Do not reuse their opening lines or phrases word for word.

${examples.map(e => `<example>\n${e.text}\n</example>`).join('\n\n')}

Now write the description for this product.

<product>
Name: ${name}
Type: ${cat === 'generic' ? 'commercial catering equipment' : cat}
Specifications:
${specText}
Features:
${featText}
Manufacturer description (use only for facts, don’t copy its wording):
${original || '(none)'}
</product>

Accuracy rules, these matter more than style:
- Use ONLY facts from the product data above. Never invent a number, size, feature, accessory or capability.
- If a figure isn’t in the data, leave it out. Do not work out totals unless the data clearly gives a per-unit figure and a count.
- Keep units as the copywriter does: 15-litre, 3.5kW, 3500W, 400mm, 23kg, 230V.

Reply with the description paragraph only.`;

  const primary = process.env.ANTHROPIC_DESC_MODEL || 'claude-sonnet-5-5';
  const fallback = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  let text, model = primary;
  try { text = await callClaude(primary, system, prompt); }
  catch (e) {
    if (primary === fallback || !(e.status === 404 || e.type === 'not_found_error' || /model/i.test(e.message))) throw e;
    model = fallback;
    text = await callClaude(fallback, system, prompt);
  }
  text = text.replace(/^["'“]|["'”]$/g, '').replace(/^#+.*\n/, '').replace(/\*\*/g, '').trim();

  // Flag any figure the AI used that isn’t in the product data
  const ok = allowedNumbers(name, specText, featText, original);
  const unknown = [...new Set([...text.matchAll(/\d+(?:[.,]\d+)?/g)].map(m => m[0])
    .filter(n => !ok.has(parseFloat(n.replace(',', '.')))))];
  const warnings = unknown.length ? [`Check these figures, they are not in the Combisteel data: ${unknown.join(', ')}`] : [];
  return { html: toHtml(text), words: text.split(/\s+/).length, model, warnings };
}

module.exports = { savedDescription, templateDescription, aiDescription, categoryFor, facts, EXAMPLES };
