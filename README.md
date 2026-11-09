# Digital Ofrenda

An interactive, drag-and-drop remembrance altar as a single embeddable web component (`<digital-ofrenda>`).

Phase 1 prototype: no dependencies, saves to the browser's localStorage.

```html
<script src="ofrenda.js"></script>
<digital-ofrenda id="maria" mode="edit"></digital-ofrenda>
```

Open `index.html` for a demo.

## Sharing an altar

In edit mode, **Export** downloads the altar as a `.ofrenda.json` file and **Import** loads one back (replacing the current altar). The same is available from code:

```js
const json = JSON.stringify(el.exportState());   // save or send it anywhere
el.importState(JSON.parse(json));                 // true on success, false if not an ofrenda
```

Imported data is treated as untrusted: unknown item types are dropped, positions are clamped, text is length-limited, and each photo must be an inline image (remote URLs are rejected). Files exported before multiple photos (a single top-level `photo`) still import.

## Seven tiers (optional upgrade)

Altars have 3 tiers by default. Edit mode also offers a traditional 7-tier altar (saved as `state.tiers`), but it is off unless the host page enables it. The component takes no payments, so the host decides who gets it:

```html
<digital-ofrenda id="maria" mode="edit" seven-tiers></digital-ofrenda>
```

```js
DigitalOfrenda.features = { sevenTiers: true };   // or enable it for every altar on the page
```

With it off, the selector shows "7 tiers (upgrade)". Choosing it leaves the altar at 3 tiers and fires a bubbling `upgrade-request` event (`detail.feature === 'sevenTiers'`) for the host to answer, for example by opening a paywall:

```js
document.addEventListener('upgrade-request', e => showPricing(e.detail.feature));
```

A saved or imported 7-tier altar shows as 3 tiers while the feature is off. The setting is kept, so enabling it later restores the 7 tiers.

## Photos (2 free, more as an upgrade)

An altar can hold any number of photo frames, but only 2 photos are free. Adding a third photo, or a third photo frame, is gated the same way as the seven-tier altar: the host enables it, and otherwise the component fires `upgrade-request` with `detail.feature === 'extraPhotos'` so the host can show a paywall.

```html
<digital-ofrenda id="maria" mode="edit" extra-photos></digital-ofrenda>
```

```js
DigitalOfrenda.features = { sevenTiers: true, extraPhotos: true };
```

Replacing a photo that is already on the altar is always allowed, and an altar that already has more than 2 photos (an import, or the feature was on earlier) keeps them all. The limit only blocks adding another.

## Enforcing the limits on your server

The 2-photo limit in the browser is a courtesy, not protection: anyone can call your storage endpoint directly. If you use shared storage, run the same checks on whatever receives `storage.save()`. `server/validate.mjs` is a dependency-free module (Cloudflare Workers, Node 18+, Deno, Bun) that does it:

```js
import { validateOfrenda } from './server/validate.mjs';

const r = validateOfrenda(body, { entitlements: { extraPhotos, sevenTiers }, previous: stored });
if (!r.ok) return reply(r.status, { error: r.code, upgrade: r.feature });   // 402 photo_limit / tiers_locked, 422 bad_image, 413 too_large, 400 bad_format
await save(r.state);                                      // store the cleaned state, never the raw body
```

- `entitlements` must come from your own payment records, never from the request. Only boolean `true` counts, and each upgrade is separate: buying extra photos does not unlock seven tiers, or the reverse.
- It applies the same allowlist as the component (item types, clamped numbers and text), accepts only inline PNG/JPEG/WebP/GIF whose first bytes match the declared type, caps each photo (about 300 KB) and the whole altar (1.5 MB), and returns a cleaned copy.
- `previous` (the altar currently stored) mirrors the browser rule that saved data is never taken away: an altar whose upgrade lapsed can keep and re-save the photos it has and a 7-tier setting it already has, but cannot add photos past 2 or switch to 7 tiers. Switching back to 3 tiers is always allowed. A refused upgrade returns 402 with `feature` set to `extraPhotos` or `sevenTiers`, the same names as `upgrade-request`.
- It does not check who may write. That is your server's job.

### Accounts, co-keepers and the example Worker

`server/worker.mjs` is a complete example for Cloudflare Workers + D1 (config in `server/wrangler.example.toml`, schema in `server/migrations/`). Altars are meant to last years and be shared by families, so people sign in by email: **no passwords**.

