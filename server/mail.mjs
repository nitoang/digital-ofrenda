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

const signoff = '\n\nDigifrenda 🧡';

// The person chose how to sign in, so each email carries one thing: a link (a button on the page) or a 6-digit code.
// The code goes in the subject so it shows up in a notification.
export const signInMessage = ({ to, link, code }) => ({
  to,
  subject: link ? 'Your Digifrenda sign-in link' : `Your Digifrenda sign-in code is ${code}`,
  text: [
    link
      ? `Here's your sign-in link. Click on the link below to start building.\n\nSign in to Digifrenda:\n${link}`
      : `Here's your sign-in code. Enter it on the sign-in page: ${code}`,
    `Bonus: no password required, as I recognize you've probably got a lot on your plate.`,
    `The ${link ? 'link' : 'code'} works once and expires in 15 minutes.`,
    `Didn't ask for this? Ignore it.\n\nDigifrenda 🧡`,
  ].join('\n\n'),
});

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
  text: `${from} asked you to look after their ofrenda, in the event they are unable to.\n\nIf you say yes, you can add to the ofrenda right away, as a co-keeper. You can't delete it. It would only ever pass to you if ${from} hasn't been on Digifrenda for a long time (a year, or six months if they chose that). Even then they'd be emailed first and would have 30 days to stop it just by signing in. If they can't, you could also ask to take it over yourself.\n\nIf you're willing, sign in with this email address to say yes:\n${link}\n\nDidn't expect this? Ignore it and nothing happens.${signoff}`,
});

export const claimNoticeMessage = ({ to, from, executesAt }) => ({
  to,
  subject: 'Someone asked to take over your ofrenda',
  text: `${from} asked to take over an ofrenda you keep, because we haven't seen you sign in for a long time.\n\nIf you do nothing, ownership moves to them on ${day(executesAt)}. You'd stay on as a co-keeper.\n\nTo stop it, just sign in any time before then. That's all it takes.${signoff}`,
});

export const claimCancelledMessage = ({ to }) => ({
  to,
  subject: 'The owner is back: your request was cancelled',
  text: `The owner of the ofrenda you asked to take over signed in again, so your request was cancelled. That's good news.\n\nYou're still their successor. If they go quiet again, it can start again.${signoff}`,
});

export const handoverMessage = ({ to, role }) => ({
  to,
  subject: role === 'owner' ? 'You now own an ofrenda' : 'An ofrenda you kept has a new owner',
  text: role === 'owner'
    ? `The handover is done. You're now the owner of the ofrenda you agreed to look after. Thank you for carrying it.${signoff}`
    : `Ownership of an ofrenda you kept has moved to its successor. You're still a co-keeper and can keep adding to it.${signoff}`,
});

export const emailChangeCodeMessage = ({ to, code }) => ({
  to,
  subject: `Your code to confirm this email address is ${code}`,
  text: `Someone signed in to a Digifrenda account asked to use this email address.\n\nTo confirm, enter this code on the page where you asked: ${code}\n\nIt works once and expires in 15 minutes. If this wasn't you, ignore this email and nothing will change.${signoff}`,
});

export const emailChangedNoticeMessage = ({ to, newEmail }) => ({
  to,
  subject: 'The email address on your Digifrenda account was changed',
  text: `The email address on your account was changed to ${newEmail}, and every other device was signed out.\n\nIf that was you, there's nothing more to do. If it wasn't, someone else had access to your account, and this address no longer signs in to it.${signoff}`,
});

export const nowOwnerMessage = ({ to }) => ({
  to,
  subject: 'You now own an ofrenda',
  text: `We haven't seen the person who owned an ofrenda you help keep sign in for a long time, so it has been passed to you. Nothing was deleted, and everything is just as they left it.\n\nYou can keep adding to it, choose who else helps, and decide what happens to it next. It counts as one of your ofrendas.${signoff}`,
});

export const lockedMessage = ({ to }) => ({
  to,
  subject: 'An ofrenda was passed to you, and it is waiting for an upgrade',
  text: `We haven't seen the person who owned an ofrenda you help keep sign in for a long time, so it has been passed to you.\n\nFree accounts can own 3 ofrendas, and you are already at that number. So this one is locked for now. You and anyone you share it with can still view it, and it stays exactly as it is. It can't be changed until you upgrade to Platinum or make room by passing one of your other ofrendas on.\n\nIt will never be deleted because of this, and nothing is asked of you.${signoff}`,
});

// A handover to someone with no account yet. They sign in with this address and it is theirs.
export const handoverOfferMessage = ({ to, from, link, name = '' }) => ({
  to,
  subject: `${from} wants to hand an ofrenda over to you`,
  text: `${from} has chosen you to look after an ofrenda${forName(name)}, alongside them.\n\nTo accept, sign in with this email address. That's all it takes, and it will be waiting for you:\n${link}\n\nIf you don't sign up, we'll remind you a few times, and ${from} still has it in the meantime. ${whyYouGotThis(from)}${warmSign}`,
});

// A handover to someone who already has an account: it has happened.
export const handoverReceivedMessage = ({ to, from, link, name = '' }) => ({
  to,
  subject: `${from} handed an ofrenda over to you`,
  text: `${from} has handed you an ofrenda${forName(name)}. You are now an owner of it, alongside them. It counts as one of your ofrendas.\n\nOpen it:\n${link}${warmSign}`,
});

