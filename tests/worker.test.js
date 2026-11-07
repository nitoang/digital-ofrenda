// Worker tests. No browser and no network: the handler runs with a fake clock, mailer and Turnstile, and
// its SQL runs on SQLite through tests/d1.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { solidPng } = require('./helpers');
const { d1 } = require('./d1');

console.error = () => {}; // the Worker logs server-side problems; keep test output readable

const png = () => 'data:image/png;base64,' + solidPng(2, 2, 200, 10, 10).toString('base64');
const frame = (id, src) => ({ id, type: 'photo', x: 50, y: 24, ...(src ? { src } : {}) });
const altar = (...items) => ({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela', items });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 3_600_000;

async function setup({ env: envOver = {}, deps: depsOver = {} } = {}) {
  const w = await import('../server/worker.mjs');
  const store = await import('../server/store.mjs');
  const sent = [], deferred = [];
  let clock = 1_700_000_000_000;
  const deps = { now: () => clock, mailer: { send: async m => void sent.push(m) }, defer: p => void deferred.push(p), ...depsOver };
  const env = { DB: d1(), APP_URL: 'https://ofrenda.test', TURNSTILE_DISABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...envOver };
  const handler = w.createHandler(deps);
  const t = {
    w, store, env, sent, db: env.DB?.raw,
    tick: ms => { clock += ms; },
    now: () => clock,
    settle: async () => { await Promise.all(deferred.splice(0)); },
    call: (method, path, { body, token, headers } = {}) => handler(new Request('https://api.test' + path, {
      method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env),
    async signup(email = 'maria@example.com') {
      const res = await t.call('POST', '/ofrendas', { body: { email } });
      assert.equal(res.status, 201);
      return res.json();
    },
    async verified(email) {
      const a = await t.signup(email);
      await t.settle();
      const tok = /#v=([\w-]+)/.exec(sent.at(-1).text)[1];
      assert.equal((await t.call('POST', `/ofrendas/${a.id}/verify`, { body: { token: tok } })).status, 200);
      return a;
    },
    async recoveryLinks(email) {
      const before = sent.length;
      await t.call('POST', '/recover', { body: { email } });
      await t.settle();
      return sent.slice(before).flatMap(m => [...m.text.matchAll(/\/a\/([a-z2-7]+)#r=([\w-]+)/g)].map(x => ({ id: x[1], token: x[2], msg: m })));
    },
    put: (a, state, token = a.token) => t.call('PUT', `/ofrendas/${a.id}`, { body: state, token }),
    grant: (id, name) => t.db.prepare('INSERT INTO features (altar_id, name, granted_at) VALUES (?, ?, 0)').run(id, name),
    sign: (body, secret = 'whsec_test', offset = 0) => {
      const ts = Math.floor(clock / 1000) + offset;
      return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    },
  };
  return t;
}

// ---------- signup ----------

test('signup: returns an id and a one-time token, stores only a hash, normalizes the email', async () => {
  const t = await setup();
  const res = await t.call('POST', '/ofrendas', { body: { email: '  Maria@Example.COM ' } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const a = await res.json();
  assert.match(a.id, /^[a-z2-7]{12}$/);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.emailQueued, true);
  const row = t.db.prepare('SELECT * FROM altars WHERE id = ?').get(a.id);
  assert.equal(row.token_hash, sha(a.token));
  assert.equal(row.email, 'maria@example.com');
  assert.equal(row.email_verified_at, null);
  assert.equal(row.state, null);
  const everything = JSON.stringify([t.db.prepare('SELECT * FROM altars').all(), t.db.prepare('SELECT * FROM email_tokens').all()]);
  assert.ok(!everything.includes(a.token), 'the edit token is never stored');
  const b = await t.signup();
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.token, b.token);
});

test('signup: sends a confirmation email that carries a link but never the edit token', async () => {
  const t = await setup();
  const a = await t.signup();
  await t.settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'maria@example.com');
  assert.match(t.sent[0].text, new RegExp(`https://ofrenda\\.test/a/${a.id}#v=[\\w-]{43}`));
  assert.ok(!t.sent[0].text.includes(a.token));
});

test('signup: a failing mailer does not fail signup', async () => {
  const t = await setup({ deps: { mailer: { send: async () => { throw new Error('provider down'); } } } });
  const a = await t.signup();
  await t.settle(); // must not reject
  assert.ok(a.id);
});

test('signup: rejects bad emails and bad bodies, and creates nothing', async () => {
  const t = await setup();
  for (const email of ['nope', 'a@b', 'a b@c.com', '', 5, null, 'a@b.c', 'x'.repeat(300) + '@a.com', 'a@b.com\nbcc:x@y.com', '<a@b.com>']) {
    const res = await t.call('POST', '/ofrendas', { body: { email } });
    assert.equal(res.status, 400, String(email).slice(0, 30));
    assert.equal((await res.json()).error, 'bad_email');
  }
  assert.equal((await t.call('POST', '/ofrendas', { body: '{nope' })).status, 400);
  assert.equal((await t.call('POST', '/ofrendas', { body: '[]' })).status, 400);
  assert.equal((await t.call('POST', '/ofrendas', { body: JSON.stringify({ email: 'a@b.com', pad: 'x'.repeat(20_000) }) })).status, 413);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altars').get().n, 0);
  assert.equal(t.sent.length, 0);
});

test('signup: Turnstile is checked and fails closed', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, form: Object.fromEntries(init.body) }); return new Response(JSON.stringify({ success: calls.length !== 1 })); };
  const t = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 'ts-secret' }, deps: { fetch } });
  const go = turnstile => t.call('POST', '/ofrendas', { body: { email: 'a@b.com', turnstile }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal((await go(undefined)).status, 403, 'no token');
  assert.equal(calls.length, 0, 'no token means no lookup');
  assert.equal((await go('bad-token')).status, 403, 'Turnstile says no');
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.deepEqual(calls[0].form, { secret: 'ts-secret', response: 'bad-token', remoteip: '203.0.113.9' });
  assert.equal((await go('good-token')).status, 201);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altars').get().n, 1);

  const down = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 's' }, deps: { fetch: async () => { throw new Error('offline'); } } });
  assert.equal((await down.call('POST', '/ofrendas', { body: { email: 'a@b.com', turnstile: 'x' } })).status, 403, 'a lookup failure refuses');
  const recover = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 's' }, deps: { fetch: async () => new Response('{"success":false}') } });
  assert.equal((await recover.call('POST', '/recover', { body: { email: 'a@b.com', turnstile: 'x' } })).status, 403, 'recovery is protected too');
});

