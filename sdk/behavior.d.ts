// eidoverse-worlds behavior SDK — the complete surface a runtime script sees.
//
// A behavior script is plain JavaScript (no imports, no async at top level —
// QuickJS sandbox, ES2023-ish). It runs SERVER-SIDE: it keeps running when
// you sleep, which is the point. It sees exactly one global, `world`, and
// affects anything only by emitting ordinary logged verbs.
//
// Write against this file locally (`bun run sdk/harness.ts yourscript.js`),
// then upload and bind:
//
//   curl -X POST "$SEQ/upload?as=script&token=$TOKEN" --data-binary @yourscript.js
//   # → {"path": "store/scripts/<hash>.js"}
//   world_verb behavior {id: "myThing", src: "store/scripts/<hash>.js",
//                        attach: "swing1", knobs: {...}}
//
// Hard limits (the sandbox enforces, the flight recorder reports):
//   25ms of CPU per activation · 24MB memory · 8 emits/activation ·
//   40 emits/min · timers ≥5s · kv ≤8KB · paused after 5 consecutive errors.

interface WorldAPI {
  /** The entity id this behavior is attached to, or null (world-level). */
  readonly self: string | null;

  /** Parameters from the `behavior` binding — how one script serves many
   *  things ("the fishing rod, but slower"). Never mutate; rebind to change. */
  readonly knobs: Record<string, unknown>;

  /** React to a world event.
   *  - "use":   someone used your entity (or any entity, if world-level).
   *  - "say":   anything said in world chat (filter it yourself).
   *  - "enter": an embodied participant arrived.
   *  - "leave": one left. */
  on(ev: "use", fn: (e: { entity: string; action: string; by: string; seq: number }) => void): void;
  on(ev: "say", fn: (e: { text: string; by: string; seq: number }) => void): void;
  on(ev: "enter" | "leave", fn: (e: { id: string }) => void): void;

  /** Run fn every `seconds` (min 5). Registrations only count at load time. */
  every(seconds: number, fn: () => void): void;

  /** Emit a logged verb — the ONLY way to affect the world. Checked against
   *  your AUTHOR's live rights, this behavior's capability mask (default:
   *  say, motion, comp, place, use, light, force), selfOnly (default true:
   *  verbs with an id may only target your attached entity), and the budgets.
   *
   *  `force {at:[x,y,z], radius?, power?}` is an instantaneous radial push —
   *  a blast, a gust, a trap springing. Bodies in radius that ALLOW being
   *  pushed (their own setting) tumble away from `at`. It has no targets and
   *  no lasting state: emit it at the moment the thing happens.
   *  A refused emit THROWS with the reason — catch it or let the flight
   *  recorder log it. */
  emit(verb: string, args?: Record<string, unknown>): void;

  /** Write to this behavior's private log ring — your console. Read it with
   *  `/debug <behaviorId>` in the client or `world_debug {behavior}` over
   *  MCPL. Costs nothing, never persisted to the world log. */
  log(...parts: unknown[]): void;

  /** Read the folded world (never mutate — emit verbs instead). */
  entity(id: string): { id: string; pos: number[]; yaw: number; lib?: string;
    comp: Record<string, unknown>; parent: unknown | null } | null;
  entities(): { id: string; pos: number[]; yaw: number; lib?: string }[];
  /** Embodied participants (id + last known position, if any). */
  people(): { id: string; pos: number[] | null }[];

  /** Persistent state, private to this behavior. Survives restarts, replays,
   *  and forks (it is event-sourced under the hood: one coalesced `bstate`
   *  entry per activation that changed something). Whole store ≤8KB —
   *  counters and flags, not archives.
   *
   *  ⚠ A REBIND starts EMPTY, by design: re-issuing the `behavior` verb for
   *  the same id folds a fresh record, and fresh code gets fresh state
   *  (shared/fold.js, the binding case: "a rebind keeps nothing") — earlier
   *  bstate does not carry across. So iterating on a live script loses its
   *  kv on every upload+rebind cycle; if the state matters across versions,
   *  read it out before rebinding, or design keys the next version can
   *  rebuild without. */
  kv: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;   // undefined/null deletes
  };
}

declare const world: WorldAPI;
