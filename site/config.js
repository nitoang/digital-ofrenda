// Per-site settings. Edit when you deploy; nothing here is secret.
window.OFRENDA_CONFIG = {
  // Cloudflare Turnstile site key (the public half). Leave empty only for local development; the Worker
  // refuses sign-in without a valid Turnstile token unless it is also in development mode.
  turnstileSiteKey: '',
};
