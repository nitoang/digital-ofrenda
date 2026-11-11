// Worker tests. No browser and no network: the handler runs with a fake clock, mailer and Turnstile, and
// its SQL runs on SQLite through tests/d1.js. Tests sign in through the real code flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { solidPng } = require('./helpers');
const { d1 } = require('./d1');
const { fakeR2 } = require('./r2');

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
    settle: async () => { while (deferred.length) await Promise.all(deferred.splice(0)); }, // work can queue more work
    runJob: async () => { try { await w.runScheduled(env, deps); } finally { while (deferred.length) await Promise.all(deferred.splice(0)); } },
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
      const start = await t.call('POST', '/auth/start', { body: { method: 'code', email } });
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

test('sign-in: start emails the one thing chosen, stores only hashes, and answers the same for anyone', async () => {
  const t = await setup();
  const res = await t.call('POST', '/auth/start', { body: { method: 'code', email: '  Maria@Example.COM ' } });
  assert.equal(res.status, 200);
  const { challenge } = await res.json();
  const [mail] = await t.mailTo('maria@example.com');
  const code = /(\d{6})/.exec(mail.subject)[1];
  assert.ok(mail.text.includes(code));
  assert.doesNotMatch(mail.text, /signin#t=/);
  const row = t.db.prepare('SELECT * FROM login_challenges').get();
  assert.equal(row.code_hash, sha(`${challenge}:${code}`));
  const link = await t.call('POST', '/auth/start', { body: { method: 'link', email: 'maria@example.com' } });
  const token = /https:\/\/ofrenda\.test\/signin#t=([\w-]{43})/.exec((await t.mailTo('maria@example.com'))[1].text)[1];
  assert.equal(t.db.prepare('SELECT link_hash FROM login_challenges WHERE challenge_id = ?').get((await link.json()).challenge).link_hash, sha(token));
  const stored = t.db.prepare('SELECT * FROM login_challenges').all().flatMap(r => Object.values(r));
  assert.ok(!stored.includes(token) && !stored.includes(code), 'neither the link token nor the code is stored');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'no account exists until the address is proven');
  // Known and unknown addresses get the same kind of answer.
  const again = await t.call('POST', '/auth/start', { body: { method: 'code', email: 'someone-new@example.com' } });
  assert.deepEqual(Object.keys(await again.json()), ['challenge', 'method']);
});

test('sign-in: the code signs you in once, with a hardened cookie that is stored hashed', async () => {
  const t = await setup();
  const start = await (await t.call('POST', '/auth/start', { body: { method: 'code', email: 'maria@example.com' } })).json();
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

test('sign-in: the emailed link works once', async () => {
  const t = await setup();
  await t.call('POST', '/auth/start', { body: { method: 'link', email: 'maria@example.com' } });
  const [mail] = await t.mailTo('maria@example.com');
  const token = /#t=([\w-]{43})/.exec(mail.text)[1];
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token: 'garbage' } })).status, 400);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token: 5 } })).status, 400);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 200);
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 400, 'link replay');
});

test('sign-in: only five guesses per code, and the right code afterwards is refused', async () => {
  const t = await setup();
  const { challenge } = await (await t.call('POST', '/auth/start', { body: { method: 'code', email: 'maria@example.com' } })).json();
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
  const a = await (await t.call('POST', '/auth/start', { body: { method: 'code', email: 'a@example.com' } })).json();
  await t.call('POST', '/auth/start', { body: { method: 'link', email: 'b@example.com' } });
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
    const r = await t.call('POST', '/auth/start', { body: { method: 'code', email: 'maria@example.com' } });
    assert.equal(r.status, 200);
    bodies.push(Object.keys(await r.json()).join());
  }
  assert.equal((await t.mailTo('maria@example.com')).length, 5);
  assert.equal(new Set(bodies).size, 1);
  t.tick(HOUR + 1);
  await t.call('POST', '/auth/start', { body: { method: 'code', email: 'maria@example.com' } });
  assert.equal((await t.mailTo('maria@example.com')).length, 6);
});

test('sign-in: bad emails and bodies are refused; Turnstile fails closed; misconfiguration refuses to run', async () => {
  const t = await setup();
  for (const email of ['nope', 'a@b', 'a b@c.com', '', 5, null, 'a@b.c', 'x'.repeat(300) + '@a.com', 'a@b.com\nbcc:x@y.com', '<a@b.com>']) {
    const res = await t.call('POST', '/auth/start', { body: { method: 'code', email } });
    assert.equal(res.status, 400, String(email).slice(0, 30));
  }
  assert.equal((await t.call('POST', '/auth/start', { body: '{nope' })).status, 400);
  assert.equal((await t.call('POST', '/auth/start', { body: '[]' })).status, 400);
  assert.equal((await t.call('POST', '/auth/start', { body: JSON.stringify({ method: 'code', email: 'a@b.com', pad: 'x'.repeat(20_000) }) })).status, 413);
  assert.equal(t.sent.length, 0);

  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, form: Object.fromEntries(init.body) }); return new Response(JSON.stringify({ success: calls.length !== 1 })); };
  const ts = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 'ts-secret' }, deps: { fetch } });
  const go = turnstile => ts.call('POST', '/auth/start', { body: { method: 'code', email: 'a@b.com', turnstile }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal((await go(undefined)).status, 403);
  assert.equal(calls.length, 0, 'no token means no lookup');
  assert.equal((await go('bad-token')).status, 403);
  assert.deepEqual(calls[0].form, { secret: 'ts-secret', response: 'bad-token', remoteip: '203.0.113.9' });
  assert.equal((await go('good-token')).status, 200);
  const down = await setup({ env: { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET: 's' }, deps: { fetch: async () => { throw new Error('offline'); } } });
  assert.equal((await down.call('POST', '/auth/start', { body: { method: 'code', email: 'a@b.com', turnstile: 'x' } })).status, 403);

  for (const [what, opts] of [
    ['no Turnstile secret and not dev mode', { env: { TURNSTILE_DISABLED: undefined } }],
    ['APP_URL missing', { env: { APP_URL: undefined } }],
    ['APP_URL not https', { env: { APP_URL: 'http://evil.test' } }],
    ['APP_URL with a path', { env: { APP_URL: 'https://x.test/path' } }],
    ['no mailer', { deps: { mailer: null } }],
    ['no database', { env: { DB: undefined } }],
  ]) {
    const bad = await setup(opts);
    const res = await bad.call('POST', '/auth/start', { body: { method: 'code', email: 'a@b.com' } });
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
  assert.equal((await t.call('POST', '/auth/start', { body: { method: 'code', email: 'x@y.com' }, origin: 'https://evil.test' })).status, 403, 'sign-in too');
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
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 2, 'the expired one was tidied away by the new sign-in');
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
  assert.deepEqual(Object.keys(team.body).sort(), ['entitlements', 'members', 'role', 'slug', 'visibility'], 'a co-keeper does not see invites, successor or takeover details');
  assert.deepEqual(team.body.entitlements, { extraPhotos: false, sevenTiers: false });
  assert.equal((await sam.call('POST', `/ofrendas/${id}/invites`, { email: 'z@example.com' })).status, 403);
  assert.equal((await sam.call('PUT', `/ofrendas/${id}/successor`, { email: 'z@example.com' })).status, 403);
  assert.equal((await sam.call('DELETE', `/ofrendas/${id}`)).status, 403);
  assert.deepEqual((await sam.json('GET', '/me')).body.altars, [{ id, role: 'keeper', slug: null }]);
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

// ---------- sharing: view only, or view and edit ----------

test('sharing: view only emails the link, gives no editing, and keeps only a hash of the address', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar(frame('a', png())));

  const res = await owner.json('POST', `/ofrendas/${id}/share`, { email: ' Sam@Example.com ', access: 'view', note: 'Thinking of you both.' });
  assert.deepEqual([res.status, res.body], [201, { access: 'view' }]);
  const [mail] = await t.mailTo('sam@example.com');
  assert.equal(mail.subject, 'owner@example.com shared an ofrenda for Abuela with you');
  assert.ok(mail.text.includes(`https://ofrenda.test/a/${id}`), 'the link is the public address of the ofrenda');
  assert.ok(mail.text.includes('A note from owner@example.com:\nThinking of you both.'));
  assert.ok(mail.text.includes('Come sit with it for a minute'), 'the view-only wording does not invite them to add things');
  assert.ok(!mail.text.includes('#i='), 'a view-only share carries no invitation token');

  // Looking needs no account. Editing, and the team page, still do.
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200);
  const sam = await t.signIn('sam@example.com');
  assert.equal((await sam.call('PUT', `/ofrendas/${id}`, altar(frame('a', png())))).status, 403, 'view only cannot edit');
  assert.equal((await sam.call('GET', `/ofrendas/${id}/team`)).status, 403);
  assert.deepEqual((await sam.json('GET', '/me')).body.altars, [], 'view only does not add it to their ofrendas');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0, 'no co-keeper invitation was created');

  const stored = t.db.prepare('SELECT * FROM view_shares').all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].email_hash, sha('sam@example.com'));
  assert.ok(!Object.values(stored[0]).some(v => String(v).includes('sam@example.com')), 'the address itself is never stored');
});

test('sharing: view and edit makes a co-keeper through the same invitation as before', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const res = await owner.json('POST', `/ofrendas/${id}/share`, { email: 'sam@example.com', access: 'edit', note: 'Please add her recipes.' });
  assert.equal(res.status, 201);
  assert.equal(res.body.access, 'edit');
  const [mail] = await t.mailTo('sam@example.com');
  assert.match(mail.subject, /owner@example\.com invited you to help keep an ofrenda/);
  assert.ok(mail.text.includes('A note from owner@example.com:\nPlease add her recipes.'));
  assert.ok(mail.text.includes('add a note or something they loved'), 'the edit wording invites them to add');
  const token = /https:\/\/ofrenda\.test\/invite#i=([\w-]{43})/.exec(mail.text)[1];
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM view_shares').get().n, 0, 'an edit share is not a view share');

  const sam = await t.signIn('sam@example.com');
  assert.equal((await sam.call('PUT', `/ofrendas/${id}`, altar(frame('a', png())))).status, 403, 'not until they accept');
  assert.deepEqual((await sam.json('POST', '/invites/accept', { token })).body, { id });
  assert.equal((await sam.call('PUT', `/ofrendas/${id}`, altar(frame('a', png())))).status, 200, 'then they can edit');

  assert.equal((await owner.json('POST', `/ofrendas/${id}/share`, { email: 'sam@example.com', access: 'edit' })).body.error, 'already_member');
  assert.equal((await owner.json('POST', `/ofrendas/${id}/share`, { email: 'sam@example.com', access: 'view' })).body.error, 'already_member', 'they can already view');
});

test('sharing: only the owner shares, and the choice, the address and the note are checked', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  const share = body => owner.json('POST', `/ofrendas/${id}/share`, body);

  assert.equal((await t.call('POST', `/ofrendas/${id}/share`, { body: { email: 'a@example.com', access: 'view' } })).status, 401);
  const stranger = await t.signIn('stranger@example.com');
  assert.equal((await stranger.call('POST', `/ofrendas/${id}/share`, { email: 'a@example.com', access: 'view' })).status, 403);
  assert.equal((await t.call('POST', `/ofrendas/${id}/share`, { body: { email: 'a@example.com', access: 'view' }, cookie: owner.cookie, origin: 'https://evil.test' })).status, 403, 'another origin is refused');

  await owner.call('POST', `/ofrendas/${id}/invites`, { email: 'keeper@example.com' });
  const keeper = await t.signIn('keeper@example.com');
  await keeper.call('POST', '/invites/accept', { token: await t.tokenFrom('keeper@example.com', /#i=([\w-]{43})/) });
  assert.equal((await keeper.call('POST', `/ofrendas/${id}/share`, { email: 'a@example.com', access: 'view' })).status, 403, 'a co-keeper cannot share');

  assert.equal((await share({ email: 'a@example.com' })).body.error, 'bad_access');
  assert.equal((await share({ email: 'a@example.com', access: 'admin' })).body.error, 'bad_access', 'there is no way to grant ownership');
  assert.equal((await share({ email: 'a@example.com', access: ['view'] })).body.error, 'bad_access');
  assert.equal((await share({ email: 'nope', access: 'view' })).body.error, 'bad_email');
  assert.equal((await share({ access: 'view' })).body.error, 'bad_email');
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: 'See https://evil.example/login' })).body.error, 'note_has_link');
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: 'visit www.example.com' })).body.error, 'note_has_link');
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: 'go to bank.com' })).body.error, 'note_has_link');
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: 'x'.repeat(t.RULES.noteMax + 1) })).body.error, 'note_too_long');
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: 42 })).body.error, 'bad_note');
  assert.equal((await t.mailTo('a@example.com')).length, 0, 'nothing was sent for any refused request');

  // An ordinary note, with a blank line and stray control characters, is cleaned and sent.
  assert.equal((await share({ email: 'a@example.com', access: 'view', note: '  She loved you.\n\nCome by soon.\u0007 ' })).status, 201);
  const [mail] = await t.mailTo('a@example.com');
  assert.ok(mail.text.includes('A note from owner@example.com:\nShe loved you.\n\nCome by soon.\n'));
  assert.ok(!mail.text.includes('\u0007'));
  assert.equal((await share({ email: 'b@example.com', access: 'view', note: '' })).status, 201);
  assert.ok(!(await t.mailTo('b@example.com'))[0].text.includes('A note from'), 'no note, no note block');
});

test('sharing: the link uses the ofrenda name once it has one, and the subject is safe', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, { ...altar(), name: 'Abuela\r\nBcc: x@evil.test' });
  assert.equal((await owner.call('PUT', `/ofrendas/${id}/slug`, { slug: 'abuela-rosa' })).status, 200);
  assert.equal((await owner.call('POST', `/ofrendas/${id}/share`, { email: 'sam@example.com', access: 'view' })).status, 201);
  const [mail] = await t.mailTo('sam@example.com');
  assert.ok(mail.text.includes('https://ofrenda.test/a/abuela-rosa'));
  assert.ok(!/[\r\n]/.test(mail.subject), 'a name with line breaks cannot add mail headers');

  const bare = await t.altarFor(owner);
  assert.equal((await owner.call('POST', `/ofrendas/${bare}/share`, { email: 'kim@example.com', access: 'view' })).status, 201);
  assert.equal((await t.mailTo('kim@example.com'))[0].subject, 'owner@example.com shared an ofrenda with you', 'no name yet, so none in the subject');
});

