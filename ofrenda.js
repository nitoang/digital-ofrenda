/*!
 * <digital-ofrenda> — an interactive, drag-and-drop remembrance altar.
 * Phase 1 prototype: no dependencies, saves to the visitor's browser (localStorage).
 *
 * Usage:
 *   <script src="ofrenda.js"></script>
 *   <digital-ofrenda id="maria" mode="edit"></digital-ofrenda>
 *
 * Attributes:
 *   id    unique key used for saving (one per ofrenda)
 *   mode  "edit" (drag, drop, personalize) or "view" (default; visitors can light candles)
 *
 * Events:
 *   ofrenda-change  fired after every saved change, detail = the full state object
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
    dog:      { emoji: '🐕', label: 'Loyal companion' },
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
    liquor:   { emoji: '🥃', label: 'Tequila / mezcal / scotch' },
    beer:     { emoji: '🍺', label: 'Beer' },
    cigs:     { emoji: '🚬', label: 'Cigarettes' },
    guitar:   { emoji: '🎸', label: 'Guitar / pick' },
    domino:   { emoji: '🎲', label: 'Dominoes / games' },
    jersey:   { emoji: '👕', label: 'Soccer jersey' },
    cleats:   { emoji: '⚽', label: 'Cleats / ball' },
    toy:      { emoji: '🧸', label: 'Toy (for children)' },
    bowl:     { emoji: '🥣', label: 'Pet water bowl' },
    kibble:   { emoji: '🦴', label: 'Pet treat / kibble' },
    collar:   { emoji: '🏷️', label: 'Collar / tag' },
    xolo:     { emoji: '🐕‍🦺', label: 'Xoloitzcuintli guide' },
  };

  const DEFAULT_NOTE = 'Siempre en nuestro corazón';
  const PHOTO_MAX_PX = 480;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const uid = () => Math.random().toString(36).slice(2, 10);

  const defaultState = () => ({
    name: '',
    dates: '',
    photo: null,
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
    .t1 { top: 14%; width: 52%; height: 100%; background: #e0742e; border-radius: 6px 6px 0 0; }
    .t2 { top: 42%; width: 78%; height: 100%; background: #c2417f; border-radius: 6px 6px 0 0; }
    .t3 { top: 66%; width: 100%; height: 100%; background: #6c3bb0; border-radius: 6px 6px 0 0; }
    .tier::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 5px; background: rgba(255,255,255,.25); border-radius: inherit; }

    .item { position: absolute; transform: translate(-50%, -50%); line-height: 1; cursor: default; border-radius: 8px; }
    .item:focus-visible { outline: 3px solid #ffd45c; outline-offset: 3px; }
    .editing .item { cursor: grab; touch-action: none; }
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
    static get observedAttributes() { return ['mode']; }

    connectedCallback() {
      this._key = 'ofrenda:' + (this.id || 'default');
      this._state = this._load() || defaultState();
      this._build();
      this._render();
    }

    attributeChangedCallback() {
      if (this._root) this._render();
    }

    get _editable() { return this.getAttribute('mode') === 'edit'; }

    // ---------- storage ----------
    _load() {
      try {
        const raw = localStorage.getItem(this._key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }

    _save() {
      try {
        localStorage.setItem(this._key, JSON.stringify(this._state));
        this._say('');
      } catch {
        this._say('Could not save — browser storage is full or blocked.');
      }
      this.dispatchEvent(new CustomEvent('ofrenda-change', { detail: this._state, bubbles: true }));
    }

    _say(msg) { if (this._status) this._status.textContent = msg; }

    // ---------- structure ----------
    _build() {
      this._root = this.attachShadow({ mode: 'open' });
      const colors = ['#ff4fa3', '#ff9a3c', '#2ec4b6', '#ffd23f', '#9b5de5', '#ff4fa3', '#ff9a3c', '#2ec4b6', '#ffd23f', '#9b5de5', '#ff4fa3', '#ff9a3c'];
      this._root.innerHTML = `
        <style>${css}</style>
        <div class="wrap">
          <header>
            <h2 class="name" data-placeholder="Name of your loved one"></h2>
            <p class="dates" data-placeholder="Dates (e.g. 1948 – 2024)"></p>
          </header>
          <div class="stage" role="group" aria-label="Ofrenda altar">
            <div class="banner">${colors.map(c => `<i style="background:${c}"></i>`).join('')}</div>
            <div class="tier t1"></div><div class="tier t2"></div><div class="tier t3"></div>
            <div class="items"></div>
          </div>
          <div class="tray">
            <h3>Drag an item onto the altar (or press Enter to add it). Drag items here to remove them.</h3>
            <div class="tray-items"></div>
            <div class="actions">
              <button type="button" class="photo-btn">Add photo</button>
              <button type="button" class="ghost-btn reset-btn">Start over</button>
              <input type="file" accept="image/*" hidden>
              <span class="hint">Click a candle to light it. Double-click a note to edit.</span>
            </div>
          </div>
          <div class="status" role="status" aria-live="polite"></div>
        </div>`;

      const $ = s => this._root.querySelector(s);
      this._wrap = $('.wrap'); this._stage = $('.stage'); this._itemsEl = $('.items');
      this._tray = $('.tray'); this._status = $('.status'); this._file = $('input[type=file]');
      this._nameEl = $('.name'); this._datesEl = $('.dates');

      const trayItems = $('.tray-items');
      for (const [type, def] of Object.entries(ITEMS)) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.type = type;
        b.innerHTML = `<b>${def.emoji}</b>${def.label}`;
        b.addEventListener('pointerdown', e => this._trayDown(e, type));
        b.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._add(type, 45 + Math.random() * 10, 45 + Math.random() * 10); }
        });
        trayItems.appendChild(b);
      }

      $('.photo-btn').addEventListener('click', () => this._file.click());
      $('.reset-btn').addEventListener('click', () => {
        if (confirm('Clear this ofrenda and start over?')) { this._state = defaultState(); this._save(); this._render(); }
      });
      this._file.addEventListener('change', () => {
        const f = this._file.files[0]; this._file.value = '';
        if (f) this._setPhoto(f);
      });

      for (const [el, key] of [[this._nameEl, 'name'], [this._datesEl, 'dates']]) {
        el.addEventListener('input', () => { this._state[key] = el.textContent.trim().slice(0, 80); });
        el.addEventListener('blur', () => this._save());
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      }
    }

    _render() {
      const edit = this._editable;
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
        if (this._state.photo) { const img = document.createElement('img'); img.src = this._state.photo; img.alt = ''; f.appendChild(img); }
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
      el.addEventListener('pointerdown', e => this._itemDown(e, el, item));
      el.addEventListener('keydown', e => this._itemKey(e, el, item));
      if (item.type === 'note') el.addEventListener('dblclick', () => this._editNote(el, item));
      return el;
    }

    _label(el, item) {
      const base = ITEMS[item.type].label;
      const extra = ITEMS[item.type].candle ? (item.lit ? ', lit' : ', unlit') : item.type === 'note' ? ': ' + (item.text ?? DEFAULT_NOTE) : '';
      el.setAttribute('aria-label', base + extra);
    }

    _place(el, item) {
      el.style.left = item.x + '%';
      el.style.top = item.y + '%';
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
        this._file.click();
      }
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

    async _setPhoto(file) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        this._state.photo = c.toDataURL('image/jpeg', 0.82);
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
