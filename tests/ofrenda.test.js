const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, PNG, tmpFile, solidPng, TOUCH_SKIP } = require('./helpers');

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
  // The click and the wait are separate steps with their own limits, so a failure says which one went wrong: the
  // click could not be made (Playwright's log says why), the picker did not open, or the upgrade prompt fired instead.
  await page.evaluate(() => { window.__up = []; document.addEventListener('upgrade-request', e => window.__up.push(e.detail.feature)); });
  const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
  chooser.catch(() => {}); // reported below, with the reason, rather than as an unhandled rejection
  await el.locator('.item.photo').first().click({ timeout: 10_000 });
  const fc = await chooser.catch(async () => {
    throw new Error('clicking a photo frame did not open the file picker; upgrade-request events: ' + JSON.stringify(await page.evaluate(() => window.__up)));
  });
  await fc.setFiles(tmpFile('b.png', solidPng(4, 4, 255, 0, 0)));
  await until(async () => (await photos())[0].src !== first);
  assert.equal((await photos()).length, 2, 'clicking a frame replaces, not adds');
  await ctx.close();
});

test('photos: 2 free, a third fires upgrade-request, extra-photos lifts the cap', async () => {
  let { el, page, ctx } = await h.altar();
  const photos = async () => (await state(page)).items.filter(i => i.type === 'photo' && i.src);
  await page.evaluate(() => { window.__up = []; document.addEventListener('upgrade-request', e => window.__up.push(e.detail.feature)); });
  const png = tmpFile('a.png', PNG);
  for (let n = 1; n <= 2; n++) {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.photo-btn').click()]);
    await fc.setFiles(png);
    await until(async () => (await photos()).length === n);
  }
  await el.locator('.photo-btn').click();
  assert.deepEqual(await page.evaluate(() => window.__up), ['extraPhotos']);
  assert.equal((await photos()).length, 2);
  // New frames land at a random spot; park the second in a corner so it can't cover the first.
  await el.evaluate(e => { const f = e._state.items.filter(i => i.type === 'photo')[1]; f.x = 90; f.y = 90; e._render(); });
  const first = (await photos())[0].src;
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.item.photo').first().click()]);
  await fc.setFiles(tmpFile('b.png', solidPng(4, 4, 255, 0, 0)));
  await until(async () => (await photos())[0].src !== first);
  assert.equal((await photos()).length, 2, 'replacing stays free and adds no frame');
  // Can't create a third photo frame from the tray either.
  const frames = async () => (await state(page)).items.filter(i => i.type === 'photo').length;
  const before = await frames();
  await el.locator('.tray button[data-type="photo"]').click();
  assert.equal(await frames(), before, 'no new frame');
  assert.deepEqual(await page.evaluate(() => window.__up), ['extraPhotos', 'extraPhotos']);
  await ctx.close();

  ({ el, page, ctx } = await h.altar({ attrs: 'extra-photos' }));
  for (let n = 1; n <= 3; n++) {
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.photo-btn').click()]);
    await fc2.setFiles(png);
    await until(async () => (await state(page)).items.filter(i => i.type === 'photo' && i.src).length === n);
  }
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

test('drag handles resize and rotate; candles get no rotate handle; viewers get none', async () => {
  const { el, page, ctx } = await h.altar();
  const item = el.locator('.item.marigold').first();
  const find = () => state(page).then(s => s.items.find(i => i.type === 'marigold'));
  await item.focus();
  const centre = async () => { const b = await item.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const center = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const [cx, cy] = await centre();

  // Resize: drag the corner handle to twice its distance from the centre.
  const [rx, ry] = await center(item.locator('.handle.resize'));
  const d = Math.hypot(rx - cx, ry - cy);
  await page.mouse.move(rx, ry); await page.mouse.down();
  await page.mouse.move(cx + (rx - cx) * 2, cy + (ry - cy) * 2, { steps: 5 });
  await page.mouse.up();
  const a = await find();
  assert.ok(a.scale > 1.8 && a.scale < 2.2, 'scale ' + a.scale);
  assert.ok(Math.hypot(...(await center(item.locator('.handle.resize'))).map((v, i) => v - [cx, cy][i])) > d * 1.5, 'handle stays reachable');

  // Rotate: drag the top handle a quarter turn to the right of the centre.
  await item.focus();
  const before = (await find()).x;
  const [hx, hy] = await center(item.locator('.handle.rotate'));
  const r = Math.hypot(hx - cx, hy - cy);
  await page.mouse.move(hx, hy); await page.mouse.down();
  await page.mouse.move(cx + r, cy, { steps: 8 });
  await page.mouse.up();
  const b = await find();
  assert.ok(Math.abs(b.rot - 90) <= 2, 'rot ' + b.rot);
  assert.equal(b.x, before, 'handle drag does not move the item');

  // Shift snaps to 15 degrees.
  await item.focus();
  const [hx2, hy2] = await center(item.locator('.handle.rotate'));
  await page.keyboard.down('Shift');
  await page.mouse.move(hx2, hy2); await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 100, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.equal((await find()).rot % 15, 0);

  assert.equal(await el.locator('.item.candle').first().locator('.handle.rotate').count(), 0);
  assert.equal(await el.locator('.item.candle').first().locator('.handle.resize').count(), 1);
  await ctx.close();

  const v = await h.altar();
  assert.ok(await v.el.locator('.handle').count() > 0);
  await v.el.evaluate(e => e.setAttribute('mode', 'view'));
  assert.equal(await v.el.locator('.handle').count(), 0);
  await v.ctx.close();
});

// ---- touch (emulated phone: 390x844, coarse pointer, real touch events via CDP) ----
async function phone() {
  const a = await h.altar({ touch: true });
  await a.page.evaluate(() => { document.body.style.margin = '0'; document.body.insertAdjacentHTML('beforeend', '<div style="height:3000px"></div>'); });
  const cdp = await a.ctx.newCDPSession(a.page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const drag = async (x0, y0, x1, y1, steps = 10) => {
    await send('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) await send('touchMove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
    await send('touchEnd');
    await a.page.waitForTimeout(300);
  };
  const tap = (x, y) => drag(x, y, x, y, 0);
  const centre = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const bring = loc => loc.evaluate(e => e.scrollIntoView({ block: 'start' }));
  return { ...a, drag, tap, centre, bring, scrollY: () => a.page.evaluate(() => scrollY) };
}

test('touch: a swipe over the altar or the tray scrolls the page, in edit and view mode', { skip: TOUCH_SKIP }, async () => {
  const t = await phone();
  for (const mode of ['edit', 'view']) {
    await t.el.evaluate((e, m) => e.setAttribute('mode', m), mode);
    for (const sel of ['.stage', '.tray-items button']) {
      await t.page.evaluate(() => scrollTo(0, 0));
      const target = t.el.locator(sel).first();
      await t.bring(target);
      await t.page.evaluate(() => scrollBy(0, -300));
      const before = await t.scrollY();
      const b = await target.boundingBox();
      if (mode === 'view' && sel !== '.stage') continue; // the tray is hidden in view mode
      await t.drag(b.x + 8, b.y + Math.min(b.height - 8, 120), b.x + 8, b.y - 150);
      assert.ok(await t.scrollY() > before + 50, `${mode} ${sel}: page should scroll (${before} -> ${await t.scrollY()})`);
    }
  }
  await t.ctx.close();
});

test('touch: tap a tray button to add, tap vs wobble on a candle, drag handles', { skip: TOUCH_SKIP }, async () => {
  const t = await phone();
  const count = () => t.el.locator('.item').count();
  const n = await count();
  const btn = t.el.locator('.tray-items button[data-type="skull"]');
  await btn.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await t.tap(...await t.centre(btn));
  assert.equal(await count(), n + 1, 'tap adds');

  const candle = t.el.locator('.item.candle').first();
  await t.bring(t.el.locator('.stage'));
  const [cx, cy] = await t.centre(candle);
  const left = () => candle.evaluate(e => e.style.left);
  const lit = () => candle.evaluate(e => e.classList.contains('lit'));
  const [l0, lit0] = [await left(), await lit()];
  await t.drag(cx, cy, cx + 6, cy + 3, 3); // a finger wobbles a few pixels during a tap
  assert.equal(await lit(), !lit0, 'tap with a small wobble still toggles the candle');
  assert.equal(await left(), l0, 'and does not move it');
  await t.drag(cx, cy, cx + 60, cy, 8);
  assert.notEqual(await left(), l0, 'a real drag still moves it');

  const marigold = t.el.locator('.item.marigold').first();
  await marigold.evaluate(e => e.focus());
  const hb = t.el.locator('.item.marigold .handle.resize').first();
  assert.ok((await hb.boundingBox()).width >= 36, 'touch-sized handle');
  const [hx, hy] = await t.centre(hb);
  await t.drag(hx, hy, hx + 40, hy + 40);
  const item = (await state(t.page)).items.find(i => i.type === 'marigold');
  assert.ok(item.scale > 1, 'resized by touch: ' + item.scale);
  await t.ctx.close();
});

// ---- keyboard ----
test('keyboard: adding focuses the new item; actions are announced; labels carry size and rotation', async () => {
  const { el, page, ctx } = await h.altar();
  const status = () => el.locator('.status').textContent();
  const label = () => el.locator('.item:focus').getAttribute('aria-label');
  await el.locator('.tray-items button[data-type="heart"]').focus();
  await page.keyboard.press('Enter');
  assert.match(await status(), /Heart added/);
  assert.equal(await label(), 'Heart', 'focus moved to the new item');
  assert.ok(await el.locator('.item:focus').getAttribute('aria-describedby'), 'keys are described');
  await page.keyboard.press('+');
  assert.equal(await status(), 'Heart: size 110%.');
  assert.equal(await label(), 'Heart, size 110%');
  await page.keyboard.press(']');
  assert.equal(await status(), 'Heart: rotated 15°.');
  assert.equal(await label(), 'Heart, size 110%, rotated 15°');
  await page.keyboard.press('Delete');
  assert.equal(await status(), 'Heart removed.');
  const candle = el.locator('.item.candle').first();
  await candle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await status(), 'Candle unlit.');
  await ctx.close();
});

// ---- security ----
const hostile = {
  kind: '<img src=x onerror=alert(1)>', tiers: 99, name: 'N'.repeat(500), dates: 5,
  items: [
    { id: '"><script>', type: 'photo', x: 1e9, y: -5, src: 'javascript:alert(1)' },
    { id: 'svg', type: 'photo', x: 50, y: 50, src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { id: 'n', type: 'note', x: 50, y: 50, text: '<img src=x onerror=alert(1)>' + 'x'.repeat(500), scale: 1e9, rot: 'spin' },
    { id: 'evil', type: '__proto__', x: 1, y: 1 },
    'not an object', null,
  ],
};

test('saved data is cleaned when it loads, not only on import', async () => {
  const { el, page, ctx } = await h.altar({ state: hostile });
  const s = await page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('#t').exportState())));
  assert.equal(s.kind, 'person');
  assert.equal(s.tiers, 3);
  assert.equal(s.name.length, 80);
  assert.equal(s.dates, '');
  assert.equal(s.items.length, 3, 'unknown item types and junk entries are dropped');
  assert.ok(s.items.every(i => !i.src || i.src.startsWith('data:image/png') ), 'no javascript: or svg sources');
  assert.ok(s.items.every(i => /^[\w-]+$/.test(i.id)), 'ids are plain');
  const note = s.items.find(i => i.type === 'note');
  assert.equal(note.text.length, 80);
  assert.equal(note.scale, 3);
  assert.equal(note.rot, undefined);
  assert.equal(await el.locator('img').count(), 0);
  await ctx.close();
});

test('data arriving from a shared store is cleaned too', async () => {
  const { browser } = h;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => h.errors.push(e.message));
  await page.goto(require('./helpers').url('tests/blank.html'));
  await page.evaluate(hostile => {
    window.__emit = null;
    customElements.get('digital-ofrenda').storage = {
      canWrite: false,
      subscribe: (id, onState) => { window.__emit = d => onState(d, { fromCache: false, hasPendingWrites: false }); setTimeout(() => window.__emit(hostile), 0); return () => {}; },
      save: async () => {},
    };
    document.body.insertAdjacentHTML('beforeend', '<digital-ofrenda id="s" mode="view"></digital-ofrenda>');
  }, hostile);
  const el = page.locator('digital-ofrenda#s');
  await until(async () => (await el.locator('.item').count()) === 3);
  assert.equal(await el.locator('img').count(), 0, 'no hostile image reached the page');
  assert.equal(await el.locator('.name').textContent(), 'N'.repeat(80));
  // Data that is not an ofrenda at all is ignored, not rendered.
  await page.evaluate(() => window.__emit({ format: 'other', items: 'x' }));
  await page.evaluate(() => window.__emit([1, 2, 3]));
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await el.locator('.item').count(), 3);
  await ctx.close();
});

test('the demo page works under its strict Content-Security-Policy', async () => {
  const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const f = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
  }).listen(0);
  const port = server.address().port;
  const ctx = await h.browser.newContext();
  const page = await ctx.newPage();
  const violations = [];
  page.on('pageerror', e => h.errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.goto(`http://localhost:${port}/`);
  const html = await page.content();
  assert.match(html, /Content-Security-Policy/);
  const edit = page.locator('digital-ofrenda[mode="edit"]');
  await edit.locator('.tray-items button[data-type="heart"]').focus();
  await page.keyboard.press('Enter');
  await until(async () => (await edit.locator('.item[aria-label^="Heart"]').count()) === 1);
  assert.equal(await edit.locator('.banner i').count(), 12, 'banner renders without inline styles');
  assert.ok(await edit.evaluate(e => e.shadowRoot.adoptedStyleSheets.length === 1), 'styles are applied as a constructed stylesheet');
  assert.deepEqual(violations, []);
  await ctx.close();
  server.close();
});