test('sharing: view-only emails are limited per address and per ofrenda, and old records are cleared', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  for (let i = 0; i < t.RULES.sharesPerEmailPerDay; i++) assert.equal((await owner.call('POST', `/ofrendas/${id}/share`, { email: 'victim@example.com', access: 'view' })).status, 201);
  assert.equal((await owner.json('POST', `/ofrendas/${id}/share`, { email: 'victim@example.com', access: 'view' })).status, 429);
  const other = await t.altarFor(owner, altar());
  assert.equal((await owner.json('POST', `/ofrendas/${other}/share`, { email: 'Victim@Example.com', access: 'view' })).body.error, 'too_many_shares', 'the limit follows the address across ofrendas');
  assert.equal((await t.mailTo('victim@example.com')).length, t.RULES.sharesPerEmailPerDay);

  const busy = await t.altarFor(owner, altar());
  for (let i = 0; i < t.RULES.sharesPerAltarPerDay; i++) assert.equal((await owner.call('POST', `/ofrendas/${busy}/share`, { email: `p${i}@example.com`, access: 'view' })).status, 201);
  assert.equal((await owner.json('POST', `/ofrendas/${busy}/share`, { email: 'one-more@example.com', access: 'view' })).body.error, 'share_limit');

  t.tick(DAY + MIN); // a day later: allowed again, and the next sign-in request clears the old records
  const again = await t.signIn('owner@example.com');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM view_shares').get().n, 0, 'records older than a day are gone');
  assert.equal((await again.call('POST', `/ofrendas/${busy}/share`, { email: 'one-more@example.com', access: 'view' })).status, 201);
});

test('sharing: deleting the ofrenda or the account removes the share records', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const gone = await t.altarFor(owner, altar());
  await owner.call('POST', `/ofrendas/${gone}/share`, { email: 'a@example.com', access: 'view' });
  assert.equal((await owner.call('DELETE', `/ofrendas/${gone}`)).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM view_shares').get().n, 0, 'deleting the ofrenda clears them');

  const kept = await t.altarFor(owner, altar());
  await owner.call('POST', `/ofrendas/${kept}/share`, { email: 'b@example.com', access: 'view' });
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM view_shares').get().n, 1);
  assert.equal((await owner.call('DELETE', '/me', { email: 'owner@example.com', deleteOfrendas: true })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM view_shares').get().n, 0, 'deleting the account clears them');
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
  assert.deepEqual((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor, { email: 'heir@example.com', accepted: false, waitMonths: 12, auto: true });

  const heir = await t.signIn('heir@example.com');
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar())).status, 403, 'no access yet');
  assert.equal((await heir.call('GET', `/ofrendas/${id}/team`)).status, 403);
  assert.deepEqual((await heir.json('GET', '/me')).body.altars, []);
  const imposter = await t.signIn('imposter@example.com');
  assert.equal((await imposter.call('POST', '/successor/accept', { token })).status, 400);
  assert.equal((await heir.call('POST', '/successor/accept', { token: 'garbage' })).status, 400);
  assert.deepEqual((await heir.json('POST', '/successor/accept', { token })).body, { id });
  assert.equal((await heir.call('POST', '/successor/accept', { token })).status, 400, 'single use');
  // Agreeing makes them a co-keeper straight away: they can add to the ofrenda, but not delete it or change who keeps it.
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar())).status, 200, 'agreeing gives edit access');
  assert.equal((await heir.call('DELETE', `/ofrendas/${id}`)).status, 403, 'but not delete');
  assert.equal((await heir.call('PUT', `/ofrendas/${id}/successor`, { email: 'x@example.com' })).status, 403);
  assert.deepEqual((await heir.json('GET', '/me')).body.successorOf, [{ id, claim: null }]);
  assert.equal((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor.accepted, true);

  t.tick(HOUR + 1); // replacing the successor starts over: the old agreement is gone
  assert.equal((await owner.call('PUT', url, { email: 'new@example.com' })).status, 200);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 403);
  assert.equal((await heir.call('PUT', `/ofrendas/${id}`, altar())).status, 403, 'replacing the successor ends their access');
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

// ---------- refunds ----------

const paidPI = (over, pi) => checkout({ payment_intent: pi, ...over });
const refund = (pi, over = {}) => JSON.stringify({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: pi, metadata: {}, ...over } } });

test('refunds: a full refund takes back exactly what that payment bought, and a partial one changes nothing', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const features = () => t.db.prepare('SELECT name FROM features WHERE altar_id = ? ORDER BY name').all(id).map(r => r.name);
  await deliver(t, paidPI({ client_reference_id: id, metadata: { feature: 'sevenTiers' } }, 'pi_tiers'));
  await deliver(t, paidPI({ client_reference_id: id, metadata: { feature: 'extraPhotos' } }, 'pi_photos'));
  assert.deepEqual(features(), ['extraPhotos', 'sevenTiers']);
  assert.equal((await deliver(t, refund('pi_tiers', { refunded: false, amount_refunded: 100 }))).status, 200);
  assert.deepEqual(features(), ['extraPhotos', 'sevenTiers'], 'partial refund: nothing changes');
  assert.equal((await deliver(t, refund('pi_tiers'))).status, 200);
  assert.deepEqual(features(), ['extraPhotos'], 'only what that payment bought');
  assert.equal((await deliver(t, refund('pi_tiers'))).status, 200, 'delivered twice');
  assert.deepEqual(features(), ['extraPhotos']);
  const r = t.db.prepare('SELECT refunded_at FROM purchases WHERE payment_intent = ?');
  assert.ok(r.get('pi_tiers').refunded_at && r.get('pi_photos').refunded_at === null);
});

test('refunds: platinum is cleared, and a refund for something unknown or unsigned does nothing', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  await deliver(t, paidPI({ client_reference_id: maria.id, metadata: { feature: 'platinum' } }, 'pi_plat'));
  const plan = () => t.db.prepare('SELECT plan FROM users WHERE id = ?').get(maria.id).plan;
  assert.equal(plan(), 'platinum');
  for (const odd of [refund('pi_nope'), refund('pi_x', { metadata: { feature: 'admin', reference: maria.id } }), refund('../x'), refund(undefined, { metadata: { feature: 'platinum', reference: '../x' } })]) {
    assert.equal((await deliver(t, odd)).status, 200);
  }
  assert.equal(plan(), 'platinum', 'untraceable refunds touch nothing');
  assert.equal((await t.call('POST', '/stripe/webhook', { body: refund('pi_plat'), origin: null })).status, 400, 'unsigned');
  assert.equal(plan(), 'platinum');
  assert.equal((await deliver(t, refund('pi_plat'))).status, 200);
  assert.equal(plan(), null);
  assert.equal((await maria.json('GET', '/me')).body.user.plan, null);
});

test('refunds: paying twice and being refunded once keeps what the other payment covers', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const count = () => t.db.prepare('SELECT COUNT(*) n FROM features WHERE altar_id = ?').get(id).n;
  await deliver(t, paidPI({ client_reference_id: id }, 'pi_a'));
  await deliver(t, paidPI({ client_reference_id: id }, 'pi_b'));
  await deliver(t, refund('pi_b'));
  assert.equal(count(), 1, 'the first payment still covers it');
  await deliver(t, refund('pi_a'));
  assert.equal(count(), 0);
});

test('refunds: a payment with no record is traced through the metadata we put on it', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  t.grant(id, 'sevenTiers');
  await deliver(t, refund('pi_old', { metadata: { feature: 'sevenTiers', reference: id } }));
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM features').get().n, 0);
});

// ---------- changing the email address ----------

test('email change: the code goes to the new address, nothing changes until it is entered, and other devices are signed out', async () => {
  const t = await setup();
  const phone = await t.signIn('maria@example.com');
  const laptop = await t.signIn('maria@example.com');
  const other = await t.signIn('other@example.com');
  const id = await t.altarFor(phone);
  assert.equal((await t.call('POST', '/me/email', { body: { email: 'new@example.com' } })).status, 401);
  assert.equal((await phone.call('POST', '/me/email', { email: 'new@example.com' }).then(r => r.status)), 200);
  const mail = (await t.mailTo('new@example.com'))[0];
  assert.match(mail.subject, /\d{6}/);
  assert.equal((await t.mailTo('maria@example.com')).filter(m => /changed/.test(m.subject)).length, 0, 'the old address is told only when it happens');
  assert.equal((await phone.json('GET', '/me')).body.user.email, 'maria@example.com', 'not yet');
  const code = /(\d{6})/.exec(mail.subject)[1];
  const bad = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  assert.equal((await phone.call('POST', '/me/email/confirm', { code: bad })).status, 400);
  assert.equal((await other.call('POST', '/me/email/confirm', { code })).status, 400, 'the code is for the account that asked');
  const ok = await phone.json('POST', '/me/email/confirm', { code });
  assert.deepEqual([ok.status, ok.body], [200, { email: 'new@example.com' }]);
  assert.equal((await phone.json('GET', '/me')).body.user.email, 'new@example.com');
  assert.equal((await laptop.call('GET', '/me')).status, 401, 'other devices signed out');
  assert.equal((await phone.call('POST', '/me/email/confirm', { code })).status, 400, 'works once');
  const notice = (await t.mailTo('maria@example.com')).find(m => /changed/.test(m.subject));
  assert.ok(notice && notice.text.includes('new@example.com'));
  assert.equal((await phone.json('GET', `/ofrendas/${id}/team`)).body.role, 'owner', 'same account, same ofrendas');
  // The old address now signs in to a fresh, empty account.
  const again = await t.signIn('maria@example.com');
  assert.notEqual(again.id, phone.id);
});

test('email change: bad addresses, the same address, wrong codes, expiry, a taken address, and mail-bombing', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  await t.signIn('taken@example.com');
  for (const email of ['nope', '', undefined, 'maria@example.com', ' MARIA@example.com ']) {
    assert.equal((await maria.call('POST', '/me/email', { email })).status, 400, String(email));
  }
  const send = async (email = 'new@example.com') => {
    const before = (await t.mailTo(email)).length;
    const r = await maria.call('POST', '/me/email', { email });
    return { status: r.status, code: r.status === 200 ? /(\d{6})/.exec((await t.mailTo(email))[before].subject)[1] : null };
  };
  let { code } = await send();
  for (let i = 0; i < t.RULES.emailChangeAttempts; i++) assert.equal((await maria.call('POST', '/me/email/confirm', { code: '000000' })).status, 400);
  assert.equal((await maria.call('POST', '/me/email/confirm', { code })).status, 400, 'five guesses, then the right code is refused too');
  ({ code } = await send());
  t.tick(t.RULES.emailChangeTtl + 1);
  assert.equal((await maria.call('POST', '/me/email/confirm', { code })).status, 400, 'expired');
  assert.equal((await maria.call('POST', '/me/email/confirm', { code: 'abcdef' })).status, 400);
  assert.equal((await maria.call('POST', '/me/email/confirm', { code: 123456 })).status, 400);
  ({ code } = await send('taken@example.com'));
  const clash = await maria.json('POST', '/me/email/confirm', { code });
  assert.deepEqual([clash.status, clash.body.error], [409, 'email_unavailable']);
  assert.equal((await maria.json('GET', '/me')).body.user.email, 'maria@example.com');
  // At most emailChangesPerHour codes an hour, however the address varies.
  const sends = [];
  for (let i = 0; i < t.RULES.emailChangesPerHour + 2; i++) sends.push((await send(`victim${i}@example.com`)).status);
  assert.deepEqual(sends.filter(s => s === 200).length + sends.filter(s => s === 429).length, sends.length);
  assert.ok(sends.includes(429));
  t.tick(HOUR + 1);
  assert.equal((await send('later@example.com')).status, 200, 'allowed again after the hour');
});

test('email change: the CSRF origin check applies', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const r = await t.call('POST', '/me/email', { body: { email: 'new@example.com' }, cookie: maria.cookie, origin: 'https://evil.test' });
  assert.equal(r.status, 403);
});

// ---------- deleting an account ----------

