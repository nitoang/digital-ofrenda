# Briefing for a legal review

Written 2026-11-12 by the engineering side. It is **not legal advice and not a claim of compliance with any law.** It
says what the product stores and does, so a person who can advise on your jurisdiction can read `site/privacy.html` and
`site/terms.html` against facts instead of guesses. Where I could not verify a fact, it says so.

The two pages were checked against the code on 2026-11-12 and corrected where they were wrong (see "Found and fixed").

## Decisions only the operator can make (the pages cannot say these yet)

- **Who is the operator?** Neither page names a person or company, an address, or a country. The licence says
  "Copyright (c) 2026 Toni Boudreaux". Many privacy rules ask for the controller's identity and contact details. I have
  not invented one.
- **Governing law and where disputes are heard.** The terms say nothing.
- **Which rules apply to which visitors** (where they live, where you are, where the data sits). Not decided, not stated.
- **A response time** for data requests. The privacy page says "ask us" at `support@digifrenda.duelokit.com` and gives no
  time or way to confirm who is asking.

## What is stored

"Gone on deleting the account?" is what the code does in `deleteAccount` (`server/store.mjs`) plus foreign-key cascades.

| Data | Where | Personal? | Kept for | Gone when the account is deleted? |
|---|---|---|---|---|
| Email address, plan, created, last active | `users` | yes | while the account exists | yes |
| Sign-in link/code hashes **and the email typed** | `login_challenges` | email yes, rest hashed | until about a day after expiry (daily job; also when anyone starts a sign-in) | yes (by email) |
| Session ids (hashed), times | `sessions` | pseudonymous | 90 days from last use, or sign-out | yes |
| Email-change code (hashed) **and the new email** | `email_changes` | yes | until a day after expiry | yes |
| Ofrenda name, dates, words, arrangement | `altars.state` | often about a **third person** (usually deceased); free text | until the ofrenda is deleted | owned and kept by others: passed to them; owned by nobody else: deleted |
| Photos | R2 bucket (or inline in `altars.state`) | often images of **third parties** | deleted when removed from the ofrenda, or with it | with the ofrenda |
| Who keeps what, roles, time added | `altar_members` | yes | while a member | yes |
| Invitations: invitee **email**, who invited | `invites` | yes, and of people with no account | 7 days to accept, then deleted a day after it ends | yes (by invitee email and by inviter) |
| Successor: email, who named them, when agreed | `successors` | yes | until removed | yes |
| Takeover requests: who, when | `claims` | pseudonymous (user id) | the row stays after it ends | yes (cascade) |
| Waiting handovers: recipient **email**, giver | `handovers` | yes, of people with no account | until the person signs up or 90 days | the giver's yes; one addressed to a deleted address is not touched (only possible in a race: an address with an account gets it at once) |
| Handover log: user id, time | `handover_log` | pseudonymous | one day (rate limit) | yes |
| Days a signed-in person opened an ofrenda | `altar_visits` | yes (behavioural) | until the ofrenda or account is deleted | yes |
| View-only share: hash of the address, time | `view_shares` | hashed | one day | n/a (the sharer's rows go) |
| Addresses that bounced or complained: hash | `mail_suppressions` | hashed address | **indefinitely**, kept after deletion on purpose | no |
| Purchases: Stripe payment id, what, for which ofrenda/account, amount, currency, time, refund/dispute state, **buyer link** | `purchases` | linked while the account exists | indefinitely | the link to the buyer is removed; the record of the sale stays. Platinum rows hold the account id as their reference, so that opaque id stays |
| Job runs, operator alert counters | `job_runs`, `alerts` | no | indefinitely | n/a |

Not stored by the application: card details (Stripe), passwords (there are none), IP addresses (passed on, see below).

## Who else handles data

- **Cloudflare**: hosts the pages, the Worker, the D1 database and the R2 photo bucket; runs Turnstile (receives the visitor's
  IP address from the Worker with each sign-in check); keeps request logs (Workers Logs are switched on). **Not verified:**
  exactly what those logs hold (URLs, IP addresses), for how long, and where. The privacy page says "can include the time,
  the page asked for and your IP address, for a limited time".
- **Resend**: sends every email (addresses and message text). Includes emails to people who never signed up (invitations,
  shared links, handover reminders). **Not verified:** how long Resend keeps message content.
- **Stripe**: takes payments on its own page. We send it the buyer's email, a price id, and metadata (what, for which
  ofrenda, the user id). We ask it to email the receipt (`receipt_email`).
