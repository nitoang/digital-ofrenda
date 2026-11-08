// Worker tests. No browser and no network: the handler runs with a fake clock, mailer and Turnstile, and
// its SQL runs on SQLite through tests/d1.js. Tests sign in through the real code flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { solidPng } = require('./helpers');
const { d1 } = require('./d1');

console.error = () => {}; // the Worker logs server-side problems; keep test output readable

const ORIGIN = 'https://ofrenda.test';
const png = () => 'data:image/png;base64,' + solidPng(2, 2, 200, 10, 10).toString('base64');
const frame = (id, src) => ({ id, type: 'photo', x: 50, y: 24, ...(src ? { src } : {}) });
const altar = (...items) => ({ format: 'digital-ofrenda', kind: 'person', name: 'Abuela', items });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

async function setup({ env: envOver = {}, deps: depsOver = {} } = {}) {
  const w = await import('../server/worker.mjs');
  const store = await import('../server/store.mjs');
  const { RULES } = await import('../server/rules.mjs');
  const sent = [], deferred = [];
  let clock = 1_700_000_000_000;
  const deps = { now: () => clock, mailer: { send: async m => void sent.push(m) }, defer: p => void deferred.push(p), ...depsOver };
  const env = { DB: d1(), APP_URL: ORIGIN, TURNSTILE_DISABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...envOver };
  const handler = w.createHandler(deps);
  const t = {
    w, store, env, sent, RULES, db: env.DB?.raw,
    now: () => clock,
    tick: ms => { clock += ms; },
    settle: async () => { await Promise.all(deferred.splice(0)); },
    call: (method, path, { body, cookie, origin = ORIGIN, headers } = {}) => handler(new Request('https://api.test' + path, {
      method, headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env),
    // Mail sent to an address (newest last), after letting queued sends finish.
    async mailTo(email) { await t.settle(); return sent.filter(m => m.to === email.toLowerCase()); },
    // The token in the newest email to `email` that contains one matching `re` (capture group 1).
    async tokenFrom(email, re) {
      const mail = (await t.mailTo(email)).reverse().find(m => re.test(m.text));
      assert.ok(mail, `no email to ${email} matching ${re}`);
      return re.exec(mail.text)[1];
    },
    async signIn(email) {
      const before = (await t.mailTo(email)).length;
      const start = await t.call('POST', '/auth/start', { body: { email } });
      assert.equal(start.status, 200);
      const { challenge } = await start.json();
      const mail = (await t.mailTo(email))[before];
      const res = await t.call('POST', '/auth/code', { body: { challenge, code: /(\d{6})/.exec(mail.subject)[1] } });
      assert.equal(res.status, 200, 'sign-in should succeed');
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const c = {
        email: email.trim().toLowerCase(), cookie,
        id: t.db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()).id,
        call: (method, path, body) => t.call(method, path, { body, cookie }),
        async json(method, path, body) { const r = await c.call(method, path, body); return { status: r.status, body: await r.json() }; },
      };
      return c;
    },
    // Create an altar owned by `user`, optionally saved.
    async altarFor(user, state) {
      const r = await user.call('POST', '/ofrendas');
      assert.equal(r.status, 201);
      const { id } = await r.json();
      if (state) assert.equal((await user.call('PUT', `/ofrendas/${id}`, state)).status, 200);
      return id;
    },
    // Move time forward, keeping the given signed-in users active so their sessions stay alive.
    async advance(ms, keepAlive = []) {
      for (let left = ms; left > 0; left -= 60 * DAY) {
        t.tick(Math.min(60 * DAY, left));
        for (const c of keepAlive) assert.equal((await c.call('GET', '/me')).status, 200);
      }
    },
    grant: (id, name) => t.db.prepare('INSERT INTO features (altar_id, name, granted_at) VALUES (?, ?, 0)').run(id, name),
    sign: (body, secret = 'whsec_test', offset = 0) => {
      const ts = Math.floor(clock / 1000) + offset;
      return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    },
    // An owner with a saved altar, a successor who has agreed, and nobody else. Returns the pieces.
    async heirScenario() {
      const owner = await t.signIn('owner@example.com');
      const id = await t.altarFor(owner, altar(frame('a', png())));
      assert.equal((await owner.call('PUT', `/ofrendas/${id}/successor`, { email: 'heir@example.com' })).status, 200);
      const heir = await t.signIn('heir@example.com');
      const token = await t.tokenFrom('heir@example.com', /#s=([\w-]{43})/);
      assert.equal((await heir.call('POST', '/successor/accept', { token })).status, 200);
      return { owner, heir, id };
    },
  };
  return t;
}

// ---------- sign-in ----------

test('sign-in: start emails a link and a code, stores only hashes, and answers the same for anyone', async () => {
  const t = await setup();
  const res = await t.call('POST', '/auth/start', { body: { email: '  Maria@Example.COM ' } });
  assert.equal(res.status, 200);
  const { challenge } = await res.json();
  const [mail] = await t.mailTo('maria@example.com');
  const code = /(\d{6})/.exec(mail.subject)[1];
  const token = /https:\/\/ofrenda\.test\/signin#t=([\w-]{43})/.exec(mail.text)[1];
  assert.ok(mail.text.includes(code));
  const row = t.db.prepare('SELECT * FROM login_challenges').get();
  assert.equal(row.link_hash, sha(token));
  assert.equal(row.code_hash, sha(`${challenge}:${code}`));
  const stored = t.db.prepare('SELECT * FROM login_challenges').all().flatMap(r => Object.values(r));
  assert.ok(!stored.includes(token) && !stored.includes(code), 'neither the link token nor the code is stored');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'no account exists until the address is proven');
  // Known and unknown addresses get the same kind of answer.
  await t.signIn('maria@example.com');
  const again = await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } });
  assert.deepEqual(Object.keys(await again.json()), ['challenge']);
});

test('sign-in: the code signs you in once, with a hardened cookie that is stored hashed', async () => {
  const t = await setup();
  const start = await (await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } })).json();
  const code = /(\d{6})/.exec((await t.mailTo('maria@example.com'))[0].subject)[1];
  const res = await t.call('POST', '/auth/code', { body: { challenge: start.challenge, code } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: 'maria@example.com', plan: null });
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
  const value = /=([\w-]{43})/.exec(setCookie)[1];
  assert.equal(t.db.prepare('SELECT id_hash FROM sessions').get().id_hash, sha(value));
  assert.equal(t.db.prepare('SELECT email FROM users').get().email, 'maria@example.com');
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge: start.challenge, code } })).status, 400, 'a code works once');
  assert.equal((await t.call('GET', '/me', { cookie: `__Host-session=${value}` })).status, 200);
});

