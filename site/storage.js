// The component's shared-storage hook (see ofrenda.js), backed by the Worker. Viewers poll to see changes;
// keepers' edits are saved with PUT. The server cleans and limits everything again, so this only moves data.

const POLL_MS = 15000;

export function makeStorage({ canWrite, onUpgrade, onSignedOut }) {
  return {
    canWrite,

    subscribe(id, onState, onError) {
      let stopped = false, timer = null, loaded = false, failures = 0;
      const meta = { fromCache: false, hasPendingWrites: false };

      async function tick() {
        clearTimeout(timer);
        try {
          const res = await fetch(`/ofrendas/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
          if (res.status === 404) onState(null, meta);
          else if (res.ok) onState(await res.json(), meta);
          else throw new Error('status ' + res.status);
          loaded = true; failures = 0;
        } catch {
          failures++;
          if (!loaded && failures === 1) onError(new Error('load failed'));
        }
        if (!stopped) timer = setTimeout(tick, Math.min(POLL_MS * 2 ** Math.min(failures, 3), 120000));
      }
      const wake = () => { if (!document.hidden) tick(); };
      document.addEventListener('visibilitychange', wake);
      tick();
      return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
    },

    async save(id, state) {
      const res = await fetch(`/ofrendas/${encodeURIComponent(id)}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
      });
      if (res.ok) return;
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (res.status === 402 && body && body.upgrade) onUpgrade?.(body.upgrade);
      if (res.status === 401) onSignedOut?.();
      throw new Error('save failed: ' + res.status);
    },
  };
}