test('delete account: needs sign-in and the email typed back, then removes the person and their traces', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const sam = await t.signIn('sam@example.com');
  assert.equal((await t.call('DELETE', '/me', { body: { email: 'sam@example.com' } })).status, 401);
  assert.equal((await sam.call('DELETE', '/me', { email: 'someone@else.com' })).status, 400);
  assert.equal((await sam.call('DELETE', '/me', {})).status, 400);
  // Sam keeps a co-kept altar of Maria's, was invited to another, and is a named successor on a third.
  const mine = await t.altarFor(maria, altar(frame('a', png())));
  await maria.call('POST', `/ofrendas/${mine}/invites`, { email: 'sam@example.com' });
  await sam.call('POST', '/invites/accept', { token: await t.tokenFrom('sam@example.com', /#i=([\w-]{43})/) });
  const second = await t.altarFor(maria);
  await maria.call('PUT', `/ofrendas/${second}/successor`, { email: 'sam@example.com' });
  const third = await t.altarFor(maria);
  await maria.call('POST', `/ofrendas/${third}/invites`, { email: 'sam@example.com' });
  const res = await sam.call('DELETE', '/me', { email: ' SAM@example.com ' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  for (const [table, col] of [['users', 'email'], ['login_challenges', 'email'], ['invites', 'email'], ['successors', 'email']]) {
    assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = 'sam@example.com'`).get().n, 0, table);
  }
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(sam.id).n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_members WHERE user_id = ?').get(sam.id).n, 0);
  assert.equal((await sam.call('GET', '/me')).status, 401);
  assert.equal((await maria.call('GET', `/ofrendas/${mine}`)).status, 200, 'what Maria owns is untouched');
  assert.deepEqual((await maria.json('GET', `/ofrendas/${mine}/team`)).body.members.map(m => m.email), ['maria@example.com']);
  // Signing in with the old address starts over with nothing.
  const fresh = await t.signIn('sam@example.com');
  assert.equal((await fresh.json('GET', '/me')).body.altars.length, 0);
});

test('delete account: ofrendas other people keep are passed on to them; only ones nobody else keeps are deleted, and only when the person says so', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const sam = await t.signIn('sam@example.com');
  const id = await t.altarFor(maria, altar(frame('a', png())));
  const solo = await t.altarFor(maria);
  await maria.call('POST', `/ofrendas/${id}/invites`, { email: 'sam@example.com' });
  await sam.call('POST', '/invites/accept', { token: await t.tokenFrom('sam@example.com', /#i=([\w-]{43})/) });
  const refused = await maria.json('DELETE', '/me', { email: 'maria@example.com' });
  assert.deepEqual([refused.status, refused.body.error, refused.body.owned, refused.body.handedOn], [409, 'owns_ofrendas', 1, 1]);
  assert.equal((await maria.json('DELETE', '/me', { email: 'maria@example.com', deleteOfrendas: 'yes' })).status, 409, 'only a real true counts');
  assert.equal((await maria.call('GET', '/me')).status, 200, 'refusals change nothing');
  assert.equal((await maria.call('DELETE', '/me', { email: 'maria@example.com', deleteOfrendas: true })).status, 200);
  assert.equal((await t.call('GET', `/ofrendas/${solo}`)).status, 404, 'the one nobody else keeps is gone');
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200, 'the shared one is not erased');
  assert.deepEqual((await sam.json('GET', '/me')).body.altars.map(a => [a.id, a.role]), [[id, 'owner']]);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'only Sam remains');
  assert.ok((await t.mailTo('sam@example.com')).some(m => /now own/i.test(m.subject)));
});

test('delete account: payment records stay without personal data, and a later refund is harmless', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  await deliver(t, paidPI({ client_reference_id: maria.id, metadata: { feature: 'platinum' } }, 'pi_plat'));
  assert.equal((await maria.call('DELETE', '/me', { email: 'maria@example.com' })).status, 200);
  const rows = t.db.prepare('SELECT * FROM purchases').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('maria'));
  assert.equal((await deliver(t, refund('pi_plat'))).status, 200);
});

test('housekeeping: expired sign-in records, sessions and email-change codes are cleared out by later sign-ins', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  await maria.call('POST', '/me/email', { email: 'new@example.com' });
  const n = table => t.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  assert.deepEqual([n('login_challenges'), n('email_changes')], [1, 1]);
  await t.advance(2 * DAY);
  await t.call('POST', '/auth/start', { body: { method: 'code', email: 'other@example.com' } });
  assert.equal(n('login_challenges'), 1, 'only the new one is left');
  assert.equal(n('email_changes'), 0);
  await t.advance(t.RULES.sessionTtl + DAY);
  await t.call('POST', '/auth/start', { body: { method: 'code', email: 'other@example.com' } });
  assert.equal(n('sessions'), 0);
});

// ---------- vanity names ----------

test('names: only the owner picks one, it must be well formed, and it points back to the same ofrenda', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const sam = await t.signIn('sam@example.com');
  const id = await t.altarFor(maria, altar(frame('a', png())));
  const put = (who, slug, ofrenda = id) => who.json('PUT', `/ofrendas/${ofrenda}/slug`, { slug });
  assert.equal((await t.call('PUT', `/ofrendas/${id}/slug`, { body: { slug: 'abuela-rosa' } })).status, 401);
  assert.equal((await put(sam, 'abuela-rosa')).status, 403, 'not a member');
  await maria.call('POST', `/ofrendas/${id}/invites`, { email: 'sam@example.com' });
  await sam.call('POST', '/invites/accept', { token: await t.tokenFrom('sam@example.com', /#i=([\w-]{43})/) });
  assert.equal((await put(sam, 'abuela-rosa')).status, 403, 'a co-keeper cannot');
  for (const bad of ['ab', 'a'.repeat(41), 'Abuela_Rosa', 'abuela--rosa', '-abuela', 'abuela-', 'abuela rosa', 'abuela/rosa', '..', 'abcdefghijkl', 'abcd2345wxyz', '', null, 5, undefined]) {
    assert.equal((await put(maria, bad)).body.error ?? 'ok', 'bad_name', String(bad));
  }
  const ok = await put(maria, '  Abuela-Rosa ');
  assert.deepEqual([ok.status, ok.body], [200, { slug: 'abuela-rosa' }], 'trimmed and lower-cased');
  const found = await t.call('GET', '/ofrendas/by-name/abuela-rosa');
  assert.deepEqual([found.status, await found.json()], [200, { id, slug: 'abuela-rosa' }]);
  assert.equal((await t.call('GET', '/ofrendas/by-name/nobody-here')).status, 404);
  assert.equal((await t.call('GET', '/ofrendas/by-name/Abuela_Rosa')).status, 404);
  assert.equal((await t.call('GET', '/ofrendas/by-name/abuela-rosa', { origin: null })).status, 200, 'public');
  // The id link still works, and members see the name.
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200);
  assert.equal((await maria.json('GET', '/me')).body.altars[0].slug, 'abuela-rosa');
  assert.equal((await sam.json('GET', `/ofrendas/${id}/team`)).body.slug, 'abuela-rosa');
  assert.equal((await maria.json('GET', `/ofrendas/${id}/team`)).body.slug, 'abuela-rosa');
  assert.equal((await t.call('PUT', `/ofrendas/${id}/slug`, { body: { slug: 'x-y-z' }, cookie: maria.cookie, origin: 'https://evil.test' })).status, 403, 'CSRF');
});

test('names: taken names stay taken, even after the owner moves on, and an owner may take an old one back', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const sam = await t.signIn('sam@example.com');
  const a = await t.altarFor(maria);
  const b = await t.altarFor(sam);
  const set = (who, id, slug) => who.json('PUT', `/ofrendas/${id}/slug`, { slug });
  assert.equal((await set(maria, a, 'abuela-rosa')).status, 200);
  assert.equal((await set(sam, b, 'abuela-rosa')).body.error, 'name_taken');
  assert.equal((await set(maria, a, 'abuela-rosa')).status, 200, 'saying it again is harmless');
  t.tick(1000);
  assert.equal((await set(maria, a, 'rosa-2024')).status, 200);
  assert.equal((await set(sam, b, 'abuela-rosa')).body.error, 'name_taken', 'her old name is still hers, so shared links cannot be taken over');
  assert.equal((await (await t.call('GET', '/ofrendas/by-name/abuela-rosa')).json()).slug, 'rosa-2024', 'old name works and reports the current one');
  t.tick(1000);
  assert.equal((await set(maria, a, 'abuela-rosa')).status, 200);
  assert.equal((await maria.json('GET', '/me')).body.altars[0].slug, 'abuela-rosa', 'taken back as the current name');
  // At most slugsPerAltar names in a lifetime.
  for (let i = 0; i < t.RULES.slugsPerAltar - 2; i++) { t.tick(1000); assert.equal((await set(maria, a, `name-${i}`)).status, 200); }
  assert.equal((await set(maria, a, 'one-too-many')).body.error, 'too_many_names');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_slugs WHERE altar_id = ?').get(a).n, t.RULES.slugsPerAltar);
});

test('names: two people claiming the same name at once get one winner, and deleting the ofrenda or account frees it', async () => {
  const t = await setup();
  const maria = await t.signIn('maria@example.com');
  const sam = await t.signIn('sam@example.com');
  const a = await t.altarFor(maria);
  const b = await t.altarFor(sam);
  const results = await Promise.all([maria.call('PUT', `/ofrendas/${a}/slug`, { slug: 'same-name' }), sam.call('PUT', `/ofrendas/${b}/slug`, { slug: 'same-name' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? maria : sam;
  const winnerId = winner === maria ? a : b;
  const loser = winner === maria ? sam : maria;
  const loserId = winner === maria ? b : a;
  assert.equal((await winner.call('DELETE', `/ofrendas/${winnerId}`)).status, 200);
  assert.equal((await t.call('GET', '/ofrendas/by-name/same-name')).status, 404, 'gone with the ofrenda');
  assert.equal((await loser.call('PUT', `/ofrendas/${loserId}/slug`, { slug: 'same-name' })).status, 200, 'and free again');
  assert.equal((await loser.call('DELETE', '/me', { email: loser.email, deleteOfrendas: true })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_slugs').get().n, 0, 'deleting an account takes its names too');
});

test('names: a handover keeps the name, and a name never shadows a real id', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  await owner.call('PUT', `/ofrendas/${id}/slug`, { slug: 'for-the-family' });
  await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim`)).status, 201);
  await t.advance(t.RULES.claimWait + DAY, [heir]);
  assert.equal((await heir.call('POST', `/ofrendas/${id}/claim/complete`)).status, 200);
  assert.equal((await (await t.call('GET', '/ofrendas/by-name/for-the-family')).json()).id, id);
  assert.equal((await heir.call('PUT', `/ofrendas/${id}/slug`, { slug: 'new-owner-name' })).status, 200, 'the new owner can rename it');
  const formerOwner = await t.signIn('owner@example.com');
  assert.equal((await formerOwner.call('PUT', `/ofrendas/${id}/slug`, { slug: 'old-owner-name' })).status, 403, 'the old owner is now a co-keeper');
  // An id-shaped string is refused as a name, so /a/<id> always means that id.
  assert.equal((await heir.json('PUT', `/ofrendas/${id}/slug`, { slug: id })).body.error, 'bad_name');
});

test('first sign-in: one welcome email, and (when enabled) a starter ofrenda called My Ofrenda', async () => {
  const t = await setup({ env: { STARTER_OFRENDA: '1' } });
  const { cookie } = await t.signIn('new@example.com');
  const welcome = (await t.mailTo('new@example.com')).filter(m => m.subject === 'Welcome to Digifrenda');
  assert.equal(welcome.length, 1);
  assert.match(welcome[0].text, /My Ofrenda/);
  const me = await (await t.call('GET', '/me', { cookie })).json();
  assert.equal(me.altars.length, 1);
  const state = await (await t.call('GET', `/ofrendas/${me.altars[0].id}`)).json();
  assert.equal(state.name, 'My Ofrenda');
  assert.ok(state.items.length > 0);
  const { validateOfrenda } = await import('../server/validate.mjs');
  assert.equal(validateOfrenda(state, { entitlements: {} }).ok, true);
  assert.ok(welcome[0].text.includes(`${ORIGIN}/a/${me.altars[0].id}`));

  // Signing in again sends no second welcome and makes no second ofrenda.
  await t.signIn('new@example.com');
  assert.equal((await t.mailTo('new@example.com')).filter(m => m.subject === 'Welcome to Digifrenda').length, 1);
  assert.equal((await (await t.call('GET', '/me', { cookie })).json()).altars.length, 1);

  // They can still add more, up to the free limit (the starter counts).
  assert.equal((await t.call('POST', '/ofrendas', { cookie })).status, 201);
  assert.equal((await t.call('POST', '/ofrendas', { cookie })).status, 201);
  assert.equal((await t.call('POST', '/ofrendas', { cookie })).status, 402);
});

test('first sign-in without STARTER_OFRENDA: welcome email only, no ofrenda', async () => {
  const t = await setup();
  const { cookie } = await t.signIn('plain@example.com');
  assert.equal((await t.mailTo('plain@example.com')).filter(m => m.subject === 'Welcome to Digifrenda').length, 1);
  assert.equal((await (await t.call('GET', '/me', { cookie })).json()).altars.length, 0);
});

test('a share email never calls the loved one "My Ofrenda"', async () => {
  const t = await setup({ env: { STARTER_OFRENDA: '1' } });
  const { cookie } = await t.signIn('own@example.com');
  const id = (await (await t.call('GET', '/me', { cookie })).json()).altars[0].id;
  const res = await t.call('POST', `/ofrendas/${id}/share`, { cookie, body: { email: 'friend@example.com', access: 'view' } });
  assert.equal(res.status, 201);
  const mail = (await t.mailTo('friend@example.com'))[0];
  assert.doesNotMatch(mail.subject + mail.text, /My Ofrenda/);
});

test('sign-in: the person chooses a link or a code, and only that one is emailed and usable', async () => {
  const t = await setup();
  // Link only: no code in the email or subject, and no code can be guessed for it.
  const l = await (await t.call('POST', '/auth/start', { body: { method: 'code', email: 'link@example.com', method: 'link' } })).json();
  assert.equal(l.method, 'link');
  const [lm] = await t.mailTo('link@example.com');
  assert.equal(lm.subject, 'Your Digifrenda sign-in link');
  assert.doesNotMatch(lm.subject + lm.text, /\b\d{6}\b/);
  for (let c = 0; c < 5; c++) assert.equal((await t.call('POST', '/auth/code', { body: { challenge: l.challenge, code: String(100000 + c) } })).status, 400);
  const token = /#t=([\w-]{43})/.exec(lm.text)[1];
  assert.equal((await t.call('POST', '/auth/redeem', { body: { token } })).status, 200);

  // Code only: no link in the email, and no link token exists for it.
  const c = await (await t.call('POST', '/auth/start', { body: { method: 'code', email: 'code@example.com', method: 'code' } })).json();
  const [cm] = await t.mailTo('code@example.com');
  assert.match(cm.subject, /^Your Digifrenda sign-in code is \d{6}$/);
  assert.doesNotMatch(cm.text, /signin#t=|https?:\/\//);
  const code = /(\d{6})/.exec(cm.subject)[1];
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge: c.challenge, code } })).status, 200);
  assert.equal((await t.call('POST', '/auth/code', { body: { challenge: c.challenge, code } })).status, 400, 'code replay');

  // Anything else is refused and sends nothing.
  const bad = await t.call('POST', '/auth/start', { body: { method: 'code', email: 'x@example.com', method: 'carrier-pigeon' } });
  assert.equal(bad.status, 400);
  assert.equal((await t.mailTo('x@example.com')).length, 0);
});

