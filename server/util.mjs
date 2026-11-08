// Small shared helpers for the Worker. No dependencies; uses only Web APIs.

export const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32))); // 256 bits, 43 characters
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // 32 symbols, so masking 5 bits has no modulo bias
export const newId = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ID_ALPHABET[b & 31]).join('');

// Six digits, drawn without modulo bias.
export function newCode() {
  const limit = 4_294_000_000; // the largest multiple of 1,000,000 below 2^32
  const u = new Uint32Array(1);
  do crypto.getRandomValues(u); while (u[0] >= limit);
  return String(u[0] % 1_000_000).padStart(6, '0');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Read at most `max` bytes, refusing early on Content-Length and again while streaming (the header can lie).
export async function readBody(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

// Small JSON bodies. Returns the object, or a Response to send straight back.
export async function readJson(request, max = 10_000) {
  const raw = await readBody(request, max);
  if (raw === null) return json({ error: 'too_large' }, 413);
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : json({ error: 'bad_json' }, 400);
  } catch { return json({ error: 'bad_json' }, 400); }
}

export function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>(),;:"\\]{1,64}@[^\s@<>(),;:"\\]{1,190}\.[^\s@<>(),;:"\\.]{2,}$/.test(e)) return null;
  return e;
}

export const isResponse = v => v instanceof Response;
export const day = ms => new Date(ms).toISOString().slice(0, 10);