test('sign-in: the emailed link is a second door into the same one-time challenge', async () => {
  const t = await setup();
  const { challenge } = await (await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } })).json();
  const [mail] = await t.mailTo('maria@example.com');
  const token = /#t=([\w-]{43})/.exec(mail.text)[1];
  const code = /(\d{6})/.exec(mail.subject)[1];
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token: 'garbage' } })).status, 400);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token: 5 } })).status, 400);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 200);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 400, 'link replay');
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge, code } })).status, 400, 'the code died with the link');
});

test('sign-in: only five guesses per code, and the right code afterwards is refused', async () => {
  const t = await setup();
  const { challenge } = await (await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } })).json();
  const code = /(\d{6})/.exec((await t.mailTo('maria@example.com'))[0].subject)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (const bad of ['12345', 'abcdef', null, 123456789]) {
    assert.equal((await t.call('POST', '/auth/code', { body: { challenge, code: bad } })).status, 400);
  }
  for (let i = 0; i < t.RULES.codeAttempts; i++) assert.equal((await t.call('POST', '/auth/code', { body: { challenge, code: wrong } })).status, 400);
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge, code } })).status, 400, 'locked out');
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge: 'nope', code } })).status, 400);
});

test('sign-in: the link and code expire after 15 minutes', async () => {
  const t = await setup();
  const a = await (await t.call('POST', '/auth/start', { body: { email: 'a@example.com' } })).json();
  await t.call('POST', '/auth/start', { body: { email: 'b@example.com' } });
  const code = /(\d{6})/.exec((await t.mailTo('a@example.com'))[0].subject)[1];
  const token = /#t=([\w-]{43})/.exec((await t.mailTo('b@example.com'))[0].text)[1];
  t.tick(15 * MIN + 1);
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge: a.challenge, code } })).status, 400);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 400);
});

test('sign-in: five emails per address per hour, and the limit looks the same from outside', async () => {
  const t = await setup();
  const bodies = [];
  for (let i = 0; i < 7; i++) {
    const r = await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } });
    assert.equal(r.status, 200);
    bodies.push(Object.keys(await r.json()).join());
  }
  assert.equal((await t.mailTo('maria@example.com')).length, 5);
  assert.equal(new Set(bodies).size, 1);
  t.tick(HOUR + 1);
  await t.call('POST', '/auth/start', { body: { email: 'maria@example.com' } });
  assert.equal((await t.mailTo('maria@example.com')).length, 6);
});

test('sign-in: bad emails and bodies are refused; Turnstile fails closed; misconfiguration refuses to run', async () => {
  const t = await setup();
  for (const email of ['nope', 'a@b', 'a b@c.com', '', 5, null, 'a@b.c', 'x'.repeat(300) + '@a.com', 'a@b.com\nbcc:x@y.com', '<a@b.com>']) {
    const res = await t.call('POST', '/auth/start', { body: { email } });
    assert.equal(res.status, 400, String(email).slice(0, 30));
  }
  assert.equal((await t.call('POST', '/auth/start', { body: '{nope' })).status, 400);
  assert.equal((await t.call('POST', '/auth/start', { body: '[]' })).status, 400);
  assert.equal((await t.call('POST', '/auth/start', { body: JSON.stringify({ email: 'a@b.com', pad: 'x'.repeat(20_000) }) })).status, 413);
  assert.equal(t.sent.length, 0);

  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, form: Object.fromEntries(init.body) }); return new Response(JSON.stringify({ success: calls.length !== 1 })); };
  const ts = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 'ts-secret' }, deps: { fetch } });
  const go = turnstile => ts.call('POST', '/auth/start', { body: { email: 'a@b.com', turnstile }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal((await go(undefined)).status, 403);
  assert.equal(calls.length, 0, 'no token means no lookup');
  assert.equal((await go('bad-token')).status, 403);
  assert.deepEqual(calls[0].form, { secret: 'ts-secret', response: 'bad-token', remoteip: '203.0.113.9' });
  assert.equal((await go('good-token')).status, 200);
  const down = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 's' }, deps: { fetch: async () => { throw new Error('offline'); } } });
  assert.equal((await down.call('POST', '/auth/start', { body: { email: 'a@b.com', turnstile: 'x' } })).status, 403);

  for (const [what, opts] of [
    ['no Turnstile secret and not dev mode', { env: { TURNSTILE_DISABLED: undefined } }],
    ['APP_URL missing', { env: { APP_URL: undefined } }],
    ['APP_URL not https', { env: { APP_URL: 'http://evil.test' } }],
    ['APP_URL with a path', { env: { APP_URL: 'https://x.test/path' } }],
    ['no mailer', { deps: { mailer: null } }],
    ['no database', { env: { DB: undefined } }],
  ]) {
    const bad = await setup(opts);
    const res = await bad.call('POST', '/auth/start', { body: { email: 'a@b.com' } });
    assert.equal(res.status, 500, what);
    assert.equal((await res.json()).error, 'misconfigured');
  }
});

test('CSRF: anything that changes data must come from our own origin', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  for (const origin of [null, 'https://evil.test', 'http://ofrenda.test', 'https://ofrenda.test.evil.test', 'null']) {
    const r = await t.call('POST', '/ofrendas', { cookie: maria.cookie, origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal((await r.json()).error, 'bad_origin');
  }
  assert.equal((await t.call('POST', '/auth/start', { body: { email: 'x@y.com' }, origin: 'https://evil.test' })).status, 403, 'sign-in too');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altars').get().n, 0);
  assert.equal((await t.call('GET', '/me', { cookie: maria.cookie, origin: null })).status, 200, 'reading is fine');
  assert.equal((await t.call('OPTIONS', '/ofrendas', { origin: 'https://evil.test' })).headers.get('access-control-allow-origin'), null, 'there is no CORS');
});

test('sessions: renewed when used, expire when idle, end on logout, and logout-all ends every device', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const expiry = () => t.db.prepare('SELECT expires_at e FROM sessions').get().e;
  const first = expiry();
  await t.advance(2 * DAY, [maria]);
  assert.equal(expiry(), t.now() + t.RULES.sessionTtl, 'using it pushes the expiry out');
  assert.ok(expiry() > first);
  assert.equal(t.db.prepare('SELECT last_seen_at s FROM users').get().s, t.now(), 'last seen is kept fresh');
  t.tick(t.RULES.sessionTtl + 1);
  assert.equal((await maria.call('GET', '/me')).status, 401, 'idle for 90 days: signed out');

  const phone = await t.signIn('maria@example.com');
  const laptop = await t.signIn('maria@example.com');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 3);
  const out = await phone.call('POST', '/auth/logout');
  assert.match(out.headers.get('set-cookie'), /Max-Age=0$/);
  assert.equal((await phone.call('GET', '/me')).status, 401);
  assert.equal((await laptop.call('GET', '/me')).status, 200, 'logging out one device leaves the others');
  const other = await t.signIn('maria@example.com');
  assert.equal((await laptop.call('POST', '/auth/logout-all')).status, 200);
  assert.equal((await other.call('GET', '/me')).status, 401);
  assert.equal((await t.call('POST', '/auth/logout')).status, 200, 'logging out while signed out is harmless');
  for (const cookie of ['__Host-session=short', '__Host-session=' + 'a'.repeat(43), 'session=' + maria.cookie.split('=')[1], '']) {
    assert.equal((await t.call('GET', '/me', { cookie })).status, 401, cookie.slice(0, 20));
  }
  assert.equal((await t.call('POST', '/auth/logout-all')).status, 401);
});

