// Reads `wrangler secret list` (JSON) on stdin and warns about required secrets that are missing. It only warns:
// on a first deployment the Worker does not exist yet, so its secrets cannot have been set. /healthz shows the rest.
//   wrangler secret list | node scripts/check-secrets.mjs NAME [NAME...]
import { fileURLToPath } from 'node:url';

export function missing(listJson, required) {
  let have;
  try { have = new Set(JSON.parse(listJson).map(s => s.name)); } catch { return required; }
  return required.filter(n => !have.has(n));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text = '';
  process.stdin.on('data', c => (text += c)).on('end', () => {
    const gone = missing(text, process.argv.slice(2));
    for (const n of gone) console.log(`::warning::Secret ${n} is not set (or could not be read). Set it with: npx wrangler secret put ${n}`);
    if (!gone.length) console.log('All required secrets are set.');
  });
}
