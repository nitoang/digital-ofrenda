import { api, getMe, describe } from './api.js';
import { h, mount, frame, messages, link, date, signOut, busy } from './ui.js';
import { showUpgrade } from './upgrade.js';
import { accountSection } from './account.js';
import { purchaseReturn, waitUntil, WAITING, SLOW, CANCELLED } from './purchase.js';

const root = document.getElementById('app');

// An altar's name for lists. Its saved state is public, so no sign-in is needed to read it.
async function titleOf(id) {
  try {
    const res = await fetch('/ofrendas/' + encodeURIComponent(id), { cache: 'no-store' });
    if (res.ok) { const s = await res.json(); if (typeof s.name === 'string' && s.name.trim()) return s.name.trim(); }
  } catch { /* fall through */ }
  return 'Untitled ofrenda';
}

async function render(note) {
  let me;
  try { me = await getMe(); } catch (e) { mount(root, frame(null, h('p', { class: 'msg error', role: 'alert' }, describe(e)))); return; }
  if (!me) { location.replace('/signin?next=/my'); return; }
  const msg = messages();
  if (note) msg.say(note);
  const titles = await Promise.all([...me.altars, ...me.successorOf].map(a => titleOf(a.id)));
  const titleFor = new Map([...me.altars, ...me.successorOf].map((a, i) => [a.id, titles[i]]));

  const create = h('button', { type: 'button', class: 'primary' }, 'Start a new ofrenda');
  create.addEventListener('click', () => busy(create, async () => {
    msg.clear();
    try { const { id } = await api('POST', '/ofrendas'); location.href = '/a/' + id; }
    catch (e) {
      if (e.status === 402) { msg.fail(e.body.message || 'You have reached the free limit.'); showUpgrade('platinum'); }
      else msg.fail(describe(e));
    }
  }));

  const mine = me.altars.length
    ? h('ul', { class: 'plain' }, me.altars.map(a => h('li', {},
        h('span', { class: 'grow' }, h('strong', {}, titleFor.get(a.id)), h('span', { class: 'badge' }, a.role === 'owner' ? 'Owner' : 'Co-keeper')),
        h('span', { class: 'actions' }, link('Open', '/a/' + a.id, { class: 'button' }), link('Keepers', '/a/' + a.id + '/keepers', { class: 'button' })))))
    : h('p', { class: 'muted' }, 'You do not have any ofrendas yet.');

  const heirs = me.successorOf.length ? [
    h('h2', {}, 'Ofrendas you agreed to look after'),
    h('p', { class: 'muted' }, 'You can only take one over after its owner has been away for a long time, and the owner is told first.'),
    h('ul', { class: 'plain' }, me.successorOf.map(a => heirRow(a, titleFor.get(a.id), msg, render))),
  ] : [];

  mount(root, frame(me,
    h('h1', {}, 'My ofrendas', me.plan === 'platinum' ? h('span', { class: 'badge' }, 'Platinum') : null),
    h('p', {}, create), msg.el, mine, heirs,
    h('p', { class: 'actions' }, signOutButton(false), signOutButton(true)),
    accountSection(me, text => render(text))));
}

function signOutButton(everywhere) {
  const b = h('button', { type: 'button' }, everywhere ? 'Sign out on all devices' : 'Sign out');
  b.addEventListener('click', async () => {
    if (!everywhere) return signOut();
    try { await api('POST', '/auth/logout-all'); } catch { /* the cookie is gone either way */ }
    location.href = '/';
  });
  return b;
}

function heirRow(a, title, msg, refresh) {
  const act = async (fn, okText) => { msg.clear(); try { await fn(); await refresh(okText); } catch (e) { msg.fail(explain(e)); } };
  const row = h('li', {}, h('span', { class: 'grow' }, h('strong', {}, title)));
  const actions = h('span', { class: 'actions' });
  if (!a.claim) {
    const ask = h('button', { type: 'button' }, 'Ask to take over');
    ask.addEventListener('click', () => busy(ask, () => act(() => api('POST', `/ofrendas/${a.id}/claim`), 'Request sent. The owner has been told.')));
    actions.append(ask);
  } else {
    row.querySelector('.grow').append(h('div', { class: 'muted' }, `Requested. Ownership can move to you on ${date(a.claim.executesAt)}, unless the owner signs in before then.`));
    const finish = h('button', { type: 'button', class: 'primary' }, 'Complete the handover');
    finish.addEventListener('click', () => busy(finish, () => act(() => api('POST', `/ofrendas/${a.id}/claim/complete`), 'Done. You are now the owner.')));
    const withdraw = h('button', { type: 'button' }, 'Withdraw');
    withdraw.addEventListener('click', () => busy(withdraw, () => act(() => api('DELETE', `/ofrendas/${a.id}/claim`), 'Request withdrawn.')));
    actions.append(finish, withdraw);
  }
  row.append(actions);
  return row;
}

function explain(e) {
  const b = e.body || {};
  if (e.status === 403 && b.error === 'owner_active') return `You can ask to take over after ${date(b.eligibleAt)}, if the owner has not been active by then.`;
  if (e.status === 403 && b.error === 'too_early') return `It is not time yet. The handover can be completed on ${date(b.executesAt)}.`;
  if (e.status === 409) return 'That request is no longer active. The owner may have signed in.';
  return describe(e);
}

(async () => {
  const back = purchaseReturn();
  await render(back && back.kind === 'cancelled' ? CANCELLED : back && back.kind === 'success' ? WAITING : undefined);
  if (back && back.kind === 'success') {
    const ok = await waitUntil(async () => (await getMe())?.plan === 'platinum');
    await render(ok ? 'Thank you! You now have Platinum.' : SLOW);
  }
})();
