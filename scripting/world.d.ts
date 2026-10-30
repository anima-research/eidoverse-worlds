// scripting/world.d.ts — types for a world script's one global, `world` (docs/SCRIPTS.md "The API"). The sandbox's own
// object is shared/protocol/sandbox.js (PRELUDE); tools/protocol/scripting-check.ts K1 keeps the member list equal to it.

/** A thing's id (minted, opaque) or "self". A person's identity is an id too. */
type Id = string;
/** Any JSON value a component can hold. */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface EventBase { on: string }
interface UseEvent extends EventBase { on: "use"; by: Id; seq?: number; action: string; args?: Json; id?: Id; held?: true; hand?: string; phase?: "down" | "up" }
interface SayEvent extends EventBase { on: "say"; by: Id; text: string; to?: Id; seq: number }
interface PresenceEvent extends EventBase { on: "enter" | "leave"; by: Id }
interface GrabEvent extends EventBase { on: "grab"; by: Id; id: Id; hand: string; grip?: string; seq?: number }
interface ReleaseEvent extends EventBase { on: "release"; by: Id; id: Id; how: "put" | "drop" | "throw" | "stay" | "return" | "snap" | "edited"; to?: Id; socket?: string; seq?: number }
interface ChangedEvent extends EventBase { id: Id; comp: string; by: Id; seq: number }
interface TickEvent extends EventBase { on: "tick" }
interface WakeEvent extends EventBase { on: "wake"; slept: number }
type WorldEvent = UseEvent | SayEvent | PresenceEvent | GrabEvent | ReleaseEvent | ChangedEvent | TickEvent | WakeEvent;

interface World {
  /** the thing the script is installed on */
  readonly self: Id;
  /** its key, "script:<name>" */
  readonly script: string;
  /** its knobs (frozen) */
  readonly knobs: Readonly<Record<string, Json>>;
  /** the activation's clock in ms (= Date.now()) */
  readonly now: number;
  on(event: "use", fn: (e: UseEvent) => void): void;
  on(event: "say", fn: (e: SayEvent) => void): void;
  on(event: "enter" | "leave", fn: (e: PresenceEvent) => void): void;
  on(event: "grab", fn: (e: GrabEvent) => void): void;
  on(event: "release", fn: (e: ReleaseEvent) => void): void;
  on(event: "tick", fn: (e: TickEvent) => void): void;
  on(event: "wake", fn: (e: WakeEvent) => void): void;
  on(event: `changed:${string}`, fn: (e: ChangedEvent) => void): void;
  /** a copy of one component's value (or of all of them), or null */
  get(id: Id, comp?: string): Json;
  /** the ids parented to it (≤ 1000) */
  children(id: Id): Id[];
  /** every id in the world (≤ 1000, sorted) */
  ids(): Id[];
  /** identities of people within r m (the act records r and how many, never who) */
  near(r: number): Id[];
  /** the same people with their distance in metres (3 dp), nearest first */
  nearby(r: number): { id: Id; d: number }[];
  /** how many people are here */
  count(): number;
  /** a person's display name, or null */
  name(id: Id): string | null;
  /** propose a write (inside scope) */
  set(id: Id, comp: string, value: Json): void;
  /** write params.<name> (needs params in scope.comps) */
  param(id: Id, name: string, value: number): void;
  /** propose a delete (a whole thing only if this activation created it) */
  delete(id: Id, comp?: string): void;
  /** propose a new thing (needs scope.create); returns its minted id */
  create(components: Record<string, Json>): Id;
  /** a say entry (needs scope.say) */
  say(text: string): void;
  /** set off another thing's reaction (its id in scope.ids; ≤ 4) */
  use(id: Id, action: string, args?: Json): void;
  /** effects on a person (scope.bodies, then their consent) */
  shove(who: Id): void;
  pose(who: Id, spec: Record<string, Json>): void;
  /** the old spelling of console.log, kept for one version */
  log(...parts: unknown[]): void;
}

declare const world: World;
declare const console: { log(...parts: unknown[]): void };
