/** A readiness acknowledgement must survive two actual paint opportunities. */
export function createReadiness({ requestFrame, cancelFrame, reveal, resources }) {
  let destroyed = false, pending, frame, resolve;
  return {
    ready() {
      if (destroyed) return Promise.resolve(false);
      if (pending) return pending;
      pending = new Promise(done => {
        resolve = done;
        const schedule = success => {
          if (destroyed || !success) { done(false); return; }
          frame = requestFrame(() => {
            frame = requestFrame(() => { if (!destroyed) { reveal(); done(true); } });
          });
        };
        if (resources) resources.then(schedule, () => done(false));
        else schedule(true);
      });
      return pending;
    },
    destroy() { destroyed = true; if (frame !== undefined) cancelFrame(frame); resolve?.(false); }
  };
}
