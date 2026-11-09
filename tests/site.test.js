// End-to-end: real Chromium, the real pages under their real Content-Security-Policy, the real Worker code, SQLite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startSite } = require('./site');
const { PNG, tmpFile } = require('./helpers');

let browser, site;
const problems = []; // page errors, browser dialogs and Content-Security-Policy violations, from every test
before(async () => { browser = await chromium.launch(); });
after(async () => {
  await browser.close();
  assert.deepEqual(problems, [], 'no page errors, dialogs or CSP violations anywhere');
});

const DAY = 86_400_000;
const altar = (...items) => ({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela', items });

// A fresh browser (own cookies) on a fresh copy of the product.
async function visitor() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1300 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp: ' + m.text()); });
  return { ctx, page };
}

async function signIn(page, email, { from = site.sent.length } = {}) {
  if (!new URL(page.url()).pathname.startsWith('/signin')) await page.goto(site.url + '/signin');
  await page.getByLabel('Your email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Code', { exact: true }).fill(await site.codeFor(email, from));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'));
}

async function until(fn, what = String(fn), ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 40));
  }
}

const withSite = (name, fn) => test(name, async () => {
  site = await startSite();
  try { await fn(); } finally { await site.close(); }
});

// Every field has a name a screen reader can announce.
const assertLabelled = page => page.evaluate(() => {
  const bad = [...document.querySelectorAll('input, select, textarea')].filter(e => !e.labels?.length && !e.getAttribute('aria-label'));
  return bad.map(e => e.outerHTML);
}).then(bad => assert.deepEqual(bad, [], 'every field is labelled'));

const startOfrenda = async page => {
  await page.goto(site.url + '/my');
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  await page.waitForURL(/\/a\/[a-z2-7]{12}$/);
  return new URL(page.url()).pathname.split('/')[2];
};
const serverState = id => { const r = site.db.prepare('SELECT state FROM altars WHERE id = ?').get(id); return r && r.state ? JSON.parse(r.state) : null; };

const withShop = (name, fn, opts = {}) => test(name, async () => {
  site = await startSite({ stripe: true, ...opts });
  try { await fn(); } finally { await site.close(); }
});
// Stripe's own pages are not part of this test: stand in for them.
const fakeStripePages = ctx => ctx.route('https://checkout.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Pretend Stripe</h1>' }));
const tinyPhoto = () => 'data:image/png;base64,' + PNG.toString('base64');

withSite('sign in with a code, land on My ofrendas, and sign out', async () => {
  const { ctx, page } = await visitor();
  await page.goto(site.url + '/');
  await page.getByRole('heading', { name: 'A place to remember' }).waitFor();
  await page.goto(site.url + '/my');
  await page.waitForURL(/\/signin\?next=\/my$/);
  await assertLabelled(page);

  // A wrong code is refused with a kind message; the right one signs in.
  await page.getByLabel('Your email address').fill('Maria@Example.com');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const code = await site.codeFor('maria@example.com');
  await assertLabelled(page);
  await page.getByLabel('Code', { exact: true }).fill(code === '123456' ? '654321' : '123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'did not work' }).waitFor();
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(u => u.pathname === '/my');
  await page.getByRole('heading', { name: 'My ofrendas' }).waitFor();
  await page.getByText('maria@example.com').first().waitFor();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(u => u.pathname === '/');
  await page.goto(site.url + '/my');
  await page.waitForURL(/\/signin/);
  await ctx.close();
});

withSite('the emailed sign-in link needs a button press, and its token leaves the address bar', async () => {
  const { ctx, page } = await visitor();
  await page.goto(site.url + '/signin');
  await page.getByLabel('Your email address').fill('maria@example.com');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const token = await site.linkFrom('maria@example.com', /signin#t=([\w-]{43})/);
  await page.goto(`${site.url}/signin#t=${token}`);
  const go = page.getByRole('button', { name: 'Continue to sign in' });
  await go.waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the token is gone from the address bar');
  assert.equal(site.db.prepare('SELECT used_at u FROM login_challenges').get().u, null, 'merely opening the link used nothing up');
  await go.click();
  await page.waitForURL(u => u.pathname === '/my');
  // The same link a second time is refused politely.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(`${site.url}/signin#t=${token}`);
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'expired or was already used' }).waitFor();
  await ctx.close();
});

