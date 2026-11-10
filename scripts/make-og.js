// Draws site/og.png, the one generic picture every link preview uses (1200x630). Run: node scripts/make-og.js
// It is the same for every ofrenda on purpose: a preview must never show a photo from an altar or a name.
const path = require('node:path');
const { chromium } = require('playwright');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; background: #f4ead8; color: #2a1640; font-family: Georgia, serif; position: relative; overflow: hidden; }
  .band { position: absolute; left: 0; right: 0; bottom: 0; height: 150px; background: #6c3bb0; }
  .dot { position: absolute; border-radius: 50%; background: #e0742e; }
  h1 { position: absolute; left: 90px; top: 190px; font-size: 128px; font-weight: normal; letter-spacing: -2px; }
  p { position: absolute; left: 96px; top: 360px; font-size: 44px; color: #5b4a6e; }
  .foot { position: absolute; left: 96px; bottom: 52px; font: 34px system-ui, sans-serif; color: #fff; }
</style>
<div class="band"></div>
<div class="dot" style="left:840px;top:50px;width:120px;height:120px"></div>
<div class="dot" style="left:990px;top:100px;width:80px;height:80px;opacity:.8"></div>
<div class="dot" style="left:920px;top:190px;width:130px;height:130px;opacity:.9"></div>
<div class="dot" style="left:1080px;top:250px;width:70px;height:70px;opacity:.7"></div>
<h1>Digifrenda</h1>
<p>A digital ofrenda to remember someone you love.</p>
<div class="foot">Light a candle. Add a photo. Share it with family.</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(__dirname, '..', 'site', 'og.png') });
  await browser.close();
  console.log('site/og.png written');
})();
