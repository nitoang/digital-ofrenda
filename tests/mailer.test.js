// MAILER Worker tests: no network, the provider call is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../mailer/worker.mjs';

const env = { RESEND_API_KEY: 'key', MAIL_FROM: 'a <a@x.test>' };
const send = (body, e = env, fetchImpl, sleep) => handle(new Request('https://mailer.internal/send', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), e, fetchImpl, sleep);
const good = { to: 'me@example.com', subject: 'Hi', text: 'Hello' };

test('mailer sends one message to the provider with the key and fixed sender', async () => {
  let call;
  const res = await send(good, env, async (u, init) => (call = { u, init }, new Response('{}', { status: 200 })));
  assert.equal(res.status, 200);
  assert.equal(call.u, 'https://api.resend.com/emails');
  assert.equal(call.init.headers.authorization, 'Bearer key');
  assert.deepEqual(JSON.parse(call.init.body), { from: env.MAIL_FROM, to: ['me@example.com'], subject: 'Hi', text: 'Hello' });
});

test('mailer refuses bad input without calling the provider', async () => {
  const never = async () => assert.fail('provider called');
  for (const bad of [
    { ...good, to: 'a@x.test, b@x.test' }, { ...good, to: 'nope' }, { ...good, to: ['a@x.test'] },
    { ...good, subject: 'a\r\nBcc: x@y.test' }, { ...good, subject: '' }, { ...good, text: '' }, { ...good, text: 'x'.repeat(10001) },
  ]) assert.equal((await send(bad, env, never)).status, 400);
  assert.equal((await send('not json', env, never)).status, 400);
});

test('mailer reports provider failure, missing settings and wrong routes', async () => {
  assert.equal((await send(good, env, async () => new Response('no', { status: 422 }))).status, 502);
  assert.equal((await send(good, env, async () => { throw new Error('down'); })).status, 502);
  assert.equal((await send(good, { MAIL_FROM: 'a' })).status, 500);
  assert.equal((await handle(new Request('https://m/send'), env)).status, 405);
  assert.equal((await handle(new Request('https://m/other', { method: 'POST' }), env)).status, 404);
});

const noWait = async () => {};
const res = status => new Response('{}', { status });

test('mailer retries a temporary failure, with the same idempotency key so nothing is delivered twice', async () => {
  const calls = [];
  const out = await send(good, env, async (u, init) => { calls.push(init.headers['idempotency-key']); return calls.length < 3 ? res(503) : res(200); }, noWait);
  assert.equal(out.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 1, 'one key for every attempt');
  assert.match(calls[0], /^[0-9a-f-]{36}$/);
});

test('mailer retries when the provider cannot be reached or is rate-limiting, then gives up after three tries', async () => {
  let n = 0;
  assert.equal((await send(good, env, async () => { n++; if (n === 1) throw new Error('down'); return n === 2 ? res(429) : res(200); }, noWait)).status, 200);
  n = 0;
  const gaveUp = await send(good, env, async () => { n++; return res(500); }, noWait);
  assert.deepEqual([gaveUp.status, n], [502, 3]);
  n = 0;
  assert.deepEqual([(await send(good, env, async () => { n++; throw new Error('down'); }, noWait)).status, n], [502, 3]);
});

test('mailer does not retry what retrying cannot fix, and pauses between tries', async () => {
  let n = 0;
  for (const status of [400, 401, 403, 422]) {
    n = 0;
    assert.equal((await send(good, env, async () => { n++; return res(status); }, noWait)).status, 502);
    assert.equal(n, 1, `status ${status} is tried once`);
  }
  const pauses = [];
  await send(good, env, async () => res(500), async ms => void pauses.push(ms));
  assert.equal(pauses.length, 2);
  assert.ok(pauses.every(ms => ms > 0 && ms <= 2000), 'short pauses: the person is waiting for the email');
});

test('mailer accepts the exact limits and refuses one past them', async () => {
  const ok = async () => res(200);
  assert.equal((await send({ ...good, subject: 's'.repeat(200) }, env, ok)).status, 200);
  assert.equal((await send({ ...good, subject: 's'.repeat(201) }, env, ok)).status, 400);
  assert.equal((await send({ ...good, text: 't'.repeat(10000) }, env, ok)).status, 200);
  assert.equal((await send({ ...good, to: 'a'.repeat(64) + '@' + 'b'.repeat(60) + '.test' }, env, ok)).status, 200);
  assert.equal((await send({ ...good, to: 'a'.repeat(65) + '@x.test' }, env, ok)).status, 400);
  assert.equal((await send({ ...good, subject: 'Recuerdo de Abuela 🕯️ — ¡Bienvenida!', text: 'Querida familia ✿' }, env, ok)).status, 200, 'non-English text is fine');
});

