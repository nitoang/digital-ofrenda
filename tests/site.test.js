// End-to-end: a real browser (BROWSER=chromium|firefox|webkit), the real pages under their real Content-Security-Policy, the real Worker code, SQLite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startSite } = require('./site');
const { PNG, tmpFile, engine, BROWSER, isNavigationCutOff } = require('./helpers');

let browser, site;
const problems = []; // page errors, browser dialogs and Content-Security-Policy violations, from every test
before(async () => { browser = await engine.launch(); });
after(async () => {
  await browser.close();
  if (cutOffByNavigation) console.log(`# ${cutOffByNavigation} same-origin fetch(es) cut off by a navigation, which WebKit reports as a page error (not a failure)`);
  assert.deepEqual(problems, [], 'no page errors, dialogs or CSP violations anywhere');
});

const DAY = 86_400_000;
const altar = (...items) => ({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela', items });

// A fresh browser (own cookies) on a fresh copy of the product.
let tearingDown = false;
let cutOffByNavigation = 0; // WebKit's report of a same-origin fetch cut off by navigation (see visitor()); counted, never failing
const opened = []; // every browser context a test opened, closed when the test ends so none pile up
async function visitor() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1300 }, ignoreHTTPSErrors: true }); // the test site uses a self-signed certificate
  opened.push(ctx);
  const page = await ctx.newPage();
  // Every page error says when it happened (while a test ran or while its page was being closed), where, how long after
  // the page last navigated, which requests had failed, and its stack, so an error only one engine reports can be traced.
  //
  // (A fetch cut off by a navigation, which WebKit reports as a page error, is tolerated: see isNavigationCutOff in helpers.js.)
  let lastNavigation = Date.now();
  const failedRequests = [];
  page.on('framenavigated', f => { if (f === page.mainFrame()) lastNavigation = Date.now(); });
  page.on('requestfailed', r => failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} (${r.failure()?.errorText})`));
  page.on('pageerror', e => {
    const text = `${e.name}: ${e.message}`, stack = String(e.stack || '');
    if (isNavigationCutOff(e, page.url())) { cutOffByNavigation++; return; }
    problems.push(`pageerror (${tearingDown ? 'while closing' : 'while a test ran'}, at ${page.url()}, ${Date.now() - lastNavigation} ms after its last navigation, failed requests: ${failedRequests.slice(-3).join(' | ') || 'none'}): ${text} [stack: ${stack.split('\n').slice(0, 4).map(l => l.trim()).join(' / ')}]`);
  });
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp: ' + m.text()); });
  return { ctx, page };
}

async function signIn(page, email, { from = site.sent.length } = {}) {
  if (!new URL(page.url()).pathname.startsWith('/signin')) await page.goto(site.url + '/signin');
  await page.getByLabel('Your email address').fill(email);
  await page.getByLabel('Email me a 6-digit code').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code', { exact: true }).fill(await site.codeFor(email, from));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'));
}

// Opening a link from an email: always a fresh document, like clicking it in a mail app. Going straight from
// /signin to /signin#t=... would be a hash-only change, which the page answers by reloading itself, and that
// races with goto() ("net::ERR_ABORTED"), so start from a blank page.
async function openEmailedLink(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

async function until(fn, what = String(fn), ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 40));
  }
}

const closeContexts = async () => {
  tearingDown = true;
  try { await Promise.allSettled(opened.splice(0).map(c => c.close())); } finally { tearingDown = false; }
};
const withSite = (name, fn) => test(name, async () => {
  site = await startSite({ tls: true });
  try { await fn(); } finally { await closeContexts(); await site.close(); }
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
  site = await startSite({ stripe: true, tls: true, ...opts });
  try { await fn(); } finally { await closeContexts(); await site.close(); }
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
  await page.getByLabel('Email me a 6-digit code').check();
  await page.getByRole('button', { name: 'Continue' }).click();
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
  await page.getByRole('button', { name: 'Continue' }).click(); // the link is the default choice
  await page.getByText('We sent a sign-in link').waitFor();
  const token = await site.linkFrom('maria@example.com', /signin#t=([\w-]{43})/);
  await openEmailedLink(page, `${site.url}/signin#t=${token}`);
  const go = page.getByRole('button', { name: 'Continue to sign in' });
  await go.waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the token is gone from the address bar');
  assert.equal(site.db.prepare('SELECT used_at u FROM login_challenges').get().u, null, 'merely opening the link used nothing up');
  await go.click();
  await page.waitForURL(u => u.pathname === '/my');
  // The same link a second time is refused politely.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(u => u.pathname === '/'); // signing out ends with a redirect to the home page; let it finish before opening the link
  await openEmailedLink(page, `${site.url}/signin#t=${token}`);
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
  assert.equal(await page.getByLabel('Link to view this ofrenda').inputValue(), `${site.url}/s/${id}`);

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

