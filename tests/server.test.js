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
  const feats = /static features = \{([^}]*)\}/.exec(src)[1].split(',').map(x => x.split(':')[0].trim()).filter(Boolean);
  assert.deepEqual([...v.FEATURES].sort(), feats.sort(), 'paid feature names match the component');
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
  assert.equal(v.validateOfrenda(three, { entitlements: { extraPhotos: true } }).ok, true);
  assert.equal(v.validateOfrenda(three, { entitlements: { extraPhotos: 'yes' } }).ok, false, 'only boolean true counts');
  assert.equal(v.validateOfrenda(three, { entitlements: { sevenTiers: true } }).ok, false, 'tiers upgrade does not unlock photos');
  assert.equal(v.validateOfrenda(three).feature, 'extraPhotos');
});

test('lapsed altar keeps what it has but cannot grow', async () => {
  const { v } = await load();
  const four = altar(...'abcd'.split('').map(i => frame(i, png())));
  assert.equal(v.validateOfrenda(four, { previous: four }).ok, true);
  assert.equal(v.validateOfrenda(altar(...'abcde'.split('').map(i => frame(i, png()))), { previous: four }).ok, false);
});

test('seven tiers: needs the upgrade, but a saved 7-tier altar keeps it', async () => {
  const { v } = await load();
  const seven = { ...altar(), tiers: 7 };
  const r = v.validateOfrenda(seven);
  assert.deepEqual([r.ok, r.status, r.code, r.feature], [false, 402, 'tiers_locked', 'sevenTiers']);
  assert.equal(v.validateOfrenda({ ...altar(), tiers: 3 }).ok, true);
  assert.equal(v.validateOfrenda(seven, { entitlements: { sevenTiers: true } }).state.tiers, 7);
  assert.equal(v.validateOfrenda(seven, { entitlements: { extraPhotos: true } }).ok, false, 'photos upgrade does not unlock tiers');
  assert.equal(v.validateOfrenda(seven, { entitlements: { sevenTiers: 1 } }).ok, false, 'only boolean true counts');
  assert.equal(v.validateOfrenda(seven, { previous: seven }).state.tiers, 7, 'lapsed altar keeps what it has');
  assert.equal(v.validateOfrenda({ ...altar(), tiers: '7' }).state.tiers, 3, 'junk values fall back to 3');
  assert.equal(v.validateOfrenda({ ...altar(), tiers: 3 }, { previous: seven }).state.tiers, 3, 'can always go back to 3');
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
