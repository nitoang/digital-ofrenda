// The daily job (a Cloudflare cron trigger). It is the only thing in the app that acts without a request, so it
// does four things and nothing else, and every step can be run twice without doing anything twice:
//
//   1. Successor notices. If an owner (every owner) has been away for the period chosen with the successor, and
//      automatic transfer is on, start the 30-day notice and email the owner and the successor.
//   2. Reminders during the notice: days 15 and 27 (RULES.claimReminders). Day 0 is the notice itself.
//   3. Finish notices that ran out without the owner coming back (only ones the job started; a notice the
//      successor asked for is completed by the successor). Signing in cancels a notice before this runs.
//   4. Handovers still waiting for someone to sign up: remind them (RULES.handoverReminders), and when the
//      time is up give the ofrenda to the signed-in person who opened it on the most days (a tie gives it to
//      all of them), else the agreed successor, else the people who already keep it, else leave it with the owner.

import * as store from './store.mjs';
import { RULES } from './rules.mjs';
import { DAY } from './util.mjs';
import { suppressing } from './mailhealth.mjs';
import { makeAlert, heartbeat } from './alerts.mjs';
import { migrateAltarPhotos } from './photos.mjs';
import { finishTakeover, altarName } from './team.mjs';
import {
  queueMail, autoClaimNoticeMessage, autoClaimSuccessorMessage, claimReminderMessage,
  handoverReminderMessage, handoverEndedGiverMessage, handoverClosedRecipientMessage, handoverFallbackOwnerMessage,
} from './mail.mjs';

const send = (deps, msg) => queueMail(deps, () => deps.mailer.send(msg));
const daysLeft = (at, now) => Math.max(1, Math.ceil((at - now) / DAY));

// One bad row must never stop the others.
// It is counted, though, so a row that fails every day is reported instead of failing quietly forever.
async function each(deps, rows, step) {
  for (const row of rows) {
    try { await step(row); } catch (e) { console.error('scheduled step failed:', e?.message); deps.failures?.push(String(e?.message)); }
  }
}

async function startNotices(env, deps, now) {
  await each(deps, await store.dueAutoTakeovers(env.DB, { now, limit: RULES.jobBatch }), async t => {
    const heir = await store.getUser(env.DB, t.accepted_user_id);
    const owners = await store.getOwners(env.DB, t.altar_id);
    if (!heir || !owners.length) return;
    const executesAt = now + RULES.claimWait;
    if (!(await store.createClaim(env.DB, { altarId: t.altar_id, requestedBy: heir.id, now, executesAt, auto: true }))) return;
    for (const o of owners) send(deps, autoClaimNoticeMessage({ to: o.email, executesAt, inactiveMs: t.inactive_ms }));
    send(deps, autoClaimSuccessorMessage({ to: heir.email, executesAt }));
  });
}

async function remindOwners(env, deps, now, claims) {
  await each(deps, claims, async c => {
    const due = RULES.claimReminders[c.reminders_sent];
    if (due === undefined || now < c.requested_at + due || now >= c.executes_at) return;
    if (!(await store.bumpClaimReminder(env.DB, c.altar_id, c.reminders_sent))) return;
    for (const o of await store.getOwners(env.DB, c.altar_id)) send(deps, claimReminderMessage({ to: o.email, executesAt: c.executes_at, daysLeft: daysLeft(c.executes_at, now) }));
  });
}

async function finishNotices(env, deps, now, claims) {
  await each(deps, claims.filter(c => c.auto && c.executes_at <= now), async c => {
    const heir = await store.getUser(env.DB, c.requested_by);
    const succ = await store.getSuccessor(env.DB, c.altar_id);
    if (!heir || succ?.accepted_user_id !== heir.id) { await store.cancelClaim(env.DB, c.altar_id, now); return; } // the successor was changed or removed
    await finishTakeover(env, deps, c.altar_id, c, heir);
  });
}