- **Operator tools, no personal data by design:** alert emails to the operator and an optional heartbeat URL carry
  payment ids, error kinds and counts, with email addresses removed (`redact` in `server/alerts.mjs`).
- Contracts with these processors (data processing terms) and where each stores data: **not looked at**.

## Behaviour with legal weight

1. **Public by link by default.** Anyone with an ofrenda's link can see it. The owner can make it private. Naming an ofrenda
   makes its address guessable (the page says so). Search engines are asked not to list ofrendas.
2. **Successor.** The owner can name someone who may take over after the owner has been silent for 12 months (or 6 if chosen),
   with a 30-day notice and reminders; it can pass automatically. This is a product feature, not a will or any legal
   instrument, and the pages do not say so.
3. **Handover to someone with no account**: reminders are emailed to them (days 30, 60, 85), and after 90 days the ofrenda
   passes **automatically to the signed-in person who opened it on the most days**, otherwise to the successor, otherwise
   the co-keepers. That is an automated decision about who controls a memorial, based on counted visits. The terms now
   describe it; whether that is enough (consent of the person it passes to, notice to the owner, explanations) is a question.
4. **Emails to people who did not ask for them**: an invitation, a shared link, and up to three handover reminders, each
   sent because a user typed that address. They carry the sender's email address. Whether this fits email-marketing and
   privacy rules where the recipient lives is a question.
5. **Visit counting** of signed-in non-owners (purpose: the handover rule above).
6. **Third-party content**: photos and words about other people, mostly the dead. The terms ask users to have the right to
   share. There is no way for a third party to report an ofrenda; no takedown process; no moderation. Content can be removed
   only by the owner (or by me with database access).
7. **Children**: the pages say 13 and over and "we do not knowingly keep their data". No age check exists. Some places set
   a higher age for consent.
8. **Cookies and storage**: one first-party session cookie (`__Host-session`); session storage briefly holds a one-time
   token from an emailed link. Turnstile and Stripe are third-party. **Not verified:** what storage Turnstile uses.
9. **Money**: one-time purchases. Partial refunds keep the upgrade; full refunds and lost disputes remove it; an open
   dispute keeps it. No withdrawal or cooling-off wording, no tax wording (Stripe automatic tax is not switched on), no
   statement on price changes.
10. **Accessibility**: automated checks and some manual work (README, "Accessibility"); no conformance statement, and nobody
    has tested with real assistive technology. Some places expect a statement.
11. **If the service closes.** Ofrendas are memorials people may expect to last. The terms promise no availability and say
    "keep your own copy"; they say nothing about notice before closing, or about what happens to ofrendas.

## Found and fixed while preparing this

- Expired and used **invitations (with the invitee's email) were never deleted**; sign-in records (with the typed email) were
  deleted only when someone else started a sign-in; the handover log grew forever. The daily job now clears them (`pruneOld`),
  and the privacy page states the periods. (`docs/HANDOFF.md` had said the daily job already did this; it did not.)
- The privacy page did not say that **other keepers can see your email address**, that logs exist, that your IP address goes
  to Turnstile, that handovers are logged for a day, or that the export now contains purchases. Added.
- The terms did not describe the **automatic handover rule**. Added.
- Both pages' "last updated" date was stale. Now 12 November 2026.

## Still not stated or not true to the letter

- Backups: the page says deleted data "may remain in the host's backups for a short time". The real windows for D1 and R2
  were not verified. Put the real number there.
- `mail_suppressions` is kept forever by design, and the page says so; whether that is justified, and whether a one-way
  hash of an email address is anonymous, is a question.
- The export file is "not protected once it is on your device" (said); it contains other keepers' email addresses.
- Platinum purchase rows keep the deleted account's opaque id as their reference.

## Questions to put to the reviewer

1. Which jurisdictions' privacy and consumer rules apply, and what must the privacy page then contain (controller identity,
   legal bases, rights and how to use them, complaint route, transfers, retention, automated decisions)?
2. Is the automatic handover to the most frequent visitor acceptable as designed, and what notice or consent does it need?
3. Are invitations, shared links and reminders to non-users permitted as they are sent now?
4. What do the terms need: governing law, liability wording, termination, content rules and takedown, abuse reporting,
   refunds and withdrawal, tax, price changes, service closure?
5. Does `successor` need a statement that it is not a will or legal succession?
6. Is the age statement enough? Is a cookie notice needed (nothing here is for advertising or analytics)?
7. Do the processors need contracts, and does the page need to name them as it does?
8. Should an accessibility statement be published?