// ---------- altars ----------

test('altars: need a session; free accounts own three, platinum owns any number', async () => {
  const t = await setup();
  assert.equal((await t.call('POST', '/ofrendas')).status, 401);
  const maria = await t.signIn('maria@example.com');
  const bea = await t.signIn('bea@example.com');
  const ids = [];
  for (let i = 0; i < t.RULES.freeAltars; i++) ids.push(await t.altarFor(maria));
  assert.ok(ids.every(id => /^[a-z2-7]{12}$/.test(id)) && new Set(ids).size === ids.length);
  const over = await maria.json('POST', '/ofrendas');
  assert.deepEqual([over.status, over.body.error, over.body.upgrade], [402, 'altar_limit', 'platinum']);
  assert.equal((await bea.call('POST', '/ofrendas')).status, 201, "someone else's count is separate");
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(maria.id);
  for (let i = 0; i < 5; i++) assert.equal((await maria.call('POST', '/ofrendas')).status, 201);
  const me = await maria.json('GET', '/me');
  assert.equal(me.body.altars.length, 8);
  assert.deepEqual(me.body.user, { id: maria.id, email: 'maria@example.com', plan: 'platinum' });
  assert.ok(me.body.altars.every(a => a.role === 'owner'));
});

test('altars: only members save, the public can view, and the view leaks nothing private', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const stranger = await t.signIn('stranger@example.com');
  const id = await t.altarFor(maria);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 404, 'nothing saved yet');
  assert.equal((await t.call('PUT', `/ofrendas/${id}`, { body: altar() })).status, 401);
  assert.equal((await stranger.call('PUT', `/ofrendas/${id}`, altar())).status, 403);
  assert.equal((await stranger.call('DELETE', `/ofrendas/${id}`)).status, 403);
  assert.equal((await maria.call('PUT', '/ofrendas/zzzzzzzzzzzz', altar())).status, 403, 'unknown altar');
  assert.equal((await maria.call('PUT', `/ofrendas/${id}`, altar(frame('a', png())))).status, 200);
  const view = await t.call('GET', `/ofrendas/${id}`, { origin: null });
  const text = await view.text();
  assert.equal(JSON.parse(text).items.length, 1);
  assert.ok(!/maria|example\.com|token|hash|session/i.test(text));
  assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await maria.call('PUT', `/ofrendas/${id}`, '{nope')).status, 400);
  assert.equal((await maria.call('PUT', `/ofrendas/${id}`, 'x'.repeat(t.w.MAX_BODY_BYTES + 1))).status, 413);
  assert.equal((await stranger.call('DELETE', `/ofrendas/${id}`)).status, 403);
  assert.equal((await maria.call('DELETE', `/ofrendas/${id}`)).status, 200);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_members').get().n, 0, 'deleting removes the memberships too');
});

test('altars: photo and tier limits come from our database, never the request', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const put = state => maria.json('PUT', `/ofrendas/${id}`, state);
  const two = altar(frame('a', png()), frame('b', png()));
  const three = altar(frame('a', png()), frame('b', png()), frame('c', png()));
  const seven = { ...altar(), tiers: 7 };
  assert.equal((await put(two)).status, 200);
  const blocked = await put(three);
  assert.deepEqual([blocked.status, blocked.body.upgrade], [402, 'extraPhotos']);
  assert.equal(JSON.parse(t.db.prepare('SELECT state FROM altars').get().state).items.length, 2, 'unchanged');
  assert.equal((await put({ ...three, plan: 'platinum', entitlements: { extraPhotos: true } })).status, 402, 'cannot grant itself');
  assert.equal((await put(seven)).body.upgrade, 'sevenTiers');
  t.grant(id, 'sevenTiers');
  assert.equal((await put(three)).status, 402, 'tiers upgrade does not unlock photos');
  assert.equal((await put(seven)).status, 200);
  t.grant(id, 'extraPhotos');
  const threeSeven = { ...three, tiers: 7 };
  assert.equal((await put(threeSeven)).status, 200);
  t.db.prepare('DELETE FROM features').run(); // refunded: keeps what it has, cannot add more
  assert.equal((await put(threeSeven)).status, 200, 'keeps 3 photos and 7 tiers');
  assert.equal((await put(altar(...'abcd'.split('').map(i => frame(i, png()))))).status, 402, 'no 4th photo');
  assert.equal((await put(three)).status, 200, 'can step back to 3 tiers');
  assert.equal((await put(threeSeven)).status, 402, 'but cannot return to 7 without the upgrade');
});

test('altars: the owner platinum plan unlocks everything on their altars, and only theirs', async () => {
  const t = await setup();
  const rich = await t.signIn('rich@example.com');
  const poor = await t.signIn('poor@example.com');
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(rich.id);
  const big = { ...altar(...'abcde'.split('').map(i => frame(i, png()))), tiers: 7 };
  const mine = await t.altarFor(rich);
  const theirs = await t.altarFor(poor);
  assert.equal((await rich.call('PUT', `/ofrendas/${mine}`, big)).status, 200);
  assert.deepEqual((await rich.json('GET', `/ofrendas/${mine}/team`)).body.entitlements, { extraPhotos: true, sevenTiers: true });
  assert.deepEqual((await poor.json('GET', `/ofrendas/${theirs}/team`)).body.entitlements, { extraPhotos: false, sevenTiers: false });
  assert.equal((await poor.call('PUT', `/ofrendas/${theirs}`, big)).status, 402);
  // A free co-keeper editing a platinum owner's altar gets the owner's plan; a platinum co-keeper does not lend theirs.
  await rich.call('POST', `/ofrendas/${theirs}/invites`, { email: 'x@example.com' }); // not a member: 403
  t.db.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'keeper', 0)").run(theirs, rich.id);
  assert.equal((await rich.call('PUT', `/ofrendas/${theirs}`, big)).status, 402, "platinum belongs to the altar's owner");
  t.db.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'keeper', 0)").run(mine, poor.id);
  assert.equal((await poor.call('PUT', `/ofrendas/${mine}`, big)).status, 200, 'co-keepers benefit from the owner plan');
});

