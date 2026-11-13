// Helpers for the deploy workflow's "create the Pages project if it is missing" step.
//
//   wrangler pages project list --json | node scripts/pages-project.mjs has NAME      exit 0 if NAME is listed, 1 if not
//   <wrangler's error text>            | node scripts/pages-project.mjs already-exists  exit 0 if it says the project exists
//
// Both are deliberately forgiving about the exact output format, because it is Wrangler's, not ours: the list is read
// as JSON wherever it sits in the text, and a project's name may be under `name` or `Project Name`. If the list cannot
// be read at all, the workflow tries to create the project anyway, and "already exists" from that is also fine.
import { fileURLToPath } from 'node:url';

export function hasProject(text, name) {
  const s = String(text ?? '');
  const from = s.indexOf('['), to = s.lastIndexOf(']');
  if (from < 0 || to < from) return false;
  try {
    const list = JSON.parse(s.slice(from, to + 1));
    return Array.isArray(list) && list.some(p => p && (p.name === name || p['Project Name'] === name));
  } catch { return false; }
}

// Cloudflare error 8000002: "A project with this name already exists."
export const alreadyExists = text => /\b8000002\b|already exists/i.test(String(text ?? ''));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, name] = process.argv.slice(2);
  let text = '';
  process.stdin.on('data', c => (text += c)).on('end', () => {
    if (mode === 'has' && name) process.exit(hasProject(text, name) ? 0 : 1);
    if (mode === 'already-exists') process.exit(alreadyExists(text) ? 0 : 1);
    console.error('usage: pages-project.mjs has NAME | already-exists  (text on stdin)');
    process.exit(2);
  });
}
