// stock-fetch.js
// Fetches Combisteel stock for your SKUs, either:
//   - FULL:        every product in the PIM (~3,100), stops early once all target SKUs are found
//   - INCREMENTAL: only products changed since the last sync (o_modificationDate filter)
//
// Safety: Combisteel does not guarantee that a stock change updates o_modificationDate,
// so a FULL sync still runs on server start and once a day (FULL_SYNC_HOUR, UK time).
// Hourly runs in between are INCREMENTAL.

const core = require('./specs-sync');

const PAGE_SIZE = 1000;
const FULL_SYNC_HOUR = parseInt(process.env.FULL_SYNC_HOUR, 10) || 3;   // 03:00 UK time
const OVERLAP_SECONDS = 15 * 60;   // re-read 15 min before the last sync, so nothing slips between runs

let lastSyncUnix = null;           // in memory: a restart means the next run is a full sync
let lastFullSyncDay = null;

function ukParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

// Decides FULL or INCREMENTAL for this run.
function chooseMode(force) {
  if (force === 'full' || force === 'incremental') return force;
  const { day, hour } = ukParts();
  if (lastSyncUnix == null) return 'full';                               // first run after start
  if (hour >= FULL_SYNC_HOUR && lastFullSyncDay !== day) return 'full';   // daily safety net
  return 'incremental';
}

async function fetchPage(offset, filter) {
  const filterArg = filter ? `, filter: ${JSON.stringify(JSON.stringify(filter))}` : '';
  const data = await core.combisteelQuery(`{
    getProductListing(first: ${PAGE_SIZE}, after: ${offset}${filterArg}) {
      totalCount
      edges { node { sku stock } }
    }
  }`);
  return data.getProductListing;
}

/**
 * @param {string[]} targetSkus  Combisteel SKUs you sell (e.g. Object.keys(shopifySkuMap))
 * @param {object}   opts        { force: 'full' | 'incremental' }  optional
 * @returns {Promise<{ mode, stock: Object<string, number>, read: number, total: number, since: number|null }>}
 */
async function fetchCombisteelStock(targetSkus, opts = {}) {
  const startedAt = Math.floor(Date.now() / 1000);
  const mode = chooseMode(opts.force);
  const targets = new Set(targetSkus.map(s => String(s).trim()));
  const since = mode === 'incremental' ? lastSyncUnix - OVERLAP_SECONDS : null;
  const filter = since ? { o_modificationDate: { $gte: String(since) } } : null;

  const stock = {};
  let offset = 0, read = 0, total = 0;
  while (true) {
    const page = await fetchPage(offset, filter);
    total = page.totalCount ?? 0;
    for (const { node } of page.edges || []) {
      read++;
      const sku = (node.sku || '').trim();
      if (targets.has(sku) && node.stock != null) stock[sku] = node.stock;
    }
    offset += PAGE_SIZE;
    const allFound = Object.keys(stock).length === targets.size;
    if (!page.edges?.length || offset >= total || allFound) break;
  }

  lastSyncUnix = startedAt;
  if (mode === 'full') lastFullSyncDay = ukParts().day;
  console.log(`[stock] ${mode} sync: read ${read} of ${total} Combisteel products, ${Object.keys(stock).length} of yours changed/found` +
    (since ? ` (since ${new Date(since * 1000).toISOString()})` : ''));
  return { mode, stock, read, total, since };
}

module.exports = { fetchCombisteelStock };