test('successor access: removing the successor ends it, but a separately invited co-keeper keeps theirs', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner, altar());
  // Invited as a co-keeper first, then also named successor.
  const inv = await owner.call('POST', `/ofrendas/${id}/invites`, { email: 'both@example.com' });
  assert.equal(inv.status, 201);
  const both = await t.signIn('both@example.com');
  const itoken = await t.tokenFrom('both@example.com', /\/invite#i=([\w-]{43})/);
  assert.equal((await both.call('POST', '/invites/accept', { token: itoken })).status, 200);
  assert.equal((await owner.call('PUT', `/ofrendas/${id}/successor`, { email: 'both@example.com' })).status, 200);
  const stoken = await t.tokenFrom('both@example.com', /\/successor#s=([\w-]{43})/);
  assert.equal((await both.call('POST', '/successor/accept', { token: stoken })).status, 200);
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}/successor`)).status, 200);
  assert.equal((await both.call('PUT', `/ofrendas/${id}`, altar())).status, 200, 'their own invitation still stands');
  // And a successor who becomes owner is no longer marked as a successor-only keeper.
  assert.equal(t.db.prepare("SELECT via_successor v FROM altar_members WHERE user_id = ?").get(both.id).v, 0);
});

test('a year of silence is the rule', async () => {
  const { RULES } = await import('../server/rules.mjs');
  assert.equal(RULES.inactiveAfter, 365 * DAY);
});


// ---------- multiple owners ----------
async function twoOwners(t) {
  const a = await t.signIn('a@example.com'), b = await t.signIn('b@example.com');
  const id = await t.altarFor(a, altar(frame('x', png())));
  await a.call('POST', `/ofrendas/${id}/invites`, { email: 'b@example.com' });
  await b.call('POST', '/invites/accept', { token: await t.tokenFrom('b@example.com', /#i=([\w-]{43})/) });
  t.db.prepare("UPDATE altar_members SET role = 'owner' WHERE altar_id = ? AND user_id = ?").run(id, b.id);
  return { a, b, id };
}

test('multiple owners: they cannot remove each other, either can step away, and the last one cannot just leave', async () => {
  const t = await setup();
  const { a, b, id } = await twoOwners(t);
  const refused = await a.json('DELETE', `/ofrendas/${id}/members/${b.id}`);
  assert.deepEqual([refused.status, refused.body.error], [403, 'owners_cannot_remove_owners']);
  assert.equal((await b.json('DELETE', `/ofrendas/${id}/members/${a.id}`)).body.error, 'owners_cannot_remove_owners');
  assert.equal((await a.call('DELETE', `/ofrendas/${id}/members/${a.id}`)).status, 200, 'an owner can step away themselves');
  const last = await b.json('DELETE', `/ofrendas/${id}/members/${b.id}`);
  assert.deepEqual([last.status, last.body.error], [400, 'owner_cannot_leave']);
});

test('multiple owners: deleting as one of several only steps you away; the last owner deleting an unshared ofrenda erases it', async () => {
  const t = await setup();
  const { a, b, id } = await twoOwners(t);
  assert.equal((await a.json('DELETE', `/ofrendas/${id}`)).body.outcome, 'left');
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200);
  assert.equal((await b.json('DELETE', `/ofrendas/${id}`)).body.outcome, 'deleted');
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 404);
});

test('deleting as the last owner passes the ofrenda to the people who keep it, or to the named successor alone', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com'), k1 = await t.signIn('k1@example.com'), k2 = await t.signIn('k2@example.com');
  const id = await t.altarFor(owner, altar(frame('a', png())));
  for (const k of [k1, k2]) {
    await owner.call('POST', `/ofrendas/${id}/invites`, { email: k.email });
    await k.call('POST', '/invites/accept', { token: await t.tokenFrom(k.email, /#i=([\w-]{43})/) });
  }
  assert.equal((await owner.json('DELETE', `/ofrendas/${id}`)).body.outcome, 'passed');
  assert.deepEqual((await k1.json('GET', '/me')).body.altars.map(x => x.role), ['owner']);
  assert.deepEqual((await k2.json('GET', '/me')).body.altars.map(x => x.role), ['owner']);
  assert.equal((await owner.json('GET', '/me')).body.altars.length, 0);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200, 'never erased while others keep it');

  const s = await t.heirScenario();
  const other = await t.signIn('other@example.com');
  await s.owner.call('POST', `/ofrendas/${s.id}/invites`, { email: other.email });
  await other.call('POST', '/invites/accept', { token: await t.tokenFrom(other.email, /#i=([\w-]{43})/) });
  assert.equal((await s.owner.json('DELETE', `/ofrendas/${s.id}`)).body.outcome, 'passed');
  assert.equal((await s.heir.json('GET', '/me')).body.altars[0].role, 'owner');
  assert.equal((await other.json('GET', '/me')).body.altars[0].role, 'keeper', 'the named successor, not everyone');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM successors WHERE altar_id = ?').get(s.id).n, 0);
});

test('an ofrenda passed to someone already at the free limit is locked: viewable, not editable, never deleted, and upgrading unlocks it', async () => {
  const t = await setup();
  const giver = await t.signIn('giver@example.com'), full = await t.signIn('full@example.com');
  const gift = await t.altarFor(giver, altar(frame('a', png())));
  await giver.call('POST', `/ofrendas/${gift}/invites`, { email: full.email });
  await full.call('POST', '/invites/accept', { token: await t.tokenFrom(full.email, /#i=([\w-]{43})/) });
  t.tick(1000);
  const mine = [];
  for (let i = 0; i < t.RULES.freeAltars; i++) { mine.push(await t.altarFor(full)); t.tick(1000); }
  await giver.call('DELETE', `/ofrendas/${gift}`);
  t.tick(1000);
  const me = (await full.json('GET', '/me')).body;
  assert.equal(me.altars.length, t.RULES.freeAltars + 1);
  assert.deepEqual(me.altars.filter(a => a.locked).map(a => a.id), [gift], 'the one passed on is the locked one');
  assert.equal((await full.call('PUT', `/ofrendas/${mine[0]}`, altar(frame('a')))).status, 200, 'their own ofrendas still edit');
  const blocked = await full.json('PUT', `/ofrendas/${gift}`, altar(frame('a')));
  assert.deepEqual([blocked.status, blocked.body.error, blocked.body.upgrade], [402, 'ofrenda_locked', 'platinum']);
  assert.equal((await t.call('GET', `/ofrendas/${gift}`)).status, 200, 'visitors can still view it');
  assert.ok((await t.mailTo(full.email)).some(m => /waiting for an upgrade/.test(m.subject)));
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(full.id);
  assert.equal((await full.call('PUT', `/ofrendas/${gift}`, altar(frame('a')))).status, 200, 'upgrading unlocks it');
  t.db.prepare("UPDATE users SET plan = NULL WHERE id = ?").run(full.id);
  assert.equal((await full.call('DELETE', `/ofrendas/${mine[1]}`)).status, 200);
  assert.equal((await full.call('PUT', `/ofrendas/${gift}`, altar(frame('a')))).status, 200, 'making room unlocks it too');
});

test('multiple owners: platinum on any owner covers the ofrenda, and a takeover needs every owner to have gone quiet', async () => {
  const t = await setup();
  const { a, b, id } = await twoOwners(t);
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(b.id);
  assert.ok(Object.values((await a.json('GET', `/ofrendas/${id}/team`)).body.entitlements).every(Boolean));
  const heir = await t.signIn('heir@example.com');
  await a.call('PUT', `/ofrendas/${id}/successor`, { email: heir.email });
  await heir.call('POST', '/successor/accept', { token: await t.tokenFrom(heir.email, /#s=([\w-]{43})/) });
  await t.advance(t.RULES.inactiveAfter + DAY, [heir, b]);
  const early = await heir.json('POST', `/ofrendas/${id}/claim`);
  assert.deepEqual([early.status, early.body.error], [403, 'owner_active'], 'one owner is still around');
});

// ---------- direct handover ----------
test('handover: needs the typed word, and goes at once to an existing account, who becomes an owner beside the giver', async () => {
  const t = await setup();
  const giver = await t.signIn('giver@example.com'), friend = await t.signIn('friend@example.com');
  const id = await t.altarFor(giver, altar(frame('a', png())));
  const path = `/ofrendas/${id}/handover`;
  assert.equal((await giver.json('POST', path, { email: friend.email })).body.error, 'confirm_required');
  assert.equal((await giver.json('POST', path, { email: friend.email, confirm: 'nope' })).body.error, 'confirm_required');
  assert.equal((await friend.json('POST', path, { email: giver.email, confirm: 'handover' })).status, 403, 'only an owner can hand over');
  assert.equal((await giver.json('POST', path, { email: giver.email, confirm: 'handover' })).body.error, 'bad_email');
  const r = await giver.json('POST', path, { email: friend.email, confirm: 'Handover' });
  assert.deepEqual([r.status, r.body.status], [201, 'done']);
  assert.deepEqual((await friend.json('GET', '/me')).body.altars.map(a => a.role), ['owner']);
  assert.deepEqual((await giver.json('GET', '/me')).body.altars.map(a => a.role), ['owner'], 'the giver stays an owner');
  assert.equal((await giver.json('POST', path, { email: friend.email, confirm: 'handover' })).body.error, 'already_owner');
  assert.ok((await t.mailTo(friend.email)).some(m => /handed an ofrenda over/.test(m.subject)));
});

test('handover: a co-keeper can be handed an ofrenda, and a free account at the limit is blocked until they upgrade', async () => {
  const t = await setup();
  const giver = await t.signIn('giver@example.com'), keeper = await t.signIn('keeper@example.com');
  const id = await t.altarFor(giver);
  await giver.call('POST', `/ofrendas/${id}/invites`, { email: keeper.email });
  await keeper.call('POST', '/invites/accept', { token: await t.tokenFrom(keeper.email, /#i=([\w-]{43})/) });
  for (let i = 0; i < t.RULES.freeAltars; i++) await t.altarFor(keeper);
  const blocked = await giver.json('POST', `/ofrendas/${id}/handover`, { email: keeper.email, confirm: 'handover' });
  assert.deepEqual([blocked.status, blocked.body.error], [409, 'recipient_at_limit']);
  assert.equal((await keeper.json('GET', '/me')).body.altars.find(a => a.id === id).role, 'keeper');
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(keeper.id);
  assert.equal((await giver.json('POST', `/ofrendas/${id}/handover`, { email: keeper.email, confirm: 'handover' })).body.status, 'done');
  assert.equal((await keeper.json('GET', '/me')).body.altars.find(a => a.id === id).role, 'owner');
});

test('handover: to a new person it waits, can be cancelled, and takes effect on their first sign-in', async () => {
  const t = await setup({ env: { STARTER_OFRENDA: '1' } });
  const giver = await t.signIn('giver@example.com');
  const a = await t.altarFor(giver), b = await t.altarFor(giver);
  const sent = await giver.json('POST', `/ofrendas/${a}/handover`, { email: 'New@Example.com', confirm: 'handover' });
  assert.deepEqual([sent.status, sent.body.status], [201, 'pending']);
  assert.equal(sent.body.expiresAt, t.now() + t.RULES.handoverWait);
  assert.equal((await giver.json('POST', `/ofrendas/${a}/handover`, { email: 'other@example.com', confirm: 'handover' })).body.error, 'handover_pending');
  assert.equal((await giver.json('GET', `/ofrendas/${a}/team`)).body.handover.email, 'new@example.com');
  assert.ok((await t.mailTo('new@example.com')).some(m => /hand an ofrenda over/.test(m.subject)));
  assert.equal((await giver.call('DELETE', `/ofrendas/${a}/handover`)).status, 200, 'cancelled before it was accepted');
  assert.equal((await giver.call('DELETE', `/ofrendas/${a}/handover`)).status, 404);

  await giver.call('POST', `/ofrendas/${a}/handover`, { email: 'new@example.com', confirm: 'handover' });
  await giver.call('POST', `/ofrendas/${b}/handover`, { email: 'new@example.com', confirm: 'handover' });
  await t.advance(DAY + 1000, [giver]); // the daily limit is tested separately
  const starter = (await giver.json('GET', '/me')).body.altars.find(x => x.id !== a && x.id !== b).id;
  const third = await giver.json('POST', `/ofrendas/${starter}/handover`, { email: 'new@example.com', confirm: 'handover' });
  assert.equal(third.body.error, 'recipient_at_limit', 'they would be over the free limit with their starter ofrenda');
  const fresh = await t.signIn('new@example.com');
  const mine = (await fresh.json('GET', '/me')).body.altars;
  assert.equal(mine.length, 3, 'the starter and the two handed over');
  assert.deepEqual(mine.filter(x => x.role === 'owner').map(x => x.id).sort(), [a, b, mine.find(x => x.id !== a && x.id !== b).id].sort());
  assert.ok(mine.every(x => !x.locked));
  assert.equal((await giver.json('GET', `/ofrendas/${a}/team`)).body.handover, null);
  assert.ok((await t.mailTo(giver.email)).some(m => /accepted your handover/.test(m.subject)));
});

test('handover: an account can start only a few a day', async () => {
  const t = await setup();
  const giver = await t.signIn('giver@example.com');
  for (let i = 0; i < t.RULES.handoversPerDay; i++) {
    const id = await t.altarFor(giver);
    assert.equal((await giver.json('POST', `/ofrendas/${id}/handover`, { email: `p${i}@example.com`, confirm: 'handover' })).status, 201);
    await giver.call('DELETE', `/ofrendas/${id}/handover`);
  }
  const target = (await giver.json('GET', '/me')).body.altars[0].id;
  assert.equal((await giver.json('POST', `/ofrendas/${target}/handover`, { email: 'late@example.com', confirm: 'handover' })).body.error, 'too_many_handovers');
  t.tick(DAY + 1000);
  assert.equal((await giver.call('GET', '/me')).status, 200);
});

// ---------- visit counting ----------
test('visits: counted once a day for signed-in people who are not owners, and nobody else', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com'), fan = await t.signIn('fan@example.com'), other = await t.signIn('other@example.com');
  const id = await t.altarFor(owner, altar(frame('a', png())));
  const visit = c => (c ? c.call('POST', `/ofrendas/${id}/visit`) : t.call('POST', `/ofrendas/${id}/visit`));
  const days = c => t.db.prepare('SELECT days FROM altar_visits WHERE altar_id = ? AND user_id = ?').get(id, c.id)?.days;
  for (const c of [owner, fan, fan, undefined]) assert.equal((await visit(c)).status, 204);
  assert.equal(days(fan), 1, 'twice in a day is one');
  assert.equal(days(owner), undefined, 'owners are not counted');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_visits').get().n, 1, 'nobody signed out is recorded');
  await t.advance(DAY, [owner, fan, other]);
  await visit(fan); await visit(other);
  assert.equal(days(fan), 2);
  assert.deepEqual((await t.store.topVisitors(t.env.DB, id)).map(v => [v.email, v.days]), [['fan@example.com', 2]]);
  await t.advance(DAY, [owner, fan, other]);
  await visit(other);
  assert.deepEqual((await t.store.topVisitors(t.env.DB, id)).map(v => v.email), ['fan@example.com', 'other@example.com'], 'a tie returns both');
  assert.equal((await t.call('POST', '/ofrendas/nope/visit')).status, 204, 'says nothing about whether an ofrenda exists');
  assert.equal((await owner.call('DELETE', `/ofrendas/${id}`)).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM altar_visits').get().n, 0, 'gone with the ofrenda');
});


// ---------- reminders and the daily job ----------
const subjects = async (t, email, re) => (await t.mailTo(email)).filter(m => re.test(m.subject));

test('successor: naming one emails the owner, and the wait and automatic transfer are the owner\'s choice', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const id = await t.altarFor(owner);
  assert.equal((await owner.json('PUT', `/ofrendas/${id}/successor`, { email: 'heir@example.com', waitMonths: 5 })).body.error, 'bad_wait');
  assert.equal((await owner.json('PUT', `/ofrendas/${id}/successor`, { email: 'heir@example.com', auto: 'yes' })).body.error, 'bad_wait');
  assert.equal((await owner.call('PUT', `/ofrendas/${id}/successor`, { email: 'heir@example.com', waitMonths: 6, auto: false })).status, 200);
  assert.equal((await subjects(t, owner.email, /named a successor/)).length, 1);
  assert.deepEqual((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor, { email: 'heir@example.com', accepted: false, waitMonths: 6, auto: false });
  assert.equal((await owner.json('PUT', `/ofrendas/${id}/successor/settings`, { waitMonths: 12 })).status, 200);
  assert.deepEqual((await owner.json('GET', `/ofrendas/${id}/team`)).body.successor, { email: 'heir@example.com', accepted: false, waitMonths: 12, auto: true });
  assert.equal((await owner.json('PUT', `/ofrendas/${id}/successor/settings`, { waitMonths: 7 })).body.error, 'bad_wait');
});

test('daily job: after a year away the 30-day notice starts by itself, with reminders on days 15 and 27, then the successor becomes owner', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  await t.advance(t.RULES.successorWaits[12] - DAY, [heir]);
  await t.runJob();
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0, 'not yet a year');
  await t.advance(2 * DAY, [heir]);
  await t.runJob(); await t.runJob();
  assert.equal(t.db.prepare('SELECT auto FROM claims WHERE altar_id = ?').get(id).auto, 1);
  assert.equal((await subjects(t, owner.email, /pass to your successor in 30 days/)).length, 1, 'once, however often the job runs');
  assert.equal((await subjects(t, heir.email, /may soon be yours/)).length, 1);
  await t.advance(15 * DAY, [heir]); await t.runJob(); await t.runJob();
  assert.equal((await subjects(t, owner.email, /Reminder/)).length, 1);
  await t.advance(12 * DAY, [heir]); await t.runJob();
  assert.equal((await subjects(t, owner.email, /Reminder/)).length, 2);
  await t.advance(3 * DAY, [heir]); await t.runJob();
  assert.equal((await subjects(t, owner.email, /Reminder/)).length, 2, 'no more after the second');
  assert.equal(t.db.prepare("SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?").get(id, heir.id).role, 'owner');
  assert.equal(t.db.prepare("SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?").get(id, owner.id).role, 'keeper', 'the old owner stays as a co-keeper');
  assert.equal((await subjects(t, owner.email, /new owner/)).length, 1);
});

test('daily job: the owner signing in during the notice stops it, and it starts again only after another full wait', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  await t.advance(t.RULES.successorWaits[12] + DAY, [heir]);
  await t.runJob();
  await t.advance(10 * DAY, [heir]);
  const back = await t.signIn('owner@example.com'); // signing in at all is enough
  assert.ok(back);
  assert.ok(t.db.prepare('SELECT cancelled_at FROM claims WHERE altar_id = ?').get(id).cancelled_at);
  await t.advance(40 * DAY, [heir, back]); await t.runJob();
  assert.equal(t.db.prepare('SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?').get(id, owner.id).role, 'owner');
  assert.equal((await subjects(t, owner.email, /pass to your successor in 30 days/)).length, 1, 'no second notice yet');
});

test('daily job: six months works, and with automatic transfer off nothing starts until the successor asks', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  await owner.call('PUT', `/ofrendas/${id}/successor/settings`, { waitMonths: 6, auto: false });
  await t.advance(t.RULES.successorWaits[6] + DAY, [heir]);
  await t.runJob();
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0, 'automatic transfer is off');
  assert.equal((await heir.json('POST', `/ofrendas/${id}/claim`)).status, 201, 'the successor may ask once the six months are up');
  await owner.call('PUT', `/ofrendas/${id}/successor/settings`, { waitMonths: 6, auto: true });
  const t2 = await setup();
  const s2 = await t2.heirScenario();
  await s2.owner.call('PUT', `/ofrendas/${s2.id}/successor/settings`, { waitMonths: 6 });
  await t2.advance(t2.RULES.successorWaits[6] - 10 * DAY, [s2.heir]); await t2.runJob();
  assert.equal(t2.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0, 'too early for six months');
  await t2.advance(11 * DAY, [s2.heir]); await t2.runJob();
  assert.equal(t2.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 1);
});

test('daily job: a successor who asked is still the one who finishes it; the job only reminds', async () => {
  const t = await setup();
  const { owner, heir, id } = await t.heirScenario();
  await owner.call('PUT', `/ofrendas/${id}/successor/settings`, { auto: false });
  await t.advance(t.RULES.inactiveAfter + DAY, [heir]);
  assert.equal((await heir.json('POST', `/ofrendas/${id}/claim`)).status, 201);
  await t.advance(16 * DAY, [heir]); await t.runJob();
  assert.equal((await subjects(t, owner.email, /Reminder/)).length, 1);
  await t.advance(20 * DAY, [heir]); await t.runJob();
  assert.equal(t.db.prepare('SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?').get(id, owner.id).role, 'owner', 'not completed by the job');
  assert.equal((await heir.json('POST', `/ofrendas/${id}/claim/complete`)).body.ok, true);
});

async function waitingHandover(t, extraSetup) {
  const giver = await t.signIn('giver@example.com');
  const id = await t.altarFor(giver, altar(frame('a', png())));
  const people = {};
  for (const n of ['fan1', 'fan2', 'fan3']) people[n] = await t.signIn(`${n}@example.com`);
  if (extraSetup) await extraSetup({ giver, id, ...people });
  assert.equal((await giver.json('POST', `/ofrendas/${id}/handover`, { email: 'never@example.com', confirm: 'handover' })).body.status, 'pending');
  return { giver, id, ...people };
}
const roleOf = (t, id, u) => t.db.prepare('SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?').get(id, u.id)?.role ?? null;

test('daily job: a handover nobody signs up for sends reminders after 30 days, then passes to the most frequent signed-in visitor', async () => {
  const t = await setup();
  const w = await waitingHandover(t, async ({ id, fan1, fan2 }) => {
    await fan1.call('POST', `/ofrendas/${id}/visit`); await fan2.call('POST', `/ofrendas/${id}/visit`);
  });
  const all = [w.giver, w.fan1, w.fan2, w.fan3];
  await t.advance(DAY, all); await w.fan1.call('POST', `/ofrendas/${w.id}/visit`); // fan1 has two days, fan2 one
  await t.advance(28 * DAY, all); await t.runJob();
  assert.equal((await subjects(t, 'never@example.com', /still waiting/)).length, 0, 'no reminder before 30 days');
  await t.advance(2 * DAY, all); await t.runJob(); await t.runJob();
  assert.equal((await subjects(t, 'never@example.com', /still waiting/)).length, 1);
  await t.advance(30 * DAY, all); await t.runJob();
  await t.advance(25 * DAY, all); await t.runJob();
  assert.equal((await subjects(t, 'never@example.com', /still waiting/)).length, 3, 'days 30, 60 and 85');
  assert.equal(roleOf(t, w.id, w.fan1), null, 'not before the 90 days are up');
  await t.advance(6 * DAY, all); await t.runJob(); await t.runJob();
  assert.equal(roleOf(t, w.id, w.fan1), 'owner');
  assert.equal(roleOf(t, w.id, w.fan2), null, 'only the top visitor');
  assert.equal(roleOf(t, w.id, w.giver), 'owner', 'the giver stays an owner');
  assert.equal((await subjects(t, w.fan1.email, /You now own/)).length, 1);
  assert.equal((await subjects(t, w.giver.email, /not accepted/)).length, 1);
  assert.equal((await subjects(t, 'never@example.com', /been closed/)).length, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM handovers').get().n, 0);
  assert.equal((await t.signIn('never@example.com')).email, 'never@example.com', 'signing up later gets nothing, and works');
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM altar_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'never@example.com' AND m.role = 'owner'").get().n, 0);
});

test('daily job: a tie between visitors makes them all owners', async () => {
  const t = await setup();
  const w = await waitingHandover(t, async ({ id, fan1, fan2, fan3 }) => {
    for (const f of [fan1, fan2, fan3]) await f.call('POST', `/ofrendas/${id}/visit`);
  });
  await t.advance(DAY, [w.giver, w.fan1, w.fan2, w.fan3]);
  for (const f of [w.fan1, w.fan2]) await f.call('POST', `/ofrendas/${w.id}/visit`);
  await t.advance(t.RULES.handoverWait, [w.giver, w.fan1, w.fan2, w.fan3]); await t.runJob();
  assert.deepEqual([w.fan1, w.fan2, w.fan3].map(f => roleOf(t, w.id, f)), ['owner', 'owner', null]);
});

test('daily job: with no visitors a handover goes to the successor, then the co-keepers, otherwise it stays put', async () => {
  const t = await setup();
  const none = await waitingHandover(t);
  await t.advance(t.RULES.handoverWait, [none.giver]); await t.runJob();
  assert.equal(roleOf(t, none.id, none.giver), 'owner');
  assert.equal((await subjects(t, none.giver.email, /not accepted/)).length, 1);
  assert.ok((await t.mailTo(none.giver.email)).some(m => /stays with you/.test(m.text)));

  const t2 = await setup();
  const k = await waitingHandover(t2, async ({ giver, id, fan1, fan2 }) => {
    for (const f of [fan1, fan2]) {
      await giver.call('POST', `/ofrendas/${id}/invites`, { email: f.email });
      await f.call('POST', '/invites/accept', { token: await t2.tokenFrom(f.email, /#i=([\w-]{43})/) });
    }
  });
  await t2.advance(t2.RULES.handoverWait, [k.giver, k.fan1, k.fan2]); await t2.runJob();
  assert.deepEqual([k.fan1, k.fan2, k.fan3].map(f => roleOf(t2, k.id, f)), ['owner', 'owner', null], 'the people who already keep it');

  const t3 = await setup();
  const sc = await waitingHandover(t3, async ({ giver, id, fan1, fan2 }) => {
    await giver.call('POST', `/ofrendas/${id}/invites`, { email: fan1.email });
    await fan1.call('POST', '/invites/accept', { token: await t3.tokenFrom(fan1.email, /#i=([\w-]{43})/) });
    await giver.call('PUT', `/ofrendas/${id}/successor`, { email: fan2.email });
    await fan2.call('POST', '/successor/accept', { token: await t3.tokenFrom(fan2.email, /#s=([\w-]{43})/) });
  });
  await t3.advance(t3.RULES.handoverWait, [sc.giver, sc.fan1, sc.fan2]); await t3.runJob();
  assert.deepEqual([sc.fan1, sc.fan2].map(f => roleOf(t3, sc.id, f)), ['keeper', 'owner'], 'the named successor, not every co-keeper');
});

test('daily job: a person who signs up in time gets the handover, and no reminders or fallback follow', async () => {
  const t = await setup();
  const w = await waitingHandover(t, async ({ id, fan1 }) => { await fan1.call('POST', `/ofrendas/${id}/visit`); });
  await t.advance(40 * DAY, [w.giver, w.fan1]);
  const late = await t.signIn('never@example.com');
  assert.equal(roleOf(t, w.id, late), 'owner');
  await t.advance(60 * DAY, [w.giver, w.fan1, late]); await t.runJob();
  assert.equal(roleOf(t, w.id, w.fan1), null);
  assert.equal((await subjects(t, 'never@example.com', /still waiting/)).length, 0);
});

test('daily job: an ofrenda locked for its new owner is still handed over, just locked', async () => {
  const t = await setup();
  const w = await waitingHandover(t, async ({ id, fan1 }) => {
    await fan1.call('POST', `/ofrendas/${id}/visit`);
    for (let i = 0; i < t.RULES.freeAltars; i++) { await t.altarFor(fan1); t.tick(1000); }
  });
  await t.advance(t.RULES.handoverWait, [w.giver, w.fan1]); await t.runJob();
  assert.equal(roleOf(t, w.id, w.fan1), 'owner');
  assert.equal((await w.fan1.json('PUT', `/ofrendas/${w.id}`, altar(frame('a')))).body.error, 'ofrenda_locked');
  assert.equal((await subjects(t, w.fan1.email, /waiting for an upgrade/)).length, 1);
});

test('a locked owner can still share to view, but cannot invite anyone to edit', async () => {
  const t = await setup();
  const giver = await t.signIn('giver@example.com'), full = await t.signIn('full@example.com');
  const gift = await t.altarFor(giver);
  await giver.call('POST', `/ofrendas/${gift}/invites`, { email: full.email });
  await full.call('POST', '/invites/accept', { token: await t.tokenFrom(full.email, /#i=([\w-]{43})/) });
  t.tick(1000);
  for (let i = 0; i < t.RULES.freeAltars; i++) { await t.altarFor(full); t.tick(1000); }
  await giver.call('DELETE', `/ofrendas/${gift}`);
  assert.equal((await full.json('GET', `/ofrendas/${gift}/team`)).body.locked, true);
  const edit = await full.json('POST', `/ofrendas/${gift}/share`, { email: 'kim@example.com', access: 'edit' });
  assert.deepEqual([edit.status, edit.body.error], [402, 'ofrenda_locked']);
  assert.equal((await full.json('POST', `/ofrendas/${gift}/invites`, { email: 'kim@example.com' })).body.error, 'ofrenda_locked');
  assert.equal((await full.call('POST', `/ofrendas/${gift}/share`, { email: 'kim@example.com', access: 'view' })).status, 201);
  assert.equal((await t.mailTo('kim@example.com')).filter(m => /invited you/.test(m.subject)).length, 0);
  t.db.prepare("UPDATE users SET plan = 'platinum' WHERE id = ?").run(full.id);
  assert.equal((await full.call('POST', `/ofrendas/${gift}/share`, { email: 'kim@example.com', access: 'edit' })).status, 201, 'unlocked once upgraded');
});

// ---------- download everything ----------
test('export: needs a signed-in person, and comes down as a JSON attachment', async () => {
  const t = await setup();
  assert.equal((await t.call('GET', '/me/export')).status, 401);
  const a = await t.signIn('a@example.com');
  const res = await a.call('GET', '/me/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="digital-ofrenda-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.format, 'digital-ofrenda-account-export');
  assert.equal(body.account.email, 'a@example.com');
});

test('export: holds my ofrendas with their photos, keepers, successor and invitations', async () => {
  const t = await setup();
  const a = await t.signIn('a@example.com'), b = await t.signIn('b@example.com');
  const photo = png();
  const id = await t.altarFor(a, altar(frame('x', photo)));
  assert.equal((await a.call('PUT', `/ofrendas/${id}/slug`, { slug: 'abuela-rosa' })).status, 200);
  await a.call('POST', `/ofrendas/${id}/invites`, { email: 'b@example.com' });
  await b.call('POST', '/invites/accept', { token: await t.tokenFrom('b@example.com', /#i=([\w-]{43})/) });
  await a.call('POST', `/ofrendas/${id}/invites`, { email: 'pending@example.com' });
  assert.equal((await a.call('PUT', `/ofrendas/${id}/successor`, { email: 'heir@example.com' })).status, 200);

  const owner = (await (await a.call('GET', '/me/export')).json()).ofrendas;
  assert.equal(owner.length, 1);
  const o = owner[0];
  assert.deepEqual([o.id, o.role, o.name], [id, 'owner', 'abuela-rosa']);
  assert.equal(o.state.items[0].src, photo, 'the photo itself is in the file');
  assert.deepEqual(o.keepers.map(k => [k.email, k.role]), [['a@example.com', 'owner'], ['b@example.com', 'keeper']]);
  assert.deepEqual(o.pendingInvitations.map(i => i.email), ['pending@example.com']);
  assert.equal(o.successor.email, 'heir@example.com');

  // A co-keeper gets the ofrenda and who keeps it, but not the owner's invitations or successor.
  const keeper = (await (await b.call('GET', '/me/export')).json()).ofrendas;
  assert.equal(keeper.length, 1);
  assert.equal(keeper[0].role, 'keeper');
  assert.equal(keeper[0].pendingInvitations, undefined);
  assert.equal(keeper[0].successor, undefined);
  assert.equal(keeper[0].state.items[0].src, photo);
});

test('export: only my own account, nothing secret, and a damaged or empty ofrenda does not break the rest', async () => {
  const t = await setup();
  const a = await t.signIn('a@example.com'), b = await t.signIn('b@example.com');
  const mine = await t.altarFor(a);                    // created, never saved: no state yet
  const broken = await t.altarFor(a, altar());
  t.db.prepare('UPDATE altars SET state = ? WHERE id = ?').run('{not json', broken);
  const theirs = await t.altarFor(b, altar(frame('x', png())));

  const res = await a.call('GET', '/me/export');
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.ofrendas.map(o => o.id).sort(), [mine, broken].sort());
  assert.ok(!text.includes(theirs), "another person's ofrenda never appears");
  assert.ok(!text.includes('b@example.com'), "another person's address never appears");
  assert.equal(body.ofrendas.find(o => o.id === mine).state, null);
  assert.equal(body.ofrendas.find(o => o.id === broken).state, null);
  for (const secret of ['hash', 'token', 'cookie', 'session', 'code']) assert.ok(!new RegExp(`"[^"]*${secret}[^"]*":`, 'i').test(text), `no ${secret} field`);
  const stored = t.db.prepare('SELECT id_hash FROM sessions WHERE user_id = ?').get(a.id).id_hash;
  assert.ok(!text.includes(stored), 'no stored session value');
});

test('export: the upgrades an ofrenda has are listed', async () => {
  const t = await setup();
  const a = await t.signIn('a@example.com');
  const id = await t.altarFor(a, altar(frame('x', png())));
  await t.store.grantFeature(t.env.DB, id, 'extraPhotos', t.now());
  const [o] = (await (await a.call('GET', '/me/export')).json()).ofrendas;
  assert.deepEqual(o.upgrades.map(u => u.feature), ['extraPhotos']);
});

// ---------- bounces and spam complaints ----------
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-resend!!').toString('base64');
function svix(t, payload, { secret = WEBHOOK_SECRET, id = 'msg_1', at = t.now(), signature } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = String(Math.floor(at / 1000));
  const mac = crypto.createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return t.call('POST', '/resend/webhook', { body, origin: null, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': signature ?? `v1,${mac}` } });
}
const bounced = (to, type = 'Permanent') => ({ type: 'email.bounced', data: { to: [to], bounce: { type } } });
const WITH_HOOK = { env: { RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET } };

test('mail health: the webhook needs a valid Svix signature, a fresh timestamp, and its secret configured', async () => {
  const t = await setup(WITH_HOOK);
  const ev = bounced('gone@example.com');
  assert.equal((await svix(t, ev)).status, 200);
  assert.equal((await svix(t, ev, { secret: 'whsec_' + Buffer.from('another-key').toString('base64') })).status, 400, 'signed with a different secret');
  assert.equal((await svix(t, ev, { signature: 'v1,AAAA' })).status, 400);
  assert.equal((await svix(t, ev, { at: t.now() - 10 * MIN })).status, 400, 'a replayed old delivery');
  assert.equal((await svix(t, '{"type":"email.bounced"')).status, 400, 'signed but not JSON');
  const missing = await t.call('POST', '/resend/webhook', { body: JSON.stringify(ev), origin: null });
  assert.equal(missing.status, 400, 'unsigned');
  const unconfigured = await setup();
  assert.equal((await svix(unconfigured, ev)).status, 500, 'no secret set: refuses instead of trusting anyone');
});

test('mail health: a permanent bounce stops all mail to that address, and only a hash is stored', async () => {
  const t = await setup(WITH_HOOK);
  const a = await t.signIn('a@example.com');
  const id = await t.altarFor(a, altar(frame('x', png())));
  assert.equal((await svix(t, bounced('Typo@Example.com'))).status, 200);
  const row = t.db.prepare('SELECT * FROM mail_suppressions').get();
  assert.equal(row.email_hash, sha('typo@example.com'));
  assert.equal(row.reason, 'bounce');
  assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM mail_suppressions').all()).includes('typo@'), 'the address itself is not stored');

  const before = t.sent.length;
  assert.equal((await a.call('POST', `/ofrendas/${id}/invites`, { email: 'typo@example.com' })).status, 201, 'the invitation itself still succeeds');
  await t.settle();
  assert.equal((await t.mailTo('typo@example.com')).length, 0, 'nothing is sent to a bounced address');
  assert.equal(t.sent.length, before, 'and other mail is unaffected');
  await a.call('POST', `/ofrendas/${id}/invites`, { email: 'fine@example.com' });
  assert.equal((await t.mailTo('fine@example.com')).length, 1);
});

test('mail health: sign-in emails to a bounced address are not sent either, and the reply looks the same', async () => {
  const t = await setup(WITH_HOOK);
  await svix(t, bounced('gone@example.com'));
  const res = await t.call('POST', '/auth/start', { body: { method: 'code', email: 'gone@example.com' } });
  const known = await t.call('POST', '/auth/start', { body: { method: 'code', email: 'new@example.com' } });
  assert.deepEqual([res.status, Object.keys(await res.json())], [known.status, Object.keys(await known.json())], 'nothing tells a stranger the address bounced');
  assert.equal((await t.mailTo('gone@example.com')).length, 0);
  assert.equal((await t.mailTo('new@example.com')).length, 1);
});

test('mail health: a temporary bounce or anything else changes nothing', async () => {
  const t = await setup(WITH_HOOK);
  for (const ev of [bounced('full@example.com', 'Transient'), bounced('full@example.com', 'Undetermined'),
    { type: 'email.delivered', data: { to: ['full@example.com'] } }, { type: 'email.opened', data: { to: ['full@example.com'] } }, { type: 'email.bounced' }, { type: 'email.bounced', data: { to: 'not-a-list', bounce: { type: 'Permanent' } } }, {}, []]) {
    assert.equal((await svix(t, ev)).status, 200);
  }
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM mail_suppressions').get().n, 0);
});

test('mail health: someone who marked mail as spam gets no ordinary mail but can still sign in and change their email', async () => {
  const t = await setup(WITH_HOOK);
  const a = await t.signIn('a@example.com');
  const id = await t.altarFor(a, altar(frame('x', png())));
  const b = await t.signIn('b@example.com');
  await svix(t, { type: 'email.complained', data: { to: ['b@example.com'] } });
  assert.equal(t.db.prepare('SELECT reason FROM mail_suppressions').get().reason, 'complaint');

  const mailsToB = (await t.mailTo('b@example.com')).length;
  await a.call('POST', `/ofrendas/${id}/invites`, { email: 'b@example.com' });
  assert.equal((await t.mailTo('b@example.com')).length, mailsToB, 'an invitation is not sent');

  const again = await t.signIn('b@example.com'); // signIn waits for the code email, so it must arrive
  assert.equal(again.email, 'b@example.com');
  const subject = (await t.mailTo('b@example.com')).at(-1).subject;
  assert.match(subject, /\d{6}/, 'the sign-in code still arrives');
  assert.ok(!('essential' in (await t.mailTo('b@example.com')).at(-1)), 'the internal flag never reaches the mailer');

  assert.equal((await b.call('POST', '/me/email', { email: 'b2@example.com' })).status, 200);
  assert.equal((await t.mailTo('b2@example.com')).length, 1, 'the email-change code goes to the new address');
});

test('mail health: a bounce outranks a complaint, repeats are harmless, and the daily job skips suppressed addresses too', async () => {
  const t = await setup(WITH_HOOK);
  const ev = { type: 'email.complained', data: { to: ['x@example.com'] } };
  await svix(t, ev); await svix(t, ev, { id: 'msg_2' });
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM mail_suppressions').get().n, 1);
  await svix(t, bounced('x@example.com'), { id: 'msg_3' });
  assert.equal(t.db.prepare('SELECT reason FROM mail_suppressions').get().reason, 'bounce');
  await svix(t, ev, { id: 'msg_4' });
  assert.equal(t.db.prepare('SELECT reason FROM mail_suppressions').get().reason, 'bounce', 'a later complaint does not soften it');

  const { suppressing } = await import('../server/mailhealth.mjs');
  const delivered = [];
  const mailer = suppressing({ send: async m => void delivered.push(m) }, t.env.DB);
  await mailer.send({ to: 'X@Example.com ', subject: 's', text: 't' });
  await mailer.send({ to: 'ok@example.com', subject: 's', text: 't', essential: true });
  assert.deepEqual(delivered.map(m => m.to), ['ok@example.com'], 'any case or spacing of a suppressed address is skipped');
});

test('mail health: if the list cannot be read, the mail is still sent', async () => {
  const { suppressing } = await import('../server/mailhealth.mjs');
  const delivered = [];
  const broken = { prepare() { throw new Error('d1 down'); } };
  await suppressing({ send: async m => void delivered.push(m) }, broken).send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(delivered.length, 1);
});

// ---------- monitoring: alerts, /healthz, the daily job's own record ----------
const OPS = { env: { ALERT_EMAIL: 'ops@example.com' } };
const alertsTo = async t => (await t.mailTo('ops@example.com'));
// Makes only the queries that mention `table` fail, so the rest of the database (the alert record) keeps working.
const breakTable = (t, table) => { const real = t.env.DB; const proxy = new Proxy(real, { get: (db, k) => k === 'prepare' ? sql => { if (sql.includes(table)) throw new Error('boom ' + table); return db.prepare(sql); } : db[k] }); t.env.DB = proxy; return () => { t.env.DB = real; }; };
const breakDb = t => { const real = t.env.DB; t.env.DB = { prepare() { throw new Error('secret table name leaked for maria@example.com'); }, batch() { throw new Error('x'); } }; return () => { t.env.DB = real; }; };

test('alerts: an unhandled error emails the operator once, with the route shape and no personal data', async () => {
  const t = await setup(OPS);
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const restore = breakDb(t);
  const res = await t.call('DELETE', `/ofrendas/${id}/members/${'u'.repeat(40)}`, { cookie: maria.cookie });
  restore();
  assert.equal(res.status, 500);
  assert.equal(await res.text(), '{"error":"server_error"}', 'the person still sees nothing');
  const [mail] = await alertsTo(t);
  assert.equal(mail.subject, '[Digifrenda alert] server_error');
  assert.match(mail.text, /\/ofrendas\/:id\/members\/:id/, 'a route pattern');
  assert.ok(!mail.text.includes(id), 'not the ofrenda id, which is its link');
  assert.ok(!mail.text.includes('maria@example.com'), 'not an email address');
  assert.ok(!mail.text.includes('uuuuuuuuuu'), 'not a long id or token');
  assert.ok(!('essential' in mail));
});

test('alerts: a storm of the same problem is one email, then a count after the cool-down', async () => {
  const t = await setup(OPS);
  const maria = await t.signIn('maria@example.com');
  const restore = breakDb(t); // the database being down must not stop the alert from going out
  for (let i = 0; i < 5; i++) await t.call('GET', '/me', { cookie: maria.cookie });
  restore();
  assert.equal((await alertsTo(t)).length, 1, 'five failures, one email');
  t.tick(t.RULES.alertCooldown + MIN);
  const restore2 = breakDb(t);
  await t.call('GET', '/me', { cookie: maria.cookie });
  restore2();
  const mails = await alertsTo(t);
  assert.equal(mails.length, 2);
  assert.match(mails[1].text, /4 more of this kind happened/);
});

test('alerts: another instance having just emailed holds this one back; with no ALERT_EMAIL nothing is emailed', async () => {
  const t = await setup(OPS);
  const maria = await t.signIn('maria@example.com');
  t.db.prepare('INSERT INTO alerts (kind, last_sent_at) VALUES (?, ?)').run('server_error', t.now());
  const restore = breakTable(t, 'altar_members');
  assert.equal((await t.call('GET', '/me', { cookie: maria.cookie })).status, 500);
  restore();
  assert.equal((await alertsTo(t)).length, 0, 'the shared record says it was sent moments ago');
  assert.equal(t.db.prepare('SELECT suppressed FROM alerts WHERE kind = ?').get('server_error').suppressed, 1, 'and the repeat is counted');

  const other = await setup();
  const kim = await other.signIn('kim@example.com');
  const restore2 = breakDb(other);
  assert.equal((await other.call('GET', '/me', { cookie: kim.cookie })).status, 500);
  restore2();
  await other.settle();
  assert.equal(other.sent.filter(m => /alert/.test(m.subject)).length, 0, 'no ALERT_EMAIL: logged only');
});

test('alerts: a failing mailer is reported, and a failing alert email never breaks anything', async () => {
  const broken = await setup({ ...OPS, deps: { mailer: { send: async () => { throw new Error('mailer responded 502'); } } } });
  const res = await broken.call('POST', '/auth/start', { body: { method: 'code', email: 'new@example.com' } });
  assert.equal(res.status, 200, 'sign-in start still answers');
  await broken.settle(); // the alert email fails too: logged, nothing thrown

  const seen = [];
  const t = await setup({ ...OPS, deps: { mailer: { send: async m => { if (m.to === 'ops@example.com') seen.push(m); else throw new Error('mailer responded 502'); } } } });
  await t.call('POST', '/auth/start', { body: { method: 'code', email: 'new@example.com' } });
  await t.settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].subject, '[Digifrenda alert] mail_failed');
  assert.ok(!seen[0].text.includes('new@example.com'));
});

test('alerts: money taken but nothing unlocked is reported, with the payment id and no personal data', async () => {
  const t = await setup(OPS);
  const maria = await t.signIn('maria@example.com');
  const id = await t.altarFor(maria);
  const post = body => t.call('POST', '/stripe/webhook', { body, origin: null, headers: { 'stripe-signature': t.sign(body) } });
  await post(checkout({ client_reference_id: id, metadata: { feature: 'sevenTiers' }, payment_intent: 'pi_good' })); // delivered fine
  assert.equal((await alertsTo(t)).length, 0, 'a normal payment says nothing');
  for (const over of [{ metadata: { feature: 'admin' } }, { client_reference_id: 'nope-no-such-altar-xx' }, { client_reference_id: '../x' }, { metadata: {} }]) {
    assert.equal((await post(checkout({ payment_intent: 'pi_lost', ...over }))).status, 200);
  }
  const mails = await alertsTo(t);
  assert.equal(mails.length, 1, 'one email, however many');
  assert.equal(mails[0].subject, '[Digifrenda alert] paid_not_delivered');
  assert.match(mails[0].text, /pi_lost/);
});

test('alerts: a webhook with a bad signature and a refund we cannot trace are reported too', async () => {
  const t = await setup(OPS);
  const bad = await t.call('POST', '/stripe/webhook', { body: checkout(), origin: null, headers: { 'stripe-signature': 't=1,v1=00' } });
  assert.equal(bad.status, 400);
  const body = refund('pi_unknown');
  assert.equal((await t.call('POST', '/stripe/webhook', { body, origin: null, headers: { 'stripe-signature': t.sign(body) } })).status, 200);
  assert.deepEqual((await alertsTo(t)).map(m => m.subject).sort(), ['[Digifrenda alert] refund_untraced', '[Digifrenda alert] stripe_webhook_rejected']);
});

test('/healthz: public, 200 with no personal data when well, 503 when the database or the configuration is not', async () => {
  const t = await setup();
  const ok = await t.call('GET', '/healthz', { origin: null });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, db: true, config: 'ok', dailyJob: { status: 'never', lastOk: null } });
  const restore = breakDb(t);
  const down = await t.call('GET', '/healthz', { origin: null });
  restore();
  assert.equal(down.status, 503);
  const text = await down.text();
  assert.equal(JSON.parse(text).db, false);
  assert.ok(!text.includes('secret table') && !text.includes('maria'), 'no error details');
  const unconfigured = await setup({ env: { APP_URL: undefined } });
  const res = await unconfigured.call('GET', '/healthz', { origin: null });
  assert.deepEqual([res.status, (await res.json()).config], [503, 'APP_URL']);
  assert.equal((await setup({ env: { DB: undefined } }).then(x => x.call('GET', '/healthz', { origin: null }))).status, 503);
  assert.equal((await t.call('POST', '/healthz')).status, 404);
});

test('/healthz and the daily job: a clean run is healthy, silence for 36 hours is late, and a failing run is reported', async () => {
  const t = await setup(OPS);
  const health = async () => (await (await t.call('GET', '/healthz', { origin: null })).json()).dailyJob.status;
  await t.runJob();
  assert.equal(await health(), 'ok');
  assert.ok(t.db.prepare('SELECT ok_at FROM job_runs WHERE name = ?').get('daily').ok_at);
  t.tick(35 * HOUR);
  assert.equal(await health(), 'ok');
  t.tick(2 * HOUR);
  const late = await t.call('GET', '/healthz', { origin: null });
  assert.deepEqual([late.status, (await late.json()).dailyJob.status], [503, 'late']);
  await t.runJob();
  assert.equal(await health(), 'ok', 'the next clean run recovers');

  // A run that dies part-way: reported, recorded, and re-thrown so Cloudflare's own history shows it.
  const original = t.store.runningClaims;
  t.db.exec('ALTER TABLE claims RENAME TO claims_gone');
  await assert.rejects(t.runJob());
  t.db.exec('ALTER TABLE claims_gone RENAME TO claims');
  assert.equal(await health(), 'failed');
  const [mail] = (await alertsTo(t)).filter(m => /daily_job_failed/.test(m.subject));
  assert.ok(mail, 'the operator is told');
  await t.runJob();
  assert.equal(await health(), 'ok', 'and it recovers');
  assert.ok(original);
});

test('daily job: one bad row does not stop the rest, but it is counted and reported', async () => {
  const t = await setup(OPS);
  const a = await t.signIn('a@example.com');
  const id = await t.altarFor(a, altar(frame('x', png())));
  await a.call('POST', `/ofrendas/${id}/handover`, { email: 'newcomer@example.com', confirm: 'handover' });
  t.tick(31 * DAY); // the first reminder is due; sending it needs the giver's record
  const restore = breakTable(t, 'FROM users');
  await t.runJob(); // does not throw: a failing step is not a failing job
  restore();
  const [mail] = (await alertsTo(t)).filter(m => /daily_job_failed/.test(m.subject));
  assert.ok(mail, 'reported');
  assert.match(mail.text, /1 step\(s\) of the daily job failed/);
  assert.ok(!mail.text.includes('a@example.com') && !mail.text.includes(id));
  const health = await t.call('GET', '/healthz', { origin: null });
  assert.deepEqual([health.status, (await health.json()).dailyJob.status], [503, 'failed']);
  await t.runJob();
  assert.equal((await (await t.call('GET', '/healthz', { origin: null })).json()).dailyJob.status, 'ok', 'a clean run clears it');
});

test('daily job: the heartbeat is pinged after a clean run, and "/fail" after a bad one, https only', async () => {
  const pings = [];
  const t = await setup({ ...OPS, env: { ALERT_EMAIL: 'ops@example.com', HEARTBEAT_URL: 'https://hc.example.test/ping/abc/' }, deps: { fetch: async url => { pings.push(url); return new Response('ok'); } } });
  await t.runJob();
  assert.deepEqual(pings, ['https://hc.example.test/ping/abc/']);
  t.db.exec('ALTER TABLE claims RENAME TO claims_gone');
  await assert.rejects(t.runJob());
  t.db.exec('ALTER TABLE claims_gone RENAME TO claims');
  assert.deepEqual(pings.slice(1), ['https://hc.example.test/ping/abc/fail']);

  const insecure = [];
  const t2 = await setup({ env: { HEARTBEAT_URL: 'http://hc.example.test/ping' }, deps: { fetch: async url => void insecure.push(url) } });
  await t2.runJob();
  assert.deepEqual(insecure, [], 'http addresses are ignored');

  const t3 = await setup({ env: { HEARTBEAT_URL: 'https://hc.example.test/ping' }, deps: { fetch: async () => { throw new Error('network down'); } } });
  await t3.runJob(); // an unreachable heartbeat never fails the job
  assert.equal((await (await t3.call('GET', '/healthz', { origin: null })).json()).dailyJob.status, 'ok');
});

// ---------- who can open an ofrenda: visibility, search engines, and link previews ----------
async function sharedOfrenda(t) {
  const owner = await t.signIn('owner@example.com'), keeper = await t.signIn('keeper@example.com'), stranger = await t.signIn('stranger@example.com');
  const id = await t.altarFor(owner, altar(frame('x', png())));
  await owner.call('POST', `/ofrendas/${id}/invites`, { email: 'keeper@example.com' });
  await keeper.call('POST', '/invites/accept', { token: await t.tokenFrom('keeper@example.com', /#i=([\w-]{43})/) });
  await owner.call('PUT', `/ofrendas/${id}/slug`, { slug: 'abuela-rosa' });
  return { owner, keeper, stranger, id };
}
const setVisibility = (who, id, visibility) => who.json('PUT', `/ofrendas/${id}/visibility`, { visibility });

test('visibility: public by default; the owner can make it private, and only the people who keep it can then open it', async () => {
  const t = await setup();
  const { owner, keeper, stranger, id } = await sharedOfrenda(t);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200, 'anyone with the link, as before');
  assert.equal((await owner.json('GET', `/ofrendas/${id}/team`)).body.visibility, 'link');

  assert.deepEqual((await setVisibility(owner, id, 'private')).body, { visibility: 'private' });
  const missing = await t.call('GET', '/ofrendas/zzzzzzzzzzzz');
  for (const who of [undefined, stranger.cookie]) {
    const res = await t.call('GET', `/ofrendas/${id}`, { cookie: who });
    assert.equal(res.status, 404, 'a stranger, signed in or not');
    assert.deepEqual(await res.json(), await missing.clone().json(), 'looks exactly like an ofrenda that does not exist');
  }
  assert.equal((await owner.call('GET', `/ofrendas/${id}`)).status, 200);
  assert.equal((await keeper.call('GET', `/ofrendas/${id}`)).status, 200, 'a co-keeper still can');
  assert.equal((await t.call('GET', '/ofrendas/by-name/abuela-rosa')).status, 404, 'and so does its vanity name');
  assert.equal((await stranger.call('GET', '/ofrendas/by-name/abuela-rosa')).status, 404);
  assert.equal((await owner.call('GET', '/ofrendas/by-name/abuela-rosa')).status, 200);
  assert.equal((await keeper.json('GET', `/ofrendas/${id}/team`)).body.visibility, 'private', 'a co-keeper can see the setting');

  assert.equal((await setVisibility(owner, id, 'link')).body.visibility, 'link');
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200, 'every earlier link works again');
  assert.equal((await t.call('GET', '/ofrendas/by-name/abuela-rosa')).status, 200);
});

test('visibility: only an owner can change it, the value is checked, and CSRF applies', async () => {
  const t = await setup();
  const { owner, keeper, stranger, id } = await sharedOfrenda(t);
  assert.equal((await setVisibility(keeper, id, 'private')).status, 403);
  assert.equal((await setVisibility(stranger, id, 'private')).status, 403);
  assert.equal((await t.call('PUT', `/ofrendas/${id}/visibility`, { body: { visibility: 'private' } })).status, 401);
  for (const bad of ['public', '', null, 1, ['private'], undefined]) assert.equal((await setVisibility(owner, id, bad)).status, 400, String(bad));
  assert.equal((await t.call('PUT', `/ofrendas/${id}/visibility`, { body: { visibility: 'private' }, cookie: owner.cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 200, 'nothing changed');
  assert.equal((await owner.json('PUT', '/ofrendas/nope0000000x/visibility', { visibility: 'private' })).status, 403);
});

test('visibility: while private, a view-only link is not sent, but inviting someone to edit still works', async () => {
  const t = await setup();
  const { owner, id } = await sharedOfrenda(t);
  await setVisibility(owner, id, 'private');
  const refused = await owner.json('POST', `/ofrendas/${id}/share`, { email: 'friend@example.com', access: 'view' });
  assert.deepEqual([refused.status, refused.body.error], [409, 'ofrenda_private']);
  assert.equal((await t.mailTo('friend@example.com')).length, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM view_shares').get().n, 0, 'and it does not count against the daily limit');
  assert.equal((await owner.call('POST', `/ofrendas/${id}/share`, { email: 'friend@example.com', access: 'edit' })).status, 201);
  await setVisibility(owner, id, 'link');
  assert.equal((await owner.call('POST', `/ofrendas/${id}/share`, { email: 'other@example.com', access: 'view' })).status, 201);
});

test('visibility: a private ofrenda survives a handover, and being passed on does not make it public', async () => {
  const t = await setup();
  const { owner, keeper, id } = await sharedOfrenda(t);
  await setVisibility(owner, id, 'private');
  assert.equal((await owner.call('POST', `/ofrendas/${id}/handover`, { email: 'keeper@example.com', confirm: 'handover' })).status, 201);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).status, 404);
  assert.equal((await keeper.call('GET', `/ofrendas/${id}`)).status, 200);
});

test('search engines: the ofrenda data and the preview page both say noindex', async () => {
  const t = await setup();
  const { id } = await sharedOfrenda(t);
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await t.call('GET', `/ofrendas/${id}`)).headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await t.call('GET', '/ofrendas/zzzzzzzzzzzz')).headers.get('x-robots-tag'), 'noindex, nofollow', 'even the not-found answer');
  const page = await t.call('GET', `/s/${id}`);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await page.text(), /<meta name="robots" content="noindex, nofollow">/);
});

test('link previews: /s/<name> carries the Open Graph tags and sends a person on to the ofrenda', async () => {
  const t = await setup();
  const { id } = await sharedOfrenda(t);
  for (const ref of [id, 'abuela-rosa']) {
    const res = await t.call('GET', `/s/${ref}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Abuela — an ofrenda on Digifrenda<\/title>/);
    assert.match(html, /<meta property="og:title" content="Abuela — an ofrenda on Digifrenda">/);
    assert.match(html, /<meta property="og:description" content="A digital ofrenda made to remember Abuela\.">/);
    assert.ok(html.includes(`<meta property="og:url" content="${ORIGIN}/s/${ref}">`), 'the preview address names itself, so a crawler stays on this page');
    assert.ok(html.includes(`<meta property="og:image" content="${ORIGIN}/og.png">`), 'always the same generic picture');
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0;url=/a/${ref}">`));
    assert.ok(html.includes(`<a href="/a/${ref}">`), 'and a plain link, for anyone the redirect does not reach');
    assert.ok(!html.includes('data:image') && !/<script/i.test(html), 'no photo from the altar, no script');
    assert.match(res.headers.get('content-security-policy'), /^default-src 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('link previews: a private, unsaved, unknown or malformed ofrenda all get the same generic preview', async () => {
  const t = await setup();
  const { owner, stranger, id } = await sharedOfrenda(t);
  const blank = await t.altarFor(owner); // never saved
  await setVisibility(owner, id, 'private');
  const generic = async ref => { const html = await (await t.call('GET', `/s/${ref}`, { cookie: stranger.cookie })).text(); return html.replace(new RegExp(ref, 'g'), 'REF'); };
  const baseline = await generic('zzzzzzzzzzzz');
  assert.match(baseline, /<title>An ofrenda on Digifrenda<\/title>/);
  for (const ref of [id, 'abuela-rosa', blank, 'no-such-name', 'AbuelaRosa', 'q9']) {
    assert.equal(await generic(ref), baseline, `${ref} reveals nothing`);
  }
  assert.ok(!baseline.includes('Abuela'));
  const own = await (await owner.call('GET', `/s/${id}`)).text();
  assert.match(own, /<title>Abuela — /, 'the owner, who can open it, sees the name');
  assert.equal((await t.call('GET', '/s/bad%20ref')).status, 404, 'a malformed reference is not a page at all');
  assert.equal((await t.call('GET', `/s/${'a'.repeat(65)}`)).status, 404);
  assert.equal((await t.call('POST', `/s/${id}`)).status, 404);
});

test('link previews: a hostile name cannot break out of the tags, and long or odd names are tamed', async () => {
  const t = await setup();
  const owner = await t.signIn('owner@example.com');
  const nasty = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const id = await t.altarFor(owner, { ...altar(), name: nasty });
  const html = await (await t.call('GET', `/s/${id}`)).text();
  assert.ok(!/<script/i.test(html) && !html.includes('<img'), 'angle brackets are escaped');
  assert.ok(!/content="[^"]*"[^>]*onerror/i.test(html), 'the attribute cannot be closed early');
  assert.match(html, /&lt;script&gt;/);
  const long = await t.altarFor(owner, { ...altar(), name: 'María '.repeat(40) });
  const title = /<title>([^<]*)<\/title>/.exec(await (await t.call('GET', `/s/${long}`)).text())[1];
  assert.ok(title.length < 120, 'cut to a sensible length');
  const odd = await t.altarFor(owner, { ...altar(), name: 'Line one\nLine two\u0007 tab\there' });
  const oddHtml = await (await t.call('GET', `/s/${odd}`)).text();
  assert.match(oddHtml, /<title>Line one Line two tab here — /, 'one line, no control characters');
});

test('link previews: need DB and a valid APP_URL, and the preview page is not an open redirect', async () => {
  const t = await setup({ env: { APP_URL: 'not a url' } });
  assert.equal((await t.call('GET', '/s/abc')).status, 500);
  const ok = await setup();
  for (const ref of ['..%2F..%2Fevil', '//evil.example', 'x:evil', 'javascript:alert(1)']) {
    const html = await (await ok.call('GET', `/s/${ref}`)).text();
    assert.ok(!/url=\/\/|url=[a-z]+:/i.test(html), ref);
  }
});

// ---------- photos kept in the R2 photo store ----------
const R2 = () => ({ env: { PHOTOS: fakeR2() } });
const bigPhoto = () => 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(200_000)]).toString('base64'); // ~267 KB
const dataBytes = d => Buffer.from(d.split(',')[1], 'base64');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const photoRow = (t, id) => t.db.prepare('SELECT state FROM altars WHERE id = ?').get(id).state;

