// Accessibility: axe-core (the checker most auditors use) over every page of the real site, signed out and signed in,
// on a desktop and a phone, with the editor in its busy states. It finds what a program can find: contrast, names,
// roles, headings, landmarks, target sizes. What it cannot judge (does it make sense read aloud?) is in the
// component tests and in docs/HANDOFF.md, which says what still needs a person with a screen reader.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startSite } = require('./site');
const { engine, PNG } = require('./helpers');

const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
let browser, site;
const problems = [];
before(async () => { browser = await engine.launch(); });
after(async () => { await browser.close(); assert.deepEqual(problems, [], 'no page errors or CSP violations'); });

const SIZES = { desktop: { width: 1000, height: 1300 }, phone: { width: 375, height: 700 } };

// Runs axe on the page as it is now. The result is a list of readable lines; empty means clean.
async function violations(page) {
  await page.evaluate(axeSource); // evaluated by the browser's debugger, so the page's content-security policy does not apply
  const found = await page.evaluate(async tags => (await axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations
    .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' — ' + (n.any[0] || n.all[0] || n.none[0] || {}).message) })), TAGS);
  return found.map(v => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.join('\n    ')}`);
}

async function open(size) {
  const ctx = await browser.newContext({ viewport: SIZES[size], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp: ' + m.text()); });
  return { ctx, page };
}

const withSite = (name, fn) => test(name, async () => {
  site = await startSite({ tls: true, stripe: true });
  try { await fn(); } finally { await site.close(); }
});

async function signIn(page, email) {
  const from = site.sent.length;
  await page.goto(site.url + '/signin');
  await page.getByLabel('Your email address').fill(email);
  await page.getByLabel('Email me a 6-digit code').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code', { exact: true }).fill(await site.codeFor(email, from));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'));
}

for (const size of Object.keys(SIZES)) {
  withSite(`a11y (${size}): the public pages have no accessibility violations`, async () => {
    const { ctx, page } = await open(size);
    const bad = [];
    for (const path of ['/', '/signin', '/privacy', '/terms', '/deleted', '/invite', '/successor']) {
      await page.goto(site.url + path);
      await page.locator('h1').first().waitFor();
      bad.push(...(await violations(page)).map(v => `${path}: ${v}`));
    }
    await ctx.close();
    assert.deepEqual(bad, []);
  });

  withSite(`a11y (${size}): signed in, My ofrendas, the editor in each of its states, the keepers page and the upgrade dialog are clean`, async () => {
    const { ctx, page } = await open(size);
    const bad = [];
    const check = async label => bad.push(...(await violations(page)).map(v => `${label}: ${v}`));
    await page.goto(site.url + '/signin');
    await check('sign-in');
    await page.getByLabel('Your email address').fill('maria@example.com');
    await page.getByLabel('Email me a 6-digit code').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Code', { exact: true }).fill(await site.codeFor('maria@example.com', 0));
    await check('sign-in, code step');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(u => !u.pathname.startsWith('/signin'));

    await page.goto(site.url + '/my');
    await page.getByRole('button', { name: 'Start a new ofrenda' }).waitFor();
    await check('My ofrendas (empty)');
    await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
    await page.waitForURL(/\/a\/[a-z2-7]{12}$/);
    const id = new URL(page.url()).pathname.split('/')[2];
    const photo = 'data:image/png;base64,' + PNG.toString('base64');
    await page.evaluate(async ([id, photo]) => {
      const r = await fetch('/ofrendas/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela Rosa', dates: '1940 – 2020', items: [
        { id: 'a', type: 'candle', x: 30, y: 60, lit: true }, { id: 'b', type: 'candle', x: 70, y: 60 }, { id: 'c', type: 'marigold', x: 50, y: 60, scale: 1.3, rot: 20 },
        { id: 'd', type: 'note', x: 50, y: 40, text: 'Te extrañamos' }, { id: 'e', type: 'photo', x: 50, y: 22, src: photo }, { id: 'f', type: 'photo', x: 25, y: 22 }] }) });
      if (!r.ok) throw new Error('save failed ' + r.status);
    }, [id, photo]);

    await page.goto(site.url + '/a/' + id);
    const editor = page.locator('digital-ofrenda');
    await editor.locator('.item').first().waitFor();
    await check('the editor');
    await editor.locator('.item[data-id="c"]').focus(); // handles show
    await check('the editor, an item selected');
    await editor.locator('label:has(input[value="pet"])').click();
    await check('the editor, pet tray');
    await editor.locator('label:has(input[value="7"])').click(); // an upgrade: opens the dialog
    await page.locator('dialog[open]').waitFor();
    await check('the upgrade dialog');
    await page.keyboard.press('Escape');
    await page.goto(site.url + `/a/${id}/keepers`);
    await page.locator('h1').first().waitFor();
    await check('keepers');

    // Someone who is only looking.
    const view = await open(size);
    await view.page.goto(site.url + '/a/' + id);
    await view.page.locator('digital-ofrenda .item').first().waitFor();
    bad.push(...(await violations(view.page)).map(v => `viewing: ${v}`));
    await view.ctx.close();
    await ctx.close();
    assert.deepEqual(bad, []);
  });
}

withSite('a11y: the tab order on each page follows what you see, and no page uses a positive tabindex', async () => {
  const { ctx, page } = await open('desktop');
  await signIn(page, 'maria@example.com');
  await page.goto(site.url + '/my');
  await page.getByRole('button', { name: 'Start a new ofrenda' }).click();
  await page.waitForURL(/\/a\/[a-z2-7]{12}$/);
  const id = new URL(page.url()).pathname.split('/')[2];
  const order = async path => {
    await page.goto(site.url + path);
    await page.locator('h1').first().waitFor();
    return page.evaluate(() => {
      const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const tabbable = [];
      const walk = root => { for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) walk(e.shadowRoot); if (e.matches('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]') && visible(e)) tabbable.push(e); } };
      walk(document);
      return { positive: [...document.querySelectorAll('[tabindex]')].filter(e => Number(e.getAttribute('tabindex')) > 0).length, tops: tabbable.map(e => Math.round(e.getBoundingClientRect().top)) };
    });
  };
  for (const path of ['/', '/signin', '/my', '/privacy', `/a/${id}/keepers`, '/a/' + id]) {
    const { positive, tops } = await order(path);
    assert.equal(positive, 0, `${path}: no positive tabindex`);
    // Reading order is top to bottom: allow items on the same row, but never a jump back up the page by more than a row.
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] >= tops[i - 1] - 60, `${path}: tab stop ${i + 1} is ${tops[i - 1] - tops[i]}px above the one before it`);
  }
  await ctx.close();
});