// Make `heirs` owners beside whoever is already one. Someone already at the free limit gets it locked, never refused.
async function giveTo(env, deps, altarId, heirs, now) {
  for (const h of heirs) {
    await store.addOwner(env.DB, { altarId, userId: h.user_id, now });
    const locked = await store.ownerLocked(env.DB, altarId, h.user_id, RULES.freeAltars);
    send(deps, handoverFallbackOwnerMessage({ to: h.email, locked }));
  }
}

async function endHandover(env, deps, now, h) {
  const gone = await store.takeExpiredHandover(env.DB, { altarId: h.altar_id, now });
  if (!gone) return; // someone else ended it first, or the person signed up in time
  const owners = new Set((await store.getOwners(env.DB, h.altar_id)).map(o => o.id));
  let outcome = 'none', heirs = (await store.topVisitors(env.DB, h.altar_id)).filter(v => !owners.has(v.user_id));
  if (heirs.length) outcome = 'visitors';
  else {
    const keepers = (await store.listKeepers(env.DB, h.altar_id)).filter(k => !owners.has(k.user_id));
    const succ = await store.getSuccessor(env.DB, h.altar_id);
    const named = succ?.accepted_user_id && keepers.find(k => k.user_id === succ.accepted_user_id);
    if (named) { outcome = 'successor'; heirs = [named]; }
    else if (keepers.length) { outcome = 'keepers'; heirs = keepers; }
  }
  await giveTo(env, deps, h.altar_id, heirs, now);
  const giver = await store.getUser(env.DB, h.from_user_id);
  if (giver) {
    send(deps, handoverEndedGiverMessage({ to: giver.email, outcome }));
    send(deps, handoverClosedRecipientMessage({ to: h.to_email, from: giver.email }));
  }
}

async function remindRecipients(env, deps, now, h, appUrl) {
  const due = RULES.handoverReminders[h.reminders_sent];
  if (due === undefined || now < h.created_at + due) return;
  if (!(await store.bumpHandoverReminder(env.DB, h.altar_id, h.reminders_sent))) return;
  const giver = await store.getUser(env.DB, h.from_user_id);
  if (!giver) return;
  send(deps, handoverReminderMessage({ to: h.to_email, from: giver.email, link: `${appUrl}/signin`, name: await altarName(env, h.altar_id), daysLeft: daysLeft(h.expires_at, now) }));
}

export async function runScheduled(env, deps) {
  if (!env.DB || !deps.mailer) { console.error('scheduled job skipped: DB or MAILER is not configured'); return; }
  deps = { ...deps, mailer: suppressing(deps.mailer, env.DB), failures: [] };
  deps.alert ??= makeAlert(env, deps);
  const now = deps.now();
  try {
    await store.jobStarted(env.DB, 'daily', now);
    await startNotices(env, deps, now);
    const claims = await store.runningClaims(env.DB, RULES.jobBatch);
    await remindOwners(env, deps, now, claims);
    await finishNotices(env, deps, now, claims);
    await each(deps, await store.waitingHandovers(env.DB, RULES.jobBatch), async h => {
      if (h.expires_at <= now) await endHandover(env, deps, now, h);
      else await remindRecipients(env, deps, now, h, env.APP_URL);
    });
    // With a photo bucket, ofrendas saved before it existed still hold photos inline: move a few more each day.
    if (env.PHOTOS) await each(deps, await store.altarsWithInlinePhotos(env.DB, RULES.photoBackfillBatch), row => migrateAltarPhotos(env, row));
  } catch (e) {
    await recordFailure(env, deps, `the daily job stopped part-way: ${e?.message}`);
    throw e; // so Cloudflare's own cron history shows it as failed too
  }
  if (deps.failures.length) {
    await recordFailure(env, deps, `${deps.failures.length} step(s) of the daily job failed. The first: ${deps.failures[0]}`);
    return;
  }
  await store.jobOk(env.DB, 'daily', deps.now());
  await heartbeat(env, deps, true);
}

async function recordFailure(env, deps, what) {
  try { await store.jobFailed(env.DB, 'daily', deps.now(), what.slice(0, 300)); } catch (e) { console.error('could not record the failure:', e?.message); }
  deps.alert('daily_job_failed', what);
  await heartbeat(env, deps, false);
}
