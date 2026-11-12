# Handoff: what is done, what is left

Written 2026-11-11, after PR #30 (photos in R2) merged. `main` was at `32582c2`. Read this first in a new session, then
check `git log` in case things have moved on.

## Start a new session with this prompt

```
Work on the repo nitoang/digital-ofrenda. Read docs/HANDOFF.md first. Then build the remaining suggestions in the order it
gives: nothing: the six suggestions are built.
Do one at a time: build it, run the full tests, push to the designated branch (restart it from main first; force-push is
blocked, so merge the old remote tip with `git merge -s ours` to make the push a fast-forward), then tell me before opening
a PR. When I say "merge if CI is green", squash-merge only after all CI checks are green on the current head. Never skip or
loosen a test to get green. Be honest about what you could not verify (for example Firefox and WebKit locally, and real R2).
```

## Already done and merged

| # | What |
|---|---|
| 5 | Daily cron job (`server/scheduled.mjs`): successor notices, reminders, handovers, photo move. It did **not** prune old records until #17 added `pruneOld`. |
| 6 | Photos in an R2 bucket (`server/photos.mjs`). Inactive until the bucket is bound as `PHOTOS`. |
| 7 | Alert emails (`ALERT_EMAIL`), `GET /healthz`, a heartbeat URL (`HEARTBEAT_URL`) (`server/alerts.mjs`). |
| 8 | Mailer retries, Resend bounce and complaint webhook, sign-in typo hint (`server/mailhealth.mjs`, `site/typos.js`). |
| 9 | Download-everything export, `GET /me/export` (`server/export.mjs`). |
| 10 | Successor and inactivity emails (built earlier by other PRs). |
| 11 | Private ofrendas, `noindex`, `/s/<name>` link previews (`server/preview.mjs`). There is deliberately no "new link" button: an ofrenda's address is its link, so private is how to cut off a leaked one. |
| 15 | Test gaps: `tests/migrations.test.js` (0001 to 0012 applied in steps with data in place), abuse-path and size-limit tests in `tests/worker.test.js`, more mailer tests. Found and fixed a bug: a Stripe "paid" event arriving after its own refund unlocked the upgrade again. |
| 16 | Housekeeping: README intro, version `0.9.0`, `CHANGELOG.md`, Dependabot (npm and Actions), a committed `package-lock.json` (CI uses `npm ci`), and an `audit` CI job that also runs weekly. Publishing `ofrenda.js` as a package was left out on purpose: the licence is all rights reserved and `package.json` is `private`. |
| 4 | Deploy workflow (`.github/workflows/deploy.yml`, scripts in `scripts/`, steps in the README under "Deploying with GitHub Actions"). Off until the variable `DEPLOY_ENABLED` is `true`. Checked here: the rendered config parses as TOML and `wrangler deploy --dry-run` accepts both Workers (Wrangler 4.160.1). Never run for real: it needs the owner's Cloudflare credentials. |
| 13 | Accessibility, as far as a program can check: axe-core over every page (`tests/a11y.test.js`), contrast fixes, button roles and `aria-pressed`, announced moves, focus after delete, 44 px touch targets, an `h1` on the ofrenda page, tab-order check. Still needs people: see "Setup only the owner can do". |
| 12 | Receipts and disputes: purchase history (`GET /me/purchases`, `/purchases` page, in the export), buyer and amount recorded (migration `0013`), partial refunds shown, `charge.dispute.*` handled (upgrade stays while open with an alert and the deadline; lost takes it back). Policy choices to confirm are listed under "Setup only the owner can do". |
| 17 | Legal review preparation: the privacy and terms pages checked against the code and corrected, retention made true (daily `pruneOld`), and a briefing for a lawyer (`docs/LEGAL-REVIEW.md`). The legal read itself has not happened. |
| 14 | Browser tests run in Chromium, Firefox and WebKit in CI. |

## Still to build, in the order to do them

Nothing left to build. What remains is the legal read itself (see "Setup only the owner can do").