test('photo store: a saved photo goes to the bucket, the state keeps a path, and the path serves the image', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const src = png(), hash = sha256(dataBytes(src)), path = `/ofrendas/${id}/photos/${hash}`;
  const res = await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', src)));
  assert.deepEqual(res.body, { ok: true, photos: { x: path } }, 'the reply names the path chosen, so the page can stop re-sending the image');
  assert.deepEqual([...t.env.PHOTOS.objects.keys()], [`photos/${id}/${hash}`]);
  assert.equal(t.env.PHOTOS.objects.get(`photos/${id}/${hash}`).httpMetadata.contentType, 'image/png');
  assert.ok(!photoRow(t, id).includes('data:image') && photoRow(t, id).includes(path), 'the database holds the path, not the image');

  assert.equal((await (await t.call('GET', `/ofrendas/${id}`)).json()).items[0].src, path);
  const img = await t.call('GET', path);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), dataBytes(src), 'the very same bytes');
  assert.equal(img.headers.get('etag'), `"${hash}"`);
  assert.equal(img.headers.get('cache-control'), 'private, no-cache', 'checked every time, so going private cuts it off at once');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal(img.headers.get('x-robots-tag'), 'noindex, nofollow');
  const again = await t.call('GET', path, { headers: { 'if-none-match': `"${hash}"` } });
  assert.deepEqual([again.status, (await again.text()).length], [304, 0], 'nothing to send when nothing changed');
});

