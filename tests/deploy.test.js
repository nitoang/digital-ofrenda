// Deployment scripts: the config rendered for Cloudflare, the site build, the secrets check and the smoke test.
// No network: Wrangler itself is not run here, only the files and checks the deploy workflow relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const example = fs.readFileSync(path.join(root, 'server', 'wrangler.example.toml'), 'utf8');
const GOOD = { D1_DATABASE_ID: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', APP_URL: 'https://ofrenda.example.com', ZONE_NAME: 'example.com' };
const lib = name => import('../scripts/' + name);

test('render: fills in the database, the address and the routes, and leaves no placeholder', async () => {
  const { render, ROUTES } = await lib('render-wrangler.mjs');
  const out = render(example, GOOD);
  assert.match(out, /database_id = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"/);
  assert.match(out, /APP_URL = "https:\/\/ofrenda\.example\.com"/);
  assert.doesNotMatch(out.replace(/^#.*$/gm, ''), /REPLACE/);
  const routes = [...out.matchAll(/\[\[routes\]\]\npattern = "([^"]+)"\nzone_name = "([^"]+)"/g)];
  assert.deepEqual(routes.map(m => m[1]), ROUTES.map(p => 'ofrenda.example.com' + p));
  assert.ok(routes.every(m => m[2] === 'example.com'));
  assert.ok(out.includes('crons = ["17 14 * * *"]') && out.includes('[observability]'), 'the rest of the config is kept');
});

test('render: the route list matches the one documented in the example config and the paths the Worker serves', async () => {
  const { ROUTES } = await lib('render-wrangler.mjs');
  const documented = /# Patterns: (.+)\n/.exec(example)[1].replace(/\(.*$/, '').trim().split(/\s+/);
  assert.deepEqual(documented, ROUTES);
  const worker = fs.readFileSync(path.join(root, 'server', 'worker.mjs'), 'utf8');
  for (const first of new Set(ROUTES.map(r => r.split('/')[1]))) assert.ok(worker.includes(`/${first.replace('*', '')}`) || first.startsWith('*'), `the Worker has no /${first}`);
});

test('render: variables land inside [vars], before any route, and only the ones that are set', async () => {
  const { render } = await lib('render-wrangler.mjs');
  const out = render(example, { ...GOOD, ALERT_EMAIL: 'me@example.com', HEARTBEAT_URL: 'https://hc-ping.com/abc-123', STRIPE_PRICE_PLATINUM: 'price_123', STRIPE_PRICE_SEVEN_TIERS: '' });
  const vars = out.slice(out.indexOf('\n[vars]'), out.indexOf('\n[[routes]]'));
  for (const line of ['ALERT_EMAIL = "me@example.com"', 'HEARTBEAT_URL = "https://hc-ping.com/abc-123"', 'STRIPE_PRICE_PLATINUM = "price_123"']) assert.ok(vars.includes(line), line);
  assert.doesNotMatch(out, /^STRIPE_PRICE_SEVEN_TIERS =/m, 'an empty variable is left out');
  assert.doesNotMatch(out, /^STRIPE_PRICE_EXTRA_PHOTOS =/m);
  assert.match(vars, /STARTER_OFRENDA = "1"/);
  assert.doesNotMatch(render(example, { ...GOOD, STARTER_OFRENDA: '0' }), /^STARTER_OFRENDA =/m);
});

test('render: the photo bucket is bound only when one is named', async () => {
  const { render } = await lib('render-wrangler.mjs');
  assert.doesNotMatch(render(example, GOOD), /r2_buckets/, 'no bucket named: wrangler would refuse a binding to one that does not exist');
  assert.match(render(example, { ...GOOD, PHOTOS_BUCKET: 'my-photos' }), /\[\[r2_buckets\]\]\nbinding = "PHOTOS"\nbucket_name = "my-photos"\n/);
});

test('render: refuses missing, malformed or hostile settings instead of writing a broken or injected config', async () => {
  const { render } = await lib('render-wrangler.mjs');
  const bad = [
    { ...GOOD, D1_DATABASE_ID: undefined }, { ...GOOD, D1_DATABASE_ID: 'REPLACE_WITH_YOUR_D1_DATABASE_ID' }, { ...GOOD, D1_DATABASE_ID: 'not-a-uuid' },
    { ...GOOD, APP_URL: 'http://ofrenda.example.com' }, { ...GOOD, APP_URL: 'https://ofrenda.example.com/' }, { ...GOOD, APP_URL: 'https://ofrenda.example.com/path' },
    { ...GOOD, ZONE_NAME: undefined }, { ...GOOD, ZONE_NAME: 'other.org' }, { ...GOOD, APP_URL: 'https://notexample.com' },
    { ...GOOD, ALERT_EMAIL: 'a@b.test"\n[vars]\nTURNSTILE_DISABLED = "1' }, { ...GOOD, ALERT_EMAIL: 'a b@x.test' }, { ...GOOD, HEARTBEAT_URL: 'http://hc-ping.com/x' },
    { ...GOOD, PHOTOS_BUCKET: 'Bad Bucket"' }, { ...GOOD, STARTER_OFRENDA: 'yes' },
    { ...GOOD, APP_URL: 'https://ofrenda.example.com\nTURNSTILE_DISABLED = "1' },
  ];
  for (const env of bad) assert.throws(() => render(example, env), Error, JSON.stringify(env));
  assert.throws(() => render(example.replace('binding = "PHOTOS"', 'binding = "OTHER"'), GOOD), /PHOTOS block/);
  assert.doesNotMatch(render(example, GOOD), /^TURNSTILE_DISABLED/m, 'development mode is never switched on by a deployment');
});

test('site build: the Turnstile site key is written into the config, and only a well-formed one', async () => {
  const { withSiteKey } = await lib('build-site.mjs');
  const config = fs.readFileSync(path.join(root, 'site', 'config.js'), 'utf8');
  assert.match(withSiteKey(config, '0x4AAAAAAAbcdEFGH_-12'), /turnstileSiteKey: '0x4AAAAAAAbcdEFGH_-12',/);
  for (const key of ['', 'short', "x'};alert(1);//xxxxxxxx", 'has space in it', 'a'.repeat(81)]) assert.throws(() => withSiteKey(config, key), /not in the expected form/, key);
  assert.throws(() => withSiteKey("turnstileSiteKey: 'already',", '0x4AAAAAAAbcd'), /empty turnstileSiteKey/);
});

test('site build: --require-turnstile stops a build that has no key, and the committed config stays empty', () => {
  const { spawnSync } = require('node:child_process');
  const run = (args, env) => spawnSync(process.execPath, ['scripts/build-site.mjs', ...args], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const refused = run(['--require-turnstile'], {});
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /TURNSTILE_SITE_KEY is not set/);
  assert.match(fs.readFileSync(path.join(root, 'site', 'config.js'), 'utf8'), /turnstileSiteKey: '',/, 'a refused build touches nothing');
  const copy = path.join(root, 'site', 'ofrenda.js'), had = fs.existsSync(copy);
  try { assert.equal(run([], {}).status, 0, 'local builds without a key still work'); }
  finally { if (!had) fs.rmSync(copy, { force: true }); } // the build copies the component into site/; do not leave it behind
});

test('secrets check: names the secrets that are missing, and treats an unreadable list as all missing', async () => {
  const { missing } = await lib('check-secrets.mjs');
  const list = JSON.stringify([{ name: 'TURNSTILE_SECRET', type: 'secret_text' }, { name: 'STRIPE_SECRET_KEY', type: 'secret_text' }]);
  assert.deepEqual(missing(list, ['TURNSTILE_SECRET', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY']), ['STRIPE_WEBHOOK_SECRET']);
  assert.deepEqual(missing('[]', ['A']), ['A']);
  assert.deepEqual(missing('Worker not found', ['A', 'B']), ['A', 'B']);
});

test('smoke test: passes for a healthy site and names what is wrong otherwise', async () => {
  const { check } = await lib('smoke.mjs');
  const site = ({ health = [200, { ok: true }], signin = [200, "default-src 'none'"] } = {}) => async url => {
    if (url.endsWith('/healthz')) return new Response(JSON.stringify(health[1]), { status: health[0] });
    return new Response('<html>', { status: signin[0], headers: signin[1] ? { 'content-security-policy': signin[1] } : {} });
  };
  assert.deepEqual(await check('https://x.test', site()), []);
  assert.match((await check('https://x.test', site({ health: [503, { ok: false, config: 'x' }] }))).join(), /healthz answered 503/);
  assert.match((await check('https://x.test', site({ health: [200, { ok: false }] }))).join(), /healthz answered 200/);
  assert.match((await check('https://x.test', site({ signin: [404, null] }))).join(), /signin answered 404/);
  assert.match((await check('https://x.test', site({ signin: [200, null] }))).join(), /_headers file was not deployed/);
});

test('deploy workflow: runs the tests first, then migrations, the mailer, the API, then the site, and does nothing until enabled', () => {
  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const order = ['uses: ./.github/workflows/test.yml', 'd1 migrations apply', 'deploy --config mailer/wrangler.toml', 'deploy --config server/wrangler.toml', 'pages deploy', 'scripts/smoke.mjs'];
  const at = order.map(s => yml.indexOf(s));
  assert.ok(at.every(i => i >= 0), `missing step: ${order.filter((s, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps are in the order the mailer and database must exist');
  assert.match(yml, /if: vars\.DEPLOY_ENABLED == 'true'/);
  assert.match(yml, /needs: tests/);
  assert.match(yml, /--require-turnstile/);
  assert.doesNotMatch(yml, /TURNSTILE_DISABLED/);
  assert.match(fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8'), /workflow_call:/);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^server\/wrangler\.toml$/m, 'the rendered config is never committed');
});
