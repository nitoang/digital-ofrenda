// Who may open an ofrenda's data and photos. Anyone with the link, unless the owner made it private: then only the
// people who keep it. A private ofrenda answers a stranger exactly as a missing one does, so nothing says it exists.

import * as store from './store.mjs';
import { sessionFrom } from './auth.mjs';

export async function canView(request, env, deps, altar) {
  if (altar.visibility !== 'private') return true;
  const s = await sessionFrom(request, env, deps);
  return !!s && !!(await store.getRole(env.DB, altar.id, s.user.id));
}
