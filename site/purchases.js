// Purchase history: what you bought, when, for how much, and whether it was refunded or disputed.
import { api, getMe, describe, titleOf } from './api.js';
import { h, mount, frame, link, date } from './ui.js';

const root = document.getElementById('app');
const WHAT = { extraPhotos: 'More photos', sevenTiers: 'Seven-tier altar', platinum: 'Platinum' };

// Stripe gives amounts in the smallest unit (cents). The browser knows how many decimals a currency has.
function money(amount, currency) {
  if (!Number.isSafeInteger(amount) || typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return 'Not recorded';
  try {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
    return f.format(amount / 10 ** f.resolvedOptions().maximumFractionDigits);
  } catch { return 'Not recorded'; }
}

function statusText(p) {
  switch (p.status) {
    case 'refunded': return 'Refunded. The upgrade was removed.';
    case 'partly_refunded': return `Partly refunded (${money(p.refunded, p.currency)}). You keep the upgrade.`;
    case 'disputed': return 'Disputed with your bank. The upgrade stays while it is looked into.';
    case 'dispute_lost': return 'The dispute was decided against the payment. The upgrade was removed.';
    default: return 'Paid';
  }
}

(async () => {
  let me;
  try { me = await getMe(); } catch (e) { mount(root, frame(null, h('p', { class: 'msg error', role: 'alert' }, describe(e)))); return; }
  if (!me) { location.replace('/signin?next=/purchases'); return; }
  let purchases;
  try { purchases = (await api('GET', '/me/purchases')).purchases; }
  catch (e) { mount(root, frame(me, h('h1', {}, 'Purchase history'), h('p', { class: 'msg error', role: 'alert' }, describe(e)))); return; }
  const names = new Map(await Promise.all([...new Set(purchases.map(p => p.ofrenda).filter(Boolean))].map(async id => [id, await titleOf(id)])));

  const table = h('table', { class: 'purchases' },
    h('caption', { class: 'sr' }, 'Your purchases, newest first'),
    h('thead', {}, h('tr', {}, ['Date', 'Bought', 'For', 'Amount', 'Status', 'Payment reference'].map(t => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, purchases.map(p => h('tr', {},
      h('td', { 'data-label': 'Date' }, date(Date.parse(p.paid))),
      h('th', { scope: 'row' }, WHAT[p.feature] || p.feature),
      h('td', { 'data-label': 'For' }, p.ofrenda ? link(names.get(p.ofrenda), '/a/' + p.ofrenda) : 'Your account'),
      h('td', { 'data-label': 'Amount' }, money(p.amount, p.currency)),
      h('td', { 'data-label': 'Status' }, statusText(p)),
      h('td', { 'data-label': 'Payment reference' }, h('code', {}, p.payment))))));

  mount(root, frame(me,
    h('h1', {}, 'Purchase history'),
    purchases.length ? table : h('p', { class: 'muted' }, 'You have not bought anything.'),
    h('p', { class: 'muted' }, 'Stripe emails a receipt to the address you paid with. If you write to us about a purchase, quote its payment reference. Amounts older than this page may show as not recorded.'),
    h('p', {}, link('Back to My ofrendas', '/my'))));
})();
