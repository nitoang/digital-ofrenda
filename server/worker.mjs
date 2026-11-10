// Example Cloudflare Worker for digital-ofrenda: passwordless sign-in, altars with co-keepers and a
// successor, saving with the free-tier limits, and the Stripe webhook. A starting point, not a drop-in product.
//
// Bindings (see wrangler.example.toml):
//   DB                      D1 database; schema in migrations/
//   MAILER                  service binding to a Worker that sends email (see mail.mjs)
//   APP_URL                 your site, e.g. "https://ofrenda.example.com". Serve the page and this Worker from
//                           this same origin: sign-in uses a cookie, and there is deliberately no CORS.
//   STARTER_OFRENDA         "1": a new account starts with one basic ofrenda, "My Ofrenda". Optional.
//   TURNSTILE_SECRET        Cloudflare Turnstile secret; sign-in refuses requests without a valid token.
//                           Set TURNSTILE_DISABLED="1" instead ONLY for local development.
//   STRIPE_WEBHOOK_SECRET   whsec_... from Stripe
//   RESEND_WEBHOOK_SECRET   whsec_... from Resend's webhook page (bounces and complaints; see mailhealth.mjs)
//   STRIPE_SECRET_KEY       sk_... from Stripe; STRIPE_PRICE_EXTRA_PHOTOS, STRIPE_PRICE_SEVEN_TIERS and
//                           STRIPE_PRICE_PLATINUM are the ids (price_...) of one-time Prices you create in Stripe
//
// Routes (JSON; everything except GET and the webhook must come from the APP_URL origin):
//   POST /auth/start {email, method, turnstile} -> {challenge}   method is required: "link" or "code"; emails just that one
//   POST /auth/redeem {token}                              the link; sets the session cookie
//   POST /auth/code {challenge, code}                      the code; sets the session cookie
//   POST /auth/logout, POST /auth/logout-all
//   GET  /me                                               who I am, my altars, takeovers I could start
//   GET  /me/export                                        download everything I have, as one JSON file (see export.mjs)
//   DELETE /me {email, deleteOfrendas?}                    delete my account (see account.mjs)
//   POST /me/email {email} | POST /me/email/confirm {code} change my email, proved with a code sent to the new one
//   POST /ofrendas                                         create one (free accounts: RULES.freeAltars)
//   GET  /ofrendas/:id                                     public view
//   GET  /ofrendas/by-name/:name                           which ofrenda a vanity name points to -> {id, slug}
//   POST /ofrendas/:id/visit                               a signed-in person opened it: counted once a day, never for owners (204)
//   PUT  /ofrendas/:id/slug {slug}                         the owner picks a vanity name (/a/abuela-rosa)
//   PUT  /ofrendas/:id | DELETE /ofrendas/:id              save (limits enforced) | delete (owner)
//   GET  /ofrendas/:id/team                                members; the owner also sees invites, successor, claim
//   POST /ofrendas/:id/share {email, access: "view"|"edit", note?}   owner shares: view only (emails the link) or view and edit (a co-keeper invitation)
//   POST /ofrendas/:id/invites {email} | DELETE /ofrendas/:id/invites/:inviteId   co-keeper invitations
//   POST /invites/accept {token}
//   DELETE /ofrendas/:id/members/:userId                   owner removes a co-keeper, or a co-keeper leaves
//   PUT /ofrendas/:id/successor {email, waitMonths?: 6|12, auto?: bool} | DELETE /ofrendas/:id/successor
//   PUT /ofrendas/:id/successor/settings {waitMonths, auto}   change those without asking the successor again
//   POST /successor/accept {token}
//   POST /ofrendas/:id/handover {email, confirm: "handover"} | DELETE /ofrendas/:id/handover   hand to someone (see handover.mjs); owner only
//   POST /ofrendas/:id/claim | DELETE /ofrendas/:id/claim | POST /ofrendas/:id/claim/complete
//   POST /checkout {feature, altarId?}                     -> {url}  start a purchase (see checkout.mjs)
//   POST /stripe/webhook                                   unlocks upgrades after payment (see billing.mjs)
//   POST /resend/webhook                                   bounces and spam complaints from the email provider (see mailhealth.mjs)
//
// Rate limiting by IP belongs at the edge: add Cloudflare rate-limiting rules for POST /auth/start,
// /auth/code, /auth/redeem and /checkout. What is limited here is per email address and per code.

import { json } from './util.mjs';
import { mailerFromEnv } from './mail.mjs';
import * as auth from './auth.mjs';
import * as altars from './altars.mjs';
import * as team from './team.mjs';
import * as handover from './handover.mjs';
import { runScheduled } from './scheduled.mjs';
import * as account from './account.mjs';
import { handleExport } from './export.mjs';
import { handleResendWebhook, suppressing } from './mailhealth.mjs';
import { handleStripe } from './billing.mjs';
import { handleCheckout } from './checkout.mjs';

export { MAX_BODY_BYTES } from './altars.mjs';
export { verifyStripe } from './billing.mjs';