**Signing in.** Enter an email and choose how to sign in: a link or a 6-digit code. Only the one you choose is emailed, it works once, and it is valid 15 minutes (`POST /auth/start` requires `method: "link" | "code"`). There is no separate sign-up: an account is created only when the address is proven. The reply never says whether an address is known. A session is a random value in a `__Host-` cookie (Secure, HttpOnly, SameSite=Lax), stored hashed, and lasts 90 days from last use because people come back after months. Wrong codes are limited to 5 per challenge, and emails to 5 per address per hour. Because it uses a cookie, every request that changes data must come from your own origin (checked against `APP_URL`); there is deliberately no CORS, so serve the page and the Worker from one origin.

**Altars and people.** An account owns up to 3 altars for free (`RULES.freeAltars`); the **platinum** plan lifts that and unlocks unlimited photos and the seven-tier option on all of the owner's altars. Other upgrades are bought per altar. Anyone with the link can view an altar. Editing needs an account on it:
- **Owner:** one per altar. Saves, deletes, invites co-keepers, names a successor.
- **Co-keepers:** invited by email (up to 10, invitations last 7 days and only work for the invited address). They can edit and can leave, but cannot delete the altar or manage people. They see who else keeps it.
- Altars use the owner's entitlements, so a co-keeper never needs a plan of their own.

