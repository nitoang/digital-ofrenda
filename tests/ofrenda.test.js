const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, PNG, tmpFile, solidPng } = require('./helpers');

let h;
before(async () => { h = await launch(); });
after(async () => {
  await h.close();
  assert.deepEqual(h.errors, [], 'no page errors or browser dialogs');
});

// Poll instead of sleeping: photo and import handling are async.
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch {}
    if (Date.now() > end) throw new Error('timed out waiting for: ' + fn);
    await new Promise(r => setTimeout(r, 50));
  }
}

const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('ofrenda:t')));

test('renders the default altar with 3 tiers and saves edits', async () => {
  const { el, page, ctx } = await h.altar();
  assert.equal(await el.locator('.tier').count(), 3);
  assert.equal(await el.locator('.item').count(), 8);
  await el.locator('.item.candle').first().click();
  assert.equal((await state(page)).items.find(i => i.type === 'candle').lit, false);
  await ctx.close();
});

test('Person / Pet / Mixed filters the tray and shows the pet note', async () => {
  const { el, ctx } = await h.altar();
  const types = () => el.locator('.tray-items button').evaluateAll(bs => bs.map(b => b.dataset.type));
  assert.ok(!(await types()).includes('bowl'));
  assert.ok((await types()).includes('cigarettes') || (await types()).includes('beer'));
  assert.equal(await el.locator('.petnote').isHidden(), true);
  await el.locator('label:has(input[value="pet"])').click();
  assert.ok((await types()).includes('bowl'));
  assert.ok(!(await types()).includes('beer'));
  assert.equal(await el.locator('.petnote').isHidden(), false);
  await el.locator('label:has(input[value="mixed"])').click();
  assert.ok((await types()).includes('bowl') && (await types()).includes('beer'));
  await ctx.close();
});

test('7 tiers: gated by default, enabled by attribute, kept when gated', async () => {
  // Off: choosing 7 fires upgrade-request and stays at 3.
  let { el, page, ctx } = await h.altar();
  await page.evaluate(() => { window.__up = 0; document.addEventListener('upgrade-request', e => { window.__up++; window.__feat = e.detail.feature; }); });
  assert.match(await el.locator('.t7label').textContent(), /upgrade/);
  await el.locator('label:has(input[value="7"])').click();
  assert.equal(await page.evaluate(() => window.__up), 1);
  assert.equal(await page.evaluate(() => window.__feat), 'sevenTiers');
  assert.equal(await el.locator('.tier').count(), 3);
  assert.equal((await state(page))?.tiers ?? 3, 3);
  await ctx.close();

  // On via attribute: 7 tiers render and persist; turning the flag off hides but keeps them.
  ({ el, page, ctx } = await h.altar({ attrs: 'seven-tiers' }));
  await el.locator('label:has(input[value="7"])').click();
  assert.equal(await el.locator('.tier').count(), 7);
  assert.equal((await state(page)).tiers, 7);
  await el.evaluate(e => e.removeAttribute('seven-tiers'));
  assert.equal(await el.locator('.tier').count(), 3);
  assert.equal((await state(page)).tiers, 7);
  await el.evaluate(e => e.setAttribute('seven-tiers', ''));
  assert.equal(await el.locator('.tier').count(), 7);
  await ctx.close();

  // On via DigitalOfrenda.features.
  ({ el, ctx } = await h.altar({ features: { sevenTiers: true } }));
  assert.doesNotMatch(await el.locator('.t7label').textContent(), /upgrade/);
  await ctx.close();
});

test('Start over needs two clicks', async () => {
  const { el, page, ctx } = await h.altar();
  await el.locator('.item.marigold').first().focus();
  await el.locator('.tray-items button[data-type="skull"]').focus();
  await page.keyboard.press('Enter');
  const before = (await state(page)).items.length;
  assert.ok(before > 8);
  await el.locator('.reset-btn').click();
  assert.equal(await el.locator('.reset-btn').textContent(), 'Click again to clear everything');
  assert.equal((await state(page)).items.length, before);
  await el.locator('.reset-btn').click();
  assert.equal((await state(page)).items.length, 8);
  await ctx.close();
});

