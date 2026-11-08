// Tiny DOM helpers. Everything is built with createElement and textContent, never innerHTML, so text that
// came from a person (an altar's name, an email address) can never turn into markup or script.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

export const mount = (root, ...nodes) => root.replaceChildren(...nodes.flat().filter(Boolean));

// Only same-site paths: a leading slash, plain characters, and no "//".
export const safePath = (v, fallback = '/my') => (typeof v === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(v) && !v.startsWith('//') ? v : fallback);

export function link(text, href, props = {}) {
  return h('a', { ...props, href: safePath(href, '/') }, text);
}

export const date = ms => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });

// The page frame: a header with the site name and the right links for who is looking.
export function frame(me, ...content) {
  const nav = h('nav', { 'aria-label': 'Account' },
    me ? [link('My ofrendas', '/my'), h('span', { class: 'who' }, me.email)] : [link('Sign in', '/signin')]);
  return [
    h('header', { class: 'top' }, link('Digital Ofrenda', '/', { class: 'brand' }), nav),
    h('main', { id: 'main' }, ...content),
  ];
}

// A message area that screen readers announce.
export function messages() {
  const box = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  return {
    el: box,
    say(text) { box.className = 'msg'; box.setAttribute('role', 'status'); box.textContent = text; },
    fail(text) { box.className = 'msg error'; box.setAttribute('role', 'alert'); box.textContent = text; },
    clear() { box.textContent = ''; },
  };
}

// A button that needs two clicks (no pop-up dialogs): the first asks, the second does it.
export function twoClick(label, confirmLabel, onConfirm, props = {}) {
  let armed = null;
  const btn = h('button', { type: 'button', ...props, class: (props.class || '') + ' danger' }, label);
  btn.addEventListener('click', async () => {
    if (!armed) {
      btn.textContent = confirmLabel;
      armed = setTimeout(() => { armed = null; btn.textContent = label; }, 6000);
      return;
    }
    clearTimeout(armed); armed = null; btn.textContent = label;
    btn.disabled = true;
    try { await onConfirm(); } finally { btn.disabled = false; }
  });
  return btn;
}

// Run an async action from a button, disabling it while it works.
export async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

export async function signOut() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* signed out locally anyway */ }
  location.href = '/';
}

// Remember a one-time token across the sign-in page without ever putting it in a URL.
export const pending = {
  save(kind, token) { try { sessionStorage.setItem('ofrenda:pending', JSON.stringify({ kind, token })); } catch { /* private mode */ } },
  take(kind) {
    try {
      const v = JSON.parse(sessionStorage.getItem('ofrenda:pending') || 'null');
      if (v && v.kind === kind && typeof v.token === 'string') return v.token;
    } catch { /* ignore */ }
    return null;
  },
  clear() { try { sessionStorage.removeItem('ofrenda:pending'); } catch { /* ignore */ } },
};
