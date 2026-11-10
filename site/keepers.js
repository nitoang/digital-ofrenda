import { api, getMe, describe, resolveRef } from './api.js';
import { h, mount, frame, messages, link, date, twoClick, busy } from './ui.js';

const root = document.getElementById('app');
const ref = (/^\/a\/([A-Za-z0-9_-]{1,64})\/keepers\/?$/.exec(location.pathname) || [])[1];
let id = null;

const NAME_ERRORS = {
  bad_name: 'Use 3 to 40 letters, numbers and single hyphens, like abuela-rosa.',
  name_taken: 'That name is already used. Try another.',
};
const INVITE_ERRORS = {
  already_member: 'That person already keeps this ofrenda.',
  already_invited: 'That person already has an invitation waiting.',
  too_many_keepers: 'An ofrenda can have up to 10 co-keepers, counting invitations.',
  too_many_invites: 'That address has been sent several invitations today. Please try again tomorrow.',
  bad_email: 'That email address does not look right.',
};
const SHARE_ERRORS = {
  ...INVITE_ERRORS,
  bad_access: 'Choose view only, or view and edit.',
  bad_note: 'That note could not be used. Please use plain text.',
  note_too_long: 'That note is too long. Please keep it under 280 characters.',
  note_has_link: 'Notes cannot contain web links.',
  too_many_shares: 'That address has been sent several links today. Please try again tomorrow.',
  share_limit: 'This ofrenda has sent a lot of links today. Please try again tomorrow.',
};
const SUCCESSOR_ERRORS = {
  bad_email: 'Enter a different email address (not your own).',
  too_soon: 'You just changed the successor. Please wait an hour before changing it again.',
  bad_wait: 'Choose 6 or 12 months.',
};
const HANDOVER_ERRORS = {
  bad_email: 'Enter a different email address (not your own).',
  confirm_required: 'Type the word handover to confirm.',
  already_owner: 'They already own this ofrenda.',
  handover_pending: 'A handover is already waiting. Cancel it first to choose someone else.',
  too_many_handovers: 'You can hand over up to 3 ofrendas a day. Please try again tomorrow.',
};

// "If I have not signed in for 12 or 6 months…" and "pass it on automatically". Used when naming a successor and when
// changing how it works. `read()` gives what the Worker expects.
function waitFields(prefix, saved) {
  const current = saved || { waitMonths: 12, auto: true };
  const month = (value, label) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: prefix + '-wait', value: String(value), checked: current.waitMonths === value }),
    h('span', {}, label));
  const auto = h('input', { type: 'checkbox', id: prefix + '-auto', checked: current.auto });
  const el = h('fieldset', { class: 'choices' },
    h('legend', {}, 'If you have not signed in for…'),
    month(12, '12 months (recommended)'), month(6, '6 months'),
    h('label', { class: 'check', for: prefix + '-auto' }, auto, h('span', {}, 'Pass it to them automatically')),
    h('p', { class: 'muted' }, 'We email you first, and 30 days later it passes to them unless you sign in. If you turn this off, it only passes if they ask, and you still have 30 days to stop it.'));
  return { el, read: () => ({ waitMonths: Number(el.querySelector('input[type="radio"]:checked').value), auto: auto.checked }) };
}
const describeWait = s => `If you are away ${s.waitMonths} months, you are emailed, and 30 days later ${s.auto ? 'it passes to them automatically' : 'they can ask to take it over, and you can stop it'} unless you sign in.`;

async function render(note) {
  id = id || await resolveRef(ref);
  if (!id) { mount(root, frame(null, h('h1', {}, 'Not found'))); return; }
  let me, team;
  try {
    me = await getMe();
    if (!me) { location.replace(`/signin?next=/a/${ref}/keepers`); return; }
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
    if (m.role === 'owner' && mine && team.members.filter(x => x.role === 'owner').length > 1) {
      li.append(twoClick('Step away', 'Click again to step away', async () => {
        msg.clear();
        try { await api('DELETE', `/ofrendas/${id}/members/${m.userId}`); location.href = '/my'; }
        catch (e) { msg.fail(describe(e)); }
      }, { 'aria-label': 'Stop being an owner of this ofrenda' }));
    }
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
    h('p', {}, link('← Back to the ofrenda', `/a/${ref}`)),
    msg.el, sections));
}

// What deleting does depends on who else is here.
function deleteNote(team) {
  const owners = team.members.filter(m => m.role === 'owner').length;
  if (owners > 1) return 'There is more than one owner, so this only removes you. The ofrenda stays with the other owners.';
  if (team.members.length > 1) return `Other people keep this ofrenda, so it is not erased. ${team.successor && team.successor.accepted ? 'It passes to your successor' : 'It passes to the people who keep it'}, and you stop being an owner. If they are already at the free limit, it is locked for them until they upgrade, but never deleted.`;
  return 'Nobody else keeps this ofrenda, so this removes it, and the link stops working. It cannot be undone.';
}

