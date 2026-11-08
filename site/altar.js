import { api, getMe, describe } from './api.js';
import { h, mount, frame, messages, link } from './ui.js';
import { makeStorage } from './storage.js';
import { showUpgrade } from './upgrade.js';

const root = document.getElementById('app');
const id = (/^\/a\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname) || [])[1];

function shareBox(url) {
  const input = h('input', { id: 'share-url', type: 'url', readonly: true, value: url, 'aria-label': 'Link to view this ofrenda' });
  const copy = h('button', { type: 'button' }, 'Copy link');
  const note = h('span', { class: 'muted', role: 'status' });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); note.textContent = 'Link copied.'; }
    catch { input.select(); note.textContent = 'Press Ctrl+C (or ⌘C) to copy.'; }
  });
  return h('div', { class: 'row share' }, h('label', { for: 'share-url' }, 'Anyone with this link can view:'), input, copy, note);
}

(async () => {
  if (!id) { mount(root, frame(null, h('h1', {}, 'Ofrenda not found'), h('p', {}, link('Go to the home page', '/')))); return; }
  let me;
  try { me = await getMe(); } catch (e) { mount(root, frame(null, h('p', { class: 'msg error', role: 'alert' }, describe(e)))); return; }

  const membership = me && me.altars.find(a => a.id === id);
  let entitlements = {};
  if (membership) { try { entitlements = (await api('GET', `/ofrendas/${id}/team`)).entitlements || {}; } catch { /* the server still enforces the limits */ } }

  // Someone who does not keep it, looking at one that has never been saved.
  if (!membership) {
    let exists = false;
    try { exists = (await fetch('/ofrendas/' + encodeURIComponent(id), { cache: 'no-store' })).ok; } catch { /* treated as missing */ }
    if (!exists) {
      mount(root, frame(me, h('h1', {}, 'This ofrenda is not ready yet'),
        h('p', {}, 'Nothing has been saved here yet. If it is yours, sign in to keep working on it.'),
        me ? null : h('p', {}, link('Sign in', '/signin?next=/a/' + id, { class: 'button primary' }))));
      return;
    }
  }

  const msg = messages();
  const Ofrenda = customElements.get('digital-ofrenda');
  Ofrenda.features = { sevenTiers: entitlements.sevenTiers === true, extraPhotos: entitlements.extraPhotos === true };
  Ofrenda.storage = makeStorage({
    canWrite: !!membership,
    onUpgrade: showUpgrade,
    onSignedOut: () => msg.fail('You have been signed out, so your latest changes were not saved. Sign in again in a new tab, then reload this page.'),
  });
  document.addEventListener('upgrade-request', e => showUpgrade(e.detail && e.detail.feature));

  const el = document.createElement('digital-ofrenda');
  el.id = id;
  el.setAttribute('mode', membership ? 'edit' : 'view');

  const tools = h('div', {}, shareBox(location.origin + '/a/' + id),
    membership ? h('p', {}, link('Keepers and sharing', `/a/${id}/keepers`, { class: 'button' }))
      : (me ? null : h('p', { class: 'muted' }, 'Do you keep this ofrenda? ', link('Sign in', '/signin?next=/a/' + id), '.')));
  const [header, main] = frame(me, tools, msg.el, el);
  main.classList.add('wide');
  mount(root, header, main);
})();
