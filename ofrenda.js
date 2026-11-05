/*!
 * <digital-ofrenda> — an interactive, drag-and-drop remembrance altar.
 * Phase 1 prototype: no dependencies, saves to the visitor's browser (localStorage).
 * Optional shared mode: set DigitalOfrenda.storage before the element connects and the altar
 * loads from and saves to that backend instead, updating live when other people change it.
 *   storage = {
 *     canWrite: boolean,
 *     subscribe(id, onState(stateOrNull, {fromCache, hasPendingWrites}), onError) -> unsubscribe,
 *     save(id, state) -> Promise
 *   }
 *
 * Usage:
 *   <script src="ofrenda.js"></script>
 *   <digital-ofrenda id="maria" mode="edit"></digital-ofrenda>
 *
 * Attributes:
 *   id    unique key used for saving (one per ofrenda)
 *   mode  "edit" (drag, drop, personalize) or "view" (default; visitors can light candles)
 *   Edit mode also lets you choose a Person, Pet or Mixed ofrenda (saved as state.kind).
 *
 * Events:
 *   ofrenda-change  fired after every saved change, detail = the full state object
 *
 * Sharing (edit mode has Export / Import buttons):
 *   el.exportState()      -> plain object ({format, version, ...state}) you can JSON.stringify
 *   el.importState(data)  -> validates + sanitizes untrusted data, replaces the altar, saves.
 *                            Returns true on success, false if the data is not an ofrenda.
 */
