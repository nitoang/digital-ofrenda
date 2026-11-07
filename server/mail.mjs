// Email is sent through a service binding named MAILER: a small Worker you write for whichever email
// provider you choose. It receives POST /send with JSON { to, subject, text } and returns 2xx when the
// provider accepted the message. That keeps this repo free of any vendor, API key or SDK.
//
// Links always use APP_URL (your configured site), never the request's Host header, so a forged Host
// header cannot make us email a link to somebody else's site. Tokens sit in the #fragment, so the page
// reads them with JavaScript and POSTs them back. Email link scanners that pre-fetch URLs therefore
// cannot use up a single-use token.

export const mailerFromEnv = env =>
  env.MAILER
    ? {
        async send(msg) {
          const res = await env.MAILER.fetch(new Request('https://mailer.internal/send', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
          }));
          if (!res.ok) throw new Error('mailer responded ' + res.status);
        },
      }
    : null;

const sign = '\n\n— digital-ofrenda\nIf you did not ask for this, you can ignore this email.';

export const verifyMessage = ({ to, link }) => ({
  to,
  subject: 'Confirm your email for your ofrenda',
  text: `Confirm this email address so you can get back into your ofrenda if you ever lose its edit link:\n\n${link}\n\nThe link works once and expires in 24 hours.${sign}`,
});

export const recoverMessage = ({ to, links }) => ({
  to,
  subject: 'Get back into your ofrenda',
  text: `Use a link below to get a new edit link for the ofrenda it names. Each link works once and expires in 30 minutes. Using one stops the old edit link from working.\n\n${links.join('\n')}${sign}`,
});
