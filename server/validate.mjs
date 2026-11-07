// Server-side validation for digital-ofrenda saves. No dependencies; runs on Cloudflare Workers,
// Node 18+, Deno and Bun. The browser enforces the free limits for honesty, but anyone can call your
// storage endpoint directly, so THIS is what actually enforces them.
//
//   const r = validateOfrenda(body, { paid, previousPhotoCount });
//   if (!r.ok) -> respond r.status with r.code / r.message
//   else       -> store r.state (already cleaned; never store the raw body)
//
// It applies the same allowlist as `sanitize` in ofrenda.js (tests/server.test.js checks the two agree).

export const FREE_PHOTOS = 2;

export const LIMITS = Object.freeze({
  maxItems: 200,
  maxImageChars: 400_000,   // base64 characters per photo (~300 KB); the component downsizes to 480px
  maxStateChars: 2_000_000, // whole saved altar, as JSON
});

// Keep in step with ITEMS in ofrenda.js (tests/server.test.js fails if they drift apart).
export const ITEM_TYPES = Object.freeze([
  'photo', 'candle', 'marigold', 'skull', 'pan', 'coffee', 'water', 'fruit', 'treat', 'tamal', 'dog', 'music',
  'heart', 'note', 'led', 'petals', 'papel', 'copal', 'salt', 'mole', 'flan', 'jamaica', 'soda', 'liquor', 'beer',
  'cigs', 'guitar', 'domino', 'jersey', 'cleats', 'toy', 'bowl', 'kibble', 'collar', 'xolo',
]);
const CANDLES = new Set(['candle', 'led']); // stay upright; carry a lit flag

const FORMAT = 'digital-ofrenda';
const KINDS = ['person', 'pet', 'mixed'];
const DEFAULT_NOTE = 'Siempre en nuestro corazón';
const IMAGE_RE = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const fail = (status, code, message) => ({ ok: false, status, code, message });

// Check the decoded first 12 bytes really match the claimed image type, so a mislabeled file is refused.
function looksLikeImage(type, b64) {
  let b;
  try { b = atob(b64.slice(0, 16)); } catch { return false; }
  const is = (i, s) => b.startsWith(s, i);
  switch (type) {
    case 'png': return b.charCodeAt(0) === 0x89 && is(1, 'PNG');
    case 'jpeg': return b.charCodeAt(0) === 0xff && b.charCodeAt(1) === 0xd8;
    case 'gif': return is(0, 'GIF8');
    case 'webp': return is(0, 'RIFF') && is(8, 'WEBP');
    default: return false;
  }
}

function cleanImage(v, max) {
  if (typeof v !== 'string' || v.length > max + 40) return null;
  const m = IMAGE_RE.exec(v);
  if (!m || m[2].length > max) return null;
  if (!looksLikeImage(m[1], m[2])) return null;
  return v;
}

/**
 * @param {unknown} input  parsed JSON from the request (untrusted)
 * @param {{ paid?: boolean, previousPhotoCount?: number, limits?: Partial<typeof LIMITS> }} [opts]
 *   paid                True when this altar has bought the extra-photos upgrade (from YOUR payment records,
 *                       never from the request).
 *   previousPhotoCount  Photos in the altar currently stored. Mirrors the browser rule that existing photos
 *                       are never deleted: a lapsed or free altar may keep what it has, but not grow past it
 *                       beyond FREE_PHOTOS.
 * @returns {{ok:true,state:object,photos:number}|{ok:false,status:number,code:string,message:string}}
 */
export function validateOfrenda(input, opts = {}) {
  const limits = { ...LIMITS, ...opts.limits };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'bad_format', 'Not an ofrenda.');
  if (input.format !== undefined && input.format !== FORMAT) return fail(400, 'bad_format', 'Not an ofrenda.');
  if (!Array.isArray(input.items)) return fail(400, 'bad_format', 'Not an ofrenda.');
  if (input.items.length > limits.maxItems) return fail(413, 'too_many_items', `At most ${limits.maxItems} items.`);

  const seen = new Set();
  const items = [];
  let photos = 0;
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object' || !ITEM_TYPES.includes(raw.type)) continue; // unknown items are dropped, as in the browser
    let id = str(raw.id, 32).replace(/[^\w-]/g, '');
    if (!id || seen.has(id)) id = crypto.randomUUID().slice(0, 8);
    seen.add(id);
    const item = { id, type: raw.type, x: num(raw.x, 0, 100, 50), y: num(raw.y, 0, 100, 50) };
    const scale = num(raw.scale, 0.5, 3, 1);
    if (scale !== 1) item.scale = scale;
    const rot = CANDLES.has(raw.type) ? 0 : num(raw.rot, -180, 180, 0);
    if (rot !== 0) item.rot = rot;
    if (CANDLES.has(raw.type)) item.lit = raw.lit === true;
    if (raw.type === 'note') item.text = str(raw.text, 80) || DEFAULT_NOTE;
    if (raw.type === 'photo' && raw.src !== undefined) {
      const src = cleanImage(raw.src, limits.maxImageChars);
      if (!src) return fail(422, 'bad_image', 'Photos must be small PNG, JPEG, WebP or GIF images.');
      item.src = src;
      photos++;
    }
    items.push(item);
  }

  const allowed = opts.paid === true ? Infinity : Math.max(FREE_PHOTOS, Math.floor(opts.previousPhotoCount) || 0);
  if (photos > allowed) {
    return fail(402, 'photo_limit', `Free altars hold ${FREE_PHOTOS} photos. Adding more is an upgrade.`);
  }

  const state = {
    kind: KINDS.includes(input.kind) ? input.kind : 'person',
    tiers: input.tiers === 7 ? 7 : 3,
    name: str(input.name, 80),
    dates: str(input.dates, 80),
    items,
  };
  if (JSON.stringify(state).length > limits.maxStateChars) return fail(413, 'too_large', 'That altar is too large.');
  return { ok: true, state, photos };
}

export const countPhotos = state =>
  Array.isArray(state?.items) ? state.items.filter(i => i && i.type === 'photo' && typeof i.src === 'string').length : 0;
