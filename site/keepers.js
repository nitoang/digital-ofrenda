import { api, getMe, describe } from './api.js';
import { h, mount, frame, messages, link, date, twoClick, busy } from './ui.js';

const root = document.getElementById('app');
const id = (/^\/a\/([A-Za-z0-9_-]{1,64})\/keepers\/?$/.exec(location.pathname) || [])[1];

const INVITE_ERRORS = {
  already_member: 'That person already keeps this ofrenda.',
  already_invited: 'That person already has an invitation waiting.',
  too_many_keepers: 'An ofrenda can have up to 10 co-keepers, counting invitations.',
  too_many_invites: 'That address has been sent several invitations today. Please try again tomorrow.',
  bad_email: 'That email address does not look right.',
};
const SUCCESSOR_ERRORS = {
  bad_email: 'Enter a different email address (not your own).',
  too_soon: 'You just changed the successor. Please wait an hour before changing it again.',
};

async function render(note) {
  if (!id) { mount(root, frame(null, h('h1', {}, 'Not found'))); return; }
  let me, team;
  try {
    me = await getMe();
    if (!me) { location.replace(`/signin?next=/a/${id}/keepers`); return; }
    team = await api('GET', `/ofrendas/${id}/team`);
  } catch (e) {
    mount(root, frame(me || null, h('h1', {}, 'Keepers'), h('p', { class: 'msg error', role: 'alert' },
      e.status === 403 ? 'You do not keep this ofrenda.' : describe(e)), h('p', {}, link('My ofrendas', '/my'))));
    return;
  }
  const owner = team.role === 'owner';
  const msg = messages();
  if (note) msg.say(note);
  const again = text => render(text);
  const run = async (fn, okText, errors = {}) => {
    msg.clear();
    try { await fn(); await again(okText); }
    catch (e) { msg.fail(errors[e.body && e.body.error] || describe(e)); }
  };

  const people = h('ul', { class: 'plain' }, team.members.map(m => {
    const mine = m.userId === me.id;
    const li = h('li', {}, h('span', { class: 'grow' }, m.email, h('span', { class: 'badge' }, m.role === 'owner' ? 'Owner' : 'Co-keeper'), mine ? h('span', { class: 'muted' }, ' (you)') : null));
    if (m.role === 'keeper' && (owner || mine)) {
      li.append(twoClick(mine ? 'Leave' : 'Remove', mine ? 'Click again to leave' : 'Click again to remove', async () => {
        msg.clear();
        try { await api('DELETE', `/ofrendas/${id}/members/${m.userId}`); if (mine) location.href = '/my'; else await again('Removed.'); }
        catch (e) { msg.fail(describe(e)); }
      }, { 'aria-label': `${mine ? 'Leave' : 'Remove'} ${m.email}` }));
    }
    return li;
  }));

  const sections = [h('h2', {}, 'Who keeps this ofrenda'), people];
  if (owner) sections.push(...ownerSections(team, msg, run));
  else sections.push(h('p', { class: 'muted' }, 'Only the owner can invite people, choose a successor, or delete the ofrenda.'));

  mount(root, frame(me,
    h('h1', {}, 'Keepers'),
    h('p', {}, link('← Back to the ofrenda', `/a/${id}`)),
    msg.el, sections));
}

function ownerSections(team, msg, run) {
  const email = h('input', { id: 'invite-email', type: 'email', autocomplete: 'off', required: true });
  const invite = h('button', { type: 'submit', class: 'primary' }, 'Send invitation');
  const inviteForm = h('form', { novalidate: true, class: 'row' }, h('label', { for: 'invite-email' }, 'Email address'), email, invite);
  inviteForm.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(invite, () => run(() => api('POST', `/ofrendas/${id}/invites`, { email: email.value }), 'Invitation sent.', INVITE_ERRORS));
  });
  const pending = team.invites.length ? h('ul', { class: 'plain' }, team.invites.map(i => h('li', {},
    h('span', { class: 'grow' }, i.email, h('span', { class: 'muted' }, ` — expires ${date(i.expiresAt)}`)),
    twoClick('Cancel', 'Click again to cancel', () => run(() => api('DELETE', `/ofrendas/${id}/invites/${i.id}`), 'Invitation cancelled.'), { 'aria-label': `Cancel the invitation to ${i.email}` })))) : null;

  const sEmail = h('input', { id: 'successor-email', type: 'email', autocomplete: 'off', required: true });
  const sSave = h('button', { type: 'submit' }, team.successor ? 'Change successor' : 'Name a successor');
  const sForm = h('form', { novalidate: true, class: 'row' }, h('label', { for: 'successor-email' }, 'Their email address'), sEmail, sSave);
  sForm.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(sSave, () => run(() => api('PUT', `/ofrendas/${id}/successor`, { email: sEmail.value }), 'We emailed them to ask. Nothing changes for them until they agree.', SUCCESSOR_ERRORS));
  });
  const status = team.successor
    ? h('p', {}, h('strong', {}, team.successor.email), team.successor.accepted ? ' has agreed to be your successor.' : ' has been asked, and has not agreed yet.')
    : h('p', { class: 'muted' }, 'You have not named a successor.');
  const claim = team.claim ? h('div', { class: 'card', role: 'alert' },
    h('p', {}, h('strong', {}, 'Your successor asked to take over this ofrenda.'), ` Ownership moves to them on ${date(team.claim.executesAt)}. Signing in again before then stops it, and so does the button below.`),
    h('p', {}, twoClick('Stop this request', 'Click again to stop it', () => run(() => api('DELETE', `/ofrendas/${id}/claim`), 'Stopped.')))) : null;

  return [
    h('h2', {}, 'Invite a co-keeper'),
    h('p', { class: 'muted' }, 'Co-keepers can add to the ofrenda and change it. They cannot delete it or change who keeps it.'),
    inviteForm, pending,
    h('h2', {}, 'Successor'),
    h('p', { class: 'muted' }, 'If you can no longer look after this ofrenda, your successor can take it over. They get no access now, and can only ask after you have been away for about six months. You are told first and can stop it by signing in.'),
    status, claim, sForm,
    team.successor ? h('p', {}, twoClick('Remove successor', 'Click again to remove', () => run(() => api('DELETE', `/ofrendas/${id}/successor`), 'Successor removed.'))) : null,
    h('h2', {}, 'Delete this ofrenda'),
    h('p', { class: 'muted' }, 'This removes it for everyone who keeps it, and the link stops working. It cannot be undone.'),
    h('p', {}, twoClick('Delete this ofrenda', 'Click again to delete it for good', async () => {
      try { await api('DELETE', `/ofrendas/${id}`); location.href = '/my'; } catch (e) { msg.fail(describe(e)); }
    })),
  ];
}

render();