test('mailer refuses odd shapes: not an object, wrong types, extra recipients smuggled in other fields', async () => {
  const never = async () => assert.fail('provider called');
  for (const bad of ['null', '[]', '7', '"text"', 'true', '{}']) assert.equal((await send(bad, env, never)).status, 400, bad);
  for (const bad of [
    { ...good, subject: 5 }, { ...good, text: ['x'] }, { ...good, to: null }, { ...good, to: { toString: 'a@x.test' } },
    { ...good, to: 'a@x.test\r\nBcc: b@x.test' }, { ...good, to: 'a@x.test\nb@x.test' }, { ...good, to: '<a@x.test>' }, { ...good, to: '"a b"@x.test' },
    { ...good, subject: 'x\ny' }, { ...good, subject: 'x\ry' },
  ]) assert.equal((await send(bad, env, never)).status, 400, JSON.stringify(bad));
});

test('mailer sends only the four fields it knows, however many the caller adds', async () => {
  let body;
  await send({ ...good, bcc: 'spy@x.test', cc: ['c@x.test'], from: 'ceo@bank.test', reply_to: 'r@x.test', headers: { 'x-a': 'b' }, attachments: [{ filename: 'x' }] }, env, async (u, init) => (body = JSON.parse(init.body), res(200)));
  assert.deepEqual(Object.keys(body).sort(), ['from', 'subject', 'text', 'to']);
  assert.equal(body.from, env.MAIL_FROM, 'the sender is fixed by the Worker, never by the caller');
  assert.deepEqual(body.to, ['me@example.com']);
});

test('mailer uses a new idempotency key for every message, so two different emails are never merged', async () => {
  const keys = [];
  const capture = async (u, init) => (keys.push(init.headers['idempotency-key']), res(200));
  await send(good, env, capture); await send(good, env, capture); await send({ ...good, to: 'other@example.com' }, env, capture);
  assert.equal(new Set(keys).size, 3, 'even an identical message sent twice is two messages (a person can ask for a second code)');
});

test('mailer never puts the key, the address or the message in its replies or its logs', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...a) => void logged.push(a.join(' '));
  try {
    const refused = await send({ ...good, to: 'secret-person@example.com', text: 'your code is 424242' }, env, async () => new Response('bad address secret-person@example.com', { status: 422 }));
    const unreachable = await send({ ...good, to: 'secret-person@example.com', text: 'your code is 424242' }, env, async () => { throw new Error('connect failed to secret-person@example.com with key'); }, noWait);
    for (const r of [refused, unreachable]) {
      const body = await r.text();
      for (const secret of ['secret-person', '424242', env.RESEND_API_KEY, 'bad address']) assert.ok(!body.includes(secret), `reply leaks ${secret}`);
    }
    const everything = logged.join('\n');
    for (const secret of ['secret-person', '424242', 'Bearer', 'bad address']) assert.ok(!everything.includes(secret), `log leaks ${secret}`);
  } finally { console.error = original; }
});

test('mailer: only a 2xx from the provider is a success, and its reply body is not trusted or inspected', async () => {
  for (const status of [301, 302, 304]) assert.equal((await send(good, env, async () => res(status))).status, 502, `${status} is not a success`);
  assert.equal((await send(good, env, async () => res(202))).status, 200, '202 Accepted is');
  assert.equal((await send(good, env, async () => new Response('<html>', { status: 200 }))).status, 200, 'the body is not inspected');
});

test('mailer: the retry total stays short enough for a person waiting for a sign-in code', async () => {
  const pauses = [];
  await send(good, env, async () => res(503), async ms => void pauses.push(ms));
  assert.ok(pauses.reduce((a, b) => a + b, 0) <= 3000, `${pauses.join('+')} ms of waiting at most`);
});

test('mailer routes: only POST /send; HEAD, PUT, DELETE and look-alike paths are refused before anything is read', async () => {
  const never = async () => assert.fail('provider called');
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await handle(new Request('https://m/send', { method }), env, never)).status, 405, method);
  for (const path of ['/send/', '/Send', '/send/x', '/', '/%73end']) {
    const r = await handle(new Request('https://m' + path, { method: 'POST', body: JSON.stringify(good) }), env, never);
    assert.equal(r.status, 404, path);
  }
});

test('mailer adds the reply address from its own settings, and never from the caller', async () => {
  let body;
  const grab = async (u, init) => (body = JSON.parse(init.body), res(200));
  await send({ ...good, reply_to: 'evil@x.test' }, { ...env, MAIL_REPLY_TO: ' support@example.com ' }, grab);
  assert.deepEqual(body.reply_to, ['support@example.com'], 'trimmed, and the caller\'s own reply_to is ignored');
  assert.deepEqual(Object.keys(body).sort(), ['from', 'reply_to', 'subject', 'text', 'to']);
  await send(good, env, grab);
  assert.ok(!('reply_to' in body), 'no setting, no header');
});

test('mailer: a bad MAIL_REPLY_TO is left out and the email is still sent', async () => {
  for (const bad of ['not an address', 'a@x.test, b@x.test', 'Support <s@x.test>', '  ', 42]) {
    let body, errors = [];
    const original = console.error; console.error = m => errors.push(m);
    try { assert.equal((await send(good, { ...env, MAIL_REPLY_TO: bad }, async (u, init) => (body = JSON.parse(init.body), res(200)))).status, 200); }
    finally { console.error = original; }
    assert.ok(!('reply_to' in body), `sent with ${JSON.stringify(bad)}`);
  }
});