withSite('sharing: the owner chooses view only or view and edit', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await assertLabelled(owner.page);
  assert.ok(await owner.page.getByLabel('View only').isChecked(), 'view only is the default');
  assert.ok(!(await owner.page.getByLabel('View and edit').isChecked()));

  // A note with a web link is refused, and nothing is sent.
  await owner.page.getByLabel('Email address', { exact: true }).fill('kim@example.com');
  await owner.page.getByLabel('A note to go with it (optional)').fill('see https://example.com/now');
  await owner.page.getByRole('button', { name: 'Share' }).click();
  await owner.page.getByRole('alert').filter({ hasText: 'Notes cannot contain web links.' }).waitFor();
  assert.equal(site.sent.filter(m => m.to === 'kim@example.com').length, 0);

  // View only: Kim gets the link and a note, no invitation, and does not appear among the keepers.
  await owner.page.getByLabel('A note to go with it (optional)').fill('She would have loved you being here.');
  await owner.page.getByRole('button', { name: 'Share' }).click();
  await owner.page.getByText('Link sent.').waitFor();
  const view = await site.mail('kim@example.com', /shared an ofrenda/);
  assert.ok(view.text.includes(`/a/${id}`));
  assert.ok(view.text.includes('She would have loved you being here.'));
  assert.ok(!view.text.includes('#i='), 'no invitation was sent');
  assert.equal(await owner.page.getByText('kim@example.com').count(), 0, 'view only people are not keepers');

  // View and edit: Sam is invited and shows as waiting.
  await owner.page.getByLabel('Email address', { exact: true }).fill('sam@example.com');
  await owner.page.getByLabel('View and edit').check();
  await owner.page.getByRole('button', { name: 'Share' }).click();
  await owner.page.getByText('Invitation sent.').waitFor();
  await owner.page.getByText('sam@example.com').waitFor();
  await site.mail('sam@example.com', /invited you to help keep an ofrenda/);
});