test('photo store: the same image is stored once, and saving the paths back is accepted without new uploads', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const src = png();
  const first = await owner.json('PUT', `/ofrendas/${id}`, altar(frame('a', src), frame('b', src)));
  assert.equal(first.status, 200);
  assert.equal(t.env.PHOTOS.objects.size, 1, 'two frames, one stored image');
  assert.equal(first.body.photos.a, first.body.photos.b);
  // The page sends the paths back on its next save.
  const stored = await (await t.call('GET', `/ofrendas/${id}`)).json();
  const before = new Map(t.env.PHOTOS.objects);
  const second = await owner.json('PUT', `/ofrendas/${id}`, stored);
  assert.deepEqual(second.body, { ok: true }, 'nothing new was stored, so nothing is reported');
  assert.deepEqual([...t.env.PHOTOS.objects.keys()], [...before.keys()]);
});

test('photo store: a path to another ofrenda, to a photo that is not there, or to anything else is refused', async () => {
  const t = await setup(R2());
  const a = await t.signIn('a@example.com'), b = await t.signIn('b@example.com');
  const mine = await t.altarFor(a), theirs = await t.altarFor(b);
  const secret = png();
  const stolen = (await b.json('PUT', `/ofrendas/${theirs}`, altar(frame('x', secret)))).body.photos.x;
  for (const [src, why] of [
    [stolen, "another ofrenda's photo (it must not become reachable through an altar I control)"],
    [`/ofrendas/${mine}/photos/${'0'.repeat(64)}`, 'a photo that was never stored'],
    [`/ofrendas/${mine}/photos/${sha256(dataBytes(secret))}/../x`, 'a traversal'],
    ['https://evil.example/x.png', 'a remote address'],
    ['/ofrendas', 'some other path'],
  ]) {
    const r = await a.json('PUT', `/ofrendas/${mine}`, altar(frame('x', src)));
    assert.deepEqual([r.status, r.body.error], [422, 'bad_image'], why);
  }
  assert.equal(t.env.PHOTOS.objects.size, 1, "nothing was copied from the other person's ofrenda");
  assert.equal([...t.env.PHOTOS.keys?.() ?? t.env.PHOTOS.objects.keys()].every(k => k.startsWith(`photos/${theirs}/`)), true);
});

