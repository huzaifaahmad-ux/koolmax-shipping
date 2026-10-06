// image-optimizer.js
// Downloads Combisteel product images, converts them to WebP under a size limit,
// and uploads them to Shopify (staged upload) so products get the optimised files.
//
// Every image becomes an exact square (default 1000 x 1000 px): the product is fitted
// inside without cropping or stretching, and the empty space is filled with white.
//
// File size target: between IMAGE_MIN_KB and IMAGE_MAX_KB (default 80-100 KB).
//
// Settings (Railway variables, optional):
//   IMAGE_MIN_KB  default 80
//   IMAGE_MAX_KB  default 100
//   IMAGE_SIZE    default 1000 (px, width and height)

// sharp is loaded lazily: if it is missing or can't run on this server, the app keeps
// running and products simply get the original Combisteel images.
let sharpLib = null;
let sharpError = null;
function getSharp() {
  if (sharpLib || sharpError) return sharpLib;
  try { sharpLib = require('sharp'); }
  catch (e) {
    sharpError = e;
    console.log('[images] sharp not available, images will not be converted:', e.message.split('\n')[0]);
  }
  return sharpLib;
}
const sharp = (...args) => getSharp()(...args);
const core = require('./specs-sync');

const MIN_BYTES = (parseInt(process.env.IMAGE_MIN_KB, 10) || 80) * 1024;
const MAX_BYTES = (parseInt(process.env.IMAGE_MAX_KB, 10) || 100) * 1024;
const SIZE = parseInt(process.env.IMAGE_SIZE, 10) || 1000;

// 1. Square canvas: the whole product fitted inside 1000 x 1000, padded with white.
// 2. Highest WebP quality that stays under the maximum (binary search), so the file
//    lands as close to the maximum as the photo allows, normally inside 80-100 KB.
// 3. If quality 100 is still under the minimum (simple image on white), try near-lossless
//    and lossless WebP, which keep more detail and are larger; use one if it fits the range.
// 4. If nothing reaches the minimum, keep the best-quality version and report it.
//    The file is never padded with empty bytes just to hit a number.
async function toWebpUnderLimit(input) {
  const square = await sharp(input)
    .rotate()                                             // respect EXIF orientation
    .flatten({ background: '#ffffff' })                   // transparent areas -> white
    .resize(SIZE, SIZE, { fit: 'contain', background: '#ffffff' })   // whole product, no crop
    .toBuffer();
  const base = { width: SIZE, height: SIZE };
  const lossy = q => sharp(square).webp({ quality: q, effort: 5, smartSubsample: true }).toBuffer();
  const inRange = b => b.length >= MIN_BYTES && b.length <= MAX_BYTES;

  let best = null;
  let lo = 20, hi = 100;
  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const buf = await lossy(q);
    if (buf.length <= MAX_BYTES) { best = { buffer: buf, quality: q }; lo = q + 1; }
    else hi = q - 1;
  }
  if (!best) return { ...base, buffer: await lossy(20), quality: 20, ok: false, reason: 'over max' };
  if (best.buffer.length >= MIN_BYTES) return { ...base, ...best, ok: true, reason: null };

  for (const nearLossless of [20, 60, 100]) {
    const buf = await sharp(square).webp({ lossless: true, nearLossless: nearLossless < 100, quality: nearLossless, effort: 4 }).toBuffer();
    if (inRange(buf)) return { ...base, buffer: buf, quality: nearLossless === 100 ? 'lossless' : `near-lossless ${nearLossless}`, ok: true, reason: null };
  }
  return { ...base, ...best, ok: false, reason: 'under min' };
}

// Upload one file to Shopify's staged storage; returns the resourceUrl to use as originalSource.
async function stagedUpload(buffer, filename) {
  const data = await core.shopifyQuery(`
    mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`, { input: [{ filename, mimeType: 'image/webp', httpMethod: 'POST', resource: 'IMAGE', fileSize: String(buffer.length) }] });

  const res = data.stagedUploadsCreate;
  if (res.userErrors.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  const target = res.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buffer], { type: 'image/webp' }), filename);

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Upload failed (${up.status})`);
  return target.resourceUrl;
}

// Turns Combisteel image URLs into Shopify media inputs.
// If a single image fails, that image falls back to the original URL so the product still gets it.
async function prepareMedia(urls, { alt, baseName }) {
  const media = [];
  const report = [];
  if (!getSharp()) {
    for (const url of urls) {
      media.push({ originalSource: url, mediaContentType: 'IMAGE', alt });
      report.push({ file: url.split('/').pop(), error: 'image converter (sharp) not installed on the server' });
    }
    return { media, report };
  }
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const original = Buffer.from(await res.arrayBuffer());
      const webp = await toWebpUnderLimit(original);
      const filename = `${baseName}${urls.length > 1 ? '-' + (i + 1) : ''}.webp`;
      const resourceUrl = await stagedUpload(webp.buffer, filename);
      media.push({ originalSource: resourceUrl, mediaContentType: 'IMAGE', alt });
      report.push({
        file: filename,
        kb: Math.round(webp.buffer.length / 1024),
        originalKb: Math.round(original.length / 1024),
        width: webp.width, height: webp.height, quality: webp.quality, ok: webp.ok, reason: webp.reason,
      });
    } catch (e) {
      media.push({ originalSource: url, mediaContentType: 'IMAGE', alt });
      report.push({ file: url.split('/').pop(), error: e.message });
    }
  }
  return { media, report };
}

module.exports = { prepareMedia, toWebpUnderLimit, MIN_BYTES, MAX_BYTES, SIZE };