test('a database failure becomes a plain 500 with no details', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  t.env.DB = { prepare() { throw new Error('secret table name leaked'); } };
  const res = await t.call('GET', '/me', { cookie: maria.cookie });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), '{"error":"server_error"}');
});

// ---------- co-keepers ----------

test('co-keepers: an invitation is bound to the invited email and works once', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const sent = await owner.json('POST', `/ofrendas/${id}/invites`, { email: 'Sam@Example.com' });
  assert.equal(sent.status, 201);
  const [mail] = await t.mailTo('sam@example.com');
  assert.match(mail.subject, /owner@example\.com invited you/);
  const token = /https:\/\/ofrenda\.test\/invite#i=([\w-]{43})/.exec(mail.text)[1];
  assert.equal(t.db.prepare('SELECT token_hash FROM invites').get().token_hash, sha(token));

  assert.equal((await t.call('POST', '/invites/accept', { body: { token } })).status, 401, 'must sign in first');
  const wrong = await t.signIn('forwarded@example.com');
  assert.equal((await wrong.call('POST', '/invites/accept', { token })).status, 400, 'a forwarded email is useless');
  const sam = await t.signIn('sam@example.com');
  assert.equal((await sam.call('POST', '/invites/accept', { token: 'garbage' })).status, 400);
  assert.deepEqual((await sam.json('POST', '/invites/accept', { token })).body, { id });
  assert.equal((await sam.call('POST', '/invites/accept', { token })).status, 400, 'single use');

  assert.equal((await sam.call('PUT', `/ofrendas/${id}`, altar(frame('a', png())))).status, 200, 'a co-keeper can edit');
  const team = await sam.json('GET', `/ofrendas/${id}/team`);
  assert.deepEqual(team.body.members.map(m => [m.email, m.role]), [['owner@example.com', 'owner'], ['sam@example.com', 'keeper']]);
  assert.deepEqual(Object.keys(team.body).sort(), ['entitlements', 'members', 'role'], 'a co-keeper does not see invites, successor or takeover details');
  assert.deepEqual(team.body.entitlements, { extraPhotos: false, sevenTiers: false });
  assert.equal((await sam.call('POST', `/ofrendas/${id}/invites`, { email: 'z@example.com' })).status, 403);
  assert.equal((await sam.call('PUT', `/ofrendas/${id}/successor`, { email: 'z@example.com' })).status, 403);
  assert.equal((await sam.call('DELETE', `/ofrendas/${id}`)).status, 403);
  assert.deepEqual((await sam.json('GET', '/me')).body.altars, [{ id, role: 'keeper' }]);
});

test('co-keepers: invitations expire, can be revoked, and are limited', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const invite = async email => owner.json('POST', `/ofrendas/${id}/invites`, { email });
  const tokenFor = email => t.tokenFrom(email, /#i=([\w-]{43})/);

  await invite('late@example.com');
  const late = await t.signIn('late@example.com');
  t.tick(t.RULES.inviteTtl + 1);
  assert.equal((await late.call('POST', '/invites/accept', { token: await tokenFor('late@example.com') })).status, 400, 'expired');
  const owner2 = await t.signIn('owner@example.com');

  const r = await owner2.json('POST', `/ofrendas/${id}/invites`, { email: 'gone@example.com' });
  const gone = await t.signIn('gone@example.com');
  assert.equal((await owner2.call('DELETE', `/ofrendas/${id}/invites/${r.body.id}`)).status, 200);
  assert.equal((await gone.call('POST', '/invites/accept', { token: await tokenFor('gone@example.com') })).status, 400, 'revoked');
  assert.equal((await owner2.call('DELETE', `/ofrendas/${id}/invites/${r.body.id}`)).status, 404);

  assert.equal((await owner2.json('POST', `/ofrendas/${id}/invites`, { email: 'owner@example.com' })).body.error, 'already_member');
  assert.equal((await owner2.json('POST', `/ofrendas/${id}/invites`, { email: 'nope' })).status, 400);
  await owner2.call('POST', `/ofrendas/${id}/invites`, { email: 'dup@example.com' });
  assert.equal((await owner2.json('POST', `/ofrendas/${id}/invites`, { email: 'dup@example.com' })).body.error, 'already_invited');

  const crowded = await t.altarFor(owner2);
  for (let i = 0; i < t.RULES.maxKeepers; i++) assert.equal((await owner2.call('POST', `/ofrendas/${crowded}/invites`, { email: `k${i}@example.com` })).status, 201);
  assert.equal((await owner2.json('POST', `/ofrendas/${crowded}/invites`, { email: 'one-too-many@example.com' })).body.error, 'too_many_keepers');

  const spammed = await t.altarFor(owner2);
  for (let i = 0; i < t.RULES.invitesPerEmailPerDay; i++) {
    const a = await owner2.json('POST', `/ofrendas/${spammed}/invites`, { email: 'victim@example.com' });
    assert.equal(a.status, 201);
    await owner2.call('DELETE', `/ofrendas/${spammed}/invites/${a.body.id}`);
  }
  assert.equal((await owner2.json('POST', `/ofrendas/${spammed}/invites`, { email: 'victim@example.com' })).status, 429);
  assert.equal((await t.mailTo('victim@example.com')).length, t.RULES.invitesPerEmailPerDay);
});

