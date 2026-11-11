// A local copy of the whole product for browser tests: the static site from site/ (served with the real
// _headers and _redirects), and the real Worker code answering the API paths, on SQLite. Mail lands in
// `sent`; time is controllable with tick(), so "180 days later" takes no time.
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { d1 } = require('./d1');
const { fakeR2 } = require('./r2');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const isApi = p => p === '/me' || p === '/checkout' || p === '/ofrendas' || p === '/healthz' || /^\/(auth|me|ofrendas|invites|successor|stripe|resend|s)\//.test(p);

// Cloudflare Pages _headers: a path line, then indented "Name: value" lines. "/*" applies everywhere and "/a/*" to
// anything under /a/. headersFor(pathname) gives what Pages would send for that path.
function readHeaderRules() {
  const rules = [];
  let current = null;
  for (const line of fs.readFileSync(path.join(SITE, '_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = { prefix: line.trim().replace(/\*$/, ''), headers: {} }; rules.push(current); continue; }
    const i = line.indexOf(':');
    if (current && i > 0) current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return pathname => Object.assign({}, ...rules.filter(r => pathname.startsWith(r.prefix)).map(r => r.headers));
}

// _redirects: "from to status"; :name matches one path segment. Status 200 means rewrite.
function readRewrites() {
  return fs.readFileSync(path.join(SITE, '_redirects'), 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => { const [from, to, status] = l.split(/\s+/); return { re: new RegExp('^' + from.replace(/:[A-Za-z]+/g, '[^/]+') + '$'), to, status }; })
    .filter(r => r.status === '200');
}

function resolveFile(pathname, rewrites) {
  let p = pathname;
  for (const r of rewrites) if (r.re.test(p)) { p = r.to; break; }
  if (p === '/') p = '/index.html';
  const candidates = [p, p + '.html', p + '/index.html'];
  for (const c of candidates) {
    const f = path.normalize(path.join(SITE, c));
    if (f.startsWith(SITE + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  const component = path.join(ROOT, 'ofrenda.js'); // the deploy build copies it into site/; tests read it directly
  return p === '/ofrenda.js' ? component : null;
}

// The session cookie is "__Host-...; Secure", which Safari's engine (WebKit) refuses to keep on plain http://localhost
// (Chrome and Firefox make an exception for localhost). So the browser tests serve the site over https with a throwaway
// self-signed certificate, and the test browsers are told to accept it. That is also closer to production.
let certificate = null;
function selfSigned() {
  if (certificate) return certificate;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofrenda-tls-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  certificate = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return certificate;
}

const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_EXTRA_PHOTOS: 'price_photos', STRIPE_PRICE_SEVEN_TIERS: 'price_tiers', STRIPE_PRICE_PLATINUM: 'price_platinum' };

// photos: true (the default) gives the Worker an in-memory photo bucket (R2), the way a real deployment keeps photos;
// false leaves photos inline in the database. tls: true serves https with a throwaway certificate (browsers must ignore certificate errors). stripe: true makes purchases available, answered by a stand-in for Stripe that records what it was asked.
async function startSite({ env: envOver = {}, port = 0, onMail, stripe = false, tls = false, photos = true } = {}) {
  const w = await import('../server/worker.mjs');
  const store = await import('../server/store.mjs');
  const { RULES } = await import('../server/rules.mjs');
  const sent = [];
  let offset = 0;
  const env = { DB: d1(), ...(photos ? { PHOTOS: fakeR2() } : {}), APP_URL: 'http://localhost', TURNSTILE_DISABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...(stripe ? STRIPE_ENV : {}), ...envOver };
  const stripeCalls = [];
  const fakeFetch = async (url, init) => {
    if (!String(url).startsWith('https://api.stripe.com/')) return fetch(url, init);
    stripeCalls.push(Object.fromEntries(init.body));
    const n = stripeCalls.length;
    return new Response(JSON.stringify({ id: 'cs_test_' + n, url: 'https://checkout.stripe.com/c/pay/cs_test_' + n }));
  };
  const handler = w.createHandler({ fetch: fakeFetch, now: () => Date.now() + offset, mailer: { send: async m => { sent.push(m); onMail?.(m); } }, defer: p => void p.catch(() => {}) });
  const headersFor = readHeaderRules();
  const headers = headersFor('/'); // what every page gets
  const rewrites = readRewrites();
  let origin = '';

  const listener = async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (isApi(url.pathname)) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const r = await handler(new Request(origin + req.url, { method: req.method, headers: req.headers, body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined }), env);
        const out = {};
        r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
        const cookies = r.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const f = resolveFile(url.pathname, rewrites);
      if (!f) { res.writeHead(404, { ...headersFor(url.pathname), 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { ...headersFor(url.pathname), 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('server error');
    }
  };
  const server = tls ? https.createServer(selfSigned(), listener) : http.createServer(listener);
  await new Promise(r => server.listen(port, r));
  origin = `${tls ? 'https' : 'http'}://localhost:${server.address().port}`;
  env.APP_URL = origin;

  const until = async (fn, what, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await new Promise(r => setTimeout(r, 25));
    }
  };

  return {
    url: origin, env, sent, store, RULES, db: env.DB.raw, headers, stripeCalls,
    tick: ms => { offset += ms; },
    // Stripe telling the webhook that the person paid for the checkout session described by `form`.
    async pay(form, type = 'checkout.session.completed') {
      const body = JSON.stringify({ type, data: { object: { payment_status: 'paid', client_reference_id: form.client_reference_id, metadata: { feature: form['metadata[feature]'] } } } });
      const t = Math.floor((Date.now() + offset) / 1000);
      const mac = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
      const r = await handler(new Request(origin + '/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${mac}` }, body }), env);
      if (!r.ok) throw new Error('webhook refused: ' + r.status);
    },
    // The 6-digit code in the newest mail to `email` after index `from`.
    codeFor: (email, from = 0) => until(() => {
      const m = sent.slice(from).reverse().find(x => x.to === email.toLowerCase() && /\d{6}/.test(x.subject));
      return m && /(\d{6})/.exec(m.subject)[1];
    }, `a sign-in code for ${email}`),
    // The first capture group of `re` in the newest mail to `email` whose text matches it.
    linkFrom: (email, re) => until(() => {
      const m = sent.slice().reverse().find(x => x.to === email.toLowerCase() && re.test(x.text));
      return m && re.exec(m.text)[1];
    }, `an email to ${email} matching ${re}`),
    mail: (email, re) => until(() => sent.find(x => x.to === email.toLowerCase() && re.test(x.subject)), `a mail to ${email} about ${re}`),
    // Closes for good, even if a browser page still holds a connection open: a failing test must report, not hang.
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
  };
}

module.exports = { startSite };