test('photo store: photos no longer used are deleted, but one still used by another frame stays', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  await t.store.grantFeature(t.env.DB, id, 'extraPhotos', t.now()); // three photos at once needs the upgrade
  const red = png(), blue = 'data:image/png;base64,' + solidPng(2, 2, 10, 10, 200).toString('base64');
  const put = (...items) => owner.json('PUT', `/ofrendas/${id}`, altar(...items));
  const keys = () => [...t.env.PHOTOS.objects.keys()].sort();
  const r = await put(frame('a', red), frame('b', red), frame('c', blue));
  assert.equal(keys().length, 2);
  const [redPath, bluePath] = [r.body.photos.a, r.body.photos.c];
  await put(frame('a', redPath), frame('c', bluePath)); // frame b removed: red is still used by a
  assert.equal(keys().length, 2, 'still used, so kept');
  await put(frame('a', redPath)); // blue no longer used
  assert.deepEqual(keys(), [`photos/${id}/${redPath.split('/').pop()}`], 'unused photo deleted');
  await put(frame('a'));          // red replaced by an empty frame
  assert.equal(keys().length, 0);
  await put(frame('a', red));     // and a replaced photo: the old image goes when a different one takes its place
  const old = keys()[0];
  await put(frame('a', blue));
  assert.equal(keys().length, 1);
  assert.notEqual(keys()[0], old);
});