test('co-keepers: the owner can remove one, one can leave, and the owner cannot go', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const join = async email => {
    await owner.call('POST', `/ofrendas/${id}/invites`, { email });
    const c = await t.signIn(email);
    await c.call('POST', '/invites/accept', { token: await t.tokenFrom(email, /#i=([\w-]{43})/) });
    return c;
  };
  const sam = await join('sam@example.com');
  const kim = await join('kim@example.com');
  assert.equal((await sam.call('DELETE', `/ofrendas/${id}/members/${kim.id}`)).status, 403, 'a co-keeper cannot remove another');
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}/members/${owner.id}`)).status, 400);
  assert.equal((await owner.json('DELETE', `/ofrendas/${id}/members/${owner.id}`)).body.error, 'owner_cannot_leave');
  assert.equal((await sam.call('DELETE', `/ofrendas/${id}/members/${owner.id}`)).status, 403);
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}/members/${kim.id}`)).status, 200);
  assert.equal((await kim.call('PUT', `/ofrendas/${id}`, altar())).status, 403, 'removed means no access');
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}/members/${kim.id}`)).status, 404);
  assert.equal((await sam.call('DELETE', `/ofrendas/${id}/members/${sam.id}`)).status, 200, 'leaving');
  assert.equal((await sam.call('PUT', `/ofrendas/${id}`, altar())).status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM altar_members WHERE role = 'owner'").get().n, 1);
});

// ---------- successor and takeover ----------

test('successor: naming someone grants nothing until they agree, and agreement is bound to their email', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const url = `/ofrendas/${id}/successor`;
  assert.equal((await owner.call('PUT', url, { email: 'owner@example.com' })).status, 400, 'not yourself');
  assert.equal((await owner.call('PUT', url, { email: 'nope' })).status, 400);
  assert.equal((await owner.call('PUT', url, { email: 'Heir@Example.com' })).status, 200);
  const [mail] = await t.mailTo('heir@example.com');
  const token = /https:\/\/ofrenda\.test\/successor#s=([\w-]{43})/.exec(mail.text)[1];
  assert.equal((await owner.call('PUT', url, { email: 'other@example.com' })).status, 429, 'not again right away');
  assert.deepEqual((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor, { email: 'heir@example.com', accepted: false });

  const heir = await t.signIn('heir@example.com');
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar())).status, 403, 'no access yet');
  assert.equal((await heir.call('GET', `/ofrendas/${id}/team`)).status, 403);
  assert.deepEqual((await heir.json('GET', '/me')).body.altars, []);
  const imposter = await t.signIn('imposter@example.com');
  assert.equal((await imposter.call('POST', '/successor/accept', { token })).status, 400);
  assert.equal((await heir.call('POST', '/successor/accept', { token: 'garbage' })).status, 400);
  assert.deepEqual((await heir.json('POST', '/successor/accept', { token })).body, { id });
  assert.equal((await heir.call('POST', '/successor/accept', { token })).status, 400, 'single use');
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar())).status, 403, 'still no access after agreeing');
  assert.deepEqual((await heir.json('GET', '/me')).body.successorOf, [{ id, claim: null }]);
  assert.equal((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor.accepted, true);

  t.tick(HOUR + 1); // replacing the successor starts over: the old agreement is gone
  assert.equal((await owner.call('PUT', url, { email: 'new@example.com' })).status, 200);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 403);
  assert.equal((await owner.call('DELETE', url)).status, 200);
  assert.equal(await t.store.getSuccessor(t.env.DB, id), null);
});

test('takeover: refused while the owner is active, or for anyone who is not the agreed successor', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  const early = await heir.json('POST', `/ofrendas/${id}/claim`);
  assert.deepEqual([early.status, early.body.error], [403, 'owner_active']);
  assert.equal(early.body.eligibleAt, t.db.prepare('SELECT last_seen_at s FROM users WHERE id = ?').get(owner.id).s + t.RULES.inactiveAfter);
  await t.advance(t.RULES.inactiveAfter - DAY, [heir]);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 403, 'one day short');
  assert.equal((await owner.call('POST', `/ofrendas/${id}/claim`)).status, 401, 'the owner session lapsed long ago, and the owner is not the successor anyway');
});

test('takeover: only a successor who agreed can ask, even after a long silence', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  const other = await t.altarFor(owner, altar());
  await owner.call('PUT', `/ofrendas/${other}/successor`, { email: 'unagreed@example.com' });
  const unagreed = await t.signIn('unagreed@example.com'); // named, signed in, but never said yes
  const bystander = await t.signIn('bystander@example.com');
  const keeper = await t.signIn('keeper@example.com');
  await owner.call('POST', `/ofrendas/${id}/invites`, { email: 'keeper@example.com' });
  await keeper.call('POST', '/invites/accept', { token: await t.tokenFrom('keeper@example.com', /#i=([\w-]{43})/) });
  await t.advance(t.RULES.inactiveAfter + DAY, [heir, unagreed, bystander, keeper]);
  for (const [who, altarId] of [[bystander, id], [keeper, id], [unagreed, other], [heir, other]]) {
    const r = await who.json('POST', `/ofrendas/${altarId}/claim`);
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], who.email);
    assert.equal((await who.call('POST', `/ofrendas/${altarId}/claim/complete`)).status, 403);
  }
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 201, 'the one who agreed can');
});

test('takeover: after a long silence the successor asks, the owner is told, and the wait must pass', async () => {
  const t = await setup();
  const { heir, id } = await t.heirScenario();
  await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
  const claim = await heir.json('POST', `/ofrendas/${id}/claim`);
  assert.equal(claim.status, 201);
  assert.equal(claim.body.executesAt, t.now() + t.RULES.claimWait);
  const notice = (await t.mailTo('owner@example.com')).find(m => /take over your ofrenda/.test(m.subject));
  assert.ok(notice, 'the owner is told');
  assert.ok(notice.text.includes(new Date(claim.body.executesAt).toISOString().slice(0, 10)));
  assert.ok(notice.text.includes('heir@example.com'));
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 409, 'one at a time');
  assert.deepEqual((await heir.json('GET', '/me')).body.successorOf, [{ id, claim: { executesAt: claim.body.executesAt } }]);

  await t.advance(t.RULES.claimWait - DAY, [heir]);
  t.tick(DAY - 1);
  const early = await heir.json('POST', `/ofrendas/${id}/claim/complete`);
  assert.deepEqual([early.status, early.body.error], [403, 'too_early']);
  t.tick(1);
  const done = await heir.json('POST', `/ofrendas/${id}/claim/complete`);
  assert.deepEqual([done.status, done.body], [200, { ok: true, role: 'owner' }]);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim/complete`)).status, 403, 'only once: they are the owner now, no longer the successor');
  const members = await heir.json('GET', `/ofrendas/${id}/team`);
  assert.deepEqual(members.body.members.map(m => [m.email, m.role]), [['heir@example.com', 'owner'], ['owner@example.com', 'keeper']]);
  assert.equal(members.body.successor, null);
  assert.equal(members.body.claim, null);
  assert.equal((await t.mailTo('owner@example.com')).at(-1).subject, 'An ofrenda you kept has a new owner');
  assert.equal((await t.mailTo('heir@example.com')).at(-1).subject, 'You now keep an ofrenda');
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar(frame('z', png())))).status, 200);
  const old = await t.signIn('owner@example.com');
  assert.equal((await old.call('PUT', `/ofrendas/${id}`, altar())).status, 200, 'the old owner stays on as a co-keeper');
  assert.equal((await old.call('DELETE', `/ofrendas/${id}`)).status, 403);
});

