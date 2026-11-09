// Email is sent through a service binding named MAILER: the Worker in mailer/, which is the only
// code that knows the email provider. It receives POST /send with JSON { to, subject, text } and returns 2xx when the
// provider accepted the message. That keeps the API Worker free of any vendor, API key or SDK.
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

// The person chose how to sign in, so the email carries only that: a link (button on the page) or a 6-digit code.
// Passing both is kept for older callers. The code goes in the subject so it shows up in a notification.
export const signInMessage = ({ to, link, code }) => {
  const parts = [];
  if (link) parts.push(`Here's your sign-in link. Click on the link below to start building.\n\nSign in to Digifrenda:\n${link}`);
  if (code) parts.push(`${link ? 'Prefer a code? Enter this' : "Here's your sign-in code. Enter it"} on the sign-in page: ${code}`);
  parts.push(`Bonus: no password required, as I recognize you've probably got a lot on your plate.`);
  parts.push(`${link && code ? 'The link and the code expire' : link ? 'The link works once and expires' : 'The code works once and expires'} in 15 minutes.${link && code ? ' Use either one; once you use one, the other stops working.' : ''}`);
  parts.push(`Didn't ask for this? Ignore it.\n\nDigifrenda 🧡`);
  return { to, subject: code ? `Your Digifrenda sign-in code is ${code}` : 'Your Digifrenda sign-in link', text: parts.join('\n\n') };
};

// Sent once, the first time an address signs in.
export const welcomeMessage = ({ to, link }) => ({
  to,
  subject: 'Welcome to Digifrenda',
  text: `Welcome to Digifrenda.\n\nAs part of our loving community, we're excited that you're taking part in this journey to share your loved one's memories with others.\n\nWe started an ofrenda for you, called My Ofrenda. Rename it for the person you're remembering, and make it yours. Whenever you're ready, you can start more ofrendas for other loved ones.\n\nHow I initially built mine:\n1. Picked a photo.\n2. Added one thing they loved (my grandma loved coffee, for example).\n3. Wrote one thing I remember.\n\nOr go all out. It's all how you want to reflect the person.\n\nOpen My Ofrenda:\n${link}${warmSign}`,
});

// Shared wording for the two "someone shared an ofrenda with you" emails (view only, and view and edit).
const forName = name => (name ? ` for ${name}` : '');
const noteBlock = (from, note) => (note ? `A note from ${from}:\n${note}\n\n` : '');
const whyYouGotThis = from => `You're getting this because ${from} entered your email address. If it isn't for you, you can ignore it.`;
const warmSign = '\n\nCon mucho cariño,\nDigifrenda 🧡';

// "View and edit": an invitation to be a co-keeper. Needs a sign-in with the invited address.
export const inviteMessage = ({ to, from, link, name = '', note = '' }) => ({
  to,
  subject: `${from} invited you to help keep an ofrenda`,
  text: `${from} built an ofrenda${forName(name)} and invited you to keep it with them.\n\nIt holds photos, favorite things, and memories. As a co-keeper you can add a note or something they loved, and change what's there. You can't delete the ofrenda or change who keeps it.\n\n${noteBlock(from, note)}Sign in with this email address to accept:\n${link}\n\nThe invitation expires in 7 days.\n\n${whyYouGotThis(from)}${warmSign}`,
});

// "View only": the link to the ofrenda. No account is needed to look at it.
export const viewShareMessage = ({ to, from, link, name = '', note = '' }) => ({
  to,
  subject: `${from} shared an ofrenda${forName(name)} with you`,
  text: `${from} built an ofrenda${forName(name)} and wants you to visit.\n\nIt holds photos, favorite things, and memories. Come sit with it for a minute. Stay as long as you like.\n\n${noteBlock(from, note)}Visit the ofrenda:\n${link}\n\n${whyYouGotThis(from)}${warmSign}`,
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

export const emailChangeCodeMessage = ({ to, code }) => ({
  to,
  subject: `Your code to confirm this email address is ${code}`,
  text: `Someone signed in to a Digital Ofrenda account asked to use this email address for it.\n\nTo confirm, enter this code on the page where you asked: ${code}\n\nIt works once and expires in 15 minutes. If this was not you, ignore this email and nothing will change.${sign}`,
});

export const emailChangedNoticeMessage = ({ to, newEmail }) => ({
  to,
  subject: 'The email address on your Digital Ofrenda account was changed',
  text: `The email address on your account was changed to ${newEmail}, and every other device was signed out.\n\nIf you did this, there is nothing more to do. If you did not, someone else had access to your account: this address no longer signs in to it.${sign}`,
});
