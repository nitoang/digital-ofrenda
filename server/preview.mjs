// The link people paste into chats and social posts: GET /s/<id or name>. A crawler that builds a link preview reads
// the Open Graph tags and never runs JavaScript, and the ofrenda page is a single-page app, so it would see nothing.
// This tiny page carries the tags and immediately sends a person on to the real page at /a/<ref>.
//
// What the preview may say: the name on the altar, only when anyone with the link may see it. A private ofrenda, one that was
// never saved, and one that does not exist all get the same generic preview, so it cannot be used to find out which
// exist or what they are called. The picture is always the same generic one (og.png), never a photo from the altar.

import { normalizeSlug } from './util.mjs';
import * as store from './store.mjs';
import { canView } from './altars.mjs';

const ID_SHAPE = /^[a-z2-7]{12}$/;
const GENERIC = { title: 'An ofrenda on Digifrenda', description: 'A digital ofrenda: a place to remember someone you love.' };
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The name as the owner typed it, made safe to put in a page title: one line, no control characters, not too long.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'); // control characters and line/paragraph separators
const cleanName = v => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '');

export async function handlePreview(request, env, deps, ref) {
  let about = GENERIC;
  const id = ID_SHAPE.test(ref) ? ref : (normalizeSlug(ref) && (await store.altarIdForSlug(env.DB, normalizeSlug(ref))));
  const altar = id && (await store.getAltar(env.DB, id));
  if (altar?.state && (await canView(request, env, deps, altar))) {
    let name = '';
    try { name = cleanName(JSON.parse(altar.state).name); } catch { /* unreadable state: generic */ }
    if (name) about = { title: `${name} — an ofrenda on Digifrenda`, description: `A digital ofrenda made to remember ${name}.` };
  }
  const base = env.APP_URL.replace(/\/+$/, '');
  const to = `/a/${ref}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(about.title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(about.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Digifrenda">
<meta property="og:title" content="${esc(about.title)}">
<meta property="og:description" content="${esc(about.description)}">
<meta property="og:url" content="${esc(`${base}/s/${ref}`)}">
<meta property="og:image" content="${esc(`${base}/og.png`)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(about.title)}">
<meta name="twitter:description" content="${esc(about.description)}">
<meta name="twitter:image" content="${esc(`${base}/og.png`)}">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
</head>
<body>
<p><a href="${esc(to)}">Open this ofrenda</a></p>
</body>
</html>
`;
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    // This page needs nothing but its own picture: no scripts, no styles, no connections, no framing.
    'content-security-policy': "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  } });
}
