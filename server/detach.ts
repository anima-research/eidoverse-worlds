// A promise nobody awaits, run for its effects: its failure is logged here. Without a handler a rejection is fatal to the
// process (sfuguard.ts installs exit-on-unhandledRejection for the whole server), so a fire-and-forget call goes through this.

/** Run `p` for its effects; a rejection is logged under `label`, never left unhandled. `onFail`, when the caller owes
 *  someone an answer (a join waiting on its door): run with the error, so they are told rather than left waiting. A
 *  handler that throws is logged too. */
export function detach(p: PromiseLike<unknown>, label: string, onFail?: (err: unknown) => void): void {
  Promise.resolve(p).catch((err: unknown) => {
    console.error(`[${label}]`, err);
    if (onFail) try { onFail(err); } catch (e) { console.error(`[${label}] answering the failure`, e); }
  });
}