**Sharing.** On the Keepers page the owner uses **Share this ofrenda**: enter an email address and choose what that person can do. **View only** (the default) emails them the link, and they need no account. **View and edit** invites them as a co-keeper, exactly as above. Either can carry an optional note (up to `RULES.noteMax` characters, plain text, no web links, so the email cannot be used to send someone a link of the owner's choosing).
- `POST /ofrendas/:id/share {email, access: "view" | "edit", note?}` (owner only) -> 201 `{access}`. Errors: `bad_access`, `bad_email`, `bad_note`, `note_too_long`, `note_has_link`, `already_member` (409), `too_many_shares` and `share_limit` (429), plus the invitation errors for `edit`.
- View only is **not** a lock: anyone who has the link can view an ofrenda, so a recipient can pass it on. It is a courtesy that says who the link came from. Only co-keepers can edit. Making ofrendas private to invited viewers is not built.
- Limits: `RULES.sharesPerEmailPerDay` (3, per address across all ofrendas) and `RULES.sharesPerAltarPerDay` (20). To enforce them without keeping anyone's address, a view-only share is recorded as a one-way hash of the address for a day, then cleared (needs migration `0004`).
- The emails are written in `server/mail.mjs` (`viewShareMessage`, `inviteMessage`). They name the sender by email address, since accounts have no display name yet, and the ofrenda by the name its owner gave it.

**A successor.** The owner can name one person per altar to take over if they can no longer look after it. Naming someone grants nothing: they must sign in and agree first. Agreeing makes them a co-keeper (they can edit, not delete); removing or replacing the successor takes that access away again. A takeover then needs all of this:
1. The owner has not been seen for a year (`RULES.inactiveAfter`, 365 days).
2. The successor asks. The owner is emailed and has 30 days (`RULES.claimWait`) to stop it; **signing in at any time cancels it**, and the successor is told.
3. After the wait the successor completes it. They become owner and the previous owner stays on as a co-keeper. Upgrades the old owner's platinum plan was providing are copied onto the altar so the family keeps them.

Nothing here needs a scheduled job; each step is a request someone makes.

**Payments.** Purchases are one-time and use Stripe Checkout, so card details never touch this code.
- `POST /checkout {feature, altarId?}` (signed in) asks Stripe for a Checkout page and returns its address. The page never chooses a price, a reference or any metadata: the Worker reads the Price ids from its settings and sets them itself. `extraPhotos` and `sevenTiers` are bought for one altar, by its **owner** (`client_reference_id` is the altar id); `platinum` is bought for the signed-in account (`client_reference_id` is the user id). Buying something you already have is refused, so nobody pays twice by accident, and the browser will only ever follow an address on `checkout.stripe.com`.
- The Stripe webhook (`checkout.session.completed` with `payment_status` "paid", or `checkout.session.async_payment_succeeded` for delayed payment methods; signature and timestamp verified) unlocks what was bought, keyed by the `client_reference_id` and `metadata.feature` the Worker set. A missing or unknown feature unlocks nothing, and every payment we act on is recorded (payment id, what it bought, for what; no personal data).
- **Refunds.** On `charge.refunded` with `refunded: true` (a full refund; partial ones change nothing) the upgrade that payment bought is removed: Platinum from the account, or the altar's feature. If someone paid twice and only one payment was refunded, the other still covers it. What an altar already holds is kept; its next save is just held to the free limits again. A refund Stripe reports for a payment we have no record of is traced through the metadata Checkout put on it, and anything untraceable does nothing.
- Coming back from Stripe, the page may arrive a moment before the webhook does, so it waits (up to about 30 seconds) for the upgrade to appear, then reloads with it switched on.

Set up Stripe once (use test mode first):
1. In the dashboard create three **one-time** Prices (extra photos, seven tiers, Platinum). Put their ids in `STRIPE_PRICE_EXTRA_PHOTOS`, `STRIPE_PRICE_SEVEN_TIERS` and `STRIPE_PRICE_PLATINUM` (see `server/wrangler.example.toml`), and your secret key in `wrangler secret put STRIPE_SECRET_KEY`. Until these are set, the buy buttons say purchases are not open yet.
2. Add a webhook endpoint at `https://<your site>/stripe/webhook` for the events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `charge.refunded`, and store its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Try it end to end with the Stripe CLI (`stripe listen --forward-to <your site>/stripe/webhook`) and a test card before going live.
4. Tax, currency and receipts are Stripe settings; this code does not turn on automatic tax. Add a Cloudflare rate-limiting rule for `POST /checkout`.

Setup you do once:
- `npx wrangler d1 create digital-ofrenda`, put the ID in the config, then `npx wrangler d1 migrations apply digital-ofrenda`.
- **Email:** `mailer/` is the `MAILER` Worker, and the only code that knows the provider (Resend). Steps: add and verify your sending domain in Resend (SPF and DKIM records), then `cd mailer`, copy `wrangler.example.toml` to `wrangler.toml`, set `MAIL_FROM` to an address on that domain, `npx wrangler secret put RESEND_API_KEY`, and `npx wrangler deploy`. Deploy it before the API Worker, whose `MAILER` binding points at it. It has no public address. To use another provider, change only `mailer/worker.mjs`. Templates are in `server/mail.mjs`. A new account gets a welcome email the first time it signs in, and (with `STARTER_OFRENDA = "1"`, on in the example config) one basic ofrenda called "My Ofrenda" that counts toward the free limit. Links use `APP_URL`, never the Host header.
- **Turnstile:** create a widget and `wrangler secret put TURNSTILE_SECRET`. Sign-in refuses requests without a valid token. `TURNSTILE_DISABLED=1` is for local development only, and the Worker returns 500 if neither is set.
- **Rate limits:** add Cloudflare rate-limiting rules on `POST /auth/start`, `/auth/code` and `/auth/redeem`.
- Tune the numbers in `server/rules.mjs`.

**Your account.** On the My ofrendas page a person can change their email or delete their account.
- `POST /me/email {email}` sends a 6-digit code to the **new** address and `POST /me/email/confirm {code}` switches it (15 minutes, five guesses, five codes an hour). Nothing changes before the code is entered. On success every other device is signed out and the old address is told, so a stolen session cannot quietly move an account away from its owner. Invitations and a successor naming the old address stay bound to it.
- `DELETE /me {email, deleteOfrendas?}` needs the email typed back. If the person owns ofrendas it is refused (409, with counts) until they say `deleteOfrendas: true`, which deletes those ofrendas for their co-keepers too. It removes the user, sessions, memberships, sign-in records and invitations to or from them, and the successor rows naming them. Payment records stay; they hold no personal data.
- Expired sign-in records, sessions and email-change codes are deleted by later sign-in requests; there is no scheduled job.

**Privacy policy and terms** are `site/privacy.html` and `site/terms.html`, linked from every page. They describe what this code actually does, but they are a draft: put your contact address where they say `[your contact email]`, and have them read by someone who can advise on your jurisdiction (governing law, refund policy and children's data rules are not covered). If you change what is stored or who processes it, change the policy too.

**Vanity names.** The owner can give an ofrenda a name in its address, so `/a/abuela-rosa` opens the same ofrenda as `/a/<id>`. On the Keepers page, under "A name in the address".
- `PUT /ofrendas/:id/slug {slug}` (owner only) and the public `GET /ofrendas/by-name/:name` -> `{id, slug}`. A name is 3 to 40 lower-case letters and digits with single hyphens (it is trimmed and lower-cased), and can never look like a real id (12 characters of a-z and 2-7), so `/a/<x>` is never ambiguous.
- The id link keeps working. Every name an ofrenda has had is kept and still opens it, so links already shared never break and nobody else can take a name over after the owner moves on; one ofrenda can use at most 5 names in its life (`RULES.slugsPerAltar`), and an owner can take an old one back. Deleting the ofrenda or the account frees its names. A handover keeps them, and the new owner can rename.
- Names are free, and on purpose not a paid upgrade. **A name makes an ofrenda easy to guess**, so the page says so, and the privacy page does too. Nothing filters offensive or impersonating names: if you want that, add a blocklist in `normalizeSlug` (`server/util.mjs`).
- Needs migration `0003`. The `/ofrendas/*` Worker route already covers it.

Not built: Stripe automatic tax (a decision, not code). Email addresses are stored in plain text because they have to be emailed.

### The website (`site/`)

`site/` is a small website, with no framework and no dependencies, that uses the routes above. It is everything you deploy to the web; `server/`, `tests/` and the demo pages stay out.

| Page | What it does |
|---|---|
| `/` | Short welcome with a link to sign in. |
| `/signin` | Email and a choice of link or 6-digit code. Handles the emailed link (a button press, so mail scanners can't use it up). |
| `/my` | Your ofrendas, starting a new one, the ofrendas you agreed to look after (ask to take over, complete the handover), sign out. |
| `/a/<id>` | The altar. Keepers get the editor, everyone else a read-only view that refreshes every 15 seconds. Has a copy-link box. |
| `/a/<id>/keepers` | Owner: invite co-keepers, name or remove a successor, stop a takeover request, delete. Co-keepers: leave. |
| `/invite`, `/successor` | Where the emailed invitation and successor-request links land. |

How it behaves:
- It plugs the Worker into the component through the shared-storage hook (`site/storage.js`), and turns the editor's options on from what the server says the altar is entitled to. The server still enforces every limit, so the page is a convenience, not protection.
- Everything is built with `textContent`, so names and emails can never turn into markup. The pages run under a strict policy (`site/_headers`): only this site's scripts and styles, plus Turnstile. The tests apply that exact file, so a page that needs anything looser fails them.
- Emailed tokens are kept out of URLs: they arrive after the `#`, are removed from the address bar at once, and wait in session storage only while the person signs in.
- The upgrade dialog explains an option and starts the purchase. A co-keeper sees "ask the owner" instead of a buy button, since only owners can buy for an altar. Platinum is offered alongside the per-altar upgrade.

**Deploying (Cloudflare Pages + Worker, one hostname).** Build command `npm run build:site`, output directory `site`. Then give the Worker these paths on the same hostname, so the page and the API share one origin: `/auth/*`, `/me`, `/me/*`, `/ofrendas`, `/ofrendas/*`, `/invites/*`, `/successor/*`, `/stripe/*`. Pages serves everything else (note `/successor` with nothing after it is a page). Set your Turnstile site key in `site/config.js`. Cloudflare's Turnstile documentation lists the exact content-security-policy entries it needs; `site/_headers` allows the usual ones, so check them against the current docs.

**Try it locally:** `npm run dev`, then open http://localhost:8787. It runs the real pages and the real Worker code on a throwaway in-memory database, and prints the emails (with your sign-in code) in the terminal. Everything resets when you stop it.

## Tests

Browser tests (Playwright + Node's built-in test runner) load the pages straight from disk:

```sh
npm install
npx playwright install chromium   # first time only
npm test
```

`tests/site.test.js` drives the whole website in Chromium against the real Worker code (sign-in, editing, limits, co-keepers, the successor handover, hostile text, open redirects, and no policy violations). `tests/server.test.js` (the validator) and `tests/worker.test.js` (sign-in, sessions, altars, co-keepers, successor takeover and the Stripe webhook, running the real SQL on SQLite) need no browser; the Worker tests use `node:sqlite`, so Node 22 or newer. The browser tests cover the default altar, Person / Pet / Mixed, 3 vs 7 tiers and the upgrade event, Start over, multiple photos, old single-photo saves, export/import (with the two-click confirm), and sanitizing of hostile imports. They fail on any page error or browser dialog.

## Security

- Everything that enters the altar (imports, saved data, and data from a shared store) is cleaned by the same allowlist: known item types only, clamped numbers, length-limited text, and photos only as inline `data:image/` PNG, JPEG, WebP or GIF (never SVG or remote URLs).
- The component builds its page with `textContent` and DOM calls, and applies its styles as a constructed stylesheet, so it works under a strict Content-Security-Policy. `index.html` shows one:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`.
  Add `connect-src` for your own backend if you use shared storage, and set `frame-ancestors` as an HTTP header (a `<meta>` tag can't).
- `shared.html` runs inside the claude.ai artifact host, which sets its own policy, so it has no CSP tag of its own.
- GitHub Actions runs `npm test` on every pull request.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

All rights reserved. See [LICENSE](LICENSE).
