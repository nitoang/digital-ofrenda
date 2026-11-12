// Copies the component into site/ so that folder is everything you deploy (e.g. to Cloudflare Pages:
// build command `npm run build:site`, output directory `site`). server/, tests/ and the demo stay out.
//
// TURNSTILE_SITE_KEY (the public half of the Turnstile widget) is written into site/config.js when it is set. With
// `--require-turnstile` (the deploy workflow) a missing key stops the build: a site without it cannot sign anyone in.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function withSiteKey(config, key) {
  if (!/^[0-9A-Za-z_-]{8,80}$/.test(key)) throw new Error('TURNSTILE_SITE_KEY is not in the expected form');
  if (!/turnstileSiteKey: '',/.test(config)) throw new Error("site/config.js no longer has an empty turnstileSiteKey: '' to fill in");
  return config.replace(/turnstileSiteKey: '',/, `turnstileSiteKey: '${key}',`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const key = process.env.TURNSTILE_SITE_KEY;
    if (!key && process.argv.includes('--require-turnstile')) throw new Error('TURNSTILE_SITE_KEY is not set');
    copyFileSync(join(root, 'ofrenda.js'), join(root, 'site', 'ofrenda.js'));
    console.log('site/ofrenda.js updated');
    if (key) {
      const file = join(root, 'site', 'config.js');
      writeFileSync(file, withSiteKey(readFileSync(file, 'utf8'), key));
      console.log('site/config.js: Turnstile site key set');
    }
  } catch (e) { console.error('Build failed:', e.message); process.exit(1); }
}
