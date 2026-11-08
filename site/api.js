// Talks to the Worker. Same origin, so the session cookie rides along automatically and no secret ever
// lives in JavaScript. State-changing requests carry the browser's own Origin header, which the Worker checks.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || String(status));
    this.status = status;
    this.body = body || {};
  }
}

export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, { error: 'network' }); }
  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Who is signed in, or null: { id, email, plan, altars: [{id, role}], successorOf: [{id, claim}] }.
export async function getMe() {
  try {
    const body = await api('GET', '/me');
    return { ...body.user, altars: body.altars || [], successorOf: body.successorOf || [] };
  } catch (e) { if (e.status === 401) return null; throw e; }
}

// A readable sentence for an error, for showing to a person.
export function describe(e, fallback = 'Something went wrong. Please try again.') {
  if (e && e.status === 0) return 'Could not reach the server. Check your connection and try again.';
  if (e && e.status === 429) return 'Too many tries. Please wait a little and try again.';
  return (e && e.body && e.body.message) || fallback;
}