test('takeover: the owner coming back cancels it, and the successor is told', async () => {
  const t = await setup();
  const { heir, id } = await t.heirScenario();
  await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 201);
  await t.advance(10 * DAY, [heir]);
  const back = await t.signIn('owner@example.com');
  assert.equal((await back.json('GET', `/ofrendas/${id}/team`)).body.claim, null);
  assert.equal((await t.mailTo('heir@example.com')).at(-1).subject, 'The owner is back: your request was cancelled');
  t.tick(t.RULES.claimWait);
  const late = await heir.json('POST', `/ofrendas/${id}/claim/complete`);
  assert.deepEqual([late.status, late.body.error], [409, 'no_claim']);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 403, 'and they have to wait out the silence all over again');
});

test('takeover: either side can stop it; changing or removing the successor stops it too', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  const startClaim = async () => {
    t.db.prepare('DELETE FROM claims').run();
    t.db.prepare('INSERT INTO claims (altar_id, requested_by, requested_at, executes_at) VALUES (?, ?, ?, ?)').run(id, heir.id, t.now(), t.now() + t.RULES.claimWait);
  };
  const active = () => t.db.prepare('SELECT COUNT(*) n FROM claims WHERE cancelled_at IS NULL AND completed_at IS NULL').get().n;

  await startClaim();
  assert.deepEqual((await heir.json('DELETE', `/ofrendas/${id}/claim`)).body, { ok: true, cancelled: true });
  assert.equal(active(), 0);
  await startClaim();
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}/claim`)).status, 200);
  assert.equal(active(), 0);
  assert.equal((await t.mailTo('heir@example.com')).at(-1).subject, 'The owner is back: your request was cancelled');
  assert.deepEqual((await owner.json('DELETE', `/ofrendas/${id}/claim`)).body, { ok: true, cancelled: false });
  assert.equal(((await (await t.signIn('stranger@example.com')).call('DELETE', `/ofrendas/${id}/claim`))).status, 403);

  await startClaim();
  t.tick(HOUR + 1);
  await owner.call('PUT', `/ofrendas/${id}/successor`, { email: 'someone.else@example.com' });
  assert.equal(active(), 0, 'a new successor cannot ride on the old request');
  await startClaim();
  await owner.call('DELETE', `/ofrendas/${id}/successor`);
  assert.equal(active(), 0);
});

test('takeover: the family keeps the owner platinum upgrades, and only if there were any', async () => {
  for (const platinum of [true, false]) {
    const t = await setup();
    const { owner, heir, id } = await t.heirScenario();
    if (platinum) t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(owner.id);
    await owner.call('PUT', `/ofrendas/${id}`, altar(...'abc'.split('').map(i => frame(i, png()))));
    await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
    await heir.call('POST', `/ofrendas/${id}/claim`);
    t.tick(t.RULES.claimWait);
    assert.equal((await heir.call('POST', `/ofrendas/${id}/claim/complete`)).status, 200);
    const names = t.db.prepare('SELECT name FROM features ORDER BY name').all().map(r => r.name);
    assert.deepEqual(names, platinum ? ['extraPhotos', 'sevenTiers'] : []);
    const more = altar(...'abcd'.split('').map(i => frame(i, png())));
    assert.equal((await heir.call('PUT', `/ofrendas/${id}`, more)).status, platinum ? 200 : 402);
    assert.equal(t.db.prepare("SELECT plan FROM users WHERE id = ?").get(heir.id).plan, null, 'the plan itself stays with its buyer');
  }
});

test('takeover: two simultaneous completions hand over exactly once', async () => {
  const t = await setup();
  const { heir, id } = await t.heirScenario();
  await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
  await heir.call('POST', `/ofrendas/${id}/claim`);
  t.tick(t.RULES.claimWait);
  const results = await Promise.all([1, 2].map(() => heir.call('POST', `/ofrendas/${id}/claim/complete`)));
  const statuses = results.map(r => r.status).sort();
  assert.equal(statuses[0], 200, 'one wins');
  assert.ok([403, 409].includes(statuses[1]), 'the other is refused');
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM altar_members WHERE role = 'owner'").get().n, 1);
});

// ---------- payments ----------

const checkout = (over = {}) => JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: 'REF', metadata: { feature: 'sevenTiers' }, ...over } } });

test('stripe: only valid, fresh, paid events with a known feature unlock anything', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const post = (body, sig) => t.call('POST', '/stripe/webhook', { body, origin: null, headers: { 'stripe-signature': sig } });
  const body = checkout({ client_reference_id: id });
  const rows = () => t.db.prepare('SELECT altar_id, name FROM features').all().map(r => ({ ...r }));
  assert.equal((await post(body, 't=1,v1=00')).status, 400);
  assert.equal((await post(body, t.sign(body, 'whsec_other'))).status, 400);
  assert.equal((await post(body, t.sign(body, 'whsec_test', -3600))).status, 400, 'stale');
  assert.equal((await post(body + ' ', t.sign(body))).status, 400, 'tampered');
  assert.equal((await t.call('POST', '/stripe/webhook', { body, origin: null })).status, 400, 'unsigned');
  for (const over of [{ payment_status: 'unpaid' }, { client_reference_id: '../x' }, { metadata: undefined }, { metadata: {} }, { metadata: { feature: 'admin' } }, { metadata: { feature: '__proto__' } }]) {
    const odd = checkout({ client_reference_id: id, ...over });
    assert.equal((await post(odd, t.sign(odd))).status, 200);
  }
  assert.equal(rows().length, 0, 'unknown or missing details unlock nothing');
  assert.equal((await post(body, t.sign(body))).status, 200);
  assert.equal((await post(body, t.sign(body))).status, 200, 'delivered twice');
  assert.deepEqual(rows(), [{ altar_id: id, name: 'sevenTiers' }]);
  const photos = checkout({ client_reference_id: id, metadata: { feature: 'extraPhotos' } });
  await post(photos, t.sign(photos));
  assert.equal(rows().length, 2);
});

test('stripe: platinum goes on the account, and a purchase pointed at the wrong kind of id does nothing', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const post = async over => { const b = checkout(over); return t.call('POST', '/stripe/webhook', { body: b, origin: null, headers: { 'stripe-signature': t.sign(b) } }); };
  const plan = () => t.db.prepare('SELECT plan FROM users WHERE id = ?').get(maria.id).plan;
  assert.equal((await post({ client_reference_id: id, metadata: { feature: 'platinum' } })).status, 200);
  assert.equal(plan(), null, 'an altar id is not an account id');
  assert.equal((await post({ client_reference_id: maria.id, metadata: { feature: 'sevenTiers' } })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM features').get().n, 0, 'an account id is not an altar id');
  assert.equal((await post({ client_reference_id: maria.id, metadata: { feature: 'platinum' } })).status, 200);
  assert.equal((await post({ client_reference_id: maria.id, metadata: { feature: 'platinum' } })).status, 200, 'twice is fine');
  assert.equal(plan(), 'platinum');
  assert.equal((await post({ client_reference_id: 'zzzzzzzzzzzz', metadata: { feature: 'platinum' } })).status, 200, 'unknown account: acknowledged, nothing happens');
  assert.equal((await maria.json('GET', '/me')).body.user.plan, 'platinum');
  for (let i = 0; i < 6; i++) assert.equal((await maria.call('POST', '/ofrendas')).status, 201);
});

// ---------- routing ----------

test('routing: unknown paths, bad ids and wrong methods', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  assert.equal((await t.call('GET', '/nope')).status, 404);
  assert.equal((await t.call('GET', '/ofrendas/..%2Fx')).status, 404);
  assert.equal((await t.call('GET', `/ofrendas/${id}/other`, { cookie: maria.cookie })).status, 404);
  const wrong = await maria.call('PATCH', `/ofrendas/${id}`);
  assert.deepEqual([wrong.status, wrong.headers.get('allow')], [405, 'PUT, DELETE']);
  assert.equal((await maria.call('GET', '/auth/start')).status, 405);
  assert.equal((await maria.call('GET', `/ofrendas/${id}/claim`)).status, 405);
});

test('store: a duplicate altar id is rejected by the database', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  await t.store.createAltar(t.env.DB, { id: 'dupe', userId: maria.id, now: 1 });
  await assert.rejects(t.store.createAltar(t.env.DB, { id: 'dupe', userId: maria.id, now: 1 }), /unique|constraint/i);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM altar_members WHERE altar_id = 'dupe'").get().n, 1, 'the failed attempt left nothing behind');
});

test('store: one-time operations succeed exactly once, however they are called', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const heir = await t.signIn('heir@example.com');
  const id = await t.altarFor(owner);
  const db = t.env.DB, s = t.store, now = t.now();
  await s.addLoginChallenge(db, { challenge: 'c1', linkHash: 'l1', codeHash: 'x', email: 'a@b.com', now, ttl: 1000 });
  const links = await Promise.all([1, 2, 3].map(() => s.redeemLoginLink(db, { linkHash: 'l1', now })));
  assert.equal(links.filter(Boolean).length, 1);
  assert.equal((await Promise.all([1, 2].map(() => s.useLoginChallenge(db, { challenge: 'c1', now })))).filter(Boolean).length, 0, 'already used by the link');
  const claim = { altarId: id, requestedBy: heir.id, now, executesAt: now };
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => s.createClaim(db, claim))), [true, false, false]);
  assert.equal((await Promise.all([1, 2].map(() => s.finishClaim(db, { altarId: id, now })))).filter(Boolean).length, 1);
  await s.createClaim(db, { altarId: id, requestedBy: heir.id, now, executesAt: now + 1000 });
  assert.equal(await s.finishClaim(db, { altarId: id, now }), null, 'the database itself refuses to finish a claim before its wait is over');
  assert.equal(await s.finishClaim(db, { altarId: id, now: now + 999 }), null);
  assert.ok(await s.finishClaim(db, { altarId: id, now: now + 1000 }));
  assert.equal(await s.createClaim(db, claim), true, 'a finished claim can be replaced by a new one');
  await s.setSuccessor(db, { altarId: id, email: 'heir@example.com', tokenHash: 'th', designatedBy: owner.id, now });
  const accepts = await Promise.all([1, 2].map(() => s.acceptSuccessor(db, { tokenHash: 'th', userId: heir.id, email: 'heir@example.com', now })));
  assert.equal(accepts.filter(Boolean).length, 1);
  assert.equal(await s.acceptSuccessor(db, { tokenHash: 'th', userId: owner.id, email: 'other@example.com', now }), null);
});

// ---------- starting a purchase ----------

const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_EXTRA_PHOTOS: 'price_photos', STRIPE_PRICE_SEVEN_TIERS: 'price_tiers', STRIPE_PRICE_PLATINUM: 'price_platinum' };
// A stand-in for Stripe's API that records what it was asked.
const fakeStripe = ({ status = 200, body, fail } = {}) => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      if (fail) throw new Error('offline');
      calls.push({ url, headers: init.headers, form: Object.fromEntries(init.body) });
      return new Response(JSON.stringify(body ?? { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status });
    },
  };
};
const shop = async (stripe = fakeStripe(), envOver = {}) => setup({ env: { ...STRIPE_ENV, ...envOver }, deps: { fetch: stripe.fetch } });
// What Stripe tells us after a successful payment for the session we asked it to create.
const paid = (form, type = 'checkout.session.completed', status = 'paid') => JSON.stringify({
  type, data: { object: { payment_status: status, client_reference_id: form.client_reference_id, metadata: { feature: form['metadata[feature]'] } } },
});
const deliver = (t, body) => t.call('POST', '/stripe/webhook', { body, origin: null, headers: { 'stripe-signature': t.sign(body) } });

test('checkout: needs sign-in and our own origin, accepts only known features, and says so when purchases are not set up', async () => {
  const stripe = fakeStripe();
  const t = await shop(stripe);
  assert.equal((await t.call('POST', '/checkout', { body: { feature: 'platinum' } })).status, 401);
  const maria = await t.signIn('maria@example.com');
  assert.equal((await t.call('POST', '/checkout', { body: { feature: 'platinum' }, cookie: maria.cookie, origin: 'https://evil.test' })).status, 403);
  for (const feature of ['admin', '__proto__', 'toString', 'constructor', '', 5, null, undefined]) {
    assert.equal((await maria.call('POST', '/checkout', { feature })).status, 400, String(feature));
  }
  assert.equal(stripe.calls.length, 0);
  const noKey = await shop(fakeStripe(), { STRIPE_SECRET_KEY: undefined });
  const m2 = await noKey.signIn('maria@example.com');
  const r = await m2.json('POST', '/checkout', { feature: 'platinum' });
  assert.deepEqual([r.status, r.body.error], [503, 'checkout_unavailable']);
  const noPrice = await shop(fakeStripe(), { STRIPE_PRICE_SEVEN_TIERS: undefined });
  const m3 = await noPrice.signIn('maria@example.com');
  assert.equal((await m3.call('POST', '/checkout', { feature: 'sevenTiers', altarId: await noPrice.altarFor(m3) })).status, 503, 'a feature with no price is unavailable');
  assert.equal((await m3.call('POST', '/checkout', { feature: 'platinum' })).status, 200, 'but the others still work');
});

test('checkout: an altar upgrade is for its owner, and the Stripe request is built only from our own data', async () => {
  const stripe = fakeStripe();
  const t = await shop(stripe);
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const res = await owner.json('POST', '/checkout', {
    feature: 'extraPhotos', altarId: id, price: 'price_evil', client_reference_id: 'someone-else', amount: 1, mode: 'subscription', metadata: { feature: 'platinum' }, success_url: 'https://evil.test',
  });
  assert.deepEqual([res.status, res.body], [200, { url: 'https://checkout.stripe.com/c/pay/cs_test_1' }]);
  assert.equal(stripe.calls.length, 1);
  const [call] = stripe.calls;
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(call.headers.authorization, 'Bearer sk_test_x');
  assert.deepEqual(call.form, {
    mode: 'payment',
    'line_items[0][price]': 'price_photos',
    'line_items[0][quantity]': '1',
    client_reference_id: id,
    'metadata[feature]': 'extraPhotos',
    'payment_intent_data[metadata][feature]': 'extraPhotos',
    'payment_intent_data[metadata][reference]': id,
    customer_email: 'owner@example.com',
    success_url: `${ORIGIN}/a/${id}?upgraded=extraPhotos`,
    cancel_url: `${ORIGIN}/a/${id}?cancelled=1`,
  });

  // A co-keeper, a stranger, and bad altar ids cannot start it.
  await owner.call('POST', `/ofrendas/${id}/invites`, { email: 'sam@example.com' });
  const sam = await t.signIn('sam@example.com');
  await sam.call('POST', '/invites/accept', { token: await t.tokenFrom('sam@example.com', /#i=([\w-]{43})/) });
  const denied = await sam.json('POST', '/checkout', { feature: 'extraPhotos', altarId: id });
  assert.deepEqual([denied.status, denied.body.error], [403, 'owner_only']);
  const stranger = await t.signIn('stranger@example.com');
  assert.equal((await stranger.json('POST', '/checkout', { feature: 'sevenTiers', altarId: id })).body.error, 'forbidden');
  for (const altarId of [undefined, '', '../x', 'a b', 5, 'zzzzzzzzzzzz']) {
    assert.ok([400, 403].includes((await owner.call('POST', '/checkout', { feature: 'sevenTiers', altarId })).status), String(altarId));
  }
  assert.equal(stripe.calls.length, 1, 'none of those reached Stripe');
});

test('checkout: you cannot buy what is already yours', async () => {
  const stripe = fakeStripe();
  const t = await shop(stripe);
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner);
  t.grant(id, 'extraPhotos');
  const again = await owner.json('POST', '/checkout', { feature: 'extraPhotos', altarId: id });
  assert.deepEqual([again.status, again.body.error], [409, 'already_unlocked']);
  assert.equal((await owner.call('POST', '/checkout', { feature: 'sevenTiers', altarId: id })).status, 200, 'the other upgrade is still for sale');
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(owner.id);
  assert.equal((await owner.call('POST', '/checkout', { feature: 'sevenTiers', altarId: id })).status, 409, 'Platinum already covers it');
  assert.equal((await owner.call('POST', '/checkout', { feature: 'platinum' })).status, 409);
  assert.equal(stripe.calls.length, 1);
});

test('checkout: Platinum is bought for the signed-in account, whatever else the request says', async () => {
  const stripe = fakeStripe();
  const t = await shop(stripe);
  const maria = await t.signIn('maria@example.com');
  const other = await t.signIn('other@example.com');
  const res = await maria.call('POST', '/checkout', { feature: 'platinum', altarId: 'whatever', client_reference_id: other.id });
  assert.equal(res.status, 200);
  assert.equal(stripe.calls[0].form.client_reference_id, maria.id);
  assert.equal(stripe.calls[0].form['line_items[0][price]'], 'price_platinum');
  assert.equal(stripe.calls[0].form.success_url, `${ORIGIN}/my?upgraded=platinum`);
  assert.equal(stripe.calls[0].form.cancel_url, `${ORIGIN}/my?cancelled=1`);
});

test('checkout: when Stripe misbehaves the person gets a plain message and nothing leaks', async () => {
  for (const [what, stripe] of [
    ['a Stripe error', fakeStripe({ status: 400, body: { error: { message: 'No such price: price_secret_internal' } } })],
    ['an address that is not Stripe', fakeStripe({ body: { url: 'https://evil.test/pay' } })],
    ['no address at all', fakeStripe({ body: { id: 'cs_1' } })],
    ['a non-string address', fakeStripe({ body: { url: { x: 1 } } })],
    ['an unreachable Stripe', fakeStripe({ fail: true })],
  ]) {
    const t = await shop(stripe);
    const maria = await t.signIn('maria@example.com');
    const res = await maria.call('POST', '/checkout', { feature: 'platinum' });
    const text = await res.text();
    assert.equal(res.status, 502, what);
    assert.ok(!/secret|evil|price_/.test(text), what + ': nothing from Stripe leaks');
    assert.equal(JSON.parse(text).error, 'checkout_failed');
  }
});

test('checkout, then payment: the webhook turns the purchase into the upgrade', async () => {
  const stripe = fakeStripe();
  const t = await shop(stripe);
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const three = altar(frame('a', png()), frame('b', png()), frame('c', png()));
  assert.equal((await owner.call('PUT', `/ofrendas/${id}`, three)).status, 402);
  await owner.call('POST', '/checkout', { feature: 'extraPhotos', altarId: id });
  const form = stripe.calls[0].form;
  // A delayed payment: first "completed but unpaid" (nothing yet), then "async payment succeeded".
  assert.equal((await deliver(t, paid(form, 'checkout.session.completed', 'unpaid'))).status, 200);
  assert.equal((await owner.call('PUT', `/ofrendas/${id}`, three)).status, 402, 'not paid yet, so nothing unlocked');
  assert.equal((await deliver(t, paid(form, 'checkout.session.async_payment_succeeded'))).status, 200);
  assert.equal((await owner.call('PUT', `/ofrendas/${id}`, three)).status, 200);
  assert.deepEqual((await owner.json('GET', `/ofrendas/${id}/team`)).body.entitlements, { extraPhotos: true, sevenTiers: false });
  assert.equal((await owner.call('POST', '/checkout', { feature: 'extraPhotos', altarId: id })).status, 409, 'and it is no longer for sale');

  // Platinum, paid by card straight away.
  await owner.call('POST', '/checkout', { feature: 'platinum' });
  assert.equal((await deliver(t, paid(stripe.calls.at(-1).form))).status, 200);
  assert.equal((await owner.json('GET', '/me')).body.user.plan, 'platinum');
  for (let i = 0; i < 4; i++) assert.equal((await owner.call('POST', '/ofrendas')).status, 201);
});