(() => {
  const ITEMS = {
    photo:    { emoji: '🖼️', label: 'Photo frame' },
    candle:   { emoji: '🕯️', label: 'Candle', candle: true },
    marigold: { emoji: '🌼', label: 'Marigold' },
    skull:    { emoji: '💀', label: 'Sugar skull' },
    pan:      { emoji: '🍞', label: 'Pan de muerto' },
    coffee:   { emoji: '☕', label: 'Coffee' },
    water:    { emoji: '🥛', label: 'Glass of water' },
    fruit:    { emoji: '🍉', label: 'Fruit' },
    treat:    { emoji: '🍫', label: 'Favorite treat' },
    tamal:    { emoji: '🫔', label: 'Tamal' },
    butterfly:{ emoji: '🦋', label: 'Monarch butterfly' },
    dog:      { emoji: '🐕', label: 'Loyal companion', for: 'pet' },
    music:    { emoji: '🎵', label: 'Favorite song' },
    heart:    { emoji: '❤️', label: 'Heart' },
    note:     { emoji: '📝', label: 'Note card' },
    // Added from community research (r/AskMexico, r/mexico, r/Dia_de_Muertos)
    led:      { emoji: '🕯️', label: 'LED candle (pet/kid safe)', candle: true },
    petals:   { emoji: '🏵️', label: 'Marigold petal path' },
    papel:    { emoji: '🎏', label: 'Papel picado' },
    copal:    { emoji: '🏺', label: 'Copal / incense' },
    salt:     { emoji: '🧂', label: 'Salt' },
    mole:     { emoji: '🍛', label: 'Mole' },
    flan:     { emoji: '🍮', label: 'Flan' },
    jamaica:  { emoji: '🍹', label: 'Agua de Jamaica' },
    soda:     { emoji: '🥤', label: 'Coke / soda' },
    liquor:   { emoji: '🥃', label: 'Tequila / mezcal / scotch', for: 'person' },
    beer:     { emoji: '🍺', label: 'Beer', for: 'person' },
    cigs:     { emoji: '🚬', label: 'Cigarettes', for: 'person' },
    guitar:   { emoji: '🎸', label: 'Guitar / pick', for: 'person' },
    domino:   { emoji: '🃏', label: 'Dominoes / cards', for: 'person' },
    jersey:   { emoji: '👕', label: 'Soccer jersey', for: 'person' },
    cleats:   { emoji: '👟', label: 'Cleats / sneakers', for: 'person' },
    toy:      { emoji: '🧸', label: 'Toy (for children)' },
    bowl:     { emoji: '🥣', label: 'Pet water bowl', for: 'pet' },
    kibble:   { emoji: '🦴', label: 'Pet treat / kibble', for: 'pet' },
    collar:   { emoji: '🏷️', label: 'Collar / tag', for: 'pet' },
    xolo:     { emoji: '🐕‍🦺', label: 'Xoloitzcuintli guide', for: 'pet' },
  };

  // Which kind of ofrenda this is. Items with `for` are only offered in the matching kinds.
  const KINDS = {
    person: { label: 'Person',  placeholder: 'Name of your loved one' },
    pet:    { label: 'Pet',     placeholder: 'Name of your pet' },
    mixed:  { label: 'Mixed',   placeholder: 'Names of your loved ones' },
  };
  const PET_NOTE = 'Pet safety: keep chocolate, grapes and sugar skulls out of reach of living pets, and skip lilies if you have a cat.';
  const offered = (type, kind) => { const f = ITEMS[type].for; return !f || kind === 'mixed' || f === kind; };

  const DEFAULT_NOTE = 'Siempre en nuestro corazón';
  const PHOTO_MAX_PX = 480;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const FORMAT = 'digital-ofrenda', VERSION = 1;
  const MAX_ITEMS = 200;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const MIN_SCALE = 0.5, MAX_SCALE = 3;
  const num = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : dflt);

  // Only inline raster images are accepted, never remote URLs or other schemes.
  const isImage = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);

  // Earlier versions kept a single `photo` on the state; now each photo frame holds its own `src`.
  const migratePhoto = state => {
    if (state && state.photo) {
      const frame = state.items.find(i => i.type === 'photo' && !i.src);
      if (frame) frame.src = state.photo;
      else state.items.push({ id: uid(), type: 'photo', x: 50, y: 24, src: state.photo });
    }
    if (state) delete state.photo;
    return state;
  };

  // Tier layouts: [top %, width %, color]. Three is the default; seven is an optional upgrade.
  const TIERS = {
    3: [[14, 52, '#e0742e'], [42, 78, '#c2417f'], [66, 100, '#6c3bb0']],
    7: [[13, 26, '#f2c14e'], [24, 38, '#e0742e'], [35, 50, '#d9534f'], [46, 62, '#c2417f'], [57, 74, '#9b5de5'], [68, 87, '#6c3bb0'], [79, 100, '#3f6fb5']],
  };

  // Turn untrusted data (e.g. an imported file) into a safe state object, or null if it isn't an ofrenda.
  const sanitize = data => {
    if (!data || typeof data !== 'object' || data.format !== FORMAT || !Array.isArray(data.items)) return null;
    const seen = new Set();
    const items = [];
    for (const raw of data.items.slice(0, MAX_ITEMS)) {
      if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(ITEMS, raw.type)) continue;
      let id = str(raw.id, 32).replace(/[^\w-]/g, '');
      if (!id || seen.has(id)) id = uid();
      seen.add(id);
      const item = { id, type: raw.type, x: num(raw.x, 0, 100, 50), y: num(raw.y, 0, 100, 50) };
      const scale = num(raw.scale, MIN_SCALE, MAX_SCALE, 1);
      if (scale !== 1) item.scale = scale;
      const rot = ITEMS[raw.type].candle ? 0 : num(raw.rot, -180, 180, 0); // candles stay upright
      if (rot !== 0) item.rot = rot;
      if (ITEMS[raw.type].candle) item.lit = raw.lit === true;
      if (raw.type === 'note') item.text = str(raw.text, 80) || DEFAULT_NOTE;
      if (raw.type === 'photo' && isImage(raw.src)) item.src = raw.src;
      items.push(item);
    }
    const state = { kind: KINDS[data.kind] ? data.kind : 'person', tiers: data.tiers === 7 ? 7 : 3, name: str(data.name, 80), dates: str(data.dates, 80), items };
    // Files exported before multiple photos kept one top-level photo.
    if (isImage(data.photo)) state.photo = data.photo;
    return migratePhoto(state);
  };

  const defaultState = () => ({
    kind: 'person',
    tiers: 3,
    name: '',
    dates: '',
    items: [
      { id: uid(), type: 'photo',    x: 50, y: 24 },
      { id: uid(), type: 'candle',   x: 33, y: 30, lit: true },
      { id: uid(), type: 'candle',   x: 67, y: 30, lit: true },
      { id: uid(), type: 'marigold', x: 36, y: 52 },
      { id: uid(), type: 'marigold', x: 64, y: 52 },
      { id: uid(), type: 'pan',      x: 50, y: 54 },
      { id: uid(), type: 'water',    x: 20, y: 76 },
      { id: uid(), type: 'marigold', x: 80, y: 76 },
    ],
  });

  const css = `
    :host { display: block; max-width: 760px; margin: 0 auto; font-family: Georgia, 'Times New Roman', serif; color: #fdf3e3; }
    * { box-sizing: border-box; }
    .wrap { background: #2a1640; border-radius: 16px; padding: 20px; }
    header { text-align: center; margin-bottom: 14px; }
    .name { margin: 0; font-size: 1.7rem; font-weight: normal; letter-spacing: .02em; min-height: 1.3em; }
    .dates { margin: 4px 0 0; opacity: .8; min-height: 1.2em; }
    [contenteditable="true"]:empty::before { content: attr(data-placeholder); opacity: .45; }
    [contenteditable="true"] { outline: none; border-bottom: 1px dashed rgba(253,243,227,.35); cursor: text; }

    .stage { position: relative; aspect-ratio: 4 / 3; container-type: inline-size; overflow: hidden;
             border-radius: 10px; background: linear-gradient(#1b0d2e, #3a1f57); touch-action: none; user-select: none; -webkit-user-select: none; }
    .banner { position: absolute; inset: 0 0 auto 0; height: 9%; display: flex; }
    .banner i { flex: 1; clip-path: polygon(0 0, 100% 0, 100% 70%, 50% 100%, 0 70%); }
    .tier { position: absolute; left: 50%; transform: translateX(-50%); }
    .tier.seven { height: 100%; }
    .tier.seven::after { height: 3px; }
    .tier::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 5px; background: rgba(255,255,255,.25); border-radius: inherit; }

    .item { position: absolute; transform: translate(-50%, -50%); line-height: 1; cursor: default; border-radius: 8px; }
    .item:focus-visible { outline: 3px solid #ffd45c; outline-offset: 3px; }
    .editing .item { cursor: grab; touch-action: none; }
    .handle { display: none; position: absolute; --k: calc(1px / var(--s, 1)); width: calc(26 * var(--k)); height: calc(26 * var(--k));
              margin: calc(-13 * var(--k)); border-radius: 50%; background: #ffd45c; border: calc(2 * var(--k)) solid #3a2158;
              box-shadow: 0 1px 4px rgba(0,0,0,.5); touch-action: none; z-index: 2; }
    .handle.resize { right: 0; bottom: 0; cursor: nwse-resize; }
    .handle.rotate { left: 50%; top: calc(-26 * var(--k)); cursor: grab; }
    .handle.rotate::before { content: ''; position: absolute; left: 50%; top: 100%; width: calc(2 * var(--k)); height: calc(14 * var(--k));
                             margin-left: calc(-1 * var(--k)); background: #ffd45c; }
    .editing .item:focus .handle, .editing .item.adjusting .handle { display: block; }
    @media (pointer: coarse) { .handle { --k: calc(1.5px / var(--s, 1)); } }
    .item.dragging { cursor: grabbing; opacity: .85; filter: drop-shadow(0 6px 8px rgba(0,0,0,.5)); }
    .emoji { font-size: 7.5cqw; display: block; }
    .item.candle { cursor: pointer; }
    .item.candle .emoji { filter: brightness(.55) saturate(.5); transition: filter .3s; }
    .item.candle.lit .emoji { filter: drop-shadow(0 0 1.6cqw #ffb534) drop-shadow(0 0 3cqw rgba(255,180,60,.7)); animation: flicker 2.4s infinite alternate; }
    @keyframes flicker { 0% { transform: scale(1); } 50% { transform: scale(1.03) rotate(-1deg); } 100% { transform: scale(.99) rotate(1deg); } }
    @media (prefers-reduced-motion: reduce) { .item.candle.lit .emoji { animation: none; } }

    .frame { width: 19cqw; aspect-ratio: 3 / 4; background: #f6e7c8; border: 1.2cqw solid #b8862b; border-radius: 4px;
             box-shadow: 0 .6cqw 2cqw rgba(0,0,0,.5); display: grid; place-items: center; overflow: hidden; }
    .frame img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
    .frame span { color: #7a5a1a; font-size: 1.9cqw; text-align: center; padding: 1cqw; font-family: system-ui, sans-serif; }
    .editing .item.photo { cursor: grab; }

    .papel { display: flex; gap: .5cqw; padding-top: .8cqw; border-top: .4cqw solid #fdf3e3; }
    .papel i { width: 4.2cqw; height: 5.5cqw; opacity: .92; clip-path: polygon(0 0, 100% 0, 100% 78%, 80% 62%, 60% 100%, 40% 62%, 20% 100%, 0 78%); }
    .note { max-width: 24cqw; background: #fff6d6; color: #3a2a10; padding: 1.2cqw 1.6cqw; font-size: 2.2cqw; line-height: 1.25;
            border-radius: 3px; box-shadow: 0 .5cqw 1.4cqw rgba(0,0,0,.45); transform: rotate(-2deg); text-align: center; }
    .note span { display: block; min-width: 4ch; }

    .kind { display: flex; justify-content: center; gap: 6px; margin: 0 0 12px; padding: 0; border: 0; font-family: system-ui, sans-serif; }
    .tiers { display: flex; justify-content: center; gap: 6px; margin: 0 0 12px; padding: 0; border: 0; font-family: system-ui, sans-serif; }
    .tiers legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .tiers label { cursor: pointer; padding: 6px 14px; border-radius: 999px; border: 1px solid rgba(253,243,227,.4); font-size: .8rem; }
    .tiers input { position: absolute; opacity: 0; pointer-events: none; }
    .tiers label:has(input:checked) { background: #c2417f; border-color: #c2417f; color: #fff; }
    .tiers label:has(input:focus-visible) { outline: 3px solid #ffd45c; outline-offset: 2px; }
    .kind legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .kind label { cursor: pointer; padding: 6px 14px; border-radius: 999px; border: 1px solid rgba(253,243,227,.4); font-size: .8rem; }
    .kind input { position: absolute; opacity: 0; pointer-events: none; }
    .kind label:has(input:checked) { background: #e0742e; border-color: #e0742e; color: #fff; }
    .kind label:has(input:focus-visible) { outline: 3px solid #ffd45c; outline-offset: 2px; }
    .petnote { margin: 8px 0 0; font-family: system-ui, sans-serif; font-size: .75rem; opacity: .8; }
    .tray { margin-top: 14px; padding: 12px; border-radius: 10px; background: #3a2158; border: 2px dashed transparent; transition: border-color .15s, background .15s; }
    .tray.danger { border-color: #ff6b6b; background: #5a2140; }
    .tray h3 { margin: 0 0 8px; font-size: .85rem; font-weight: normal; opacity: .75; font-family: system-ui, sans-serif; }
    .tray-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
    .tray button { all: unset; box-sizing: border-box; cursor: grab; touch-action: none; text-align: center; padding: 8px 4px;
                   border-radius: 8px; background: rgba(255,255,255,.07); font-family: system-ui, sans-serif; font-size: .7rem; }
    .tray button:hover { background: rgba(255,255,255,.14); }
    .tray button:focus-visible { outline: 3px solid #ffd45c; }
    .tray button b { display: block; font-size: 1.7rem; font-weight: normal; margin-bottom: 2px; }
    .actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; font-family: system-ui, sans-serif; font-size: .8rem; }
    .actions button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 999px; background: #e0742e; color: #fff; }
    .actions button.ghost-btn { background: transparent; border: 1px solid rgba(253,243,227,.4); }
    .actions button:focus-visible { outline: 3px solid #ffd45c; }
    .hint { opacity: .65; }
    .ghost { position: fixed; z-index: 99999; pointer-events: none; transform: translate(-50%, -50%); font-size: 40px; filter: drop-shadow(0 6px 8px rgba(0,0,0,.5)); }
    .status { min-height: 1.1em; opacity: .8; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `;

  class DigitalOfrenda extends HTMLElement {
    static get observedAttributes() { return ['mode', 'seven-tiers']; }

    static storage = null;
    // Host-controlled feature flags. The component can't take payment, so a host page
    // enables paid options here (or with attributes) and answers 'upgrade-request' events.
    static features = { sevenTiers: false };

    connectedCallback() {
      this._key = 'ofrenda:' + (this.id || 'default');
      this._store = DigitalOfrenda.storage;
      if (this._store) {
        // Shared mode: show the default altar read-only until the shared copy has loaded,
        // so an early edit can never overwrite it.
        this._state = defaultState();
        this._synced = false;
        this._build();
        this._render();
        this._say('Loading the shared altar…');
        this._slow = setTimeout(() => this._say('The shared altar is slow to respond. It will appear when it loads.'), 10000);
        this._unsub = this._store.subscribe(this.id || 'default',
          (data, meta) => this._onRemote(data, meta),
          () => this._say('The shared altar could not be loaded.'));
      } else {
        this._state = this._load() || defaultState();
        this._build();
        this._render();
      }
    }

    disconnectedCallback() {
      this._unsub?.();
      clearTimeout(this._slow); clearTimeout(this._timer); clearTimeout(this._retry);
    }

    attributeChangedCallback() {
      if (this._root) this._render();
    }

    get _sevenAllowed() {
      return DigitalOfrenda.features?.sevenTiers === true || (this.hasAttribute('seven-tiers') && this.getAttribute('seven-tiers') !== 'false');
    }

    // A saved 7-tier altar shows as 3 tiers (data kept) while the feature is off.
    get _tiers() { return this._state.tiers === 7 && this._sevenAllowed ? 7 : 3; }

    get _editable() { return this.getAttribute('mode') === 'edit' && (!this._store || this._synced); }

    // ---------- storage ----------
    _load() {
      try {
        const raw = localStorage.getItem(this._key);
        return raw ? this._migrate(JSON.parse(raw)) : null;
      } catch { return null; }
    }

    _migrate(state) { return migratePhoto(state); }

    // ---------- shared storage ----------
    _onRemote(data, meta) {
      if (meta?.fromCache) return; // wait for the store's confirmed answer
      if (!this._synced) {
        this._synced = true;
        clearTimeout(this._slow);
        this._say('');
        if (!data) { this._render(); return; }
      }
      if (!data || meta?.hasPendingWrites) return;
      const json = JSON.stringify(data);
      if (json === this._lastJson) return; // echo of our own save
      this._pending = { data, json };
      this._applyPending();
    }

    _busy() {
      return !!(this._timer || this._writing || this._root.querySelector('.dragging, .ghost') || this._root.activeElement?.isContentEditable);
    }

    _applyPending() {
      clearTimeout(this._retry);
      if (!this._pending) return;
      if (this._busy()) { this._retry = setTimeout(() => this._applyPending(), 800); return; }
      const { data, json } = this._pending;
      this._pending = null;
      this._lastJson = json;
      this._state = migratePhoto({ ...defaultState(), ...JSON.parse(json) });
      if (!Array.isArray(this._state.items)) this._state.items = [];
      this._render();
    }

    _queueRemote() {
      if (!this._synced || !this._store.canWrite) return; // viewers see changes only on their own screen
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this._flush(); }, 300);
    }

    async _flush() {
      if (this._writing) { this._again = true; return; }
      this._writing = true;
      try {
        const json = JSON.stringify(this._state);
        this._lastJson = json;
        await this._store.save(this.id || 'default', JSON.parse(json));
        this._say('');
      } catch {
        this._say('Could not save to the shared altar. Check your connection and try again.');
      } finally {
        this._writing = false;
        if (this._again) { this._again = false; this._flush(); } else this._applyPending();
      }
    }

    _save() {
      if (this._store) {
        this._queueRemote();
        this.dispatchEvent(new CustomEvent('ofrenda-change', { detail: this._state, bubbles: true }));
        return;
      }
      try {
        localStorage.setItem(this._key, JSON.stringify(this._state));
        this._say('');
      } catch {
        this._say('Could not save — browser storage is full or blocked.');
      }
      this.dispatchEvent(new CustomEvent('ofrenda-change', { detail: this._state, bubbles: true }));
    }

    // ---------- sharing ----------
    exportState() { return { format: FORMAT, version: VERSION, ...JSON.parse(JSON.stringify(this._state)) }; }

    importState(data) {
      const next = sanitize(data);
      if (!next) return false;
      this._state = next;
      this._save();
      this._render();
      return true;
    }

    _download() {
      const blob = new Blob([JSON.stringify(this.exportState(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = (this._state.name || 'ofrenda').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ofrenda';
      a.href = url; a.download = slug + '.ofrenda.json';
      this._root.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._say('Ofrenda exported.');
    }

    async _importFile(file) {
      if (file.size > 8 * 1024 * 1024) { this._say('That file is too large to be an ofrenda.'); return; }
      let data;
      try { data = JSON.parse(await file.text()); } catch { this._say('That file is not valid JSON.'); return; }
      if (!sanitize(data)) { this._say('That file is not a digital-ofrenda export.'); return; }
      // confirm() is blocked in some embeds, so ask on the Import button itself
      this._pendingImport = data;
      this._importBtn.textContent = 'Click to replace this ofrenda';
      this._say('File ready. Click Import again to replace this ofrenda with it.');
      clearTimeout(this._importTimer);
      this._importTimer = setTimeout(() => this._cancelImport('Import cancelled.'), 8000);
    }

    _cancelImport(msg) {
      clearTimeout(this._importTimer); this._importTimer = null;
      this._pendingImport = null;
      if (this._importBtn) this._importBtn.textContent = 'Import';
      if (msg) this._say(msg);
    }

    _say(msg) { if (this._status) this._status.textContent = msg; }

    // ---------- structure ----------
    _build() {
      this._root = this.attachShadow({ mode: 'open' });
      const colors = ['#ff4fa3', '#ff9a3c', '#2ec4b6', '#ffd23f', '#9b5de5', '#ff4fa3', '#ff9a3c', '#2ec4b6', '#ffd23f', '#9b5de5', '#ff4fa3', '#ff9a3c'];
      this._root.innerHTML = `
        <style>${css}</style>
        <div class="wrap">
          <fieldset class="kind">
            <legend>Type of ofrenda</legend>
            ${Object.entries(KINDS).map(([k, d]) => `<label><input type="radio" name="kind" value="${k}">${d.label}</label>`).join('')}
          </fieldset>
          <fieldset class="tiers">
            <legend>Number of tiers</legend>
            <label><input type="radio" name="tiers" value="3">3 tiers</label>
            <label><input type="radio" name="tiers" value="7"><span class="t7label">7 tiers</span></label>
          </fieldset>
          <header>
            <h2 class="name" data-placeholder=""></h2>
            <p class="dates" data-placeholder="Dates (e.g. 1948 – 2024)"></p>
          </header>
          <div class="stage" role="group" aria-label="Ofrenda altar">
            <div class="banner">${colors.map(c => `<i style="background:${c}"></i>`).join('')}</div>
            <div class="tierlayer"></div>
            <div class="items"></div>
          </div>
          <div class="tray">
            <h3>Drag an item onto the altar (or press Enter to add it). Drag items here to remove them.</h3>
            <div class="tray-items"></div>
            <p class="petnote" hidden></p>
            <div class="actions">
              <button type="button" class="photo-btn">Add photo</button>
              <button type="button" class="ghost-btn export-btn">Export</button>
              <button type="button" class="ghost-btn import-btn">Import</button>
              <button type="button" class="ghost-btn reset-btn">Start over</button>
              <input type="file" class="photo-input" accept="image/*" hidden>
              <input type="file" class="import-input" accept=".json,application/json" hidden>
              <span class="hint">Click a candle to light it. Click a photo frame to change its photo. Double-click a note to edit. With an item selected: arrows move it, + / − resize it, [ / ] rotate it (candles stay upright). Or drag the round handles.</span>
            </div>
          </div>
          <div class="status" role="status" aria-live="polite"></div>
        </div>`;

      const $ = s => this._root.querySelector(s);
      this._wrap = $('.wrap'); this._stage = $('.stage'); this._itemsEl = $('.items');
      this._tray = $('.tray'); this._status = $('.status'); this._file = $('.photo-input'); this._importEl = $('.import-input');
      this._nameEl = $('.name'); this._datesEl = $('.dates');
      this._kindEl = $('.kind'); this._petNote = $('.petnote'); this._trayItems = $('.tray-items');
      this._tiersEl = $('.tiers'); this._tierLayer = $('.tierlayer');
      this._tiersEl.addEventListener('change', e => {
        const n = Number(e.target.value);
        if (n === 7 && !this._sevenAllowed) {
          this.dispatchEvent(new CustomEvent('upgrade-request', { bubbles: true, composed: true, detail: { feature: 'sevenTiers' } }));
          this._say('The seven-tier altar is an upgrade.');
          this._render(); // snap the radio back
          return;
        }
        if (n !== 3 && n !== 7) return;
        this._state.tiers = n;
        this._save();
        this._render();
      });
      this._kindEl.addEventListener('change', e => {
        if (!KINDS[e.target.value]) return;
        this._state.kind = e.target.value;
        this._save();
        this._render();
      });

      $('.photo-btn').addEventListener('click', () => this._pickPhoto(null));
      $('.export-btn').addEventListener('click', () => this._download());
      this._importBtn = $('.import-btn');
      this._importBtn.addEventListener('click', () => {
        if (this._pendingImport) {
          const data = this._pendingImport;
          this._cancelImport();
          this.importState(data);
          this._say('Ofrenda imported.');
          return;
        }
        this._importEl.click();
      });
      this._importEl.addEventListener('change', () => {
        const f = this._importEl.files[0]; this._importEl.value = '';
        if (f) this._importFile(f);
      });
      const reset = $('.reset-btn');
      reset.addEventListener('click', () => {
        if (!this._confirmReset) {
          // confirm() is blocked in some embeds, so ask on the button itself
          this._confirmReset = setTimeout(() => { this._confirmReset = null; reset.textContent = 'Start over'; }, 4000);
          reset.textContent = 'Click again to clear everything';
          return;
        }
        clearTimeout(this._confirmReset); this._confirmReset = null; reset.textContent = 'Start over';
        this._state = defaultState(); this._save(); this._render();
      });
      this._file.addEventListener('change', () => {
        const f = this._file.files[0]; this._file.value = '';
        const target = this._photoTarget; this._photoTarget = null;
        if (f) this._setPhoto(f, target);
      });

      for (const [el, key] of [[this._nameEl, 'name'], [this._datesEl, 'dates']]) {
        el.addEventListener('input', () => { this._state[key] = el.textContent.trim().slice(0, 80); });
        el.addEventListener('blur', () => this._save());
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      }
    }

    _buildTray() {
      const kind = this._kind;
      this._trayItems.textContent = '';
      for (const [type, def] of Object.entries(ITEMS)) {
        if (!offered(type, kind)) continue;
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.type = type; b.title = def.label;
        b.innerHTML = `<b>${def.emoji}</b>${def.label}`;
        b.addEventListener('pointerdown', e => this._trayDown(e, type));
        b.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._add(type, 45 + Math.random() * 10, 45 + Math.random() * 10); }
        });
        this._trayItems.appendChild(b);
      }
      this._petNote.textContent = PET_NOTE;
      this._petNote.hidden = kind === 'person';
    }

    get _kind() { return KINDS[this._state.kind] ? this._state.kind : 'person'; }

    _render() {
      const edit = this._editable;
      const kind = this._kind;
      this._kindEl.hidden = !edit;
      this._tiersEl.hidden = !edit;
      const tiers = this._tiers, allowed = this._sevenAllowed;
      for (const r of this._tiersEl.querySelectorAll('input')) r.checked = Number(r.value) === tiers;
      this._tiersEl.querySelector('.t7label').textContent = allowed ? '7 tiers' : '7 tiers (upgrade)';
      this._tierLayer.textContent = '';
      TIERS[tiers].forEach(([top, width, color], i) => {
        const t = document.createElement('div');
        t.className = 'tier' + (tiers === 7 ? ' seven' : '');
        t.style.cssText = `top:${top}%;width:${width}%;background:${color};border-radius:6px 6px 0 0;z-index:0`;
        this._tierLayer.appendChild(t);
      });
      for (const r of this._kindEl.querySelectorAll('input')) r.checked = r.value === kind;
      this._nameEl.dataset.placeholder = KINDS[kind].placeholder;
      this._buildTray();
      this._wrap.classList.toggle('editing', edit);
      this._tray.hidden = !edit;
      for (const el of [this._nameEl, this._datesEl]) el.contentEditable = edit ? 'true' : 'false';
      this._nameEl.textContent = this._state.name;
      this._datesEl.textContent = this._state.dates;
      this._nameEl.hidden = !edit && !this._state.name;
      this._datesEl.hidden = !edit && !this._state.dates;

      this._itemsEl.textContent = '';
      for (const item of this._state.items) this._itemsEl.appendChild(this._makeEl(item));
    }

    // ---------- items ----------
    _makeEl(item) {
      const def = ITEMS[item.type];
      const el = document.createElement('div');
      el.className = 'item ' + item.type + (def.candle ? ' candle' : '') + (item.lit ? ' lit' : '');
      el.dataset.id = item.id;
      el.tabIndex = 0;
      el.setAttribute('role', 'img');

      if (item.type === 'photo') {
        const f = document.createElement('div'); f.className = 'frame';
        if (item.src) { const img = document.createElement('img'); img.src = item.src; img.alt = ''; f.appendChild(img); }
        else { const s = document.createElement('span'); s.textContent = this._editable ? 'Click to add a photo' : ''; f.appendChild(s); }
        el.appendChild(f);
      } else if (item.type === 'note') {
        const n = document.createElement('div'); n.className = 'note';
        const s = document.createElement('span'); s.textContent = item.text ?? DEFAULT_NOTE;
        n.appendChild(s); el.appendChild(n);
      } else if (item.type === 'papel') {
        const p = document.createElement('div'); p.className = 'papel';
        for (const c of ['#ff4fa3', '#ff9a3c', '#2ec4b6', '#ffd23f', '#9b5de5']) {
          const i = document.createElement('i'); i.style.background = c; p.appendChild(i);
        }
        el.appendChild(p);
      } else {
        const s = document.createElement('span'); s.className = 'emoji'; s.textContent = def.emoji; el.appendChild(s);
      }

      this._label(el, item);
      this._place(el, item);
      if (this._editable) {
        for (const kind of def.candle ? ['resize'] : ['resize', 'rotate']) {
          const hd = document.createElement('span');
          hd.className = 'handle ' + kind; hd.setAttribute('aria-hidden', 'true');
          hd.addEventListener('pointerdown', e => this._handleDown(e, el, item, kind));
          el.appendChild(hd);
        }
      }
      el.addEventListener('pointerdown', e => this._itemDown(e, el, item));
      el.addEventListener('keydown', e => this._itemKey(e, el, item));
      if (item.type === 'note') el.addEventListener('dblclick', () => this._editNote(el, item));
      return el;
    }

    _label(el, item) {
      const base = ITEMS[item.type].label;
      const extra = ITEMS[item.type].candle ? (item.lit ? ', lit' : ', unlit') : item.type === 'note' ? ': ' + (item.text ?? DEFAULT_NOTE) : '';
      el.setAttribute('aria-label', base + extra);
      el.title = base; // hover tooltip
    }

    _place(el, item) {
      el.style.left = item.x + '%';
      el.style.top = item.y + '%';
      const scale = item.scale ?? 1, rot = ITEMS[item.type].candle ? 0 : (item.rot ?? 0);
      el.style.setProperty('--s', scale);
      el.style.transform = scale === 1 && !rot ? '' : `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`;
      el.style.zIndex = Math.round(item.y * 10); // lower on the altar = in front
    }

    _add(type, x, y) {
      const item = { id: uid(), type, x: clamp(x, 4, 96), y: clamp(y, 12, 96) };
      if (ITEMS[type].candle) item.lit = true;
      if (type === 'note') item.text = DEFAULT_NOTE;
      this._state.items.push(item);
      const el = this._makeEl(item);
      this._itemsEl.appendChild(el);
      this._save();
      if (type === 'note') this._editNote(el, item);
    }

    _remove(item) {
      this._state.items = this._state.items.filter(i => i !== item);
      this._itemsEl.querySelector(`[data-id="${item.id}"]`)?.remove();
      this._save();
    }

    _over(elm, ev) {
      const r = elm.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    }

    _activate(el, item) {
      if (ITEMS[item.type].candle) {
        item.lit = !item.lit;
        el.classList.toggle('lit', item.lit);
        this._label(el, item);
        this._save();
      } else if (item.type === 'photo' && this._editable) {
        this._pickPhoto(item);
      }
    }

    // ---------- resize / rotate handles ----------
    // Both work from the item's centre: resize by distance from it, rotate by angle around it.
    _handleDown(e, el, item, kind) {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      el.focus({ preventScroll: true });
      const hd = e.currentTarget;
      const r = el.getBoundingClientRect(); // rotation about the centre leaves the bounding box centred
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
      const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
      const scale0 = item.scale ?? 1, rot0 = item.rot ?? 0;
      hd.setPointerCapture(e.pointerId);
      el.classList.add('adjusting');

      const move = ev => {
        if (kind === 'resize') {
          const v = clamp(scale0 * Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0, MIN_SCALE, MAX_SCALE);
          item.scale = Math.round(v * 100) / 100;
        } else {
          let deg = rot0 + (Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180 / Math.PI;
          deg = ev.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
          item.rot = ((deg % 360) + 540) % 360 - 180;
        }
        if (item.scale === 1) delete item.scale;
        if (item.rot === 0) delete item.rot;
        this._place(el, item);
      };
      const up = () => {
        hd.removeEventListener('pointermove', move);
        hd.removeEventListener('pointerup', up);
        hd.removeEventListener('pointercancel', up);
        el.classList.remove('adjusting');
        this._save();
      };
      hd.addEventListener('pointermove', move);
      hd.addEventListener('pointerup', up);
      hd.addEventListener('pointercancel', up);
    }

    // ---------- dragging items already on the altar ----------
    _itemDown(e, el, item) {
      if (e.button !== 0 || e.target.isContentEditable) return;
      const edit = this._editable;
      const sx = e.clientX, sy = e.clientY;
      const r0 = this._stage.getBoundingClientRect();
      const offX = item.x - (sx - r0.left) / r0.width * 100;
      const offY = item.y - (sy - r0.top) / r0.height * 100;
      let moved = false;
      el.setPointerCapture(e.pointerId);

      const move = ev => {
        if (!edit) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        el.classList.add('dragging');
        const r = this._stage.getBoundingClientRect();
        item.x = clamp((ev.clientX - r.left) / r.width * 100 + offX, 0, 100);
        item.y = clamp((ev.clientY - r.top) / r.height * 100 + offY, 0, 100);
        this._place(el, item);
        this._tray.classList.toggle('danger', this._over(this._tray, ev));
      };
      const up = ev => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        this._tray.classList.remove('danger');
        if (moved) {
          if (ev.type === 'pointerup' && this._over(this._tray, ev)) this._remove(item);
          else this._save();
        } else if (ev.type === 'pointerup') {
          this._activate(el, item);
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }

    _itemKey(e, el, item) {
      if (e.target !== el) return;
      const activate = e.key === 'Enter' || e.key === ' ';
      if (activate && (ITEMS[item.type].candle || (item.type === 'photo' && this._editable))) {
        e.preventDefault(); this._activate(el, item); return;
      }
      if (!this._editable) return;
      if (item.type === 'note' && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); this._editNote(el, item); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const next = el.nextElementSibling || el.previousElementSibling;
        this._remove(item);
        next?.focus();
        return;
      }
      const size = { '+': 1, '=': 1, '-': -1, '_': -1 }[e.key], turn = { ']': 1, '[': -1 }[e.key];
      if (size || (turn && !ITEMS[item.type].candle)) {
        e.preventDefault();
        if (size) item.scale = clamp(Math.round(((item.scale ?? 1) + size * (e.shiftKey ? 0.05 : 0.1)) * 100) / 100, MIN_SCALE, MAX_SCALE);
        else item.rot = ((Math.round((item.rot ?? 0) + turn * (e.shiftKey ? 5 : 15) + 540) % 360) + 360) % 360 - 180;
        if (item.scale === 1) delete item.scale;
        if (item.rot === 0) delete item.rot;
        this._place(el, item);
        this._save();
        return;
      }
      const step = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) {
        e.preventDefault();
        item.x = clamp(item.x + d[0], 0, 100);
        item.y = clamp(item.y + d[1], 0, 100);
        this._place(el, item);
        this._save();
      }
    }

    // ---------- dragging from the tray ----------
    _trayDown(e, type) {
      if (!this._editable || e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      const ghost = document.createElement('div');
      ghost.className = 'ghost';
      ghost.textContent = ITEMS[type].emoji;
      ghost.hidden = true;
      this._root.appendChild(ghost);
      const follow = ev => { ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; };

      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; ghost.hidden = false; follow(ev);
      };
      const up = ev => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        ghost.remove();
        if (ev.type !== 'pointerup') return;
        if (!moved) { this._add(type, 45 + Math.random() * 10, 45 + Math.random() * 10); return; }
        if (this._over(this._stage, ev)) {
          const r = this._stage.getBoundingClientRect();
          this._add(type, (ev.clientX - r.left) / r.width * 100, (ev.clientY - r.top) / r.height * 100);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }

    // ---------- notes & photo ----------
    _editNote(el, item) {
      if (!this._editable) return;
      const span = el.querySelector('.note span');
      span.contentEditable = 'true';
      span.focus();
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = this._root.getSelection ? this._root.getSelection() : window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);

      const finish = () => {
        span.removeEventListener('blur', finish);
        span.removeEventListener('keydown', key);
        span.contentEditable = 'false';
        item.text = span.textContent.trim().slice(0, 80) || DEFAULT_NOTE;
        span.textContent = item.text;
        this._label(el, item);
        this._save();
        el.focus();
      };
      const key = ev => {
        ev.stopPropagation();
        if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Escape') { ev.preventDefault(); span.blur(); }
      };
      span.addEventListener('blur', finish);
      span.addEventListener('keydown', key);
    }

    // item = the frame to fill; null = fill the first empty frame, or add a new one.
    _pickPhoto(item) {
      this._photoTarget = item;
      this._file.click();
    }

    async _setPhoto(file, item) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const src = c.toDataURL('image/jpeg', 0.82);
        const target = item && this._state.items.includes(item) ? item
          : this._state.items.find(i => i.type === 'photo' && !i.src);
        if (target) target.src = src;
        else this._state.items.push({ id: uid(), type: 'photo', x: clamp(30 + Math.random() * 40, 4, 96), y: clamp(25 + Math.random() * 35, 12, 96), src });
        this._save();
        this._render();
      } catch {
        this._say('That file could not be read as an image.');
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  if (!customElements.get('digital-ofrenda')) customElements.define('digital-ofrenda', DigitalOfrenda);
})();