test('photo store: a private ofrenda keeps its photos private, and turning it back on restores them', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com'), stranger = await t.signIn('s@example.com');
  const id = await t.altarFor(owner);
  const path = (await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', png())))).body.photos.x;
  assert.equal((await t.call('GET', path)).status, 200, 'anyone with the link, as before');
  await owner.json('PUT', `/ofrendas/${id}/visibility`, { visibility: 'private' });
  const missing = await t.call('GET', `/ofrendas/${id}/photos/${'0'.repeat(64)}`);
  for (const cookie of [undefined, stranger.cookie]) {
    const res = await t.call('GET', path, { cookie });
    assert.equal(res.status, 404, 'a stranger cannot fetch it, even knowing the exact address');
    assert.deepEqual(await res.json(), await missing.clone().json(), 'and it looks like a photo that does not exist');
  }
  assert.equal((await owner.call('GET', path)).status, 200);
  assert.equal((await t.call('GET', path, { headers: { 'if-none-match': `"${path.split('/').pop()}"` } })).status, 404, 'a cached copy cannot be revalidated by a stranger either');
  await owner.json('PUT', `/ofrendas/${id}/visibility`, { visibility: 'link' });
  assert.equal((await t.call('GET', path)).status, 200);
});

test('photo store: deleting an ofrenda or an account deletes its photos, and only its own', async () => {
  const t = await setup(R2());
  const a = await t.signIn('a@example.com'), b = await t.signIn('b@example.com');
  const one = await t.altarFor(a), two = await t.altarFor(a), other = await t.altarFor(b);
  const blue = 'data:image/png;base64,' + solidPng(2, 2, 10, 10, 200).toString('base64');
  await a.json('PUT', `/ofrendas/${one}`, altar(frame('x', png()), frame('y', blue)));
  await a.json('PUT', `/ofrendas/${two}`, altar(frame('x', png())));
  await b.json('PUT', `/ofrendas/${other}`, altar(frame('x', png())));
  const count = id => [...t.env.PHOTOS.objects.keys()].filter(k => k.startsWith(`photos/${id}/`)).length;
  assert.deepEqual([count(one), count(two), count(other)], [2, 1, 1]);
  assert.equal((await a.call('DELETE', `/ofrendas/${one}`)).status, 200);
  assert.deepEqual([count(one), count(two), count(other)], [0, 1, 1], 'only that ofrenda\'s photos went');
  const del = await a.json('DELETE', '/me', { email: 'a@example.com', deleteOfrendas: true });
  assert.equal(del.status, 200);
  assert.deepEqual([count(two), count(other)], [0, 1], "an account's photos go with its ofrendas; other people's stay");
});

test('photo store: an ofrenda can hold far more than the old 1.5 MB, because the database row stays small', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  await t.store.grantFeature(t.env.DB, id, 'extraPhotos', t.now());
  let items = [];
  for (let round = 0; round < 4; round++) {
    const fresh = [frame(`p${round}a`, bigPhoto()), frame(`p${round}b`, bigPhoto())];
    const r = await owner.json('PUT', `/ofrendas/${id}`, altar(...items, ...fresh));
    assert.equal(r.status, 200, `save ${round + 1}`);
    items = (await (await t.call('GET', `/ofrendas/${id}`)).json()).items; // the paths, as the page now holds them
  }
  const stored = [...t.env.PHOTOS.objects.values()].reduce((n, o) => n + o.bytes.length, 0);
  assert.equal(t.env.PHOTOS.objects.size, 8);
  assert.ok(stored > 1_500_000, `${stored} bytes of photos, past the old cap`);
  assert.ok(photoRow(t, id).length < 4000, `the row is ${photoRow(t, id).length} characters`);
});

test('photo store: each photo is still limited in size and must really be an image', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const tooBig = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(320_000)]).toString('base64');
  assert.equal((await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', tooBig)))).body.error, 'bad_image');
  const fake = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.equal((await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', fake)))).body.error, 'bad_image');
  assert.equal(t.env.PHOTOS.objects.size, 0, 'nothing refused was stored');
});

test('photo store: without a bucket nothing changes: photos stay inline, and a path or the photo route is refused', async () => {
  const t = await setup();
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const src = png();
  assert.deepEqual((await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', src)))).body, { ok: true });
  assert.equal((await (await t.call('GET', `/ofrendas/${id}`)).json()).items[0].src, src, 'inline, as before');
  const path = `/ofrendas/${id}/photos/${sha256(dataBytes(src))}`;
  assert.equal((await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', path)))).body.error, 'bad_image');
  assert.equal((await t.call('GET', path)).status, 404);
});

test('photo store: the account export puts photos back inline, byte for byte, and never leaks a path to the server', async () => {
  const t = await setup(R2());
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const src = png();
  await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', src)));
  const text = await (await owner.call('GET', '/me/export')).text();
  const [exported] = JSON.parse(text).ofrendas;
  assert.equal(exported.state.items[0].src, src, 'exactly the image that was saved');
  assert.ok(!text.includes('/photos/'), 'no path into the photo store');
  // A photo that has gone missing leaves an empty frame rather than failing the whole export.
  t.env.PHOTOS.objects.clear();
  const res = await owner.call('GET', '/me/export');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ofrendas[0].state.items[0].src, undefined);
});

test('photo store: the daily job moves photos saved inline into the bucket, a few at a time, without counting as an edit', async () => {
  const t = await setup(); // no bucket yet: photos are saved inline, as on an older deployment
  const owner = await t.signIn('o@example.com');
  const id = await t.altarFor(owner);
  const src = png();
  await owner.json('PUT', `/ofrendas/${id}`, altar(frame('x', src), frame('y')));
  const before = t.db.prepare('SELECT state, updated_at FROM altars WHERE id = ?').get(id);
  assert.ok(before.state.includes('data:image'));
  // Many more such ofrendas than one run handles.
  const total = t.RULES.photoBackfillBatch + 3;
  for (let i = 0; i < total - 1; i++) t.db.prepare('INSERT INTO altars (id, state, created_at, updated_at) VALUES (?, ?, 1, ?)').run(`aaaaaaaaaa${String(i).padStart(2, '0')}`, JSON.stringify(altar(frame('x', src))), 10 + i);
  const inline = () => t.db.prepare("SELECT COUNT(*) n FROM altars WHERE state LIKE '%data:image%'").get().n;
  assert.equal(inline(), total);

  t.env.PHOTOS = fakeR2(); // the bucket is switched on
  await t.runJob();
  assert.equal(inline(), 3, 'one run moves one batch');
  await t.runJob();
  assert.equal(inline(), 0, 'the next finishes the rest');
  const after = t.db.prepare('SELECT state, updated_at FROM altars WHERE id = ?').get(id);
  assert.equal(after.updated_at, before.updated_at, 'moving a photo is not an edit');
  const hash = sha256(dataBytes(src));
  assert.equal(JSON.parse(after.state).items[0].src, `/ofrendas/${id}/photos/${hash}`);
  assert.deepEqual(JSON.parse(after.state).items[1], JSON.parse(before.state).items[1], 'the empty frame is untouched');
  assert.ok(t.env.PHOTOS.objects.has(`photos/${id}/${hash}`));
  const img = await t.call('GET', `/ofrendas/${id}/photos/${hash}`);
  assert.deepEqual([img.status, Buffer.from(await img.arrayBuffer())], [200, dataBytes(src)], 'and it is served');
  await t.runJob(); // nothing left: harmless
  assert.equal((await (await t.call('GET', '/healthz', { origin: null })).json()).dailyJob.status, 'ok');
});

test('photo store: the move never overwrites a save made while it was reading, and one bad row does not stop the rest', async () => {
  const t = await setup();
  const src = png(), other = 'data:image/png;base64,' + solidPng(2, 2, 10, 10, 200).toString('base64');
  const row = (id, state) => t.db.prepare('INSERT INTO altars (id, state, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, state);
  row('aaaaaaaaaaa1', JSON.stringify(altar(frame('x', src))));
  // The row changed after the job read it: the compare-and-set refuses.
  const read = t.db.prepare('SELECT id, state FROM altars WHERE id = ?').get('aaaaaaaaaaa1');
  t.db.prepare('UPDATE altars SET state = ? WHERE id = ?').run(JSON.stringify(altar(frame('x', other))), 'aaaaaaaaaaa1');
  assert.equal(await t.store.replaceState(t.env.DB, 'aaaaaaaaaaa1', read.state, 'overwritten'), false);
  assert.ok(t.db.prepare('SELECT state FROM altars WHERE id = ?').get('aaaaaaaaaaa1').state.includes(other.slice(0, 40)), 'the newer save is intact');

  // A row the bucket cannot take is reported and the others still move.
  t.env.PHOTOS = fakeR2();
  row('aaaaaaaaaaa2', JSON.stringify(altar(frame('x', src))));
  row('aaaaaaaaaaa3', JSON.stringify(altar(frame('x', src))));
  const put = t.env.PHOTOS.put.bind(t.env.PHOTOS);
  t.env.PHOTOS.put = async (key, ...rest) => { if (key.startsWith('photos/aaaaaaaaaaa2/')) throw new Error('bucket unavailable'); return put(key, ...rest); };
  await t.runJob();
  const stored = id => t.db.prepare('SELECT state FROM altars WHERE id = ?').get(id).state;
  assert.ok(stored('aaaaaaaaaaa2').includes('data:image'), 'the failed one is left as it was, safe');
  assert.ok(!stored('aaaaaaaaaaa3').includes('data:image'), 'the next one moved');
  assert.equal((await (await t.call('GET', '/healthz', { origin: null })).json()).dailyJob.status, 'failed', 'and the failure is visible');
});
