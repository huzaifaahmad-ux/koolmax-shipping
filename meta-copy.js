// meta-copy.js
// Meta descriptions in the Koolmax copywriter style:
//   one sentence, ~140-158 chars, UK English, opens with the full product name,
//   one or two hard facts, ends on a kitchen benefit tied to those facts.
//   No price, no store name, no "buy now".
//
// 1. templateMetaDescription(): free, instant, deterministic (default)
// 2. aiMetaDescription():       optional, uses the Claude API with the copywriter examples
//                               (needs ANTHROPIC_API_KEY in Railway)

const MIN_LEN = 120;
const MAX_LEN = 158;

const STYLE_EXAMPLES = [
  'The Combisteel Pasta Cooker 23L is a tabletop electric unit with two baskets and a drain valve, built for seamless and efficient pasta service.',
  'The Combisteel Base 900 Gas Pasta Cooker Twin Tank handles two 24L tanks and ten baskets, keeping high-volume kitchens fast, organised and ready for service.',
  'The Combisteel Base 900 Electric Pasta Cooker holds 24 litres and five baskets, giving busy kitchens steady pasta output without needing a gas connection.',
  'The Combisteel Base 900 Gas Pasta Cooker delivers 24 litres and five baskets of capacity, keeping pasta service fast and steady through a busy service.',
  'The Combisteel Base 900 Gas Boiling Pan 250L Indirect Heat uses gas power, keeping large batches cooking evenly without scorching or sticking below.',
  'The Combisteel Base 900 Gas Boiling Pan 150L Indirect Heat cooks soups and sauces evenly which helps prevent scorching or sticking in every session.',
  'Combisteel Induction Cooking Top 2000W gives tight kitchens precise, adjustable heat for quick tasks without using up any valuable counter space.',
  'Combisteel Induction Cooking Top 3500W heats faster than smaller hobs, letting you cook and boil quickly in a genuinely compact, powerful footprint.',
  'Combisteel Induction Wok Cooking Top delivers the fast, responsive heat wok dishes need, so food cooks properly instead of steaming in a slow pan.',
];

