// After a deployment: is the site really there? Usage: node scripts/smoke.mjs https://your-site
// Checks /healthz (the Worker, its database and its configuration), a Pages page, and that Pages' security headers
// were deployed. Retries for a minute, because a new deployment takes a moment to spread.
import { fileURLToPath } from 'node:url';

export async function check(base, fetchImpl = fetch) {
  const problems = [];
  const health = await fetchImpl(base + '/healthz');
  const body = await health.json().catch(() => null);
  if (health.status !== 200 || body?.ok !== true) problems.push(`/healthz answered ${health.status} ${JSON.stringify(body)}`);
  const page = await fetchImpl(base + '/signin');
  if (page.status !== 200) problems.push(`/signin answered ${page.status}`);
  else if (!/default-src 'none'/.test(page.headers.get('content-security-policy') || '')) problems.push('/signin has no content-security-policy: the _headers file was not deployed');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = (process.argv[2] || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(base)) { console.error('Usage: node scripts/smoke.mjs https://your-site'); process.exit(2); }
  let problems = ['not tried'];
  for (let i = 0; i < 6 && problems.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 10_000));
    problems = await check(base).catch(e => [`could not reach ${base}: ${e.message}`]);
    if (problems.length) console.log(`Attempt ${i + 1}:`, problems.join('; '));
  }
  if (problems.length) { console.error('Smoke test failed.'); process.exit(1); }
  console.log('Smoke test passed.');
}
