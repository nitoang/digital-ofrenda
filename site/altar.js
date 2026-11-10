import { api, getMe, describe, resolveRef } from './api.js';
import { h, mount, frame, messages, link } from './ui.js';
import { makeStorage } from './storage.js';
import { showUpgrade } from './upgrade.js';
import { purchaseReturn, waitUntil, WAITING, SLOW, CANCELLED } from './purchase.js';

const root = document.getElementById('app');
const ref = (/^\/a\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname) || [])[1];
let id = null; // the ofrenda's real id; the address may have used its vanity name instead

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
  id = await resolveRef(ref);
  if (!id) { mount(root, frame(null, h('h1', {}, 'Ofrenda not found'), h('p', {}, link('Go to the home page', '/')))); return; }
  const back = purchaseReturn();
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

  if (me && !(membership && membership.role === 'owner')) api('POST', `/ofrendas/${id}/visit`).catch(() => {}); // counts the day; see the privacy page
  const msg = messages();
  const Ofrenda = customElements.get('digital-ofrenda');
  Ofrenda.features = { sevenTiers: entitlements.sevenTiers === true, extraPhotos: entitlements.extraPhotos === true };
  Ofrenda.storage = makeStorage({
    canWrite: !!membership,
    onUpgrade: feature => showUpgrade(feature, { altarId: id, role: membership && membership.role }),
    onSignedOut: () => msg.fail('You have been signed out, so your latest changes were not saved. Sign in again in a new tab, then reload this page.'),
  });
  document.addEventListener('upgrade-request', e => showUpgrade(e.detail && e.detail.feature, { altarId: id, role: membership && membership.role }));

  const el = document.createElement('digital-ofrenda');
  el.id = id;
  el.setAttribute('mode', membership ? 'edit' : 'view');

  const tools = h('div', {}, shareBox(location.origin + '/a/' + ((membership && membership.slug) || id)),
    membership ? h('p', {}, link('Keepers and sharing', `/a/${(membership && membership.slug) || id}/keepers`, { class: 'button' }))
      : (me ? null : h('p', { class: 'muted' }, 'Do you keep this ofrenda? ', link('Sign in', '/signin?next=/a/' + id), '.')));
  const [header, main] = frame(me, tools, msg.el, el);
  main.classList.add('wide');
  mount(root, header, main);

  if (back && back.kind === 'cancelled') msg.say(CANCELLED);
  if (back && back.kind === 'success') {
    // The payment may reach the server a moment after the browser gets back; wait for it, then reload so the
    // editor starts with the upgrade switched on.
    if (entitlements[back.feature]) { msg.say('Your upgrade is ready.'); return; }
    msg.say(WAITING);
    const ok = await waitUntil(async () => (await api('GET', `/ofrendas/${id}/team`)).entitlements?.[back.feature] === true);
    if (ok) location.replace(location.pathname); else msg.fail(SLOW);
  }
})();
