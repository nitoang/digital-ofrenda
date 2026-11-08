// Explains an upgrade and starts the purchase. The page never chooses a price: it names a feature, the Worker
// asks Stripe for a Checkout page, and the person pays on Stripe's own site.
import { api, describe } from './api.js';
import { h, busy } from './ui.js';

const OFFERS = {
  extraPhotos: { title: 'More photos', blurb: 'Free ofrendas hold 2 photos.', button: 'Add more photos to this ofrenda', detail: 'Unlimited photos on this ofrenda.' },
  sevenTiers: { title: 'The seven-tier altar', blurb: 'The traditional seven-tier altar is an upgrade.', button: 'Unlock seven tiers for this ofrenda', detail: 'The seven-tier layout on this ofrenda.' },
  platinum: { title: 'Platinum', blurb: 'Free accounts can keep 3 ofrendas.', button: 'Get Platinum', detail: 'Unlimited ofrendas, unlimited photos and every option, on all your ofrendas.' },
};

const STRIPE = 'https://checkout.stripe.com/';

// feature: what was asked for. ctx: { altarId, role } when it came from an altar page.
export function showUpgrade(feature, ctx = {}) {
  const main = OFFERS[feature] || OFFERS.platinum;
  const isAltarFeature = feature === 'extraPhotos' || feature === 'sevenTiers';
  document.getElementById('upgrade-dialog')?.remove();

  const msg = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const close = h('button', { type: 'button' }, 'Close');
  const dialog = h('dialog', { id: 'upgrade-dialog', 'aria-labelledby': 'upgrade-title' }, h('h2', { id: 'upgrade-title' }, main.title), h('p', {}, main.blurb));

  if (isAltarFeature && ctx.role !== 'owner') {
    dialog.append(h('p', {}, 'Only the owner of this ofrenda can buy upgrades for it. Ask them to add it.'));
  } else {
    const offers = isAltarFeature ? [feature, 'platinum'] : ['platinum'];
    dialog.append(h('p', { class: 'muted' }, 'You will see the price on the next page, before you pay.'));
    for (const f of offers) {
      const o = OFFERS[f];
      const buy = h('button', { type: 'button', class: f === offers[0] ? 'primary' : '' }, o.button);
      buy.addEventListener('click', () => busy(buy, async () => {
        msg.className = 'msg'; msg.textContent = '';
        try {
          const { url } = await api('POST', '/checkout', { feature: f, altarId: f === 'platinum' ? undefined : ctx.altarId });
          if (typeof url !== 'string' || !url.startsWith(STRIPE)) throw new Error('unexpected address');
          location.assign(url);
        } catch (e) {
          msg.className = 'msg error'; msg.setAttribute('role', 'alert');
          msg.textContent = e.status === 409 ? 'You already have that. Reload the page to see it.' : describe(e, 'We could not start the payment. Please try again.');
        }
      }));
      dialog.append(h('div', { class: 'card' }, h('p', {}, h('strong', {}, o.title), ' — ', o.detail), h('p', {}, buy)));
    }
  }
  dialog.append(msg, h('p', {}, close));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
