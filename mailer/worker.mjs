// The MAILER Worker: the only place that knows which email provider is used (Resend).
// The API Worker reaches it through a service binding and sends POST /send { to, subject, text }.
// It has no public route (workers_dev = false), so nobody on the internet can make it send mail.
//
// Settings: RESEND_API_KEY (secret), MAIL_FROM (for example "digital-ofrenda <hello@your-domain>",
// on a domain verified in Resend, with SPF and DKIM set up), MAIL_REPLY_TO (optional: where replies go, for example
// "support@your-domain"; it may be on a different domain from MAIL_FROM, so it must be a mailbox that receives mail).

// A temporary failure (the provider is unreachable, rate-limiting us, or has an error of its own) is retried a couple of
// times with a short pause. Every attempt for one message carries the same Idempotency-Key, so a retry after a
// response that was lost on the way can never deliver the same email twice. Anything else Resend refuses (a bad
// address, a bad key) will not get better by trying again and is reported straight away.
const ATTEMPTS = 3;
const PAUSE_MS = [400, 1500];
const temporary = status => status === 429 || status >= 500;
const wait = ms => new Promise(r => setTimeout(r, ms));

const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,255}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Where a person's reply to any of our emails goes (MAIL_REPLY_TO, optional, any domain). Fixed by the Worker, never by the
// caller. A value that is not one plain address is logged and left out: mail still goes out, just without a reply address.
const replyTo = env => {
  const to = typeof env.MAIL_REPLY_TO === 'string' ? env.MAIL_REPLY_TO.trim() : '';
  if (!to) return {};
  if (!EMAIL.test(to)) { console.error('MAIL_REPLY_TO is not a plain email address; sending without it'); return {}; }
  return { reply_to: [to] };
};

export const handle = async (request, env, fetchImpl = fetch, sleep = wait) => {
  const url = new URL(request.url);
  if (url.pathname !== '/send') return reply(404, { error: 'not found' });
  if (request.method !== 'POST') return reply(405, { error: 'method not allowed' });
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return reply(500, { error: 'misconfigured' });

  let msg;
  try { msg = await request.json(); } catch { return reply(400, { error: 'bad json' }); }
  const { to, subject, text } = msg ?? {};
  if (typeof to !== 'string' || !EMAIL.test(to)) return reply(400, { error: 'bad recipient' });
  if (typeof subject !== 'string' || !subject || subject.length > 200 || /[\r\n]/.test(subject)) return reply(400, { error: 'bad subject' });
  if (typeof text !== 'string' || !text || text.length > 10000) return reply(400, { error: 'bad body' });

  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, ...replyTo(env) }),
  };
  let status = 0; // 0: could not reach the provider at all
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try { status = (await fetchImpl('https://api.resend.com/emails', init)).status; } catch { status = 0; }
    if (status >= 200 && status < 300) return reply(200, { ok: true });
    if (status !== 0 && !temporary(status)) break;
    if (attempt < ATTEMPTS) await sleep(PAUSE_MS[attempt - 1]);
  }
  // Never log the address or body. The status is enough to debug with.
  if (status === 0) return reply(502, { error: 'provider unreachable' });
  console.error('resend responded', status);
  return reply(502, { error: 'provider refused', status });
};

export default { fetch: (request, env) => handle(request, env) };
