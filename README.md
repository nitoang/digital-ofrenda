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

### Signup, email recovery and the example Worker

`server/worker.mjs` is a complete example for Cloudflare Workers + D1 (config in `server/wrangler.example.toml`, schema in `server/migrations/`). There are no accounts and no passwords. Each altar has a secret **edit token**, and every altar has an **email address for recovery**.

1. **Signup:** `POST /ofrendas` with `{email, turnstile}` creates the altar and returns `{id, token}` once. Only the token's SHA-256 hash is stored. The page keeps the token in the browser and shows an edit link (`/a/<id>#k=<token>`) and a view link (`/a/<id>`) to share.
2. **Confirmation:** the owner gets an email with a one-time link (`/a/<id>#v=...`, valid 24 hours). `POST /ofrendas/:id/verify` confirms the address. Until it is confirmed, recovery does nothing for that altar, so a mistyped address can never be used to take over an altar.
3. **Recovery:** `POST /recover` with `{email, turnstile}` always answers `200 {"ok":true}`, whether or not the address is known. If it belongs to confirmed altars, one email lists a link for each (`/a/<id>#r=...`, valid 30 minutes, up to 10). `POST /ofrendas/:id/recover` swaps the link for a **new edit token** and the old token stops working. Emailed tokens sit after the `#`, and the page POSTs them, so email scanners that pre-fetch links cannot use them up.
4. **Rotate:** `POST /ofrendas/:id/rotate` (with the current token) issues a new edit token, for example after a link leaks. Recovery and rotation both cancel recovery links still waiting in inboxes.
5. **Saving:** `PUT /ofrendas/:id` needs the bearer token and applies `validateOfrenda`, with entitlements read from the `features` table. A request cannot grant itself an upgrade. `GET /ofrendas/:id` is public and returns only the altar, never the email or any credential.
6. **Payments:** a signature-checked Stripe webhook (`checkout.session.completed`) inserts a `features` row using `client_reference_id` as the altar ID and `metadata.feature` (`extraPhotos` or `sevenTiers`) as the name. A missing or unknown feature unlocks nothing.

Setup you do once:
- `npx wrangler d1 create digital-ofrenda`, put the ID in the config, then `npx wrangler d1 migrations apply digital-ofrenda`.
- **Email:** write a tiny Worker for the email provider you choose that accepts `POST /send` with `{to, subject, text}`, and bind it as `MAILER`. The templates are in `server/mail.mjs`. Links use `APP_URL`, never the request's Host header.
- **Turnstile:** create a widget and `wrangler secret put TURNSTILE_SECRET`. Signup and recovery refuse requests without a valid token. `TURNSTILE_DISABLED=1` exists for local development only, and the Worker returns 500 if neither is set.
- **Rate limits:** add Cloudflare rate-limiting rules on `POST /ofrendas` and `POST /recover`. The Worker also limits per email address: 3 confirmation emails and 20 recovery links per hour, so one inbox cannot be flooded. A fourth altar registered to the same address within an hour gets its confirmation email once the hour has passed (use the resend route).

Things it leaves to you: creating the Stripe Checkout session (with `client_reference_id` and `metadata.feature`), clearing a `features` row on refund (the altar keeps what it already has), changing an altar's email address, deleting an altar and its email on request, and custom names. Email addresses are stored in plain text because they have to be emailed, so publish a privacy policy.

## Tests

Browser tests (Playwright + Node's built-in test runner) load the pages straight from disk:

```sh
npm install
npx playwright install chromium   # first time only
npm test
```

`tests/server.test.js` (the validator) and `tests/worker.test.js` (signup, confirmation, recovery, saving and the Stripe webhook, running the real SQL on SQLite) need no browser; the Worker tests use `node:sqlite`, so Node 22 or newer. The browser tests cover the default altar, Person / Pet / Mixed, 3 vs 7 tiers and the upgrade event, Start over, multiple photos, old single-photo saves, export/import (with the two-click confirm), and sanitizing of hostile imports. They fail on any page error or browser dialog.

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
