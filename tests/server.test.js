// Server-side checks. No browser needed: these import the ES modules in server/ directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { solidPng } = require('./helpers');

const load = async () => ({ v: await import('../server/validate.mjs'), w: await import('../server/worker.mjs') });
const png = () => 'data:image/png;base64,' + solidPng(2, 2, 200, 10, 10).toString('base64');
const frame = (id, src) => ({ id, type: 'photo', x: 50, y: 24, ...(src ? { src } : {}) });
const altar = (...items) => ({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela', items });

test('server item allowlist matches ofrenda.js', async () => {
  const { v } = await load();
  const src = fs.readFileSync(path.join(__dirname, '..', 'ofrenda.js'), 'utf8');
  const body = src.slice(src.indexOf('const ITEMS = {'), src.indexOf('// Which kind of ofrenda'));
  const types = [...body.matchAll(/^    (\w+):\s+\{/gm)].map(m => m[1]);
  const candles = [...body.matchAll(/^    (\w+):.*candle: true/gm)].map(m => m[1]);
  assert.deepEqual([...v.ITEM_TYPES].sort(), types.sort());
  assert.ok(candles.length >= 2 && candles.every(c => v.ITEM_TYPES.includes(c)));
  const free = Number(/const FREE_PHOTOS = (\d+)/.exec(src)[1]);
  assert.equal(v.FREE_PHOTOS, free);
});

test('free altar: 2 photos ok, 3 rejected with 402', async () => {
  const { v } = await load();
  assert.equal(v.validateOfrenda(altar(frame('a', png()), frame('b', png()))).ok, true);
  const r = v.validateOfrenda(altar(frame('a', png()), frame('b', png()), frame('c', png())));
  assert.deepEqual([r.ok, r.status, r.code], [false, 402, 'photo_limit']);
});

test('empty frames do not count; paid lifts the cap', async () => {
  const { v } = await load();
  assert.equal(v.validateOfrenda(altar(frame('a', png()), frame('b', png()), frame('c'))).ok, true);
  const three = altar(frame('a', png()), frame('b', png()), frame('c', png()));
  assert.equal(v.validateOfrenda(three, { paid: true }).ok, true);
  assert.equal(v.validateOfrenda(three, { paid: 'yes' }).ok, false, 'only boolean true counts as paid');
});

test('lapsed altar keeps what it has but cannot grow', async () => {
  const { v } = await load();
  const four = altar(...'abcd'.split('').map(i => frame(i, png())));
  assert.equal(v.validateOfrenda(four, { previousPhotoCount: 4 }).ok, true);
  assert.equal(v.validateOfrenda(altar(...'abcde'.split('').map(i => frame(i, png()))), { previousPhotoCount: 4 }).ok, false);
});

test('only inline PNG/JPEG/WebP/GIF with matching bytes', async () => {
  const { v } = await load();
  const bad = [
    'https://evil.example/x.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:text/html;base64,PGgxPg==',
    'javascript:alert(1)',
    'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64'), // mislabeled
    'data:image/webp;base64,' + png().split(',')[1],
    'data:image/png;base64,' + 'A'.repeat(500_000), // over the per-image cap
    42,
  ];
  for (const src of bad) {
    const r = v.validateOfrenda(altar(frame('a', src)));
    assert.deepEqual([r.ok, r.code], [false, 'bad_image'], String(src).slice(0, 40));
  }
  const gif = 'data:image/gif;base64,' + Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary').toString('base64');
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
  const webp = 'data:image/webp;base64,' + Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary').toString('base64');
  for (const src of [gif, jpg, webp]) assert.equal(v.validateOfrenda(altar(frame('a', src))).ok, true, src.slice(0, 20));
});

test('cleans output like the browser: unknown items dropped, text clamped, extras stripped', async () => {
  const { v } = await load();
  const r = v.validateOfrenda({
    format: 'digital-ofrenda', kind: 'bogus', tiers: 99, name: 'x'.repeat(500), __proto__x: 1, evil: '<script>',
    items: [
      { id: 'n', type: 'note', text: 'y'.repeat(500), x: 999, y: -5, onclick: 'alert(1)' },
      { id: 'c', type: 'candle', lit: 'yes', rot: 90, scale: 99 },
      { id: 'z', type: 'not-a-thing' }, null, 'str',
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.kind, 'person');
  assert.equal(r.state.tiers, 3);
  assert.equal(r.state.name.length, 80);
  assert.deepEqual(Object.keys(r.state).sort(), ['dates', 'items', 'kind', 'name', 'tiers']);
  assert.equal(r.state.items.length, 2);
  assert.equal(r.state.items[0].text.length, 80);
  assert.deepEqual([r.state.items[0].x, r.state.items[0].y], [100, 0]);
  assert.equal(r.state.items[0].onclick, undefined);
  assert.deepEqual(r.state.items[1], { id: 'c', type: 'candle', x: 50, y: 50, scale: 3, lit: false });
});

test('rejects non-ofrendas and oversized altars', async () => {
  const { v } = await load();
  for (const x of [null, [], 'str', 5, {}, { items: 'no' }, { format: 'other', items: [] }]) assert.equal(v.validateOfrenda(x).code, 'bad_format');
  const many = altar(...Array.from({ length: 201 }, (_, i) => ({ id: 'i' + i, type: 'skull' })));
  assert.equal(v.validateOfrenda(many).status, 413);
  assert.equal(v.validateOfrenda(altar(frame('a', png())), { limits: { maxStateChars: 100 } }).code, 'too_large');
});

// ---- worker ----
const kv = () => {
  const m = new Map();
  return { m, get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v) };
};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'edit-token-1234567890';
const put = (body, token = TOKEN, extra = {}) =>
  new Request('https://api.test/ofrendas/maria', { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const env = () => ({ OFRENDAS: Object.assign(kv(), {}), STRIPE_WEBHOOK_SECRET: 'whsec_test' });
const withOwner = e => (e.OFRENDAS.m.set('owner:maria', sha(TOKEN)), e);

test('worker: auth fails closed', async () => {
  const { w } = await load();
  const noOwner = env();
  assert.equal((await w.default.fetch(put(altar()), noOwner)).status, 403);
  const e = withOwner(env());
  assert.equal((await w.default.fetch(put(altar(), 'wrong-token-1234567890'), e)).status, 403);
  assert.equal((await w.default.fetch(new Request('https://api.test/ofrendas/maria', { method: 'PUT', body: '{}' }), e)).status, 403);
  assert.equal(e.OFRENDAS.m.has('ofrenda:maria'), false);
});

test('worker: save, read back, enforce cap, paid unlocks it', async () => {
  const { w } = await load();
  const e = withOwner(env());
  const two = altar(frame('a', png()), frame('b', png()));
  const three = altar(frame('a', png()), frame('b', png()), frame('c', png()));
  assert.equal((await w.default.fetch(put(two), e)).status, 200);
  const got = await (await w.default.fetch(new Request('https://api.test/ofrendas/maria'), e)).json();
  assert.equal(got.items.length, 2);
  const blocked = await w.default.fetch(put(three), e);
  assert.equal(blocked.status, 402);
  assert.equal((await blocked.json()).upgrade, 'extraPhotos');
  assert.equal(JSON.parse(e.OFRENDAS.m.get('ofrenda:maria')).items.length, 2, 'stored altar unchanged');
  e.OFRENDAS.m.set('paid:maria', '1');
  assert.equal((await w.default.fetch(put(three), e)).status, 200);
  e.OFRENDAS.m.delete('paid:maria'); // refunded: keeps 3, cannot add a 4th
  assert.equal((await w.default.fetch(put(three), e)).status, 200);
  assert.equal((await w.default.fetch(put(altar(...'abcd'.split('').map(i => frame(i, png())))), e)).status, 402);
});

test('worker: body size, bad json, bad ids, and no client-supplied paid flag', async () => {
  const { w } = await load();
  const e = withOwner(env());
  assert.equal((await w.default.fetch(put('{nope'), e)).status, 400);
  assert.equal((await w.default.fetch(put('x'.repeat(w.MAX_BODY_BYTES + 1)), e)).status, 413);
  const three = { ...altar(frame('a', png()), frame('b', png()), frame('c', png())), paid: true };
  assert.equal((await w.default.fetch(new Request('https://api.test/ofrendas/maria?paid=1', put(three)), e)).status, 402);
  assert.equal((await w.default.fetch(new Request('https://api.test/ofrendas/..%2Fx'), e)).status, 404);
  assert.equal((await w.default.fetch(new Request('https://api.test/ofrendas/maria', { method: 'DELETE' }), e)).status, 405);
});

const stripeEvent = (over = {}) => JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: 'maria', ...over } } });
const sign = (body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const hook = (body, sig) => new Request('https://api.test/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sig }, body });

test('worker: Stripe webhook marks paid only for valid, fresh, paid events', async () => {
  const { w } = await load();
  const e = env();
  const body = stripeEvent();
  assert.equal((await w.default.fetch(hook(body, 't=1,v1=00'), e)).status, 400);
  assert.equal((await w.default.fetch(hook(body, sign(body, 'whsec_other')), e)).status, 400);
  assert.equal((await w.default.fetch(hook(body, sign(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600)), e)).status, 400, 'stale timestamp');
  assert.equal((await w.default.fetch(hook(body + ' ', sign(body)), e)).status, 400, 'tampered body');
  assert.equal(e.OFRENDAS.m.has('paid:maria'), false);
  const unpaid = stripeEvent({ payment_status: 'unpaid' });
  assert.equal((await w.default.fetch(hook(unpaid, sign(unpaid)), e)).status, 200);
  const badId = stripeEvent({ client_reference_id: '../x' });
  assert.equal((await w.default.fetch(hook(badId, sign(badId)), e)).status, 200);
  assert.equal([...e.OFRENDAS.m.keys()].length, 0);
  assert.equal((await w.default.fetch(hook(body, sign(body)), e)).status, 200);
  assert.equal(e.OFRENDAS.m.get('paid:maria'), '1');
});