test('signup: refuses to run when misconfigured', async () => {
  for (const [what, opts] of [
    ['no Turnstile secret and not in dev mode', { env: { TURNSTILE_DISABLED: undefined } }],
    ['APP_URL missing', { env: { APP_URL: undefined } }],
    ['APP_URL not https', { env: { APP_URL: 'http://evil.test' } }],
    ['APP_URL with a path', { env: { APP_URL: 'https://x.test/path' } }],
    ['no mailer', { deps: { mailer: null } }],
  ]) {
    const t = await setup(opts);
    const res = await t.call('POST', '/ofrendas', { body: { email: 'a@b.com' } });
    assert.equal(res.status, 500, what);
    assert.equal((await res.json()).error, 'misconfigured');
  }
  const t = await setup({ env: { DB: undefined } });
  assert.equal((await t.call('GET', '/ofrendas/abc')).status, 500);
});

// ---------- reading and saving ----------

test('saving: needs the right token; GET is public and leaks nothing private', async () => {
  const t = await setup();
  const a = await t.signup();
  assert.equal((await t.call('GET', `/ofrendas/${a.id}`)).status, 404, 'nothing saved yet');
  assert.equal((await t.call('PUT', `/ofrendas/${a.id}`, { body: altar() })).status, 403);
  assert.equal((await t.put(a, altar(), 'wrong-token-1234567890')).status, 403);
  assert.equal((await t.put(a, altar(), 'short')).status, 403);
  assert.equal((await t.call('PUT', '/ofrendas/zzzzzzzzzzzz', { body: altar(), token: a.token })).status, 403, 'unknown altar');
  assert.equal((await t.put(a, altar(frame('a', png())))).status, 200);
  const got = await t.call('GET', `/ofrendas/${a.id}`);
  const text = await got.text();
  assert.equal(JSON.parse(text).items.length, 1);
  assert.ok(!/maria|example\.com|token|hash/i.test(text), 'no email or credentials in the public response');
  const other = await t.signup('other@example.com');
  assert.equal((await t.put(a, altar(), other.token)).status, 403, "another altar's token does not work here");
});

