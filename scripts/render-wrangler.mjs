// Turns server/wrangler.example.toml into the real server/wrangler.toml for a deployment, from settings in the
// environment (GitHub Actions variables, in the deploy workflow). The result is never committed (.gitignore).
//
//   D1_DATABASE_ID   required  the id from `wrangler d1 create digital-ofrenda`
//   APP_URL          required  https://your-site, no path; its hostname is where the routes below go
//   ZONE_NAME        required  the Cloudflare zone that hostname belongs to (for example example.com)
//   PHOTOS_BUCKET    optional  an R2 bucket name. Without it no bucket is bound and photos stay inline in D1.
//   STARTER_OFRENDA  optional  "0" turns off the starter ofrenda for new accounts (default on)
//   STRIPE_PRICE_EXTRA_PHOTOS, STRIPE_PRICE_SEVEN_TIERS, STRIPE_PRICE_PLATINUM, ALERT_EMAIL, HEARTBEAT_URL   optional
//
// Secrets are not handled here; they live in Cloudflare (`wrangler secret put`), see the README.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The paths the Worker answers on the site's hostname; Pages serves everything else. A test keeps this in step
// with the list in wrangler.example.toml.
export const ROUTES = ['/auth/*', '/me', '/me/*', '/checkout', '/ofrendas', '/ofrendas/*', '/invites/*', '/successor/*', '/stripe/*', '/resend/*', '/s/*', '/healthz'];

const OPTIONAL_VARS = ['STRIPE_PRICE_EXTRA_PHOTOS', 'STRIPE_PRICE_SEVEN_TIERS', 'STRIPE_PRICE_PLATINUM', 'ALERT_EMAIL', 'HEARTBEAT_URL'];
const SAFE = /^[A-Za-z0-9@._:/+=-]{1,300}$/; // nothing that could close a TOML string or start a new line
const must = (name, value, re) => {
  if (typeof value !== 'string' || !SAFE.test(value) || (re && !re.test(value))) throw new Error(`${name} is missing or not in the expected form`);
  return value;
};

export function render(example, env) {
  const id = must('D1_DATABASE_ID', env.D1_DATABASE_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const appUrl = must('APP_URL', env.APP_URL, /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i);
  const zone = must('ZONE_NAME', env.ZONE_NAME, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i);
  const host = appUrl.slice('https://'.length);
  if (host !== zone && !host.endsWith('.' + zone)) throw new Error('APP_URL must be on the ZONE_NAME zone');

  let out = example.replace('REPLACE_WITH_YOUR_D1_DATABASE_ID', id).replace('https://REPLACE-WITH-YOUR-SITE', appUrl);

  // The R2 block is only kept when a bucket is named: wrangler refuses to deploy a binding to a bucket that does not exist.
  const block = /\[\[r2_buckets\]\]\nbinding = "PHOTOS"\nbucket_name = "[^"\n]*"\n/;
  if (!block.test(out)) throw new Error('wrangler.example.toml no longer has the expected PHOTOS block');
  out = out.replace(block, env.PHOTOS_BUCKET ? `[[r2_buckets]]\nbinding = "PHOTOS"\nbucket_name = "${must('PHOTOS_BUCKET', env.PHOTOS_BUCKET, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)}"\n` : '');

  if (env.STARTER_OFRENDA === '0') out = out.replace(/^STARTER_OFRENDA = "1"\n/m, '');
  else if (env.STARTER_OFRENDA !== undefined && env.STARTER_OFRENDA !== '' && env.STARTER_OFRENDA !== '1') throw new Error('STARTER_OFRENDA must be 0 or 1');

  const extra = OPTIONAL_VARS.filter(k => env[k]).map(k => `${k} = "${must(k, env[k], k === 'HEARTBEAT_URL' ? /^https:\/\// : undefined)}"\n`).join('');
  out = out.replace(/^(APP_URL = "[^"\n]*"\n)/m, `$1${extra}`);

  out = out.replace(/\s*$/, '\n') + '\n# Added by scripts/render-wrangler.mjs: the Worker answers these paths on the site\'s hostname.\n'
    + ROUTES.map(p => `[[routes]]\npattern = "${host}${p}"\nzone_name = "${zone}"\n`).join('\n');

  if (/REPLACE/.test(out.replace(/^#.*$/gm, ''))) throw new Error('a placeholder is left in the rendered config');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
  try {
    writeFileSync(join(dir, 'wrangler.toml'), render(readFileSync(join(dir, 'wrangler.example.toml'), 'utf8'), process.env));
    console.log('server/wrangler.toml written');
  } catch (e) { console.error('Cannot write server/wrangler.toml:', e.message); process.exit(1); }
}