withSite('start an ofrenda, edit it, and it is saved; a visitor sees it read-only', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  await el.locator('.tray-items button[data-type="heart"]').focus();
  await page.keyboard.press('Enter');
  await until(() => serverState(id)?.items.some(i => i.type === 'heart'), 'the edit to reach the server');
  await page.reload();
  await page.locator('digital-ofrenda[mode="edit"] .item[aria-label^="Heart"]').waitFor();
  await page.getByRole('link', { name: 'Keepers and sharing' }).waitFor();
  assert.equal(await page.getByLabel('Link to view this ofrenda').inputValue(), `${site.url}/a/${id}`);

  const v = await visitor();
  await v.page.goto(`${site.url}/a/${id}`);
  const view = v.page.locator('digital-ofrenda[mode="view"]');
  await view.locator('.item[aria-label^="Heart"]').waitFor();
  assert.equal(await view.locator('.tray').isVisible(), false, 'no editing tools for a visitor');
  assert.equal(await view.locator('.export-btn').isVisible(), false);
  assert.equal(await v.page.getByRole('link', { name: 'Keepers and sharing' }).count(), 0);
  await v.page.getByText('Do you keep this ofrenda?').waitFor();

  // An ofrenda that was created but never saved has nothing to show a visitor.
  const empty = await page.evaluate(() => fetch('/ofrendas', { method: 'POST' }).then(r => r.json()).then(j => j.id));
  await v.page.goto(`${site.url}/a/${empty}`);
  await v.page.getByRole('heading', { name: 'This ofrenda is not ready yet' }).waitFor();
  await ctx.close(); await v.ctx.close();
});

withSite('free accounts keep 3 ofrendas; the 4th explains Platinum, and Platinum lifts the limit', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  for (let i = 0; i < 3; i++) assert.equal(await page.evaluate(() => fetch('/ofrendas', { method: 'POST' }).then(r => r.status)), 201);
  await page.goto(site.url + '/my');
  assert.equal(await page.getByRole('link', { name: 'Open' }).count(), 3);
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  const dialog = page.getByRole('dialog', { name: 'Platinum' });
  await dialog.waitFor();
  await page.getByRole('alert').filter({ hasText: 'Free accounts can own 3 ofrendas' }).waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'detached' });

  site.db.prepare("UPDATE users SET plan = 'platinum'").run();
  await page.reload();
  await page.getByText('Platinum', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  await page.waitForURL(/\/a\/[a-z2-7]{12}$/);
  await ctx.close();
});

withSite('a third photo opens the upgrade dialog; Platinum switches the options on', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  const photos = () => (serverState(id)?.items || []).filter(i => i.type === 'photo' && i.src).length;
  const png = tmpFile('a.png', PNG);
  const addPhoto = async n => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.photo-btn').click()]);
    await fc.setFiles(png);
    await until(() => photos() === n, `${n} photo(s) on the server`);
  };
  assert.deepEqual(await page.evaluate(() => customElements.get('digital-ofrenda').features), { sevenTiers: false, extraPhotos: false });
  await addPhoto(1); await addPhoto(2);
  await el.locator('.photo-btn').click();
  await page.getByRole('dialog', { name: 'More photos' }).waitFor();
  await page.getByRole('button', { name: 'Close' }).click();
  assert.equal(photos(), 2);

  site.db.prepare("UPDATE users SET plan = 'platinum'").run();
  await page.reload();
  await page.locator('digital-ofrenda[mode="edit"]').waitFor();
  await until(() => page.evaluate(() => customElements.get('digital-ofrenda').features.extraPhotos), 'features from the server');
  assert.deepEqual(await page.evaluate(() => customElements.get('digital-ofrenda').features), { sevenTiers: true, extraPhotos: true });
  await addPhoto(3);
  await ctx.close();
});

