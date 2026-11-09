// "Your account" on the My ofrendas page: change the email address, and delete the account.
import { api, describe } from './api.js';
import { h, messages, busy } from './ui.js';

// onChanged(text) is called after the email address changes, so the page can show the new one.
export function accountSection(me, onChanged) {
  return [h('h2', {}, 'Your account'), changeEmail(me, onChanged), deleteAccount(me)];
}

function changeEmail(me, onChanged) {
  const msg = messages();
  const box = h('div', { class: 'card' });

  function askAddress(prefill = '') {
    const email = h('input', { id: 'new-email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true, value: prefill });
    const send = h('button', { type: 'submit' }, 'Email me a code');
    const form = h('form', { novalidate: true },
      h('h3', {}, 'Change your email address'),
      h('p', { class: 'muted' }, 'You are signed in as ', h('strong', {}, me.email), '. We will send a code to the new address to make sure it is yours. Nothing changes until you enter it, and your ofrendas stay with you.'),
      h('label', { for: 'new-email' }, 'New email address'), email, h('p', {}, send), msg.el);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      busy(send, async () => {
        msg.clear();
        if (!email.value.includes('@')) { msg.fail('Enter the new email address.'); email.focus(); return; }
        try { const r = await api('POST', '/me/email', { email: email.value }); askCode(r.email); }
        catch (e) { msg.fail(e.status === 400 && e.body.message ? e.body.message : describe(e)); }
      });
    });
    box.replaceChildren(form);
  }

  function askCode(address) {
    const code = h('input', { id: 'email-code', class: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });
    const confirm = h('button', { type: 'submit', class: 'primary' }, 'Change my email');
    const back = h('button', { type: 'button' }, 'Use a different address');
    const form = h('form', { novalidate: true },
      h('h3', {}, 'Enter the code'),
      h('p', {}, 'We sent a 6-digit code to ', h('strong', {}, address), '. It works for 15 minutes.'),
      h('label', { for: 'email-code' }, 'Code'), code, h('p', {}, confirm, ' ', back), msg.el);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      busy(confirm, async () => {
        msg.clear();
        try { const r = await api('POST', '/me/email/confirm', { code: code.value.trim() }); onChanged(`Your email address is now ${r.email}. You were signed out on your other devices.`); }
        catch (e) {
          msg.fail(e.status === 409 ? e.body.message : e.status === 400 ? 'That code did not work. It may have expired. Go back to ask for a new one.' : describe(e));
          code.select();
        }
      });
    });
    back.addEventListener('click', () => { msg.clear(); askAddress(address); });
    box.replaceChildren(form);
    code.focus();
  }

  askAddress();
  return box;
}

function deleteAccount(me) {
  const msg = messages();
  const email = h('input', { id: 'confirm-email', type: 'email', autocomplete: 'off', required: true });
  const also = h('input', { id: 'also-ofrendas', type: 'checkbox' });
  const alsoRow = h('p', { hidden: true }, h('label', { class: 'check', for: 'also-ofrendas' }, also, ' Yes, delete my ofrendas too'));
  const go = h('button', { type: 'submit', class: 'danger' }, 'Delete my account');
  const form = h('form', { novalidate: true },
    h('h3', {}, 'Delete your account'),
    h('p', { class: 'muted' }, 'This removes your account, your sign-in records, and your place on other people’s ofrendas. It cannot be undone. If you have Platinum or upgrades, they go with it, and we cannot move them to another account.'),
    h('label', { for: 'confirm-email' }, 'To confirm, type your email address (', h('strong', {}, me.email), ')'), email, alsoRow, h('p', {}, go), msg.el);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(go, async () => {
      msg.clear();
      try {
        await api('DELETE', '/me', { email: email.value, deleteOfrendas: also.checked });
        location.href = '/deleted';
      } catch (e) {
        if (e.status === 409 && e.body.error === 'owns_ofrendas') {
          alsoRow.hidden = false;
          const n = e.body.owned, others = e.body.sharedWith;
          msg.fail(`You own ${n} ${n === 1 ? 'ofrenda' : 'ofrendas'}${others ? `, and ${others} ${others === 1 ? 'other person helps' : 'other people help'} keep ${n === 1 ? 'it' : 'them'}` : ''}. Deleting your account deletes ${n === 1 ? 'it' : 'them'} for good. Tick the box to go ahead, or hand over ownership first.`);
        } else msg.fail(e.status === 400 && e.body.message ? e.body.message : describe(e));
      }
    });
  });
  return h('div', { class: 'card' }, form);
}
