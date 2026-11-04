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

Imported data is treated as untrusted: unknown item types are dropped, positions are clamped, text is length-limited, and the photo must be an inline image (remote URLs are rejected).
