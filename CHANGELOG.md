# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each entry ends with the pull request that made it. Before 0.9.0 nothing was versioned; the sections below group the history by what it added.

## Unreleased

### Added
- A **Contact** link in every page footer, and the support address on the privacy and terms pages is now `support@duelokit.com`, a mailbox that receives mail.
- `MAIL_REPLY_TO` on the mailer: replies to any email we send go to the support mailbox instead of the sending address. Optional; set by the Worker, never by the caller.

## 0.9.0 - 2026-11-11

Feature complete and covered by tests, but not yet deployed: the owner-only setup in [docs/HANDOFF.md](docs/HANDOFF.md) is still to do.

### Added
- Tests that apply migrations `0001` to `0012` in steps with data in place, abuse-path and size-limit tests, and more mailer tests.
- Housekeeping: this changelog, Dependabot for npm and GitHub Actions, a weekly and per-pull-request `npm audit` job, and a committed `package-lock.json` (CI installs with `npm ci`).
- `docs/HANDOFF.md`: what is done, what is left, and how to carry on in a new session (#31).

### Fixed
- A Stripe "paid" event that arrived after the refund of the same payment (a late retry) gave the upgrade back. A refund that arrives before its payment event is now remembered too.

### Changed
- The README no longer calls this a "Phase 1 prototype".

## 0.8 - Reliability, privacy and photos (2026-11-10)
- Photos live in an R2 bucket instead of inside the ofrenda's database row; a daily job moves older ones across (#30).
- Monitoring: operator alert emails, `GET /healthz`, a heartbeat URL, and a daily-job run record. Private ofrendas, `noindex`, and `/s/<name>` link previews. Browser tests run in Chromium, Firefox and WebKit in CI (#29).
- Email failures: the mailer retries, a Resend bounce and complaint webhook stops mail to dead addresses, and the sign-in page hints at typos (#28).
- Download my data: `GET /me/export` (#26).
- A daily reminders job, automatic successor transfer, and the handover and successor screens (#25).

## 0.7 - Owners and handovers (2026-11-09)
- Multiple owners, direct handover, locked ofrendas for accounts at the free limit, and visit counting (#24).
- A successor becomes a co-keeper on agreeing; a year of silence is the rule; new emails (#23).
- Sign-in requires a choice of link or code; the send-both fallback was removed (#22). A welcome email, a starter ofrenda, and link-or-code sign-in (#21).
- Owners can share an ofrenda as view only or view and edit (#20).
- Account deletion, email change, refunds, privacy and terms pages, and vanity names (#19).

## 0.6 - Email and payments (2026-11-08)
- The MAILER Worker (Resend) for real email (#18).
- Stripe Checkout for extra photos, seven tiers or Platinum (#17).

## 0.5 - Accounts and the website (2026-11-07)
- The website: sign-in, my ofrendas, the altar page, keepers, invitations (#16).
- Passwordless accounts, co-keepers, a successor and a Platinum plan (#15).
- The seven-tier upgrade enforced on the server, with per-feature entitlements (#14). Free altars capped at 2 photos, enforced on the server (#13).

## 0.4 - Hardening (2026-11-06)
- `SECURITY.md` and `LICENSE` (#12).
- Stored and shared data sanitised, a strict content-security policy, and CI (#11).

## 0.3 - The component grows (2026-11-04)
- Touch scrolling and tap handling fixed, keyboard actions announced (#10). Item tooltips, emoji fixes, and resize and rotate (#9).
- Playwright browser tests and `package.json` (#8). The optional 7-tier altar, gated by the host page (#7).
- Import confirmation without `confirm()` (#6). Multiple photos (#5). Export and import as JSON (#4).
- A shared storage hook and a live shared ofrenda page (#3).

## 0.2 - Types and offerings (2026-11-03)
- A Person, Pet or Mixed ofrenda type selector (#2). 21 offerings from community research (#1).

## 0.1 - First prototype (2026-11-03)
- The digital ofrenda web component: drag-and-drop altar saved in the browser.

