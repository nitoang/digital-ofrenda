// Telling the operator when something is wrong, without waiting for someone to read logs.
//
//   ALERT_EMAIL     where problems are emailed (optional; without it they are only logged)
//   HEARTBEAT_URL   a "dead man's switch" address, for example from healthchecks.io or Better Stack (optional). The daily
//                   job calls it after a clean run and "<url>/fail" after a bad one; the service alerts YOU if it goes
//                   quiet. That is the only way to notice a job that never ran at all.
//   GET /healthz    for an uptime monitor: 200 when the database answers and the daily job ran cleanly lately, else 503.
//
// An alert is one short email per kind of problem per RULES.alertCooldown, saying how many more happened meanwhile.
// It carries a route pattern and an error message, never an address, a token or a request body.

import { json, normalizeEmail } from './util.mjs';
import * as store from './store.mjs';
import { RULES } from './rules.mjs';

// Anything that looks like an email address, or a long token, is removed before it can reach a log or an inbox.
const redact = text => String(text ?? '')
  .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[email]')
  .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
  .slice(0, 500);

// "/ofrendas/abc123/members/u1" -> "/ofrendas/:id/members/:id": the id of an ofrenda is its link.
export const routeShape = pathname => String(pathname).replace(/^(\/ofrendas)\/[^/]+/, '$1/:id').replace(/\/(members|invites)\/[^/]+/, '/$1/:id').replace(/^(\/a)\/[^/]+/, '$1/:ref');

// The cool-down is also kept in memory, per Worker instance. The database is the shared record, but the database
// being down is exactly when an alert matters most, and then it cannot say "already sent". So an instance never
// emails the same kind twice inside the cool-down, whatever the database says, and sends once if it cannot ask.
const inMemory = new WeakMap(); // env -> Map(kind -> { at, held })

// Returns an alert(kind, detail) function. It never throws and never slows a request: the email is sent after the reply.
export function makeAlert(env, deps) {
  return (kind, detail) => {
    const text = redact(detail);
    console.error(`ALERT ${kind}: ${text}`);
    const to = normalizeEmail(env.ALERT_EMAIL);
    if (!to || !deps.mailer) return;
    if (!inMemory.has(env)) inMemory.set(env, new Map());
    const mine = inMemory.get(env), now = deps.now(), before = mine.get(kind);
    if (before && now - before.at < RULES.alertCooldown) { before.held++; return; }
    mine.set(kind, { at: now, held: 0 });
    deps.defer((async () => {
      try {
        let held = 0;
        try { held = await store.claimAlert(env.DB, { kind, now, cooldown: RULES.alertCooldown }); }
        catch { held = 0; } // the database cannot say: send anyway
        if (held === null) return; // another instance already emailed this kind
        const more = held + (before?.held ?? 0);
        await deps.mailer.send({ to, essential: true, subject: `[Digifrenda alert] ${kind}`,
          text: `${text}${more ? `\n\n${more} more of this kind happened since the last email.` : ''}\n\nRepeats within ${Math.round(RULES.alertCooldown / 3_600_000)} hours are counted, not emailed.` });
      } catch (e) { console.error('alert not sent:', redact(e?.message)); }
    })());
  };
}

// Pings the heartbeat address. Only https, and a failure to reach it never matters to the job.
export async function heartbeat(env, deps, ok) {
  const url = env.HEARTBEAT_URL;
  if (!url || !/^https:\/\//i.test(url)) return;
  try { await (deps.fetch || fetch)(ok ? url : url.replace(/\/+$/, '') + '/fail', { method: 'GET' }); }
  catch (e) { console.error('heartbeat not sent:', redact(e?.message)); }
}

// GET /healthz. Public and cheap; says nothing about people.
export async function handleHealth(env, deps, configProblem) {
  let db = false;
  try { db = !!env.DB && (await store.databaseAnswers(env.DB)); } catch { /* reported as db: false */ }
  let status = 'never';
  let lastOk = null;
  if (db) {
    const job = await store.getJob(env.DB, 'daily').catch(() => null);
    if (job) {
      lastOk = job.ok_at ?? null;
      if (job.failed_at) status = 'failed';
      else if (job.ok_at && deps.now() - job.ok_at > RULES.jobMaxSilence) status = 'late';
      else if (job.ok_at) status = 'ok';
      else if (deps.now() - job.started_at > RULES.jobMaxSilence) status = 'late';
    }
  }
  const config = configProblem || 'ok';
  // "never" is fine: a new deployment has not reached its first scheduled run yet (the heartbeat covers a job that never starts).
  const ok = db && config === 'ok' && status !== 'failed' && status !== 'late';
  return json({ ok, db, config, dailyJob: { status, lastOk: lastOk && new Date(lastOk).toISOString() } }, ok ? 200 : 503);
}
