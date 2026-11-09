// What happens when an owner stops owning an ofrenda: they delete it, or delete their account.
//
//   - Another owner remains: the person simply steps away. Nothing else changes.
//   - They are the last owner, but other people keep it: nothing is erased. Ownership passes to the successor if
//     one has agreed, otherwise to everyone who keeps it. Anyone who is already at the free limit of ofrendas gets
//     it locked instead: they and visitors can still view it, they must upgrade to change it, and it is never
//     deleted or pushed towards deletion.
//   - Nobody else is on it: it is deleted.

import * as store from './store.mjs';
import { queueMail, nowOwnerMessage, lockedMessage } from './mail.mjs';
import { RULES } from './rules.mjs';
import { FEATURES } from './validate.mjs';

// `user` is the person stepping away ({id, plan}). Returns 'left', 'passed' or 'deleted'.
export async function retireOwner(env, deps, altarId, user) {
  const now = deps.now();
  const members = await store.listMembers(env.DB, altarId);
  const others = members.filter(m => m.user_id !== user.id);
  if (members.some(m => m.role === 'owner' && m.user_id !== user.id)) {
    await store.leaveAsOwner(env.DB, altarId, user.id);
    return 'left';
  }
  if (!others.length) { await store.deleteAltar(env.DB, altarId); return 'deleted'; }

  const successor = await store.getSuccessor(env.DB, altarId);
  const named = successor?.accepted_user_id && others.find(m => m.user_id === successor.accepted_user_id);
  const heirs = named ? [named] : others;
  await store.passOn(env.DB, { altarId, fromUserId: user.id, heirIds: heirs.map(h => h.user_id), now, grants: user.plan === 'platinum' ? FEATURES : [] });
  for (const h of heirs) {
    const locked = await store.ownerLocked(env.DB, altarId, h.user_id, RULES.freeAltars);
    queueMail(deps, () => deps.mailer.send((locked ? lockedMessage : nowOwnerMessage)({ to: h.email })));
  }
  return 'passed';
}
