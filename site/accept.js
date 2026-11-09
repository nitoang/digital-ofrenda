// Accepting an emailed invitation (/invite#i=...) or a successor request (/successor#s=...). The token comes
// in the link's # part, is kept only in this tab's session storage while the person signs in, and is removed
// from the address bar straight away.
import { api, getMe, describe } from './api.js';
import { h, mount, frame, messages, link, signOut, pending, busy } from './ui.js';

const root = document.getElementById('app');
const kind = location.pathname.startsWith('/successor') ? 'successor' : 'invite';
const hashToken = (new RegExp(`^#${kind === 'invite' ? 'i' : 's'}=([\\w-]{20,100})$`).exec(location.hash) || [])[1];
if (hashToken) { pending.save(kind, hashToken); history.replaceState(null, '', location.pathname); }
const token = hashToken || pending.take(kind);

// A link opened in the tab that is already on this page only changes the # part, so look again.
addEventListener('hashchange', () => location.reload());

const WORDS = {
  invite: {
    title: 'You have been invited to help keep an ofrenda',
    body: 'As a co-keeper you can add to it and change it together with the others. You cannot delete it or change who keeps it.',
    button: 'Accept the invitation',
    bad: 'This invitation has expired, was already used, or was sent to a different email address.',
  },
  successor: {
    title: 'You have been asked to be a successor',
    body: 'If the owner can no longer look after this ofrenda, you could take it over. When you agree, you can add to it right away as a co-keeper, but you cannot delete it. You could only ask to take it over after the owner has been away for about a year, and the owner is told first and can stop it by signing in.',
    button: 'Agree to be the successor',
    bad: 'This request has expired, was already answered, or was sent to a different email address.',
  },
}[kind];

(async () => {
  const msg = messages();
  if (!token) {
    mount(root, frame(null, h('h1', {}, 'This link is incomplete'), h('p', {}, 'Please open the link from your email again.'), msg.el));
    return;
  }
  let me = null;
  try { me = await getMe(); } catch (e) { mount(root, frame(null, h('p', { class: 'msg error', role: 'alert' }, describe(e)))); return; }
  if (!me) {
    location.replace('/signin?next=' + (kind === 'invite' ? '/invite' : '/successor'));
    return;
  }
  const accept = h('button', { type: 'button', class: 'primary' }, WORDS.button);
  accept.addEventListener('click', () => busy(accept, async () => {
    try {
      const { id } = await api('POST', kind === 'invite' ? '/invites/accept' : '/successor/accept', { token });
      pending.clear();
      mount(root, frame(me, h('h1', {}, kind === 'invite' ? 'You are now a co-keeper' : 'Thank you'),
        h('p', {}, kind === 'invite' ? 'You can open the ofrenda and start adding to it.' : 'You are this ofrenda’s successor, and a co-keeper, so you can open it and start adding to it.'),
        h('p', {}, link('Open the ofrenda', '/a/' + id, { class: 'button primary' }))));
    } catch (e) {
      msg.fail(e.status === 400 ? WORDS.bad : describe(e));
    }
  }));
  const other = h('button', { type: 'button' }, 'Sign out and use another account');
  other.addEventListener('click', async () => { await signOut(); });
  mount(root, frame(me, h('h1', {}, WORDS.title), h('p', {}, WORDS.body),
    h('p', { class: 'muted' }, 'You are signed in as ', h('strong', {}, me.email), '. This only works for the address it was sent to.'),
    h('p', {}, accept), msg.el, h('p', {}, other)));
})();