withSite('co-keepers: invite by email, accept in the browser, edit together, remove', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await assertLabelled(owner.page);
  await owner.page.getByLabel('Email address', { exact: true }).fill('Sam@Example.com');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await owner.page.getByText('Invitation sent.').waitFor();
  await owner.page.getByText('sam@example.com').waitFor();

  const token = await site.linkFrom('sam@example.com', /\/invite#i=([\w-]{43})/);
  const sam = await visitor();
  await sam.page.goto(`${site.url}/invite#i=${token}`);
  await sam.page.waitForURL(u => u.pathname === '/signin');
  assert.ok(!sam.page.url().includes(token), 'the invitation token never goes into a URL we send to the server');
  await signIn(sam.page, 'sam@example.com');
  await sam.page.waitForURL(u => u.pathname === '/invite');
  await sam.page.getByText('You have been invited to help keep an ofrenda').waitFor();
  await sam.page.getByRole('button', { name: 'Accept the invitation' }).click();
  await sam.page.getByRole('link', { name: 'Open the ofrenda' }).click();
  const samEl = sam.page.locator('digital-ofrenda[mode="edit"]');
  await samEl.locator('.tray-items button[data-type="heart"]').focus();
  await sam.page.keyboard.press('Enter');
  await until(() => serverState(id)?.items.some(i => i.type === 'heart'), 'the co-keeper edit to reach the server');

  // The used link is useless to anyone else.
  const other = await visitor();
  await other.page.goto(`${site.url}/invite#i=${token}`);
  await other.page.waitForURL(u => u.pathname === '/signin');
  await signIn(other.page, 'bystander@example.com');
  await other.page.getByRole('button', { name: 'Accept the invitation' }).click();
  await other.page.getByRole('alert').filter({ hasText: 'expired, was already used, or was sent to a different email' }).waitFor();
  // Already signed in, opening the link: the token still leaves the address bar at once.
  await other.page.goto(`${site.url}/invite#i=${token}`);
  await other.page.getByRole('button', { name: 'Accept the invitation' }).waitFor();
  assert.equal(new URL(other.page.url()).hash, '', 'the invitation token is removed from the address bar');

  // The owner sees Sam, and removes them with two clicks.
  await owner.page.reload();
  await owner.page.getByText('sam@example.com').waitFor();
  const remove = owner.page.getByRole('button', { name: 'Remove sam@example.com' });
  await remove.click();
  assert.equal(await remove.textContent(), 'Click again to remove');
  await remove.click();
  await owner.page.getByText('Removed.').waitFor();
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM altar_members WHERE altar_id = ?').get(id).n, 1);
  await sam.page.goto(`${site.url}/a/${id}`);
  await sam.page.locator('digital-ofrenda[mode="view"]').waitFor();
  for (const c of [owner, sam, other]) await c.ctx.close();
});

withSite('successor: agree, wait out the silence, ask, wait out the notice, take over', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await owner.page.getByLabel('Their email address').fill('heir@example.com');
  await owner.page.getByRole('button', { name: 'Name a successor' }).click();
  await owner.page.getByText('We emailed them to ask').waitFor();
  await owner.page.getByText('has been asked, and has not agreed yet.').waitFor();

  const token = await site.linkFrom('heir@example.com', /\/successor#s=([\w-]{43})/);
  const heir = await visitor();
  await heir.page.goto(`${site.url}/successor#s=${token}`);
  await heir.page.waitForURL(u => u.pathname === '/signin');
  await signIn(heir.page, 'heir@example.com');
  await heir.page.waitForURL(u => u.pathname === '/successor');
  await heir.page.getByRole('button', { name: 'Agree to be the successor' }).click();
  await heir.page.getByRole('heading', { name: 'Thank you' }).waitFor();
  await owner.page.reload();
  await owner.page.getByText('has agreed to be your successor.').waitFor();

  await heir.page.goto(site.url + '/my');
  await heir.page.getByRole('heading', { name: 'Ofrendas you agreed to look after' }).waitFor();
  await heir.page.getByRole('button', { name: 'Ask to take over' }).click();
  await heir.page.getByRole('alert').filter({ hasText: 'You can ask to take over after' }).waitFor();

  site.tick(site.RULES.inactiveAfter + DAY); // the owner has been silent for more than 180 days
  await heir.page.goto(site.url + '/my');
  await heir.page.waitForURL(/\/signin\?next=\/my$/); // their own session ran out meanwhile
  await signIn(heir.page, 'heir@example.com');
  await heir.page.getByRole('button', { name: 'Ask to take over' }).click();
  await heir.page.getByText('Request sent. The owner has been told.').waitFor();
  await heir.page.getByText('Ownership can move to you on').waitFor();
  await site.mail('owner@example.com', /take over your ofrenda/);

  await heir.page.getByRole('button', { name: 'Complete the handover' }).click();
  await heir.page.getByRole('alert').filter({ hasText: 'It is not time yet' }).waitFor();
  site.tick(site.RULES.claimWait);
  await heir.page.getByRole('button', { name: 'Complete the handover' }).click();
  await heir.page.getByText('Done. You are now the owner.').waitFor();
  await heir.page.getByText('Owner', { exact: true }).waitFor();
  assert.equal(site.db.prepare("SELECT u.email FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'owner'").get(id).email, 'heir@example.com');
  for (const c of [owner, heir]) await c.ctx.close();
});

