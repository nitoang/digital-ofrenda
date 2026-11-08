// A local copy of the whole product for browser tests: the static site from site/ (served with the real
// _headers and _redirects), and the real Worker code answering the API paths, on SQLite. Mail lands in
// `sent`; time is controllable with tick(), so "180 days later" takes no time.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { d1 } = require('./d1');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const isApi = p => p === '/me' || p === '/ofrendas' || /^\/(auth|ofrendas|invites|successor|stripe)\//.test(p);

// Cloudflare Pages _headers: indented "Name: value" lines under a path line. Only "/*" is used here.
function readHeaders() {
  const out = {};
  let on = false;
  for (const line of fs.readFileSync(path.join(SITE, '_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { on = line.trim() === '/*'; continue; }
    const i = line.indexOf(':');
    if (on && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
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

async function startSite({ env: envOver = {}, port = 0, onMail } = {}) {
  const w = await import('../server/worker.mjs');
  const store = await import('../server/store.mjs');
  const { RULES } = await import('../server/rules.mjs');
  const sent = [];
  let offset = 0;
  const env = { DB: d1(), APP_URL: 'http://localhost', TURNSTILE_DISABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...envOver };
  const handler = w.createHandler({ now: () => Date.now() + offset, mailer: { send: async m => { sent.push(m); onMail?.(m); } }, defer: p => void p.catch(() => {}) });
  const headers = readHeaders();
  const rewrites = readRewrites();
  let origin = '';

  const server = http.createServer(async (req, res) => {
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
      if (!f) { res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { ...headers, 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('server error');
    }
  });
  await new Promise(r => server.listen(port, r));
  origin = 'http://localhost:' + server.address().port;
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
    url: origin, env, sent, store, RULES, db: env.DB.raw, headers,
    tick: ms => { offset += ms; },
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
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { startSite };