test('multiple photos: fill empty frame, then add more, then replace one', async () => {
  const { el, page, ctx } = await h.altar();
  const photos = async () => (await state(page)).items.filter(i => i.type === 'photo');
  const pick = async (click, file, expectSrcs) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), click()]);
    await fc.setFiles(file);
    await until(async () => (await photos()).filter(p => p.src).length === expectSrcs);
  };
  const png = tmpFile('a.png', PNG);
  await pick(() => el.locator('.photo-btn').click(), png, 1);
  assert.equal((await photos()).length, 1);
  assert.ok((await photos())[0].src.startsWith('data:image/jpeg'));
  await pick(() => el.locator('.photo-btn').click(), png, 2);
  assert.equal((await photos()).length, 2, 'second photo adds a new frame');
  const first = (await photos())[0].src;
  // New frames land at a random spot; park it in a corner so it can't sit on top of the first frame.
  await el.evaluate(e => { const f = e._state.items.filter(i => i.type === 'photo')[1]; f.x = 90; f.y = 90; e._render(); });
  // Clicking a frame replaces its photo (a different image, so the data changes) without adding a frame.
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.item.photo').first().click()]);
  await fc.setFiles(tmpFile('b.png', solidPng(4, 4, 255, 0, 0)));
  await until(async () => (await photos())[0].src !== first);
  assert.equal((await photos()).length, 2, 'clicking a frame replaces, not adds');
  await ctx.close();
});

test('migrates an old single-photo save', async () => {
  const src = 'data:image/png;base64,' + PNG.toString('base64');
  const { el, page, ctx } = await h.altar({ state: { kind: 'person', name: 'Abuela', dates: '', photo: src, items: [{ id: 'p1', type: 'photo', x: 50, y: 24 }] } });
  assert.equal(await el.locator('.item.photo img').count(), 1);
  assert.equal(await el.locator('.name').textContent(), 'Abuela');
  await ctx.close();
});

test('export then import round-trips, with a two-click import confirm', async () => {
  const { el, page, ctx } = await h.altar({ attrs: 'seven-tiers' });
  await el.locator('.name').click();
  await page.keyboard.type('Round Trip');
  await el.locator('.name').blur();
  await el.locator('label:has(input[value="7"])').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), el.locator('.export-btn').click()]);
  assert.match(dl.suggestedFilename(), /^round-trip\.ofrenda\.json$/);
  const exported = JSON.parse(require('node:fs').readFileSync(await dl.path(), 'utf8'));
  assert.equal(exported.format, 'digital-ofrenda');
  assert.equal(exported.tiers, 7);

  // Change the altar, then import the export back.
  await el.locator('.reset-btn').click(); await el.locator('.reset-btn').click();
  assert.equal((await state(page)).name, '');
  const file = tmpFile('x.json', JSON.stringify(exported));
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.import-btn').click()]);
  await fc.setFiles(file);
  await until(async () => (await el.locator('.import-btn').textContent()) === 'Click to replace this ofrenda');
  assert.equal((await state(page)).name, '', 'not applied until confirmed');
  await el.locator('.import-btn').click();
  assert.equal((await state(page)).name, 'Round Trip');
  assert.equal(await el.locator('.tier').count(), 7);
  assert.equal(await el.locator('.import-btn').textContent(), 'Import');
  await ctx.close();
});

test('import rejects junk and sanitizes hostile data', async () => {
  const { el, page, ctx } = await h.altar();
  const importFile = async contents => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.import-btn').click()]);
    await fc.setFiles(tmpFile('i.json', contents));
  };
  const status = () => el.locator('.status').textContent();
  await importFile('not json');
  await until(async () => /not valid JSON/.test(await status()));
  await importFile('{"hello":1}');
  await until(async () => /not a digital-ofrenda export/.test(await status()));
  assert.equal(await el.locator('.import-btn').textContent(), 'Import');

  const ok = await el.evaluate(e => e.importState({
    format: 'digital-ofrenda', name: '<img src=x onerror=alert(1)>', tiers: 99,
    items: [
      { type: 'nope', x: 1, y: 1 },
      { type: 'candle', x: 500, y: -50 },
      { type: 'photo', x: 50, y: 50, src: 'https://evil.example/x.png' },
    ],
  }));
  assert.equal(ok, true);
  const s = await state(page);
  assert.equal(s.tiers, 3);
  assert.equal(s.items.length, 2);
  assert.ok(s.items.every(i => i.x >= 0 && i.x <= 100 && i.y >= 0 && i.y <= 100));
  assert.ok(!s.items.some(i => i.src));
  assert.equal(await el.locator('.name img').count(), 0, 'name is text, not HTML');
  await ctx.close();
});