function ownerSections(team, msg, run) {
  // Sharing: the owner picks what the person can do. View only is the default, the safer choice.
  const email = h('input', { id: 'invite-email', type: 'email', autocomplete: 'off', required: true });
  const choice = (value, label, hint, checked, disabled = false) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'access', value, checked, disabled }),
    h('span', {}, h('strong', {}, label), h('span', { class: 'muted' }, ' — ' + hint)));
  const access = h('fieldset', { class: 'choices' },
    h('legend', {}, 'What can they do?'),
    choice('view', 'View only', 'we email them the link, and they can look but not change anything.', true),
    choice('edit', 'View and edit', team.locked ? 'not available while this ofrenda is locked. Upgrade to invite people to edit it.' : 'they are invited as a co-keeper, and can add to the ofrenda and change it.', false, team.locked));
  const note = h('textarea', { id: 'share-note', rows: 3, maxlength: 280, autocomplete: 'off' });
  const share = h('button', { type: 'submit', class: 'primary' }, 'Share');
  const shareForm = h('form', { novalidate: true, class: 'share-form' },
    h('label', { for: 'invite-email' }, 'Email address'), email,
    access,
    h('label', { for: 'share-note' }, 'A note to go with it (optional)'), note,
    h('p', { class: 'muted' }, 'Plain text, up to 280 characters, and no web links.'),
    share);
  shareForm.addEventListener('submit', ev => {
    ev.preventDefault();
    const level = shareForm.querySelector('input[name="access"]:checked').value;
    busy(share, () => run(async () => {
      await api('POST', `/ofrendas/${id}/share`, { email: email.value, access: level, note: note.value });
    }, level === 'edit' ? 'Invitation sent.' : 'Link sent.', SHARE_ERRORS));
  });
  const pending = team.invites.length ? h('ul', { class: 'plain' }, team.invites.map(i => h('li', {},
    h('span', { class: 'grow' }, i.email, h('span', { class: 'muted' }, ` — expires ${date(i.expiresAt)}`)),
    twoClick('Cancel', 'Click again to cancel', () => run(() => api('DELETE', `/ofrendas/${id}/invites/${i.id}`), 'Invitation cancelled.'), { 'aria-label': `Cancel the invitation to ${i.email}` })))) : null;

  const sEmail = h('input', { id: 'successor-email', type: 'email', autocomplete: 'off', required: true });
  const sSave = h('button', { type: 'submit' }, team.successor ? 'Change successor' : 'Name a successor');
  const sWait = waitFields('new-successor', team.successor);
  const sForm = h('form', { novalidate: true }, h('div', { class: 'row' }, h('label', { for: 'successor-email' }, 'Their email address'), sEmail), sWait.el, h('p', {}, sSave));
  sForm.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(sSave, () => run(() => api('PUT', `/ofrendas/${id}/successor`, { email: sEmail.value, ...sWait.read() }), 'We emailed them to ask. Nothing changes for them until they agree.', SUCCESSOR_ERRORS));
  });
  const status = team.successor
    ? h('p', {}, h('strong', {}, team.successor.email), team.successor.accepted ? ' has agreed to be your successor. ' : ' has been asked, and has not agreed yet. ', describeWait(team.successor))
    : h('p', { class: 'muted' }, 'You have not named a successor.');
  // Change how it works without asking the successor again.
  let settings = null;
  if (team.successor) {
    const cWait = waitFields('change-successor', team.successor);
    const cSave = h('button', { type: 'submit' }, 'Save');
    settings = h('details', {}, h('summary', {}, 'Change how this works'),
      h('form', { novalidate: true }, cWait.el, h('p', {}, cSave)));
    settings.querySelector('form').addEventListener('submit', ev => {
      ev.preventDefault();
      busy(cSave, () => run(() => api('PUT', `/ofrendas/${id}/successor/settings`, cWait.read()), 'Saved. Your successor was not emailed again.', SUCCESSOR_ERRORS));
    });
  }
  const claim = team.claim ? h('div', { class: 'card', role: 'alert' },
    h('p', {}, h('strong', {}, team.claim.auto ? 'We have not seen you in a while, so this ofrenda is about to pass to your successor.' : 'Your successor asked to take over this ofrenda.'), ` Ownership moves to them on ${date(team.claim.executesAt)}. Signing in again before then stops it, and so does the button below.`),
    h('p', {}, twoClick('Stop this request', 'Click again to stop it', () => run(() => api('DELETE', `/ofrendas/${id}/claim`), 'Stopped.')))) : null;

  // Handing the ofrenda to someone: they become an owner and you stay one.
  const hEmail = h('input', { id: 'handover-email', type: 'email', autocomplete: 'off', required: true });
  const hWord = h('input', { id: 'handover-word', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true });
  const hGo = h('button', { type: 'submit', class: 'danger' }, 'Hand this ofrenda over');
  const hForm = h('form', { novalidate: true },
    h('div', { class: 'card warn', role: 'note' },
      h('p', {}, h('strong', {}, 'This is a big step.')),
      h('p', {}, 'The person you choose becomes an owner of this ofrenda. They can edit it, invite and remove co-keepers, name a successor, and hand it on or delete it, and you cannot take that back. You stay an owner too, and owners cannot remove each other. It also counts as one of their ofrendas, and free accounts can have 3.')),
    h('label', { for: 'handover-email' }, 'Email address of the person to hand it to'), hEmail,
    h('label', { for: 'handover-word' }, 'To confirm, type the word handover'), hWord,
    h('p', {}, hGo));
  hForm.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(hGo, () => run(async () => {
      const r = await api('POST', `/ofrendas/${id}/handover`, { email: hEmail.value, confirm: hWord.value });
      return r;
    }, 'Handed over. They have been emailed.', {
      ...HANDOVER_ERRORS,
      recipient_at_limit: 'That person already owns as many ofrendas as a free account can. They need to upgrade before you can hand this one over.',
    }));
  });
  const waiting = team.handover ? h('div', { class: 'card', role: 'status' },
    h('p', {}, h('strong', {}, team.handover.email), ` has not signed in yet. The handover waits for them until ${date(team.handover.expiresAt)}, and happens when they sign in with that address. We remind them by email. If they never do, the ofrenda may go to someone who visits it often.`),
    h('p', {}, twoClick('Cancel the handover', 'Click again to cancel', () => run(() => api('DELETE', `/ofrendas/${id}/handover`), 'Handover cancelled.')))) : null;

  const nameInput = h('input', { id: 'vanity-name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, 'aria-describedby': 'vanity-help' });
  const nameSave = h('button', { type: 'submit' }, team.slug ? 'Change name' : 'Choose a name');
  const nameForm = h('form', { novalidate: true, class: 'row' }, h('label', { for: 'vanity-name' }, 'Name'), nameInput, nameSave);
  nameForm.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(nameSave, () => run(() => api('PUT', `/ofrendas/${id}/slug`, { slug: nameInput.value }), 'Saved. The link below now uses the new name.', NAME_ERRORS));
  });

  return [
    h('h2', {}, 'A name in the address'),
    h('p', { id: 'vanity-help', class: 'muted' }, 'Give this ofrenda an easy address like ', h('strong', {}, location.origin + '/a/abuela-rosa'), '. Letters, numbers and hyphens, 3 to 40 characters. The original link keeps working, and so do earlier names, so links you already shared never break. Anyone who guesses a name can view the ofrenda, so choose one only if you are happy for it to be easy to find.'),
    team.slug ? h('p', {}, 'Current name: ', link(location.origin + '/a/' + team.slug, '/a/' + team.slug)) : null,
    nameForm,
    h('h2', {}, 'Share this ofrenda'),
    h('p', { class: 'muted' }, 'Anyone who has the link can view this ofrenda, so a person you share it with can pass the link on. Only people you invite to view and edit can change it. They become co-keepers: they cannot delete the ofrenda or change who keeps it, and they must sign in with the email address you enter.'),
    shareForm, pending,
    h('h2', {}, 'Successor'),
    h('p', { class: 'muted' }, 'If you can no longer look after this ofrenda, your successor can take it over. Once they agree they can add to the ofrenda as a co-keeper, but they cannot delete it. If you have been away for a year (or six months, if you choose), you are emailed, and 30 days later it passes to them automatically unless you sign in. Signing in at any time stops it.'),
    status, claim, settings, sForm,
    team.successor ? h('p', {}, twoClick('Remove successor', 'Click again to remove', () => run(() => api('DELETE', `/ofrendas/${id}/successor`), 'Successor removed.'))) : null,
    h('h2', {}, 'Hand this ofrenda to someone'),
    waiting || hForm,
    h('h2', {}, 'Delete this ofrenda'),
    h('p', { class: 'muted' }, deleteNote(team)),
    h('p', {}, twoClick('Delete this ofrenda', team.members.length > 1 ? 'Click again to confirm' : 'Click again to delete it for good', async () => {
      try { await api('DELETE', `/ofrendas/${id}`); location.href = '/my'; } catch (e) { msg.fail(describe(e)); }
    })),
  ];
}

render();
