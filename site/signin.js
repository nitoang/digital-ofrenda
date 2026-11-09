import { api, getMe, describe } from './api.js';
import { h, mount, frame, messages, safePath, busy } from './ui.js';
import { turnstile } from './turnstile.js';

const root = document.getElementById('app');
const next = safePath(new URLSearchParams(location.search).get('next'));
const linkToken = (/^#t=([\w-]{20,100})$/.exec(location.hash) || [])[1];

function done() { location.replace(next); }

// The emailed link: a button, so that mail scanners that merely open links cannot use it up.
function showLink(token) {
  history.replaceState(null, '', location.pathname + location.search);
  const msg = messages();
  const go = h('button', { type: 'button', class: 'primary' }, 'Continue to sign in');
  go.addEventListener('click', () => busy(go, async () => {
    try { await api('POST', '/auth/redeem', { token }); done(); }
    catch (e) { msg.fail(e.status === 400 ? 'This link has expired or was already used. Please ask for a new link.' : describe(e)); }
  }));
  mount(root, frame(null, h('h1', {}, 'Sign in'), h('p', {}, 'You are almost there.'), h('p', {}, go), msg.el,
    h('p', {}, h('a', { href: '/signin' }, 'Ask for a new link'))));
}

function showEmail(prefill = '') {
  const msg = messages();
  const ts = turnstile();
  const email = h('input', { id: 'email', type: 'email', name: 'email', autocomplete: 'email', required: true, value: prefill, inputmode: 'email' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Continue');
  const choice = (value, label, hint, checked) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'method', value, checked }),
    h('span', {}, h('strong', {}, label), h('span', { class: 'muted' }, ' — ' + hint)));
  const how = h('fieldset', { class: 'choices' },
    h('legend', {}, 'How would you like to sign in?'),
    choice('link', 'Email me a link', 'one tap in the email signs you in.', true),
    choice('code', 'Email me a 6-digit code', 'you type it in here. Handy if you read email on another device.', false));
  const form = h('form', { novalidate: true },
    h('label', { for: 'email' }, 'Your email address'), email, how, ts.el, h('p', {}, submit), msg.el);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(submit, async () => {
      msg.clear();
      if (!email.value.includes('@')) { msg.fail('Enter your email address.'); email.focus(); return; }
      try {
        const method = form.querySelector('input[name="method"]:checked').value;
        const { challenge } = await api('POST', '/auth/start', { email: email.value, method, turnstile: ts.token() });
        ts.reset();
        if (method === 'link') showSent(email.value.trim()); else showCode(email.value.trim(), challenge);
      } catch (e) {
        ts.reset();
        msg.fail(e.status === 403 ? 'The human check did not pass. Please try again.' : e.status === 400 ? 'That email address does not look right.' : describe(e));
      }
    });
  });
  mount(root, frame(null,
    h('h1', {}, 'Sign in or start an ofrenda'),
    h('p', { class: 'lead' }, 'No password to remember. Tell us where to send your way in.'),
    form));
  email.focus();
}

// They chose the link: nothing to type here. The link opens this page and asks for one press.
function showSent(address) {
  const again = h('button', { type: 'button' }, 'Use a different email');
  again.addEventListener('click', () => showEmail(address));
  mount(root, frame(null, h('h1', {}, 'Check your email'),
    h('p', { id: 'sent', tabindex: '-1' }, 'We sent a sign-in link to ', h('strong', {}, address), '. It works once and expires in 15 minutes.'),
    h('p', { class: 'muted' }, 'Nothing arrived? Check your spam folder. You can ask for up to 5 an hour.'),
    h('p', {}, again)));
  document.getElementById('sent').focus();
}

function showCode(address, challenge) {
  const msg = messages();
  const code = h('input', { id: 'code', class: 'code', type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true, 'aria-describedby': 'sent' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const again = h('button', { type: 'button' }, 'Use a different email');
  const form = h('form', { novalidate: true },
    h('p', { id: 'sent', tabindex: '-1' }, 'We sent a 6-digit code to ', h('strong', {}, address), '. It works once and expires in 15 minutes.'),
    h('label', { for: 'code' }, 'Code'), code, h('p', {}, submit, ' ', again), msg.el,
    h('p', { class: 'muted' }, 'Nothing arrived? Check your spam folder. You can ask for up to 5 an hour.'));
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    busy(submit, async () => {
      msg.clear();
      try { await api('POST', '/auth/code', { challenge, code: code.value.trim() }); done(); }
      catch (e) {
        msg.fail(e.status === 400 ? 'That code did not work. It may have expired or been used. Go back to ask for a new one.' : describe(e));
        code.select();
      }
    });
  });
  again.addEventListener('click', () => showEmail(address));
  mount(root, frame(null, h('h1', {}, 'Check your email'), form));
  code.focus();
}

// A link opened in the tab that is already on this page only changes the # part, so look again.
addEventListener('hashchange', () => location.reload());

(async () => {
  if (linkToken) return showLink(linkToken);
  let me = null;
  try { me = await getMe(); } catch { /* show the form anyway */ }
  if (me) return done();
  showEmail();
})();