## Setup only the owner can do
- **Legal review:** give `docs/LEGAL-REVIEW.md`, `site/privacy.html` and `site/terms.html` to someone who can advise on your jurisdiction. It lists the decisions only you can make (who the operator is, governing law, response time for data requests) and the questions to ask. Then fill in the backup window, which was not verified.
- **Stripe webhook events:** add `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` to the existing endpoint (it now needs six events), and apply migration `0013`. The dispute payload handling (`payment_intent`, `status`, `reason`, `evidence_details.due_by`) was written from Stripe's documentation and has never met a real event: send test events with the Stripe CLI (`stripe trigger charge.dispute.created`) first.
- **Dispute and refund policy (confirm or change):** a dispute that is open leaves the upgrade in place; a lost one removes it; a partial refund keeps it. Changing any of these is in `server/billing.mjs` (`handleDispute`) and the terms page. Also decide whether you want the stricter choice of removing the upgrade as soon as a dispute opens.
- **Receipts:** checkout sets `receipt_email`, so Stripe emails receipts in live mode. Check your Stripe branding and receipt settings. The history page does not link to Stripe's hosted receipt page.
- **Accessibility with real assistive technology:** nobody has yet listened to the editor with a screen reader (VoiceOver on iPhone and Mac, TalkBack, NVDA or JAWS) or used it by touch on real phones and tablets. Everything here was checked with axe and the browser's accessibility tree. Things to listen for: whether the long keyboard hint read on every focused item is too much (it is the `aria-describedby` on each item; a shorter per-item hint is the likely fix), whether the status messages are heard, and whether drag-free use is practical for someone who cannot hold a pointer.
- **Deploy workflow:** follow the README steps (Cloudflare resources, Worker secrets, two GitHub secrets, the variables, then `DEPLOY_ENABLED`). The first real run is untested: expect to fix small things, and use the `production` environment's approval so nothing deploys unseen. Check `PAGES_PROJECT` exists and that the API token's permissions are enough.
- **Stripe:** an end-to-end test-mode run with the Stripe CLI and a test card.
- **Cloudflare:** rate-limit rules on `POST /auth/start`, `/auth/code`, `/auth/redeem` and `/checkout`. The code only
  limits per address, not per IP.
- **Turnstile:** check the content-security-policy entries in `site/_headers` against Cloudflare's current docs.
- **Backups:** D1, and R2 once it is in use.
- **Resend:** add a webhook for `email.bounced`, `email.complained` and `email.suppressed`, and set
  `RESEND_WEBHOOK_SECRET`. The webhook payload handling was written from memory of Resend's format: send a test event first.
- **Cloudflare config:** apply migrations `0010` to `0012`, create and bind the R2 bucket, and add the `/s/*` and
  `/healthz` routes.
- **Monitoring:** set `ALERT_EMAIL` and `HEARTBEAT_URL`, and point an uptime monitor at `/healthz`.
- **Real R2:** try the photo storage on a test bucket first. Everything was tested against an in-memory stand-in
  (`tests/r2.js`) written from Cloudflare's documentation, never against the real service.

## Known gaps and caveats
- The test database wrapper (`tests/d1.js`) has one connection, so overlapping `batch` calls collide. Tests that need true simultaneity (a burst of sign-in requests for one address, where the count-then-insert check could let a few past the 5-an-hour limit) cannot be written against it; the Cloudflare rate-limit rule is the real stop there.
- Nothing caps the total size of an ofrenda's photos (each is about 300 KB, an ofrenda holds up to 200 items). Photos are
  not scanned.
- Moving existing inline photos into R2 happens at 25 ofrendas a day, so a large database takes a while.
- An owner is not told when an invitation or a shared link bounced.
- A Chromium hang in CI happened twice early on and was never explained. It has not recurred since the test harness was
  hardened (hard-closing connections, closing browser contexts, per-test and per-job timeouts).
- CI has a new job named `audit`; the weekly schedule runs only that job. CI job names changed when the browser matrix arrived. Update any required-checks rule if the repository has one.

## How the repo and the workflow behave

**Tests** (Node 22 is required; `node:sqlite` is used):
- `npm test` runs everything, in Chromium.
- `npm run test:unit` needs no browser.
- `npm run test:browser` runs the component and site tests. `BROWSER=firefox` or `BROWSER=webkit` is for CI: those browsers
  could not be downloaded in the cloud environment where this was built, so Firefox and WebKit only ever ran in CI.
- `tests/site.js` is a local copy of the whole product for browser tests (the real Worker, the real pages under their real
  headers, SQLite, an in-memory R2 bucket, controllable time). `npm run dev` uses it, and `HTTPS=1 npm run dev` serves it
  over HTTPS (Safari will not keep the sign-in cookie on plain `http://localhost`).
- The browser tests serve the site over HTTPS with a throwaway certificate, because WebKit refuses the `Secure` `__Host-`
  session cookie on plain `http://localhost`.
- A test opens at most one real file chooser; other files go to the hidden input with `setInputFiles`. Firefox sometimes
  drops a chooser when the same hidden input is opened repeatedly in one page.
- The "no page errors anywhere" guard in `tests/site.test.js` tolerates only one known WebKit case: a same-origin fetch cut
  off by a navigation, with a stack in the site's own try/catch code. Everything else fails the run.
- Never skip, disable or loosen a test to get CI green.

**Git:**
- Develop on the designated branch (`claude/optimistic-lovelace-khsuh1` in the sessions so far).
- After each PR merges, restart the branch from `main`.
- The remote branch then still holds the old, pre-squash tip, and a force-push is blocked in the cloud environment. Run
  `git merge -s ours --no-edit origin/<branch>` (records the old tip without changing any file) so the push is a plain
  fast-forward.

**PRs:**
- Only open one when asked.
- When asked to "merge if CI is green", squash-merge with the verified head commit as `expectedHeadSha`, after checking that
  every check is green on the current head and the PR is mergeable.
- Update the PR description if it goes stale.
- The commit and PR attribution lines come from the session's own instructions.
