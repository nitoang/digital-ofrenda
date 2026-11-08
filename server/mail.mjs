// Email is sent through a service binding named MAILER: a small Worker you write for whichever email
// provider you choose. It receives POST /send with JSON { to, subject, text } and returns 2xx when the
// provider accepted the message. That keeps this repo free of any vendor, API key or SDK.
//
// Links always use APP_URL (your configured site), never the request's Host header, so a forged Host
// header cannot make us email a link to somebody else's site. Tokens sit in the #fragment, so the page
// reads them with JavaScript and POSTs them back. Email link scanners that pre-fetch URLs therefore
// cannot use up a single-use token.

import { day } from './util.mjs';

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

// Send after the response goes out, and never let a mail failure break the request.
export const queueMail = (deps, work) => deps.defer(Promise.resolve().then(work).catch(e => console.error('email not sent:', e?.message)));

const sign = '\n\n— digital-ofrenda\nIf you did not expect this email, you can ignore it.';

export const signInMessage = ({ to, link, code }) => ({
  to,
  subject: `Your sign-in code is ${code}`,
  text: `Sign in to your ofrendas:\n\n${link}\n\nOr enter this code on the sign-in page: ${code}\n\nBoth work once and expire in 15 minutes.${sign}`,
});

export const inviteMessage = ({ to, from, link }) => ({
  to,
  subject: `${from} invited you to help keep an ofrenda`,
  text: `${from} invited you to be a co-keeper of an ofrenda, so you can add to it and change it together.\n\nSign in with this email address to accept:\n${link}\n\nThe invitation expires in 7 days.${sign}`,
});

export const successorAskMessage = ({ to, from, link }) => ({
  to,
  subject: `${from} asked you to be the successor of an ofrenda`,
  text: `${from} would like you to look after an ofrenda if they are no longer able to. Nothing changes unless that happens: you get no access now, and you are only ever asked to take over after a long silence and a notice period.\n\nTo agree, sign in with this email address:\n${link}${sign}`,
});

export const claimNoticeMessage = ({ to, from, executesAt }) => ({
  to,
  subject: 'Someone asked to take over your ofrenda',
  text: `${from} asked to take over an ofrenda you keep, because you have not signed in for a long time.\n\nIf you do nothing, ownership moves to them on ${day(executesAt)}. You stay on as a co-keeper. To stop it, just sign in at any time before then.${sign}`,
});

export const claimCancelledMessage = ({ to }) => ({
  to,
  subject: 'The owner is back: your request was cancelled',
  text: `The owner of the ofrenda you asked to take over signed in again, so your request was cancelled. You are still its successor, and you can ask again if they go quiet again.${sign}`,
});

export const handoverMessage = ({ to, role }) => ({
  to,
  subject: role === 'owner' ? 'You now keep an ofrenda' : 'An ofrenda you kept has a new owner',
  text: role === 'owner'
    ? `The handover finished: you are now the owner of the ofrenda you agreed to look after.${sign}`
    : `Ownership of an ofrenda you kept moved to its successor. You are still a co-keeper and can keep editing.${sign}`,
});