export const handoverAcceptedMessage = ({ to, who }) => ({
  to,
  subject: `${who} accepted your handover`,
  text: `${who} signed in and is now an owner of the ofrenda you handed over. You are still an owner too.${signoff}`,
});

// ---------- successor: the owner is told when they name one, and during the notice ----------
const monthsOf = ms => Math.round(ms / (30.5 * 86_400_000));

export const successorNamedMessage = ({ to, successor, inactiveMs, auto }) => ({
  to,
  subject: 'You named a successor for your ofrenda',
  text: `You asked ${successor} to look after your ofrenda if you can't. They get no access until they say yes.\n\nIf you haven't signed in for ${monthsOf(inactiveMs)} months, we'll email you first. ${auto
    ? "If you still haven't signed in 30 days after that, your ofrenda passes to them automatically, and you stay on as a co-keeper."
    : 'After that, they can ask to take it over, and you would have 30 days to stop it.'}\n\nSigning in at any time stops it. You can change this, or choose someone else, whenever you like.${signoff}`,
});

// The notice the job sends on its own (nobody asked): day 0 of the 30.
export const autoClaimNoticeMessage = ({ to, executesAt, inactiveMs }) => ({
  to,
  subject: 'Your ofrenda will pass to your successor in 30 days',
  text: `We haven't seen you sign in for ${monthsOf(inactiveMs)} months, so we're starting the process you chose when you named a successor.\n\nIf you do nothing, your ofrenda passes to them on ${day(executesAt)}. You'd stay on as a co-keeper, and nothing is deleted.\n\nTo stop it, sign in any time before then. That's all it takes.${signoff}`,
});

export const claimReminderMessage = ({ to, executesAt, daysLeft }) => ({
  to,
  subject: `Reminder: your ofrenda passes to your successor in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
  text: `This is a reminder that, unless you sign in, your ofrenda passes to your successor on ${day(executesAt)}.\n\nYou'd stay on as a co-keeper, and nothing is deleted. To stop it, just sign in.${signoff}`,
});

export const autoClaimSuccessorMessage = ({ to, executesAt }) => ({
  to,
  subject: 'An ofrenda you agreed to look after may soon be yours',
  text: `The owner of an ofrenda you agreed to look after hasn't signed in for a long time, so the 30-day notice has started. We've emailed them.\n\nIf they don't come back, it becomes yours on ${day(executesAt)}, and they'll stay on as a co-keeper. If they sign in before then, it stops, and you stay their successor.\n\nYou don't need to do anything.${signoff}`,
});

// ---------- a handover that is waiting for someone to sign up ----------
export const handoverReminderMessage = ({ to, from, link, name = '', daysLeft }) => ({
  to,
  subject: `${from} is still waiting for you to accept an ofrenda`,
  text: `${from} handed an ofrenda${forName(name)} over to you, and it's still waiting. To accept, sign in with this email address:\n${link}\n\nThere are ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left. After that, ${from} will be told, and the ofrenda may go to someone who has been visiting it, so it stays with people who care about it.\n\n${whyYouGotThis(from)}${warmSign}`,
});

// The 90 days are up and the person never signed up. `outcome`: visitors, successor, keepers or none.
export const handoverEndedGiverMessage = ({ to, outcome }) => ({
  to,
  subject: 'Your handover was not accepted',
  text: `The person you handed an ofrenda to didn't get the chance to sign up, so the handover has ended.\n\n${{
    visitors: 'We passed it to the signed-in person who visited it most often. You stay an owner too, and you can see who helps keep it on its Keepers page.',
    successor: 'Nobody had visited it, so we passed it to the successor you named. You stay an owner too.',
    keepers: 'Nobody had visited it, so we passed it to the people who already help you keep it. You stay an owner too.',
    none: 'Nobody else visits or keeps it, so it stays with you, exactly as it was.',
  }[outcome]}${signoff}`,
});

export const handoverClosedRecipientMessage = ({ to, from }) => ({
  to,
  subject: 'The ofrenda that was waiting for you has been closed',
  text: `${from} handed an ofrenda over to you, and the time to accept it is up, so we've closed the handover. There's nothing you need to do. If you'd still like to keep it, ask ${from} to hand it over again.\n\nWe won't email you about this again.${signoff}`,
});

// The ofrenda reached someone because they visit it often (or were already trusted to help keep it).
export const handoverFallbackOwnerMessage = ({ to, locked }) => ({
  to,
  subject: locked ? 'An ofrenda was passed to you, and it is waiting for an upgrade' : 'You now own an ofrenda',
  text: locked
    ? `The owner of an ofrenda you keep handed it to someone who never signed up, so it has been passed to you instead.\n\nFree accounts can own 3 ofrendas, and you are already at that number. So this one is locked for now. You and anyone you share it with can still view it, and it stays exactly as it is. It can't be changed until you upgrade to Platinum or make room by passing one of your other ofrendas on.\n\nIt will never be deleted because of this, and nothing is asked of you.${signoff}`
    : `The owner of an ofrenda you keep handed it to someone who never signed up, so it has been passed to you. They stay an owner too, and nothing was deleted.\n\nYou can keep adding to it, choose who else helps, and decide what happens to it next. It counts as one of your ofrendas.${signoff}`,
});
