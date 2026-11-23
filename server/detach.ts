// A promise nobody awaits, run for its effects: its failure is logged here. Without a handler a rejection is fatal to the
// process (sfuguard.ts installs exit-on-unhandledRejection for the whole server), so a fire-and-forget call goes through this.

/** Run `p` for its effects; a rejection is logged under `label`, never left unhandled. */
export function detach(p: PromiseLike<unknown>, label: string): void {
  Promise.resolve(p).catch((err: unknown) => console.error(`[${label}]`, err));
}
