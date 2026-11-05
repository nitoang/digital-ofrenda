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

## Tests

Browser tests (Playwright + Node's built-in test runner) load the pages straight from disk:

```sh
npm install
npx playwright install chromium   # first time only
npm test
```

They cover the default altar, Person / Pet / Mixed, 3 vs 7 tiers and the upgrade event, Start over, multiple photos, old single-photo saves, export/import (with the two-click confirm), and sanitizing of hostile imports. They fail on any page error or browser dialog.