test('saving: bad json and oversized bodies are refused', async () => {
  const t = await setup();
  const a = await t.signup();
  assert.equal((await t.put(a, '{nope')).status, 400);
  assert.equal((await t.put(a, 'x'.repeat(t.w.MAX_BODY_BYTES + 1))).status, 413);
  assert.equal(t.db.prepare('SELECT state FROM altars WHERE id = ?').get(a.id).state, null);
});

test('saving: the photo cap is enforced from the features table, and lapsed altars keep what they have', async () => {
  const t = await setup();
  const a = await t.signup();
  const two = altar(frame('a', png()), frame('b', png()));
  const three = altar(frame('a', png()), frame('b', png()), frame('c', png()));
  assert.equal((await t.put(a, two)).status, 200);
  const blocked = await t.put(a, three);
  assert.equal(blocked.status, 402);
  assert.equal((await blocked.json()).upgrade, 'extraPhotos');
  assert.equal(JSON.parse(t.db.prepare('SELECT state FROM altars WHERE id = ?').get(a.id).state).items.length, 2);
  assert.equal((await t.put(a, { ...three, paid: true, entitlements: { extraPhotos: true } })).status, 402, 'the request cannot grant itself an upgrade');
  t.grant(a.id, 'sevenTiers');
  assert.equal((await t.put(a, three)).status, 402, 'the tiers upgrade does not unlock photos');
  t.grant(a.id, 'extraPhotos');
  assert.equal((await t.put(a, three)).status, 200);
  t.db.prepare('DELETE FROM features WHERE altar_id = ?').run(a.id); // refunded
  assert.equal((await t.put(a, three)).status, 200, 'keeps the 3 it has');
  assert.equal((await t.put(a, altar(...'abcd'.split('').map(i => frame(i, png()))))).status, 402, 'cannot add a 4th');
});

test('saving: seven tiers are enforced per altar', async () => {
  const t = await setup();
  const a = await t.signup();
  const b = await t.signup('b@example.com');
  const seven = { ...altar(), tiers: 7 };
  const denied = await t.put(a, seven);
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).upgrade, 'sevenTiers');
  t.grant(a.id, 'extraPhotos');
  assert.equal((await t.put(a, seven)).status, 402, 'photos upgrade does not unlock tiers');
  t.grant(a.id, 'sevenTiers');
  assert.equal((await t.put(a, seven)).status, 200);
  t.db.prepare('DELETE FROM features').run();
  assert.equal((await t.put(a, seven)).status, 200, 'keeps 7 after a refund');
  assert.equal((await t.put(b, seven)).status, 402, 'a different altar is unaffected');
});

// ---------- email confirmation ----------

