// The link at the bottom of every optional tip email (/stop-tips#t=...). One click turns the tips off, without
// signing in. The token is in the # part so it never reaches a server log, and is removed from the address bar.
import { api, describe } from './api.js';
import { h, mount, frame, messages, busy } from './ui.js';

const root = document.getElementById('app');
const token = (/^#t=([\w-]{20,100})$/.exec(location.hash) || [])[1];
if (token) history.replaceState(null, '', location.pathname);

const msg = messages();
if (!token) {
  mount(root, frame(null, h('h1', {}, 'This link is incomplete'), h('p', {}, 'Please open the link from the email again, or turn the tips off on your My ofrendas page.')));
} else {
  const stop = h('button', { type: 'button', class: 'primary' }, 'Stop these emails');
  stop.addEventListener('click', () => busy(stop, async () => {
    try {
      await api('POST', '/tips/off', { token });
      mount(root, frame(null, h('h1', {}, 'Done'), h('p', {}, 'We will not send you these tips any more. Emails about your account, like sign-in codes, still arrive.')));
    } catch (e) {
      msg.fail(e.status === 400 ? 'This link did not work. You can turn the tips off on your My ofrendas page instead.' : describe(e));
    }
  }));
  mount(root, frame(null, h('h1', {}, 'Stop the tips by email?'),
    h('p', {}, 'These are the occasional ideas for your ofrenda. Emails about your account, like sign-in codes, are not affected.'),
    h('p', {}, stop), msg.el));
}