withSite('names that look like markup are shown as plain text, never run', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const hostile = '<img src=x onerror="window.__pwned=1">';
  assert.equal(await page.evaluate(async ([id, name]) => (await fetch('/ofrendas/' + id, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'digital-ofrenda', name, items: [] }),
  })).status, [id, hostile]), 200);
  await page.goto(site.url + '/my');
  await page.getByText(hostile).waitFor();
  assert.equal(await page.locator('main img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await page.goto(`${site.url}/a/${id}/keepers`);
  await page.getByRole('heading', { name: 'Keepers' }).waitFor();
  await ctx.close();
});

withSite('the ?next= address can only ever lead to a page on this site', async () => {
  const { ctx, page } = await visitor();
  await page.goto(site.url + '/signin');
  const results = await page.evaluate(async () => {
    const { safePath } = await import('/ui.js');
    return ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b', '/x?y=1', '/ok/path-1_2', '/my', '', null, undefined, 5]
      .map(v => [v, safePath(v)]);
  });
  assert.deepEqual(results.map(r => r[1]), ['/my', '/my', '/my', '/my', '/my', '/my', '/ok/path-1_2', '/my', '/my', '/my', '/my', '/my']);
  await page.goto(site.url + '/signin?next=//evil.example/steal');
  await signIn(page, 'maria@example.com');
  assert.equal(new URL(page.url()).origin, site.url);
  assert.equal(new URL(page.url()).pathname, '/my');
  await ctx.close();
});

withShop('buying more photos: the dialog offers it, Stripe is asked, and coming back unlocks it', async () => {
  const { ctx, page } = await visitor();
  await fakeStripePages(ctx);
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  const png = tmpFile('a.png', PNG);
  const photos = () => (serverState(id)?.items || []).filter(i => i.type === 'photo' && i.src).length;
  const addPhoto = async n => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), el.locator('.photo-btn').click()]);
    await fc.setFiles(png);
    await until(() => photos() === n, `${n} photo(s) on the server`);
  };
  await addPhoto(1); await addPhoto(2);
  await el.locator('.photo-btn').click();
  const dialog = page.getByRole('dialog', { name: 'More photos' });
  await dialog.getByRole('button', { name: 'Get Platinum' }).waitFor();
  await dialog.getByText('You will see the price on the next page').waitFor();

  await dialog.getByRole('button', { name: 'Add more photos to this ofrenda' }).click();
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_1$/);
  const form = site.stripeCalls[0];
  assert.equal(form['metadata[feature]'], 'extraPhotos');
  assert.equal(form.client_reference_id, id);
  assert.equal(form['line_items[0][price]'], 'price_photos');

  // Paying: the webhook may even arrive after the browser is back. The page waits for it.
  await page.goto(form.success_url);
  await page.getByText('Applying your upgrade').waitFor();
  await site.pay(form);
  await until(() => page.evaluate(() => customElements.get('digital-ofrenda').features.extraPhotos), 'the upgrade to appear', 15000);
  assert.equal(new URL(page.url()).search, '', 'the marker leaves the address bar');
  await page.locator('digital-ofrenda[mode="edit"]').waitFor();
  await addPhoto(3);
  await ctx.close();
});