test('confirmation: the emailed token works once, only for its own altar', async () => {
  const t = await setup();
  const a = await t.signup();
  const b = await t.signup('b@example.com');
  await t.settle();
  const tokA = /#v=([\w-]+)/.exec(t.sent[0].text)[1];
  const verify = (id, token) => t.call('POST', `/ofrendas/${id}/verify`, { body: { token } });
  assert.equal((await verify(b.id, tokA)).status, 400, "not another altar's");
  assert.equal((await verify(a.id, 'garbage')).status, 400);
  assert.equal((await verify(a.id, 5)).status, 400);
  assert.equal(t.db.prepare('SELECT email_verified_at v FROM altars WHERE id = ?').get(a.id).v, null);
  assert.equal((await verify(a.id, tokA)).status, 200);
  assert.equal(t.db.prepare('SELECT email_verified_at v FROM altars WHERE id = ?').get(a.id).v, t.now());
  assert.equal((await verify(a.id, tokA)).status, 400, 'single use');
});

test('confirmation: expires after 24 hours; recovery tokens cannot confirm', async () => {
  const t = await setup();
  const a = await t.signup();
  await t.settle();
  const tok = /#v=([\w-]+)/.exec(t.sent[0].text)[1];
  t.tick(24 * HOUR + 1);
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/verify`, { body: { token: tok } })).status, 400);

  const v = await t.verified('v@example.com');
  const [link] = await t.recoveryLinks('v@example.com');
  assert.equal(link.id, v.id);
  assert.equal((await t.call('POST', `/ofrendas/${v.id}/verify`, { body: { token: link.token } })).status, 400, 'wrong purpose');
  assert.equal((await t.call('POST', `/ofrendas/${v.id}/recover`, { body: { token: link.token } })).status, 200, 'and it is still usable for recovery');
});

test('confirmation: resend needs the edit token and is limited per email', async () => {
  const t = await setup();
  const a = await t.signup(); // 1st mail
  const resend = token => t.call('POST', `/ofrendas/${a.id}/verify/resend`, { token });
  assert.equal((await resend()).status, 403);
  assert.equal((await resend('wrong-token-1234567890')).status, 403);
  assert.equal((await (await resend(a.token)).json()).emailQueued, true); // 2nd
  assert.equal((await (await resend(a.token)).json()).emailQueued, true); // 3rd
  assert.equal((await (await resend(a.token)).json()).emailQueued, false, '4th within an hour is held back');
  await t.settle();
  assert.equal(t.sent.length, 3);
  t.tick(HOUR + 1);
  assert.equal((await (await resend(a.token)).json()).emailQueued, true);
  const v = await t.verified('v@example.com');
  const before = t.sent.length;
  assert.deepEqual(await (await t.call('POST', `/ofrendas/${v.id}/verify/resend`, { token: v.token })).json(), { verified: true });
  await t.settle();
  assert.equal(t.sent.length, before, 'nothing to resend once confirmed');
});

// ---------- recovery ----------

test('recovery: every request gets the same answer, and only confirmed addresses get a link', async () => {
  const t = await setup();
  await t.signup('unconfirmed@example.com');
  await t.verified('confirmed@example.com');
  t.sent.length = 0;
  const ask = async email => { const r = await t.call('POST', '/recover', { body: { email } }); await t.settle(); return [r.status, await r.text()]; };
  const unknown = await ask('nobody@example.com');
  const unconfirmed = await ask('unconfirmed@example.com');
  assert.equal(t.sent.length, 0, 'unknown and unconfirmed addresses get nothing');
  const confirmed = await ask('Confirmed@Example.com');
  assert.deepEqual(unknown, [200, '{"ok":true}']);
  assert.deepEqual(unconfirmed, unknown);
  assert.deepEqual(confirmed, unknown, 'the response never reveals whether an address is registered');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'confirmed@example.com');
  assert.equal((await t.call('POST', '/recover', { body: { email: 'not an email' } })).status, 400);
});

test('recovery: the email lists one link per confirmed altar, capped, with no edit token in it', async () => {
  const t = await setup();
  const first = await t.verified('family@example.com');
  const second = await t.verified('family@example.com');
  await t.signup('family@example.com'); // unconfirmed: not offered
  const links = await t.recoveryLinks('family@example.com');
  assert.deepEqual(links.map(l => l.id).sort(), [first.id, second.id].sort());
  assert.equal(new Set(links.map(l => l.msg)).size, 1, 'one email');
  for (const l of links) assert.ok(!l.msg.text.includes(first.token) && !l.msg.text.includes(second.token));

  const many = await setup();
  for (let i = 0; i < 12; i++) { await many.verified('big@example.com'); many.tick(HOUR + 1); } // signup mail is limited to 3 per email per hour
  assert.equal((await many.recoveryLinks('big@example.com')).length, 10);
});

test('recovery: requests are limited per email address', async () => {
  const t = await setup();
  await t.verified('one@example.com');
  let mails = 0;
  for (let i = 0; i < 25; i++) mails += (await t.recoveryLinks('one@example.com')).length ? 1 : 0;
  assert.equal(mails, 20);
  t.tick(HOUR + 1);
  assert.equal((await t.recoveryLinks('one@example.com')).length, 1);
});

test('recovery: the link gives a new edit token and kills the old one', async () => {
  const t = await setup();
  const a = await t.verified('maria@example.com');
  assert.equal((await t.put(a, altar(frame('a', png())))).status, 200);
  const [link] = await t.recoveryLinks('maria@example.com');
  const redeem = (id = a.id, token = link.token) => t.call('POST', `/ofrendas/${id}/recover`, { body: { token } });
  assert.equal((await redeem('zzzzzzzzzzzz')).status, 400, 'wrong altar');
  assert.equal((await redeem(a.id, 'garbage')).status, 400);
  const res = await redeem();
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.db.prepare('SELECT token_hash h FROM altars WHERE id = ?').get(a.id).h, sha(token));
  assert.equal((await t.put(a, altar(), a.token)).status, 403, 'the old link is dead');
  assert.equal((await t.put(a, altar(frame('a', png())), token)).status, 200);
  assert.equal((await redeem()).status, 400, 'single use');
});

test('recovery: links expire after 30 minutes, race safely, and cancel each other', async () => {
  const t = await setup();
  const a = await t.verified('maria@example.com');
  const [late] = await t.recoveryLinks('maria@example.com');
  t.tick(30 * 60_000 + 1);
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/recover`, { body: { token: late.token } })).status, 400, 'expired');

  const [x] = await t.recoveryLinks('maria@example.com');
  const [y] = await t.recoveryLinks('maria@example.com');
  const results = await Promise.all([x, x].map(l => t.call('POST', `/ofrendas/${a.id}/recover`, { body: { token: l.token } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400], 'two simultaneous uses: exactly one wins');
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/recover`, { body: { token: y.token } })).status, 400, 'using one cancels the others');
});

// ---------- rotating the token ----------

test('rotate: needs the current token, swaps it, and cancels pending recovery links', async () => {
  const t = await setup();
  const a = await t.verified('maria@example.com');
  const [link] = await t.recoveryLinks('maria@example.com');
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/rotate`)).status, 403);
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/rotate`, { token: 'wrong-token-1234567890' })).status, 403);
  const res = await t.call('POST', `/ofrendas/${a.id}/rotate`, { token: a.token });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.notEqual(token, a.token);
  assert.equal((await t.put(a, altar(), a.token)).status, 403);
  assert.equal((await t.put(a, altar(), token)).status, 200);
  assert.equal((await t.call('POST', `/ofrendas/${a.id}/recover`, { body: { token: link.token } })).status, 400);
});

// ---------- Stripe ----------

const checkout = (over = {}) => JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: 'REF', metadata: { feature: 'sevenTiers' }, ...over } } });

test('stripe: only valid, fresh, paid events with a known feature unlock anything', async () => {
  const t = await setup();
  const a = await t.signup();
  const post = (body, sig) => t.call('POST', '/stripe/webhook', { body, headers: { 'stripe-signature': sig } });
  const body = checkout({ client_reference_id: a.id });
  const rows = () => t.db.prepare('SELECT altar_id, name FROM features').all().map(r => ({ ...r }));
  assert.equal((await post(body, 't=1,v1=00')).status, 400);
  assert.equal((await post(body, t.sign(body, 'whsec_other'))).status, 400);
  assert.equal((await post(body, t.sign(body, 'whsec_test', -3600))).status, 400, 'stale');
  assert.equal((await post(body + ' ', t.sign(body))).status, 400, 'tampered');
  assert.equal((await t.call('POST', '/stripe/webhook', { body })).status, 400, 'unsigned');
  assert.equal(rows().length, 0);
  for (const over of [{ payment_status: 'unpaid' }, { client_reference_id: '../x' }, { metadata: undefined }, { metadata: {} }, { metadata: { feature: 'admin' } }, { metadata: { feature: '__proto__' } }]) {
    const odd = checkout({ client_reference_id: a.id, ...over });
    assert.equal((await post(odd, t.sign(odd))).status, 200);
  }
  assert.equal(rows().length, 0, 'unknown or missing details unlock nothing');
  assert.equal((await post(body, t.sign(body))).status, 200);
  assert.equal((await post(body, t.sign(body))).status, 200, 'delivered twice');
  assert.deepEqual(rows(), [{ altar_id: a.id, name: 'sevenTiers' }]);
  const photos = checkout({ client_reference_id: a.id, metadata: { feature: 'extraPhotos' } });
  assert.equal((await post(photos, t.sign(photos))).status, 200);
  assert.equal(rows().length, 2);
});

test('stripe: a payment for an altar that does not exist is acknowledged but unlocks nothing', async () => {
  const t = await setup();
  const body = checkout({ client_reference_id: 'zzzzzzzzzzzz' });
  assert.equal((await t.call('POST', '/stripe/webhook', { body, headers: { 'stripe-signature': t.sign(body) } })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM features').get().n, 0);
});

// ---------- routing, CORS, errors ----------

test('routing: unknown paths, bad ids and wrong methods', async () => {
  const t = await setup();
  const a = await t.signup();
  assert.equal((await t.call('GET', '/nope')).status, 404);
  assert.equal((await t.call('GET', '/ofrendas/..%2Fx')).status, 404);
  assert.equal((await t.call('GET', `/ofrendas/${a.id}/other`)).status, 404);
  const del = await t.call('DELETE', `/ofrendas/${a.id}`);
  assert.deepEqual([del.status, del.headers.get('allow')], [405, 'GET, PUT']);
  assert.equal((await t.call('GET', `/ofrendas/${a.id}/rotate`)).status, 405);
  assert.equal((await t.call('GET', '/recover')).status, 404);
});

test('CORS is off unless configured', async () => {
  const off = await setup();
  assert.equal((await off.call('OPTIONS', '/ofrendas')).status, 403);
  const a = await off.signup();
  assert.equal((await off.call('GET', `/ofrendas/${a.id}`)).headers.get('access-control-allow-origin'), null);
  const on = await setup({ env: { ALLOW_ORIGIN: 'https://site.test' } });
  const pre = await on.call('OPTIONS', '/ofrendas');
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await on.call('POST', '/ofrendas', { body: { email: 'x@y.com' } })).headers.get('access-control-allow-origin'), 'https://site.test');
});

test('a database failure becomes a plain 500 with no details', async () => {
  const t = await setup();
  t.env.DB = { prepare() { throw new Error('secret table name leaked'); } };
  const res = await t.call('PUT', '/ofrendas/abc', { body: altar(), token: 'x'.repeat(30) });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), '{"error":"server_error"}');
});

test('store: a duplicate altar id is rejected by the database', async () => {
  const t = await setup();
  const row = { id: 'dupe', tokenHash: 'h', email: 'a@b.com', now: 1 };
  await t.store.createAltar(t.env.DB, row);
  await assert.rejects(t.store.createAltar(t.env.DB, row), /unique|constraint/i);
});