withSite('co-keepers: invite by email, accept in the browser, edit together, remove', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await assertLabelled(owner.page);
  await owner.page.getByLabel('Email address', { exact: true }).fill('Sam@Example.com');
  await owner.page.getByLabel('View and edit').check();
  await owner.page.getByRole('button', { name: 'Share' }).click();
  await owner.page.getByText('Invitation sent.').waitFor();
  await owner.page.getByText('sam@example.com').waitFor();

  const token = await site.linkFrom('sam@example.com', /\/invite#i=([\w-]{43})/);
  const sam = await visitor();
  await openEmailedLink(sam.page, `${site.url}/invite#i=${token}`);
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
  await openEmailedLink(other.page, `${site.url}/invite#i=${token}`);
  await other.page.waitForURL(u => u.pathname === '/signin');
  await signIn(other.page, 'bystander@example.com');
  await other.page.getByRole('button', { name: 'Accept the invitation' }).click();
  await other.page.getByRole('alert').filter({ hasText: 'expired, was already used, or was sent to a different email' }).waitFor();
  // Already signed in, opening the link: the token still leaves the address bar at once.
  await openEmailedLink(other.page, `${site.url}/invite#i=${token}`);
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

withSite('successor: the owner chooses how long to wait and whether it passes automatically, and can change it later', async () => {
  const owner = await visitor();
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await assertLabelled(owner.page);
  assert.ok(await owner.page.getByLabel('12 months (recommended)').isChecked(), '12 months is the default');
  assert.ok(await owner.page.getByLabel('Pass it to them automatically').isChecked(), 'automatic is the default');
  await owner.page.getByLabel('Their email address').fill('heir@example.com');
  await owner.page.getByLabel('6 months').check();
  await owner.page.getByLabel('Pass it to them automatically').uncheck();
  await owner.page.getByRole('button', { name: 'Name a successor' }).click();
  await owner.page.getByText('We emailed them to ask').waitFor();
  await owner.page.getByText('If you are away 6 months, you are emailed, and 30 days later they can ask to take it over').waitFor();
  assert.deepEqual({ ...site.db.prepare('SELECT inactive_ms, auto_transfer FROM successors WHERE altar_id = ?').get(id) }, { inactive_ms: site.RULES.successorWaits[6], auto_transfer: 0 });
  await site.mail('owner@example.com', /named a successor/);

  const change = owner.page.locator('details');
  await change.locator('summary').click();
  await assertLabelled(owner.page);
  await change.getByLabel('12 months (recommended)').check();
  await change.getByLabel('Pass it to them automatically').check();
  await change.getByRole('button', { name: 'Save' }).click();
  await owner.page.getByText('Saved. Your successor was not emailed again.').waitFor();
  await owner.page.getByText('If you are away 12 months, you are emailed, and 30 days later it passes to them automatically').waitFor();
  assert.deepEqual({ ...site.db.prepare('SELECT inactive_ms, auto_transfer FROM successors WHERE altar_id = ?').get(id) }, { inactive_ms: site.RULES.successorWaits[12], auto_transfer: 1 });
  assert.equal(site.sent.filter(m => m.to === 'heir@example.com').length, 1, 'changing the settings does not email them again');
  await owner.ctx.close();
});

withSite('handover: a typed confirmation, an existing account gets it at once, a new person after they sign in, and it can be cancelled', async () => {
  const owner = await visitor(), friend = await visitor();
  await signIn(friend.page, 'friend@example.com');
  await signIn(owner.page, 'owner@example.com');
  const id = await startOfrenda(owner.page);
  await owner.page.goto(`${site.url}/a/${id}/keepers`);
  await assertLabelled(owner.page);
  const who = owner.page.getByLabel('Email address of the person to hand it to');
  const word = owner.page.getByLabel('To confirm, type the word handover');
  await owner.page.getByText('This is a big step.').waitFor();

  await who.fill('friend@example.com');
  await word.fill('hand');
  await owner.page.getByRole('button', { name: 'Hand this ofrenda over' }).click();
  await owner.page.getByRole('alert').filter({ hasText: 'Type the word handover' }).waitFor();
  assert.equal(site.db.prepare("SELECT COUNT(*) n FROM altar_members WHERE altar_id = ? AND role = 'owner'").get(id).n, 1, 'nothing happened');

  await word.fill('handover');
  await owner.page.getByRole('button', { name: 'Hand this ofrenda over' }).click();
  await owner.page.getByText('Handed over. They have been emailed.').waitFor();
  assert.equal(site.db.prepare("SELECT COUNT(*) n FROM altar_members WHERE altar_id = ? AND role = 'owner'").get(id).n, 2, 'both are owners now');
  await site.mail('friend@example.com', /handed an ofrenda over to you/);
  await owner.page.getByRole('button', { name: 'Stop being an owner of this ofrenda' }).waitFor(); // with two owners, you can step away

  // A person with no account yet: it waits, and can be cancelled.
  await who.fill('newcomer@example.com');
  await word.fill('handover');
  await owner.page.getByRole('button', { name: 'Hand this ofrenda over' }).click();
  await owner.page.getByText('newcomer@example.com has not signed in yet.').waitFor();
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM handovers').get().n, 1);
  await owner.page.getByRole('button', { name: 'Cancel the handover' }).click();
  await owner.page.getByRole('button', { name: 'Click again to cancel' }).click();
  await owner.page.getByText('Handover cancelled.').waitFor();
  assert.equal(site.db.prepare('SELECT COUNT(*) n FROM handovers').get().n, 0);

  // Waiting again, then they sign in for the first time.
  await who.fill('newcomer@example.com');
  await word.fill('handover');
  await owner.page.getByRole('button', { name: 'Hand this ofrenda over' }).click();
  await owner.page.getByText('newcomer@example.com has not signed in yet.').waitFor();
  const newcomer = await visitor();
  await signIn(newcomer.page, 'newcomer@example.com');
  assert.equal(site.db.prepare("SELECT COUNT(*) n FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'owner' AND u.email = 'newcomer@example.com'").get(id).n, 1);
  await owner.page.reload();
  assert.equal(await owner.page.getByText('has not signed in yet').count(), 0);
  for (const c of [owner, friend, newcomer]) await c.ctx.close();
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
  await openEmailedLink(heir.page, `${site.url}/successor#s=${token}`);
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
  await owner.page.getByLabel('View and edit').check();
  await owner.page.getByRole('button', { name: 'Share' }).click();
  await owner.page.getByText('Invitation sent.').waitFor();

  const sam = await visitor();
  await openEmailedLink(sam.page, `${site.url}/invite#i=${await site.linkFrom('sam@example.com', /\/invite#i=([\w-]{43})/)}`);
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

withSite('sign-in: a likely typo in the address is caught before anything is sent, and the person can still overrule it', async () => {
  const { page } = await visitor();
  await page.goto(site.url + '/signin');
  const from = site.sent.length;
  await page.getByLabel('Your email address').fill('maria@gmial.com');
  await page.getByLabel('Email me a 6-digit code').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Did you mean').waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Did you mean' }).locator('strong').innerText(), 'maria@gmail.com');
  assert.equal(site.sent.length, from, 'nothing is sent while we ask');
  await page.getByRole('button', { name: 'Use maria@gmail.com' }).click();
  assert.equal(await page.getByLabel('Your email address').inputValue(), 'maria@gmail.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code', { exact: true }).fill(await site.codeFor('maria@gmail.com', from));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'));
  assert.ok(!site.sent.slice(from).some(m => m.to === 'maria@gmial.com'), 'nothing went to the mistyped address');

  // "No, send to what I typed": a real but unusual address is never blocked.
  const other = await visitor();
  await other.page.goto(site.url + '/signin');
  const from2 = site.sent.length;
  await other.page.getByLabel('Your email address').fill('lola@gmial.com');
  await other.page.getByLabel('Email me a 6-digit code').check();
  await other.page.getByRole('button', { name: 'Continue' }).click();
  await other.page.getByRole('button', { name: 'No, send to what I typed' }).click();
  await other.page.getByLabel('Code', { exact: true }).fill(await site.codeFor('lola@gmial.com', from2));
  await other.page.getByRole('button', { name: 'Sign in' }).click();
  await other.page.waitForURL(u => !u.pathname.startsWith('/signin'));
});

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

withSite('account: "Download my data" saves one JSON file with my ofrendas in it', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  await page.goto(site.url + '/my');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download my data' }).click()]);
  assert.match(download.suggestedFilename(), /^digital-ofrenda-export-\d{4}-\d{2}-\d{2}\.json$/);
  const body = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
  assert.equal(body.account.email, 'maria@example.com');
  assert.ok(body.ofrendas.some(o => o.id === id && o.role === 'owner'));
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
  await page.getByText(/One of your ofrendas has nobody else to keep it/).waitFor();
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

withSite('privacy: the owner makes an ofrenda private and a stranger sees nothing; turning it back on restores every link', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const saved = await page.evaluate(([id, body]) => fetch('/ofrendas/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }).then(r => r.status), [id, JSON.stringify(altar())]);
  assert.equal(saved, 200);
  const stranger = await visitor();
  const sees = async () => { await stranger.page.goto(`${site.url}/a/${id}`); return stranger.page.locator('digital-ofrenda').or(stranger.page.getByRole('heading', { name: 'This ofrenda is not ready yet' })).first().waitFor().then(() => stranger.page.locator('digital-ofrenda').count()); };
  assert.equal(await sees(), 1, 'public by default');

  await page.goto(`${site.url}/a/${id}/keepers`);
  await page.getByRole('heading', { name: 'Who can see it' }).waitFor();
  assert.equal(await page.getByLabel('Anyone with the link').isChecked(), true);
  await page.getByLabel('Only the people who keep it').check();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByText('This ofrenda is now private.').waitFor();
  assert.equal(await page.getByLabel('Only the people who keep it').isChecked(), true, 'the choice sticks');
  await assertLabelled(page);

  assert.equal(await sees(), 0, 'a stranger gets the same page as for one that does not exist');
  await stranger.page.getByText('or it is private').waitFor();
  await page.goto(`${site.url}/a/${id}`);
  await page.locator('digital-ofrenda').waitFor();
  await page.locator('#private-note').waitFor();
  assert.equal(await page.locator('#share-url').count(), 0, 'no link to copy while private');
  assert.equal((await page.request.get(`${site.url}/ofrendas/${id}`)).status(), 200, 'the owner can still open it');

  await page.goto(`${site.url}/a/${id}/keepers`);
  await page.getByLabel('Anyone with the link').check();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByText('Anyone with the link can open this ofrenda.').waitFor();
  assert.equal(await sees(), 1, 'the same link works again');
  await page.goto(`${site.url}/a/${id}`);
  await page.locator('#share-url').waitFor();
});

withSite('link previews: /s/<name> has the preview tags and a picture, sends a person on to the ofrenda, and everything says noindex', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  await page.evaluate(([id, body]) => fetch('/ofrendas/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }).then(r => r.status), [id, JSON.stringify(altar())]);

  const html = await (await page.request.get(`${site.url}/s/${id}`)).text();
  assert.ok(html.includes('<meta property="og:title" content="Abuela — an ofrenda on Digifrenda">'));
  assert.ok(html.includes(`<meta property="og:image" content="${site.url}/og.png">`));
  const img = await page.request.get(`${site.url}/og.png`);
  assert.equal(img.headers()['content-type'], 'image/png');
  const bytes = await img.body();
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 630], 'the size the preview tags promise');

  const stranger = await visitor();
  await stranger.page.goto(`${site.url}/s/${id}`);
  await stranger.page.waitForURL(u => u.pathname === `/a/${id}`);
  await stranger.page.locator('digital-ofrenda').waitFor();

  for (const [path, how] of [[`/a/${id}`, 'the page'], [`/a/${id}/keepers`, 'the keepers page'], [`/s/${id}`, 'the preview'], [`/ofrendas/${id}`, 'the data']]) {
    assert.equal((await page.request.get(site.url + path)).headers()['x-robots-tag'], 'noindex, nofollow', how);
  }
  for (const f of ['a', 'keepers']) assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'site', f + '.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow">/, f + '.html');
  await stranger.ctx.close();
});

withSite('photo store: a photo added in the browser is kept in the bucket and shown to visitors, and later saves stay small', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  const puts = [];
  page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/ofrendas/' + id)) puts.push({ size: (r.postData() || '').length, inline: (r.postData() || '').includes('data:image') }); });
  await el.locator('.photo-input').setInputFiles(tmpFile('a.png', PNG));
  const pathOf = () => (serverState(id)?.items || []).find(i => i.type === 'photo' && i.src)?.src;
  await until(() => pathOf(), 'the photo saved');
  assert.match(pathOf(), new RegExp(`^/ofrendas/${id}/photos/[a-f0-9]{64}$`), 'the server kept a path');
  assert.equal(site.env.PHOTOS.objects.size, 1, 'and the image itself is in the bucket');
  assert.ok(!site.db.prepare('SELECT state FROM altars WHERE id = ?').get(id).state.includes('data:image'), 'nothing inline in the database');

  // Another edit: the photo goes as its short path, so the save is small.
  await until(() => puts.length >= 1, 'first save request');
  await page.waitForTimeout(500);
  const before = puts.length;
  await el.locator('.tray button[data-type="heart"]').click();
  await until(() => puts.length > before, 'second save request');
  assert.equal(puts[0].inline, true, 'the first save carries the new image');
  assert.equal(puts.at(-1).inline, false, `the later save (${puts.at(-1).size} characters) carries the short path, not the image again`);
  assert.ok(puts.slice(1).every(p => !p.inline), 'and so does every save after the first');

  // After a reload the page shows it from the bucket, through the Worker, and so does a visitor.
  await page.reload();
  await page.locator('digital-ofrenda .item.photo img').waitFor();
  await until(() => page.locator('digital-ofrenda .item.photo img').evaluate(i => i.complete && i.naturalWidth > 0), 'the photo loaded for the owner');
  const visitor2 = await visitor();
  await visitor2.page.goto(`${site.url}/a/${id}`);
  await visitor2.page.locator('digital-ofrenda .item.photo img').waitFor();
  await until(() => visitor2.page.locator('digital-ofrenda .item.photo img').evaluate(i => i.complete && i.naturalWidth > 0), 'the photo loaded for a visitor');
  assert.equal(await visitor2.page.locator('digital-ofrenda .item.photo img').getAttribute('src'), pathOf());
});

withSite('photo store: Export writes the photo inline so the file stands alone, and it imports back', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  await el.locator('.photo-input').setInputFiles(tmpFile('a.png', PNG));
  await until(() => (serverState(id)?.items || []).some(i => i.type === 'photo' && i.src), 'the photo saved');
  await page.reload();
  await until(() => page.locator('digital-ofrenda .item.photo img').evaluate(i => i.complete && i.naturalWidth > 0), 'the photo loaded');
  const [download] = await Promise.all([page.waitForEvent('download'), el.locator('.export-btn').click()]);
  const exported = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
  const photo = exported.items.find(i => i.type === 'photo' && i.src);
  assert.match(photo.src, /^data:image\/jpeg;base64,/, 'inline, not a path to this server');
  const stored = [...site.env.PHOTOS.objects.values()][0].bytes;
  assert.deepEqual(Buffer.from(photo.src.split(',')[1], 'base64'), Buffer.from(stored), 'the very same image');
  await page.getByText('Ofrenda exported.').waitFor();
  // Import it into a different ofrenda: the image goes back into the bucket.
  const other = await startOfrenda(page);
  const otherEl = page.locator('digital-ofrenda[mode="edit"]');
  await otherEl.locator('.import-input').setInputFiles({ name: 'x.ofrenda.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await otherEl.locator('.import-btn').click(); // the second click confirms
  await until(() => (serverState(other)?.items || []).some(i => i.type === 'photo' && /^\/ofrendas\/.+\/photos\//.test(i.src || '')), 'the imported photo saved as a path');
  assert.equal(site.env.PHOTOS.objects.size, 2, 'one per ofrenda (they are never shared between ofrendas)');
});

withSite('photo store: a private ofrenda\'s photo cannot be fetched by a stranger, and deleting the ofrenda deletes it', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  const el = page.locator('digital-ofrenda[mode="edit"]');
  await el.locator('.photo-input').setInputFiles(tmpFile('a.png', PNG));
  const pathOf = () => (serverState(id)?.items || []).find(i => i.type === 'photo' && i.src)?.src;
  await until(() => pathOf(), 'the photo saved');
  const photoUrl = site.url + pathOf();
  const stranger = await visitor();
  assert.equal((await stranger.page.request.get(photoUrl)).status(), 200, 'public by default');

  await page.goto(`${site.url}/a/${id}/keepers`);
  await page.getByLabel('Only the people who keep it').check();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByText('This ofrenda is now private.').waitFor();
  assert.equal((await stranger.page.request.get(photoUrl)).status(), 404, 'now the exact address gives a stranger nothing');
  assert.equal((await page.request.get(photoUrl)).status(), 200, 'while the owner still sees it');

  assert.equal(site.env.PHOTOS.objects.size, 1);
  const gone = await page.evaluate(id => fetch('/ofrendas/' + id, { method: 'DELETE' }).then(r => r.status), id);
  assert.equal(gone, 200);
  assert.equal(site.env.PHOTOS.objects.size, 0, 'the photo went with the ofrenda');
});

withSite('names: the owner picks a name and /a/<name> opens the same ofrenda, with the id link still working', async () => {
  const { page } = await visitor();
  await signIn(page, 'maria@example.com');
  const id = await startOfrenda(page);
  await page.goto(site.url + `/a/${id}/keepers`);
  await page.getByLabel('Name', { exact: true }).fill('Abuela_Rosa');
  await page.getByRole('button', { name: 'Choose a name' }).click();
  await page.getByText('Use 3 to 40 letters').waitFor();
  await page.getByLabel('Name', { exact: true }).fill('abuela-rosa');
  await page.getByRole('button', { name: 'Choose a name' }).click();
  await page.getByText('Current name:').waitFor();
  await assertLabelled(page);

  // Through the name, the page is still the editor for its owner, and sharing uses the name.
  await page.goto(site.url + '/a/abuela-rosa');
  await page.locator('digital-ofrenda').waitFor();
  assert.equal(await page.locator('#share-url').inputValue(), site.url + '/s/abuela-rosa', 'the link to paste is the preview page, which sends people on');
  await page.getByRole('link', { name: 'Keepers and sharing' }).click();
  await page.waitForURL(u => u.pathname === '/a/abuela-rosa/keepers');
  await page.getByText('Current name:').waitFor();

  // A visitor who is not signed in can view it by name or by id, and an unknown name is just not found.
  const saved = await page.evaluate(([id, body]) => fetch('/ofrendas/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }).then(r => r.status), [id, JSON.stringify(altar())]);
  assert.equal(saved, 200);
  const stranger = await visitor();
  for (const p of ['/a/abuela-rosa', `/a/${id}`]) {
    await stranger.page.goto(site.url + p);
    await stranger.page.locator('digital-ofrenda').waitFor();
    assert.equal(await stranger.page.getByRole('heading', { name: 'This ofrenda is not ready yet' }).count(), 0, p);
  }
  await stranger.page.goto(site.url + '/a/nobody-here');
  await stranger.page.getByRole('heading', { name: 'Ofrenda not found' }).waitFor();
});

withShop('purchase history: My ofrendas links to it, it lists what I bought, and a refund and a dispute show', async () => {
  const { ctx, page } = await visitor();
  await fakeStripePages(ctx);
  await signIn(page, 'maria@example.com');
  await page.goto(site.url + '/purchases');
  await page.getByText('You have not bought anything.').waitFor();
  const id = await startOfrenda(page);
  await page.goto(site.url + '/my');
  await page.getByRole('link', { name: 'Purchase history' }).click();
  await page.getByRole('heading', { name: 'Purchase history' }).waitFor();

  // Buying through the real checkout route, then Stripe's webhook for it.
  const bought = async (feature, altarId) => {
    const r = await page.evaluate(async ([feature, altarId]) => (await fetch('/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feature, altarId }) })).status, [feature, altarId]);
    assert.equal(r, 200);
    await site.pay(site.stripeCalls.at(-1));
  };
  await bought('sevenTiers', id);
  await bought('platinum');
  await page.goto(site.url + '/purchases');
  const rows = page.locator('table.purchases tbody tr');
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(), 2);
  const text = await rows.evaluateAll(rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')));
  assert.ok(text.some(t => /Seven-tier altar.*\$9\.00.*Paid.*pi_test_1/.test(t)), text.join(' | '));
  assert.ok(text.some(t => /Platinum.*Your account.*\$9\.00.*Paid.*pi_test_2/.test(t)));
  await page.getByRole('link', { name: 'Untitled ofrenda' }).waitFor();
  await page.getByRole('columnheader', { name: 'Payment reference' }).waitFor();

  // The bank disputes one; a partial refund on the other.
  const hook = (type, object) => site.webhook(type, object);
  await hook('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_test_1', status: 'needs_response', reason: 'fraudulent', evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86400 } });
  await hook('charge.refunded', { refunded: false, amount_refunded: 300, payment_intent: 'pi_test_2', metadata: {} });
  await page.reload();
  await page.getByText('Disputed with your bank').waitFor();
  await page.getByText('Partly refunded').waitFor();
  await closeContexts();
});
