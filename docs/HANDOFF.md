# Handoff: what is done, what is left

Written 2026-11-11, after PR #30 (photos in R2) merged. `main` was at `32582c2`. Read this first in a new session, then
check `git log` in case things have moved on.

## Start a new session with this prompt

```
Work on the repo nitoang/digital-ofrenda. Read docs/HANDOFF.md first. Then build the remaining suggestions in the order it
gives: #15 test gaps, #16 housekeeping, #4 deploy workflow, #13 accessibility, #12 receipts and disputes, #17 legal review.
Do one at a time: build it, run the full tests, push to the designated branch (restart it from main first; force-push is
blocked, so merge the old remote tip with `git merge -s ours` to make the push a fast-forward), then tell me before opening
a PR. When I say "merge if CI is green", squash-merge only after all CI checks are green on the current head. Never skip or
loosen a test to get green. Be honest about what you could not verify (for example Firefox and WebKit locally, and real R2).
```

## Already done and merged

| # | What |
|---|---|
| 5 | Daily cron job that prunes expired data (`server/scheduled.mjs`). It was never confirmed that expired invites are purged. |
| 6 | Photos in an R2 bucket (`server/photos.mjs`). Inactive until the bucket is bound as `PHOTOS`. |
| 7 | Alert emails (`ALERT_EMAIL`), `GET /healthz`, a heartbeat URL (`HEARTBEAT_URL`) (`server/alerts.mjs`). |
| 8 | Mailer retries, Resend bounce and complaint webhook, sign-in typo hint (`server/mailhealth.mjs`, `site/typos.js`). |
| 9 | Download-everything export, `GET /me/export` (`server/export.mjs`). |
| 10 | Successor and inactivity emails (built earlier by other PRs). |
| 11 | Private ofrendas, `noindex`, `/s/<name>` link previews (`server/preview.mjs`). There is deliberately no "new link" button: an ofrenda's address is its link, so private is how to cut off a leaked one. |
| 14 | Browser tests run in Chromium, Firefox and WebKit in CI. |

## Still to build, in the order to do them

### 1. #15 Test gaps
- The mailer has only a handful of tests (`tests/mailer.test.js`).
- Missing: abuse-path tests (rate limits, replayed webhooks), migration-upgrade tests that apply
  `server/migrations/0001` to `0012` in steps with data in place, and size and load limits.
- The Worker tests run the real SQL on SQLite (`tests/d1.js`, which applies every migration on start-up).

### 2. #16 Housekeeping
- The README still opens with "Phase 1 prototype".
- The version is still `0.1.0` (`package.json`).
- There is no Dependabot, no `npm audit` step and no CHANGELOG.
- Publishing `ofrenda.js` as a package for reuse is optional.

### 3. #4 Deploy workflow
- Today there is only `server/wrangler.example.toml`. `mailer/wrangler.toml` is committed.
- Order: apply migrations, deploy the mailer, deploy the API Worker, then Pages (build `npm run build:site`, output
  directory `site`).
- Worker routes on the site's hostname: `/auth/*`, `/me`, `/me/*`, `/checkout`, `/ofrendas`, `/ofrendas/*`,
  `/invites/*`, `/successor/*`, `/stripe/*`, `/resend/*`, `/s/*`, `/healthz`.
- Cron: `17 14 * * *`. Cloudflare Workers Logs are on via `[observability]`.
- Secrets: `TURNSTILE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `RESEND_WEBHOOK_SECRET`; `RESEND_API_KEY` on
  the mailer.
- Variables: `APP_URL`, `STRIPE_PRICE_EXTRA_PHOTOS`, `STRIPE_PRICE_SEVEN_TIERS`, `STRIPE_PRICE_PLATINUM`, `ALERT_EMAIL`,
  `HEARTBEAT_URL`, `STARTER_OFRENDA`.
- Also: the R2 bucket binding `PHOTOS`, and the Turnstile site key in `site/config.js`.
- The owner must add Cloudflare API credentials to the repository's GitHub secrets; an assistant cannot.
- CI job names the workflow already has: `test`, `browser (chromium)`, `browser (firefox)`, `browser (webkit)`.

### 4. #13 Accessibility
- Already in place: an `aria-live` status area, keyboard actions for items, an `assertLabelled` browser test, and
  reduced-motion support for the candle animation.
- Still to do: a screen-reader pass over the drag-and-drop alternatives, colour contrast, focus order on the site pages,
  and a mobile touch pass. The two real-touch tests run in Chromium only.

### 5. #12 Receipts and disputes
- The `purchases` table holds `payment_intent`, `feature`, `reference` and `refunded_at`. It does not record who bought.
- Only a full `charge.refunded` is handled (`server/billing.mjs`). Partial refunds are ignored. Disputes and chargebacks
  are not handled.
- To add: a purchase-history page, and handling for `charge.dispute.*` events.

### 6. #17 Legal review
- `site/privacy.html` and `site/terms.html` exist. They were updated as features landed, but have not had a legal read.
- Check them against what is stored now: visit counts, hashed view-share records, hashed mail-suppression records,
  handovers, job runs, and photos in R2. The contact address in use is `support@digifrenda.duelokit.com`.
- Data-request handling (copy of data, deletion) is documented there; check it matches reality.

## Setup only the owner can do
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
- Nothing caps the total size of an ofrenda's photos (each is about 300 KB, an ofrenda holds up to 200 items). Photos are
  not scanned.
- Moving existing inline photos into R2 happens at 25 ofrendas a day, so a large database takes a while.
- An owner is not told when an invitation or a shared link bounced.
- A Chromium hang in CI happened twice early on and was never explained. It has not recurred since the test harness was
  hardened (hard-closing connections, closing browser contexts, per-test and per-job timeouts).
- CI job names changed when the browser matrix arrived. Update any required-checks rule if the repository has one.

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