test('every tray button and placed item has a name and a hover tooltip', async () => {
  const { el, ctx } = await h.altar();
  await el.locator('label:has(input[value="mixed"])').click();
  const tray = await el.locator('.tray-items button').evaluateAll(bs => bs.map(b => [b.title, b.textContent.trim()]));
  assert.ok(tray.length >= 30);
  for (const [title, text] of tray) assert.ok(title && text.includes(title), 'tray button: ' + text);
  const placed = await el.locator('.item').evaluateAll(is => is.map(i => [i.title, i.getAttribute('aria-label')]));
  assert.ok(placed.length > 0);
  for (const [title, aria] of placed) assert.ok(title && aria.startsWith(title), 'item: ' + aria);
  await ctx.close();
});

test('keyboard resize and rotate; candles stay upright; notes still edit', async () => {
  const { el, page, ctx } = await h.altar();
  const find = type => state(page).then(s => s.items.find(i => i.type === type));
  await el.locator('.tray-items button[data-type="note"]').focus();
  await page.keyboard.press('Enter');
  const note = el.locator('.item.note').first();
  await note.focus();
  await page.keyboard.press('+'); await page.keyboard.press('+');
  assert.equal((await find('note')).scale, 1.2);
  await page.keyboard.press('Shift+-');
  assert.equal((await find('note')).scale, 1.15);
  await page.keyboard.press(']'); await page.keyboard.press('Shift+]');
  assert.equal((await find('note')).rot, 20);
  assert.match(await note.evaluate(e => e.style.transform), /rotate\(20deg\) scale\(1\.15\)/);
  await page.keyboard.press('['); await page.keyboard.press('[');
  assert.equal((await find('note')).rot, -10);
  for (let i = 0; i < 40; i++) await page.keyboard.press('+');
  assert.equal((await find('note')).scale, 3, 'clamped');
  for (let i = 0; i < 40; i++) await page.keyboard.press('-');
  assert.equal((await find('note')).scale, 0.5, 'clamped');
  // Back to defaults removes the keys.
  for (let i = 0; i < 5; i++) await page.keyboard.press('+');
  await page.keyboard.press('Shift+]'); await page.keyboard.press('Shift+]');
  const n = await find('note');
  assert.ok(n.scale === undefined && n.rot === undefined, JSON.stringify(n));
  // Still editable when transformed.
  await page.keyboard.press(']');
  await page.keyboard.press('F2');
  assert.ok(await note.locator('input, textarea, [contenteditable]').count() > 0);
  await page.keyboard.press('Escape');

  const candle = el.locator('.item.candle').first();
  await candle.focus();
  await page.keyboard.press(']');
  assert.equal((await find('candle')).rot, undefined);
  await page.keyboard.press('+');
  assert.equal((await find('candle')).scale, 1.1, 'candles can resize');
  assert.ok(!/rotate\(\d/.test(await candle.evaluate(e => e.style.transform).then(t => t.replace('rotate(0deg)', ''))));
  await ctx.close();
});

test('imported scale and rotation are clamped; candle rotation is dropped', async () => {
  const { el, page, ctx } = await h.altar();
  await el.evaluate(e => e.importState({
    format: 'digital-ofrenda',
    items: [
      { type: 'marigold', x: 10, y: 10, scale: 9999, rot: 9999 },
      { type: 'skull', x: 20, y: 20, scale: -5, rot: 'x' },
      { type: 'candle', x: 30, y: 30, rot: 45 },
      { type: 'pan', x: 40, y: 40, scale: 1, rot: 0 },
    ],
  }));
  const items = (await state(page)).items;
  assert.deepEqual([items[0].scale, items[0].rot], [3, 180]);
  assert.deepEqual([items[1].scale, items[1].rot], [0.5, undefined]);
  assert.equal(items[2].rot, undefined);
  assert.ok(items[3].scale === undefined && items[3].rot === undefined);
  await ctx.close();
});
