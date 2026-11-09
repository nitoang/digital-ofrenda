// The MAILER Worker: the only place that knows which email provider is used (Resend).
// The API Worker reaches it through a service binding and sends POST /send { to, subject, text }.
// It has no public route (workers_dev = false), so nobody on the internet can make it send mail.
//
// Settings: RESEND_API_KEY (secret), MAIL_FROM (for example "digital-ofrenda <hello@your-domain>",
// on a domain verified in Resend, with SPF and DKIM set up).

const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,255}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const handle = async (request, env, fetchImpl = fetch) => {
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

  let res;
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    });
  } catch { return reply(502, { error: 'provider unreachable' }); }
  // Never log the address or body. The status is enough to debug with.
  if (!res.ok) { console.error('resend responded', res.status); return reply(502, { error: 'provider refused', status: res.status }); }
  return reply(200, { ok: true });
};

export default { fetch: (request, env) => handle(request, env) };
