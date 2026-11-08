// The human check on sign-in (Cloudflare Turnstile). With no site key configured (local development) it does
// nothing, and the Worker must then be in development mode too, or it refuses the request.
import { h } from './ui.js';

let loading = null;
function loadScript() {
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Turnstile did not load'));
    document.head.append(s);
  });
  return loading;
}

export function turnstile() {
  const key = window.OFRENDA_CONFIG && window.OFRENDA_CONFIG.turnstileSiteKey;
  const el = h('div', { class: 'turnstile' });
  if (!key) return { el, token: () => undefined, reset() {} };
  let token = null, widget = null;
  loadScript().then(() => {
    widget = window.turnstile.render(el, {
      sitekey: key,
      callback: t => { token = t; },
      'expired-callback': () => { token = null; },
      'error-callback': () => { token = null; },
    });
  }).catch(() => { el.textContent = 'The human check could not load. Reload the page to try again.'; });
  return {
    el,
    token: () => token || undefined,
    reset() { token = null; if (widget !== null && window.turnstile) window.turnstile.reset(widget); },
  };
}