// ---------- helpers ----------
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = n => (Number.isInteger(n) && n >= 0 && n <= 12 ? WORDS[n] : String(n));
const num = v => {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const fmt = n => (Number.isInteger(n) ? String(n) : String(n).replace(/\.0+$/, ''));
const plural = (n, s, p = s + 's') => `${word(n)} ${n === 1 ? s : p}`;

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const pick = (arr, seed, salt = 0) => arr[(hash(seed) + salt) % arr.length];

function joinFacts(list) {
  if (list.length <= 1) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// ---------- facts from Combisteel specs ----------
function extractFacts(title, raw = {}) {
  const t = title.toLowerCase();
  const fuelRaw = (raw['6073'] || '').toLowerCase();
  const fuel = /induct/.test(t) || fuelRaw === 'inductie' ? 'induction'
    : /\bgas\b/.test(t) || fuelRaw === 'gas' ? 'gas'
    : /electr|\bel\b/.test(t) || fuelRaw === 'elektrisch' ? 'electric'
    : null;
  const modelRaw = raw['6074'] || '';
  const model = modelRaw === 'Tafelmodel' ? 'tabletop'
    : modelRaw === 'Staand model' ? 'freestanding'
    : modelRaw === 'Inbouw model' ? 'built-in' : null;

  const titleLitres = num((title.match(/(\d+(?:[.,]\d+)?)\s*(l|ltr|litre|liter)s?\b/i) || [])[1]);
  const litres = titleLitres
    ?? num(raw['6312']) ?? num(raw['6349']) ?? num(raw['6426']) ?? num(raw['6432']) ?? num(raw['6315']) ?? num(raw['6390']);
  const titleWatts = num((title.match(/(\d{3,5})\s*w\b/i) || [])[1]);
  const kw = num(raw['6069']) ?? num(raw['6072']);

  return {
    fuel, model, litres,
    watts: titleWatts,
    kw,
    baskets: num(raw['6231']),
    tanks: num(raw['6510']) || (/twin|double|2\s*tank/.test(t) ? 2 : null),
    burners: num(raw['6216']),
    doors: num(raw['6580']),
    drawers: num(raw['6583']),
    shelves: num(raw['6258']),
    gn: raw['6318'] || null,
    drainTap: raw['6714'] === 'Ja',
    indirect: raw['6723'] === 'Indirect' || /indirect/.test(t),
    temp: raw['6180'] || raw['6543'] || null,
    pizzas: num(raw['6245']),
    basketsPerHour: num(raw['6228']),
  };
}

// ---------- categories: fact phrases + benefit endings ----------
const CATEGORIES = [
  {
    id: 'pasta', match: /pasta/,
    facts: f => [
      f.tanks === 2 && f.litres ? `two ${fmt(f.litres)}L tanks` : f.litres ? `${fmt(f.litres)} litres` : null,
      f.baskets ? plural(f.baskets, 'basket') : null,
      f.drainTap ? 'a drain valve' : null,
    ],
    benefits: f => [
      'keeping pasta service fast and steady through a busy service',
      'keeping high-volume kitchens fast, organised and ready for service',
      'built for seamless and efficient pasta service',
      f.fuel === 'electric' ? 'giving busy kitchens steady pasta output without needing a gas connection' : 'giving busy kitchens steady pasta output all day',
    ],
  },
  {
    id: 'boiling', match: /boiling pan|kettle|bratt/,
    facts: f => [f.litres ? `${fmt(f.litres)} litres of capacity` : null, f.indirect ? 'indirect heating' : null],
    benefits: f => [
      f.indirect ? 'keeping large batches cooking evenly without scorching or sticking below' : 'keeping large batches of soups and sauces cooking evenly',
      'cooking soups and sauces evenly, which helps prevent scorching or sticking in every session',
      'so large-batch stocks, soups and sauces are ready on time',
    ],
  },
  {
    id: 'wok', match: /wok/,
    facts: f => [f.watts ? `${f.watts}W of power` : f.kw ? `${fmt(f.kw)}kW of power` : null],
    benefits: () => [
      'delivering the fast, responsive heat wok dishes need, so food cooks properly instead of steaming in a slow pan',
      'giving wok dishes the fierce, even heat they need for proper stir-frying',
    ],
  },
  {
    id: 'induction', match: /induct/,
    facts: f => [f.watts ? `${f.watts}W of power` : f.kw ? `${fmt(f.kw)}kW of power` : null],
    benefits: () => [
      'giving tight kitchens precise, adjustable heat for quick tasks without using up any valuable counter space',
      'heating faster than smaller hobs, letting you cook and boil quickly in a compact, powerful footprint',
      'delivering precise, instant heat control in a compact footprint',
    ],
  },
  {
    id: 'bainmarie', match: /bain.?marie/,
    facts: f => [f.gn ? `${f.gn} capacity` : null, f.drainTap ? 'a drain tap' : null],
    benefits: () => [
      'keeping sauces and sides at serving temperature without drying out',
      'holding food hot and ready through a busy service',
      'so prepared food stays hot, moist and ready to plate',
    ],
  },
  {
    id: 'fryer', match: /fryer|friteuse/,
    facts: f => [f.tanks === 2 ? 'twin tanks' : null, f.litres ? `${fmt(f.litres)} litres of oil` : null, f.baskets ? plural(f.baskets, 'basket') : null],
    benefits: () => [
      'keeping chips and fried food crisp and consistent through a busy service',
      'giving busy kitchens fast recovery and consistent frying results',
    ],
  },
  {
    id: 'griddle', match: /griddle|fry.?top|plancha|grill/,
    facts: f => [f.kw ? `${fmt(f.kw)}kW of power` : null],
    benefits: () => [
      'giving even heat across the plate for burgers, steaks and breakfasts',
      'so busy kitchens can sear and cook to order at speed',
    ],
  },
  {
    id: 'oven', match: /oven|combi|convection/,
    facts: f => [f.gn ? `${f.gn} capacity` : null, f.kw ? `${fmt(f.kw)}kW of power` : null],
    benefits: () => [
      'delivering consistent results batch after batch in a busy kitchen',
      'so roasting and baking come out even every time',
    ],
  },
  {
    id: 'range', match: /cooker|range|hob|stove|burner/,
    facts: f => [f.burners ? plural(f.burners, 'burner') : null, f.kw ? `${fmt(f.kw)}kW of power` : null],
    benefits: () => [
      'giving busy kitchens dependable heat for every pan on the line',
      'keeping several dishes on the go at once through a busy service',
    ],
  },
  {
    id: 'warewash', match: /dish.?wash|glass.?wash|pass.?through|hood/,
    facts: f => [f.basketsPerHour ? `up to ${f.basketsPerHour} baskets an hour` : null],
    benefits: () => [
      'keeping clean crockery and glassware moving through a busy service',
      'so hygienic, spotless results never hold up the pass',
    ],
  },
  {
    id: 'hotcupboard', match: /heated|warming|hot cupboard|plate warmer/,
    facts: f => [f.doors ? plural(f.doors, 'door') : null, f.temp ? `${f.temp}°C range` : null],
    benefits: () => [
      'keeping plates and dishes warm and ready for service',
      'so food and crockery stay at temperature right up to the pass',
    ],
  },
  {
    id: 'refrigeration', match: /fridge|freezer|refrigerat|chiller|counter|cabinet|display|cool/,
    facts: f => [
      f.litres ? `${fmt(f.litres)} litres of storage` : null,
      f.doors ? plural(f.doors, 'door') : null,
      f.drawers ? plural(f.drawers, 'drawer') : null,
    ],
    benefits: () => [
      'keeping ingredients chilled, organised and close to hand during service',
      'giving busy kitchens reliable cold storage that keeps stock fresh',
    ],
  },
  {
    id: 'generic', match: /./,
    facts: f => [f.kw ? `${fmt(f.kw)}kW of power` : null, f.litres ? `${fmt(f.litres)} litres of capacity` : null],
    benefits: () => [
      'built to keep up with the demands of a busy commercial kitchen',
      'giving professional kitchens dependable performance every service',
    ],
  },
];

function categoryFor(title) {
  const t = title.toLowerCase();
  return CATEGORIES.find(c => c.match.test(t));
}

// Fuel / model word, only when the title doesn't already say it
function descriptor(title, f) {
  const t = title.toLowerCase();
  const bits = [];
  if (f.model && !t.includes(f.model.replace('-', ' ')) && !t.includes(f.model)) bits.push(f.model);
  if (f.fuel && !t.includes(f.fuel) && !(f.fuel === 'electric' && /\bel\b|electr/.test(t))) bits.push(f.fuel);
  return bits.join(' ');
}

// ---------- template generator ----------
function templateMetaDescription(title, raw, seed) {
  const name = /^combisteel\b/i.test(title) ? title : `Combisteel ${title}`;
  const f = extractFacts(title, raw);
  const cat = categoryFor(title);
  // Skip facts the product name already states (e.g. "23L" or "3500W" in the title)
  const titleNums = (title.match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.'));
  const facts = cat.facts(f).filter(Boolean).filter(x => {
    if (/tanks?$/.test(x)) return true;
    if (/^indirect/.test(x) && /indirect/i.test(title)) return false;
    const n = (x.match(/\d+(?:\.\d+)?/) || [])[0];
    return !n || !titleNums.includes(n);
  });
  const benefits = cat.benefits(f).filter(Boolean);
  const desc = descriptor(title, f);
  const opener = pick(['The ', '', 'The '], seed, 7) + name;

  // Turn "keeping ..." into a main verb: "keeps ..."
  const asVerb = b => b
    .replace(/^keeping\b/, 'keeps').replace(/^giving\b/, 'gives').replace(/^delivering\b/, 'delivers')
    .replace(/^heating\b/, 'heats').replace(/^cooking\b/, 'cooks').replace(/^holding\b/, 'holds')
    .replace(/^built for\b/, 'is built for').replace(/^so\b/, 'is built');

  const verbs = ['holds', 'delivers', 'handles', 'offers'];
  const factSets = [facts.slice(0, 3), facts.slice(0, 2), facts.slice(0, 1), []];
  const tidy = x => x.replace(/\s+/g, ' ').replace(/\ba ([aeiou])/gi, 'an $1');

  for (const fs of factSets) {
    const options = [];
    benefits.forEach((benefit, i) => {
      const first = fs[0] || '';
      const vlist = /door|drawer|burner|drain|tap/.test(first) ? ['has', 'comes with']
        : /indirect/.test(first) ? ['uses']
        : /power/.test(first) ? ['delivers', 'puts out']
        : verbs;
      const verb = pick(vlist, seed, i);
      if (fs.length && desc) options.push(`${opener} is a ${desc} unit with ${joinFacts(fs)}, ${benefit}.`);
      if (fs.length) options.push(`${opener} ${verb} ${joinFacts(fs)}, ${benefit}.`);
      if (!fs.length && desc && !/^so\b/.test(benefit)) options.push(`${opener} is a ${desc} unit that ${asVerb(benefit).replace(/^is built for/, 'is built for')}.`);
      if (!fs.length && !/^so\b/.test(benefit)) options.push(`${opener} ${asVerb(benefit)}.`);
    });
    const fitting = options.map(tidy).filter(x => x.length >= MIN_LEN && x.length <= MAX_LEN);
    if (fitting.length) return fitting[hash(seed) % fitting.length];
  }

  // Nothing landed in the 120-158 window: longest sentence that still fits, else trim at a word
  const all = [];
  for (const b of benefits) all.push(tidy(`${opener} ${asVerb(b)}.`));
  const under = all.filter(x => x.length <= MAX_LEN).sort((a, b) => b.length - a.length);
  if (under.length) return under[0];
  return all[0].slice(0, MAX_LEN).replace(/\s+\S*$/, '').replace(/[,\s]+$/, '') + '.';
}

// ---------- optional AI generator (Claude API) ----------
async function aiMetaDescription(title, raw, specification = []) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in Railway');
  const name = /^combisteel\b/i.test(title) ? title : `Combisteel ${title}`;
  const specText = specification.map(([l, v]) => `${l}: ${v}`).join('\n') || 'No specs available';

  const prompt = `You write meta descriptions for a UK commercial catering equipment store.

Match the style of these examples exactly:
${STYLE_EXAMPLES.map(e => `- ${e}`).join('\n')}

Rules:
- One sentence, between 130 and 158 characters, UK English.
- Start with "The ${name}" or "${name}".
- Mention one or two concrete facts from the specs (capacity, baskets, power, fuel, size). Write small counts as words ("two baskets").
- End with a practical kitchen benefit that follows from those facts.
- No price, no store name, no "buy", no exclamation marks, no quotes.

Product: ${name}
Specs:
${specText}

Reply with the meta description only.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Claude API error ${res.status}`);
  let text = (json.content || []).map(c => c.text || '').join('').trim().replace(/^["']|["']$/g, '');
  if (text.length > MAX_LEN + 5) text = text.slice(0, MAX_LEN).replace(/\s+\S*$/, '').replace(/[,\s]+$/, '') + '.';
  return text;
}

module.exports = { templateMetaDescription, aiMetaDescription, extractFacts, STYLE_EXAMPLES, MAX_LEN };
