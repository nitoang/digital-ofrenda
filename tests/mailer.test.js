// MAILER Worker tests: no network, the provider call is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../mailer/worker.mjs';

const env = { RESEND_API_KEY: 'key', MAIL_FROM: 'a <a@x.test>' };
const send = (body, e = env, fetchImpl) => handle(new Request('https://mailer.internal/send', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), e, fetchImpl);
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
