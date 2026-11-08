// Tells a person an option is an upgrade. Purchasing is not built yet, so this explains and offers nothing to
// click. When the Stripe Checkout route exists, add the purchase button here (see README).
import { h } from './ui.js';

const TEXT = {
  extraPhotos: ['More photos', 'Free ofrendas hold 2 photos. A photo upgrade lets you add as many as you like.'],
  sevenTiers: ['The seven-tier altar', 'The traditional seven-tier altar is an upgrade.'],
  platinum: ['Platinum', 'Free accounts can keep 3 ofrendas. Platinum removes that limit and includes unlimited photos and every option.'],
};

export function showUpgrade(feature) {
  const [title, body] = TEXT[feature] || ['An upgrade', 'That option is an upgrade.'];
  document.getElementById('upgrade-dialog')?.remove();
  const close = h('button', { type: 'button', class: 'primary' }, 'Close');
  const dialog = h('dialog', { id: 'upgrade-dialog', 'aria-labelledby': 'upgrade-title' },
    h('h2', { id: 'upgrade-title' }, title),
    h('p', {}, body),
    h('p', { class: 'muted' }, 'Upgrades are not open for purchase yet.'),
    h('p', {}, close));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
