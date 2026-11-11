// An in-memory stand-in for a Cloudflare R2 bucket, with the parts of the interface the Worker uses:
// put, get, head, delete (one key or a list) and list (prefix, cursor, limit). Tests can look at `objects`.
function fakeR2() {
  const objects = new Map(); // key -> { bytes, httpMetadata }
  const meta = (key, o) => ({ key, size: o.bytes.length, httpMetadata: o.httpMetadata, httpEtag: `"${key}"` });
  return {
    objects,
    async put(key, value, opts = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(typeof value === 'string' ? Buffer.from(value) : value);
      objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts.httpMetadata || {} });
      return meta(key, objects.get(key));
    },
    async head(key) { const o = objects.get(key); return o ? meta(key, o) : null; },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { ...meta(key, o), body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) };
    },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map(k => meta(k, objects.get(k))), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
  };
}
module.exports = { fakeR2 };
