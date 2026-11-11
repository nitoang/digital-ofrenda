// Shared setup for the browser tests. Pages are loaded straight from disk (no server needed).
const playwright = require('playwright');

// Which browser engine the browser tests drive: BROWSER=chromium (default), firefox or webkit. CI runs all three.
const BROWSER = process.env.BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(BROWSER)) throw new Error(`BROWSER must be chromium, firefox or webkit, not "${BROWSER}"`);
const engine = playwright[BROWSER];
// Real touch events (swipe-to-scroll, drag handles with a finger) are sent through the Chrome DevTools Protocol,
// which only Chromium has. Firefox cannot emulate a phone at all, and WebKit has no way to send touch moves.
const TOUCH_SKIP = BROWSER !== 'chromium' && 'real touch events need the Chrome DevTools Protocol (Chromium only)';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const url = (file = 'index.html') => 'file://' + path.join(root, file);

// A 1x1 PNG, enough to exercise the photo pipeline.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A solid-colour PNG of any size, built by hand so no image library is needed.
function solidPng(w, h, r, g, b) {
  const zlib = require('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function launch() {
  const browser = await engine.launch();
  const errors = [];
  // Opens a page with a single empty edit-mode altar so localStorage state never leaks between tests.
  async function altar({ attrs = '', features, state, touch = false } = {}) {
    const ctx = await browser.newContext(touch
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } // a phone: coarse pointer, touch events
      : { viewport: { width: 900, height: 1200 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
    await page.addInitScript(({ features, state }) => {
      if (features) window.__features = features;
      if (state && !localStorage.getItem('ofrenda:t')) localStorage.setItem('ofrenda:t', JSON.stringify(state));
    }, { features, state });
    await page.goto(url('tests/blank.html'));
    await page.evaluate(attrs => {
      if (window.__features) customElements.get('digital-ofrenda').features = window.__features;
      document.body.insertAdjacentHTML('beforeend', `<digital-ofrenda id="t" mode="edit" ${attrs}></digital-ofrenda>`);
    }, attrs);
    return { page, ctx, el: page.locator('digital-ofrenda#t') };
  }
  return { browser, errors, altar, close: () => browser.close() };
}

function tmpFile(name, contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ofrenda-')), name);
  fs.writeFileSync(p, contents);
  return p;
}

module.exports = { launch, url, PNG, tmpFile, solidPng, BROWSER, engine, TOUCH_SKIP };
