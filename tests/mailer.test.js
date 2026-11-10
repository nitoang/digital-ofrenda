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