withShop('Platinum from My ofrendas: the fourth ofrenda offers it, and paying lifts the limit', async () => {
  const { ctx, page } = await visitor();
  await fakeStripePages(ctx);
  await signIn(page, 'maria@example.com');
  for (let i = 0; i < 3; i++) await page.evaluate(() => fetch('/ofrendas', { method: 'POST' }));
  await page.goto(site.url + '/my');
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  await page.getByRole('dialog', { name: 'Platinum' }).getByRole('button', { name: 'Get Platinum' }).click();
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//);
  const form = site.stripeCalls[0];
  assert.equal(form['metadata[feature]'], 'platinum');
  assert.equal(form.client_reference_id, site.db.prepare('SELECT id FROM users').get().id);

  await site.pay(form);
  await page.goto(form.success_url);
  await page.getByText('Thank you! You now have Platinum.').waitFor();
  await page.getByText('Platinum', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  await page.waitForURL(/\/a\/[a-z2-7]{12}$/);
  await ctx.close();
});

withShop('a co-keeper is told to ask the owner, and cancelling a payment says nothing was charged', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  const two = altar({ id: 'p1', type: 'photo', x: 20, y: 30, src: tinyPhoto() }, { id: 'p2', type: 'photo', x: 80, y: 30, src: tinyPhoto() });
  assert.equal(await owner.page.evaluate(async ([id, state]) => (await fetch('/ofrendas/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })).status, [id, two]), 200);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await owner.page.getByLabel('Email address', { exact: true }).fill('sam@example.com');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await owner.page.getByText('Invitation sent.').waitFor();

  const sam = await visitor();
  await sam.page.goto(`${site.url}/invite#i=${await site.linkFrom('sam@example.com', /\/invite#i=([\w-]{43})/)}`);
  await sam.page.waitForURL(u => u.pathname === '/signin');
  await signIn(sam.page, 'sam@example.com');
  await sam.page.getByRole('button', { name: 'Accept the invitation' }).click();
  await sam.page.getByRole('link', { name: 'Open the ofrenda' }).click();
  const el = sam.page.locator('digital-ofrenda[mode="edit"]');
  await el.locator('.photo-btn').click();
  const dialog = sam.page.getByRole('dialog', { name: 'More photos' });
  await dialog.getByText('Only the owner of this ofrenda can buy upgrades').waitFor();
  assert.equal(await dialog.getByRole('button', { name: /Get Platinum|Add more photos/ }).count(), 0, 'no way to buy');
  assert.equal(site.stripeCalls.length, 0);

  await owner.page.goto(`${site.url}/a/${id}?cancelled=1`);
  await owner.page.getByText('No problem. Nothing was charged.').waitFor();
  assert.equal(new URL(owner.page.url()).search, '');
  for (const c of [owner, sam]) await c.ctx.close();
});

withSite('when purchases are not set up, the dialog says so politely', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  for (let i = 0; i < 3; i++) await page.evaluate(() => fetch('/ofrendas', { method: 'POST' }));
  await page.goto(site.url + '/my');
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  const dialog = page.getByRole('dialog', { name: 'Platinum' });
  await dialog.getByRole('button', { name: 'Get Platinum' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Purchases are not open yet.' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/my', 'it stays where it is');
  await ctx.close();
});

withShop('the page itself only follows an address on Stripe, even if told otherwise', async () => {
  const { ctx, page } = await visitor();
  await signIn(page, 'maria@example.com');
  for (let i = 0; i < 3; i++) await page.evaluate(() => fetch('/ofrendas', { method: 'POST' }));
  await page.goto(site.url + '/my');
  await page.route(site.url + '/checkout', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://checkout.stripe.com.evil.example/pay' }) }));
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  const dialog = page.getByRole('dialog', { name: 'Platinum' });
  await dialog.getByRole('button', { name: 'Get Platinum' }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(new URL(page.url()).origin, site.url, 'it did not go anywhere');
  await ctx.close();
});

// ---------- account: email, deletion, and the legal pages ----------

withSite('account: changing the email address needs the code sent to the new one', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  await page.goto(site.url + '/my');
  await page.getByLabel('New email address').fill('maria.new@example.com');
  const from = site.sent.length;
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const code = await site.codeFor('maria.new@example.com', from);
  await page.getByLabel('Code', { exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Change my email' }).click();
  await page.getByText('That code did not work').waitFor();
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Change my email' }).click();
  await page.getByText('Your email address is now maria.new@example.com').waitFor();
  assert.equal(await page.locator('.who').innerText(), 'maria.new@example.com', 'the header shows the new address');
  await site.mail('maria@example.com', /changed/);
  await assertLabelled(page);
});

withSite('account: deleting asks for the email, warns about owned ofrendas, then signs out for good', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  await page.goto(site.url + '/my');
  await page.getByLabel(/To confirm, type your email/).fill('wrong@example.com');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.getByText('Type your email address exactly').waitFor();
  await page.getByLabel(/To confirm, type your email/).fill('maria@example.com');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.getByText(/You own 1 ofrenda/).waitFor();
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'nothing deleted yet');
  await page.getByLabel('Yes, delete my ofrendas too').check();
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.waitForURL(u => u.pathname === '/deleted');
  await page.getByRole('heading', { name: 'Your account has been deleted' }).waitFor();
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM altars WHERE id = ?').get(id).n, 0);
  await page.goto(site.url + '/my');
  await page.waitForURL(u => u.pathname === '/signin');
});

withSite('legal pages: privacy and terms are public, linked from every page, and say what the product does', async () => {
  const { page } = await visitor();
  for (const [start, name] of [['/', 'Privacy'], ['/signin', 'Terms']]) {
    await page.goto(site.url + start);
    await page.getByRole('link', { name }).click();
    await page.waitForURL(u => u.pathname === '/' + name.toLowerCase());
  }
  await page.goto(site.url + '/privacy');
  const text = await page.locator('main').innerText();
  for (const word of ['Cloudflare', 'Resend', 'Stripe', 'Delete your account', 'Anyone who has the link']) assert.ok(text.includes(word), word);
  await page.goto(site.url + '/terms');
  assert.ok((await page.locator('main').innerText()).includes('refunded in full'));
  await assertLabelled(page);
});