const ID = '([A-Za-z0-9_-]{1,64})';
// [method, path pattern, handler(request, env, deps, ...captures)]
const ROUTES = [
  ['POST', /^\/auth\/start$/, auth.handleStart],
  ['POST', /^\/auth\/redeem$/, auth.handleRedeemLink],
  ['POST', /^\/auth\/code$/, auth.handleRedeemCode],
  ['POST', /^\/auth\/logout$/, auth.handleLogout],
  ['POST', /^\/auth\/logout-all$/, auth.handleLogoutEverywhere],
  ['GET', /^\/me$/, altars.handleMe],
  ['GET', /^\/me\/export$/, handleExport],
  ['DELETE', /^\/me$/, account.handleDeleteAccount],
  ['POST', /^\/me\/email$/, account.handleStartEmailChange],
  ['POST', /^\/me\/email\/confirm$/, account.handleConfirmEmailChange],
  ['POST', /^\/checkout$/, handleCheckout],
  ['POST', /^\/ofrendas$/, altars.handleCreate],
  ['POST', new RegExp(`^/ofrendas/${ID}/visit$`), altars.handleVisit],
  ['PUT', new RegExp(`^/ofrendas/${ID}$`), altars.handleSave],
  ['DELETE', new RegExp(`^/ofrendas/${ID}$`), altars.handleDelete],
  ['PUT', new RegExp(`^/ofrendas/${ID}/slug$`), altars.handleSetSlug],
  ['GET', new RegExp(`^/ofrendas/${ID}/team$`), team.handleTeam],
  ['POST', new RegExp(`^/ofrendas/${ID}/share$`), team.handleShare],
  ['POST', new RegExp(`^/ofrendas/${ID}/invites$`), team.handleInvite],
  ['DELETE', new RegExp(`^/ofrendas/${ID}/invites/${ID}$`), team.handleRevokeInvite],
  ['POST', /^\/invites\/accept$/, team.handleAcceptInvite],
  ['DELETE', new RegExp(`^/ofrendas/${ID}/members/${ID}$`), team.handleRemoveMember],
  ['PUT', new RegExp(`^/ofrendas/${ID}/successor$`), team.handleSetSuccessor],
  ['DELETE', new RegExp(`^/ofrendas/${ID}/successor$`), team.handleClearSuccessor],
  ['PUT', new RegExp(`^/ofrendas/${ID}/successor/settings$`), team.handleSuccessorSettings],
  ['POST', /^\/successor\/accept$/, team.handleAcceptSuccessor],
  ['POST', new RegExp(`^/ofrendas/${ID}/handover$`), handover.handleHandover],
  ['DELETE', new RegExp(`^/ofrendas/${ID}/handover$`), handover.handleCancelHandover],
  ['POST', new RegExp(`^/ofrendas/${ID}/claim$`), team.handleClaim],
  ['DELETE', new RegExp(`^/ofrendas/${ID}/claim$`), team.handleCancelClaim],
  ['POST', new RegExp(`^/ofrendas/${ID}/claim/complete$`), team.handleCompleteClaim],
];
const PUBLIC_GET = new RegExp(`^/ofrendas/${ID}$`);
const BY_NAME = /^\/ofrendas\/by-name\/([a-z0-9-]{1,64})$/;

const misconfigured = what => { console.error('digital-ofrenda worker is missing configuration: ' + what); return json({ error: 'misconfigured' }, 500); };
const appUrlOk = env => /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/localhost(:\d+)?)$/i.test(env.APP_URL || '');

function configProblem(env, deps) {
  if (!env.DB) return 'DB';
  if (!appUrlOk(env)) return 'APP_URL';
  if (!deps.mailer) return 'MAILER';
  if (!env.TURNSTILE_SECRET && env.TURNSTILE_DISABLED !== '1') return 'TURNSTILE_SECRET';
  return null;
}

async function route(request, env, deps) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/stripe/webhook' && method === 'POST') return env.DB ? handleStripe(request, env, deps) : misconfigured('DB');
  if (pathname === '/resend/webhook' && method === 'POST') return handleResendWebhook(request, env, deps);

  if (method === 'GET' && BY_NAME.test(pathname)) return env.DB ? altars.handleByName(env, BY_NAME.exec(pathname)[1]) : misconfigured('DB');

  if (method === 'GET' && PUBLIC_GET.test(pathname)) {
    return env.DB ? altars.handleGet(env, PUBLIC_GET.exec(pathname)[1]) : misconfigured('DB');
  }

  const problem = configProblem(env, deps);
  if (problem) return misconfigured(problem);

  // Cookies are sent automatically, so every state-changing request must come from our own page.
  if (method !== 'GET' && method !== 'HEAD' && request.headers.get('origin') !== new URL(env.APP_URL).origin) {
    return json({ error: 'bad_origin' }, 403);
  }

  const allow = [];
  for (const [m, pattern, handler] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    if (m === method) return handler(request, env, deps, ...match.slice(1));
    allow.push(m);
  }
  return allow.length ? json({ error: 'method_not_allowed' }, 405, { allow: [...new Set(allow)].join(', ') }) : json({ error: 'not_found' }, 404);
}

export const createHandler = (deps = {}) => async (request, env) => {
  const d = { now: Date.now, fetch: globalThis.fetch.bind(globalThis), defer: p => p, mailer: mailerFromEnv(env), ...deps };
  d.mailer = suppressing(d.mailer, env.DB); // addresses that bounced or complained are skipped
  let res;
  try {
    res = await route(request, env, d);
  } catch (e) {
    console.error('unhandled error:', e?.stack || e);
    res = json({ error: 'server_error' }, 500);
  }
  res.headers.set('x-content-type-options', 'nosniff');
  return res;
};

export { runScheduled };

export default {
  scheduled: (event, env, ctx) => ctx.waitUntil(runScheduled(env, { now: Date.now, defer: p => ctx.waitUntil(p), mailer: mailerFromEnv(env) })),
  fetch: (request, env, ctx) => createHandler({ defer: p => ctx.waitUntil(p) })(request, env),
};
