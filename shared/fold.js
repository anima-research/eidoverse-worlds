// fold — how a log entry changes the world's shape, as one pure module.
//
// This is the reference fold of the eidoverse-log protocol (spec/PROTOCOL.md
// §2–§3): fold every entry from empty state and you have the world, on any
// runtime, at any time. It lived inside server/server.ts as foldEntry; it
// lives here so the sequencer, the browser client, and the mcpl agent can
// stop mirroring it by hand — AGENTS.md house rule 1 ("the fold is sacred")
// is true by construction only for code that lives in this directory.
// Conformance: tools/foldfix-test.ts folds spec/fixtures/*/log.jsonl and
// compares against each folded.json.
//
// Same constraints as everything in shared/ (README.md): pure, dependency-
// free (the one import is a sibling), no Date.now() — every timestamp comes
// off the entry, so a fold is a pure function of the log.

import { foldSkyEntry } from './forecast.js';

/**
 * One log entry: the unit of world history (PROTOCOL.md §1).
 * @typedef {{ seq: number, ts: number, actor: string, verb: string,
 *             args: Record<string, unknown> }} LogEntry
 */

/**
 * A runtime script binding, folded from `behavior` / `bstate` entries. The
 * script BYTES live in the content-addressed store; this holds the binding
 * (src, attach, caps, knobs, author) plus the script's persisted kv
 * (`state`). The sequencer's richer view is server/behaviors.ts BehaviorRec —
 * same runtime shape.
 * @typedef {{ src: string, runtime?: "client", attach?: string,
 *             caps?: unknown, knobs?: unknown, author: string, ts: number,
 *             state?: Record<string, unknown> }} BehaviorBinding
 */

/**
 * The world as it IS, rather than everything that ever happened to it.
 *
 * A log is history and grows forever — that is the point of it, and it is why
 * a world is forkable and re-filmable. But replaying all of history to show
 * someone a room is the wrong cost: joining should scale with how much is in
 * the world now, not with how long the world has existed.
 *
 * So this is a DERIVED CACHE, never a source of truth. Delete every snapshot
 * file and the worlds are identical after the next boot, just slower to load.
 * Nothing here is allowed to be information the log does not contain.
 *
 * @typedef {object} WorldState
 * @property {Record<string, {
 *   kind?: "light", pos: number[], actor: string, ts: number,
 *   lib?: string, yaw?: number, scale?: number,
 *   collide?: string,
 *   color?: number, intensity?: number, range?: number,
 *   keep?: boolean, day?: false,
 *   comp?: Record<string, unknown>,
 *   parent?: { to: string, slot?: string, offset?: number[], yaw?: number },
 * }>} entities
 *   Things and lights, one flat id namespace. `keep` (lights) = first claim
 *   on a casting slot, never governor-shed; `day: false` (lights) = burns
 *   at noon, opted out of the time-of-day cycle. `comp` is the generic bag,
 *   written by `comp` verbs and folded BLINDLY — the fold never learns what a
 *   component means; meaning lives in evaluators (motion, sockets,
 *   reactions, …), so a new component type is evaluator code + emitted
 *   verbs, zero fold changes. `parent` is scene-graph attachment: this
 *   entity rides another (cargo on a truck, a lantern on a swing), transform
 *   parent-relative.
 * @property {Record<string, { to: string, slot?: string, offset?: number[],
 *   yaw?: number }>} [mounts]
 *   Attachments of non-entity bodies (avatars) — a sitter on a swing seat, a
 *   passenger on a deck. Same shape as entity.parent, keyed by principal.
 * @property {{ sim: string, tickMs: number, ts: number, seq: number }} [epoch]
 *   The active deterministic-sim epoch (dialect 3, PROTOCOL_v2 §3). `ts` is
 *   the tick-0 anchor — preserved through snapshot rehydration, or every
 *   joiner would disagree about what tick it is.
 * @property {Record<string, unknown> | null} terrain
 * @property {Record<string, unknown> | null} grass
 * @property {(Record<string, unknown> & { ts?: number }) | null} sky
 * @property {{ name: string, path: string }[]} assets
 * @property {{ actor: string, text: string, ts: number, seq: number }[]} recentChat
 *   A little conversational context for arrivals. NOT the chat archive — the
 *   log holds that. seq is carried so a joiner can tell which of these the
 *   TAIL will also deliver — state and tail overlap whenever a world has not
 *   folded recently, and without it every such message renders twice.
 * @property {number} chatTotal
 *   Everything ever said here, so a joiner can be told that what it is
 *   looking at is a window and not the whole conversation.
 * @property {Record<string, { role: "owner" | "builder" | "visitor",
 *   gen?: boolean, sub?: string }>} roles
 *   Per-world permissions, fed by owner-authored `grant` verbs in the log —
 *   event-sourced like everything else, so roles replay, fold, and audit.
 *   A world with NO owner in this map is OPEN (everyone builds — the
 *   pre-permissions behaviour, and what a scratch world should be). The
 *   moment an owner exists, unlisted ids are visitors. `gen` is the spend
 *   capability: bringing NEW assets into the world's vocabulary (the `asset`
 *   verb — where Orrery generations land). `sub` binds the grant to a
 *   durable subject: when present, only that sub wears it.
 * @property {Record<string, { by: string, ts: number, reason?: string,
 *   sub?: string }>} [bans]
 *   Per-world bans, fed by owner-authored `ban`/`unban` verbs in the log —
 *   event-sourced like roles, so a ban replays, folds, audits, and rides a
 *   fork. Keyed by lowercased display id; `sub` (when the target was present
 *   to be identified at ban time) makes the ban survive a rename. Optional
 *   because snapshots from before this verb lack the map.
 * @property {Record<string, BehaviorBinding>} [behaviors]
 *   Runtime scripts bound into this world by `behavior` entries.
 */

/** The rights ladder (PROTOCOL.md §7): visitor < builder < owner.
 *  @type {Record<string, number>} */
export const ROLE_RANK = { visitor: 0, builder: 1, owner: 2 };

/** The recent-chat window a fold maintains for arrivals. Implementation
 *  policy, not conformance-scored (PROTOCOL.md §3 `say`). */
export const RECENT_CHAT = 40;

/** @returns {WorldState} */
export const emptyState = () => ({
  entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0,
  roles: {}, bans: {},
});

/** Make room in the recent-chat window WITHOUT letting one loud speaker erase
 *  everyone else.
 *
 *  A plain "keep the last N" is a lie about what a room sounded like: measured,
 *  a bot emitting 300 telemetry lines reduced the window to 40 messages
 *  spanning ZERO seconds, all its own, and the two people actually holding a
 *  conversation vanished from it completely. An arrival would have seen a
 *  machine talking to itself.
 *
 *  So the loudest voice loses its oldest line first, and nobody's LAST line is
 *  ever dropped while someone else still has several. Recency still wins
 *  within a speaker; fairness decides between them.
 *  @param {WorldState["recentChat"]} rc */
export function trimRecentChat(rc) {
  while (rc.length > RECENT_CHAT) {
    const counts = new Map();
    for (const m of rc) counts.set(m.actor, (counts.get(m.actor) ?? 0) + 1);
    let victim = -1;
    let worst = 1;
    for (let i = 0; i < rc.length; i++) {
      const n = counts.get(rc[i].actor);
      if (n > worst) { worst = n; victim = i; }      // oldest line of the loudest
    }
    rc.splice(victim >= 0 ? victim : 0, 1);          // everyone tied at 1: oldest goes
  }
}

/** Fold one entry into the running state. This is the ONLY place that knows how
 *  a verb changes the world's shape, and it must stay a pure function of the
 *  log — if it ever disagrees with what a client renders, joiners see a world
 *  that never existed.
 *  @param {WorldState} st @param {LogEntry} e */
export function foldEntry(st, e) {
  const a = /** @type {any} */ (e.args);
  switch (e.verb) {
    case "force":
      // an instantaneous cause: no state to fold. Live clients react to the
      // broadcast entry; a replay or a late join must never re-detonate.
      return;
    case "punt":
      // same doctrine: the punt is history, the flight is presence (a lease
      // some volunteer holds), the landing is the `place` that lease commits
      return;
    case "spawn":
      if (!a?.id || !a?.lib) return;
      st.entities[a.id] = {
        lib: a.lib, pos: a.pos ?? [0, 0, 0], yaw: a.yaw ?? 0,
        ...(a.scale != null ? { scale: a.scale } : {}),
        // `collide` ("exact" | "box") is the spawner's override of the
        // size-derived collider choice, and the fold used to drop it: the
        // clients present at the spawn honoured it, and everyone who joined
        // afterwards folded a snapshot that had never heard of it. The same
        // object was walkable or solid depending on when you arrived — which
        // is precisely the drift house rule 1 forbids. The LOG always kept it,
        // so no world lost anything; it just never reached the snapshot.
        ...(a.collide != null ? { collide: a.collide } : {}),
        actor: e.actor, ts: e.ts,
      };
      return;
    case "place": {
      const ent = st.entities[a?.id];
      if (!ent) return;
      if (a.pos) ent.pos = a.pos;
      if (a.yaw != null) ent.yaw = a.yaw;
      if (a.scale != null) ent.scale = a.scale;
      return;
    }
    case "light": {
      if (!a?.id) return;
      // Re-issuing `light` on an id that already folds as a light is a partial
      // UPDATE: absent fields keep their prior value, so `{id, intensity: 40}`
      // brightens without resetting color/range/pos. `keep: true` marks the
      // light first-in-line for a casting slot and exempt from perf-governor
      // shedding (keep: false clears it); `day: false` opts it out of the
      // time-of-day cycle — the deliberate noon porch light (day: true, the
      // default, clears it). Both stored only in their non-default state.
      // A non-light already holding the id is replaced wholesale, same as
      // before — the id namespace is flat. (PROTOCOL §3.1, fixture 05.)
      const prev = st.entities[a.id];
      const base = prev?.kind === "light" ? prev : null;
      const keep = a.keep ?? base?.keep;
      const day = a.day ?? base?.day;
      st.entities[a.id] = {
        kind: "light", pos: a.pos ?? base?.pos ?? [0, 1, 0],
        color: a.color ?? base?.color ?? 0xffd9a0,
        intensity: a.intensity ?? base?.intensity ?? 16,
        range: a.range ?? base?.range ?? 10,
        ...(keep ? { keep: true } : {}),
        ...(day === false ? { day: false } : {}),
        // A partial update is not re-authoring (§3.1): what the merge doesn't
        // author must survive it — the comp bag (§4: annotations are
        // preserved), the parent attachment, and any yaw/scale a `place`
        // stamped onto the light. Wholesale assignment here used to destroy
        // all four on every re-light: brightening a comped, mounted lantern
        // dismounted it for every joiner. A non-light base still carries
        // nothing — replacement across kinds stays wholesale (fixture 04).
        ...(base?.comp ? { comp: base.comp } : {}),
        ...(base?.parent ? { parent: base.parent } : {}),
        ...(base?.yaw != null ? { yaw: base.yaw } : {}),
        ...(base?.scale != null ? { scale: base.scale } : {}),
        actor: e.actor, ts: e.ts,
      };
      return;
    }
    case "remove": {
      // Anything riding the removed thing steps off with its absolute pose
      // stamped — remove the truck, the cargo lands where the truck stood.
      const gone = st.entities[a?.id];
      if (gone) {
        for (const child of Object.values(st.entities)) {
          if (child.parent?.to !== a.id) continue;
          const off = child.parent.offset ?? [0, 0, 0];
          const yaw = gone.yaw ?? 0;
          const [ox, oy, oz] = off;
          child.pos = [
            gone.pos[0] + ox * Math.cos(yaw) + oz * Math.sin(yaw),
            gone.pos[1] + oy,
            gone.pos[2] - ox * Math.sin(yaw) + oz * Math.cos(yaw),
          ];
          child.yaw = yaw + (child.parent.yaw ?? 0);
          delete child.parent;
        }
        if (st.mounts) {
          for (const [id, rel] of Object.entries(st.mounts)) if (rel.to === a.id) delete st.mounts[id];
          if (!Object.keys(st.mounts).length) delete st.mounts;
        }
      }
      delete st.entities[a?.id];
      return;
    }
    case "epoch": {
      // Dialect 3 (PROTOCOL_v2 §3): the world enters — or upgrades — its
      // deterministic-sim epoch. The instant fold records WHICH epoch is
      // active (joiners and validators need it); the sim fold (shared/
      // sim.js, run beside this one) owns everything the epoch means.
      if (typeof a?.sim !== "string" || !Number.isInteger(a?.tickMs)) return;
      st.epoch = { sim: a.sim, tickMs: a.tickMs, ts: e.ts, seq: e.seq };
      return;
    }
    case "terrain": st.terrain = a; return;
    case "grass": st.grass = a?.clear ? null : a; return;   // clear = mow, no field to replay
    // Sky and weather fold through the shared module: forecast/override
    // provenance is stamped from the ENTRY (spoof-proof), and a weather verb
    // under a rated sky rebases `hours` so the day doesn't snap (issue #29).
    case "sky": st.sky = foldSkyEntry(null, { verb: "sky", args: a, ts: e.ts, seq: e.seq, actor: e.actor }); return;
    case "weather": st.sky = foldSkyEntry(st.sky, { verb: "weather", args: a, ts: e.ts, seq: e.seq, actor: e.actor }); return;
    case "asset":
      if (a?.path && !st.assets.some((x) => x.path === a.path)) {
        st.assets.push({ name: a.name ?? "upload", path: a.path });
      }
      return;
    case "say":
      st.recentChat.push({ actor: e.actor, text: String(a?.text ?? ""), ts: e.ts, seq: e.seq });
      st.chatTotal = (st.chatTotal ?? 0) + 1;
      trimRecentChat(st.recentChat);
      return;
    case "grant": {
      // {id, role?, gen?} — role change and/or gen-capability change. Roles
      // are log entries so permission history is auditable and replays like
      // everything else. (Snapshots from before this verb lack the map.)
      if (!a?.id) return;
      st.roles ??= {};
      // default matches the owned-world default (builder), so `/grant bob
      // +gen` on an unlisted id doesn't silently demote him to visitor
      const cur = st.roles[a.id] ?? { role: "builder" };
      const role = ROLE_RANK[a.role] != null ? a.role : cur.role;
      const gen = a.gen != null ? Boolean(a.gen) : cur.gen;
      // Durable ink (Hesperus finding #1): when the grant was written while
      // its subject's durable sub was KNOWN, the grant carries it — and only
      // that sub can wear it. A display name is a nameplate, not a deed;
      // before this, anyone reusing an offline owner's nick inherited the
      // world. Grants without a sub (unauthenticated ids, pre-fix history)
      // keep their old name-keyed meaning.
      st.roles[a.id] = { role, ...(gen ? { gen: true } : {}),
        ...(a.sub ? { sub: String(a.sub) } : cur.sub ? { sub: cur.sub } : {}) };
      return;
    }
    case "ban": {
      // {id, reason?, sub?} — the world's door closes for this identity. The
      // fold only records the fact; disconnecting whoever matches RIGHT NOW is
      // the verb handler's side effect (folds must stay pure — a replay must
      // never kick anyone).
      if (!a?.id) return;
      st.bans ??= {};
      st.bans[String(a.id).toLowerCase()] = {
        by: e.actor, ts: e.ts,
        ...(a.reason ? { reason: String(a.reason) } : {}),
        ...(a.sub ? { sub: String(a.sub) } : {}),
      };
      return;
    }
    case "unban": {
      if (!a?.id || !st.bans) return;
      const key = String(a.id).toLowerCase();
      delete st.bans[key];
      // an unban by display name also lifts a ban filed under that identity's
      // sub — forgiveness should not depend on knowing which handle was keyed
      for (const [k, b] of Object.entries(st.bans)) if (b.sub === a.id) delete st.bans[k];
      return;
    }
    // `kick` deliberately has no case: like `use`, it is an ACT, not a state —
    // it folds nothing, but the log keeps it (who removed whom is history).
    // The removal itself is the verb handler's side effect.
    case "comp": {
      // Generic component fold. Blind by design: `data` is opaque here, and
      // stays whatever shape its author gave it. `data: null` removes.
      const ent = st.entities[a?.id];
      if (!ent || typeof a?.type !== "string") return;
      ent.comp ??= {};
      if (a.data == null) delete ent.comp[a.type]; else ent.comp[a.type] = a.data;
      if (!Object.keys(ent.comp).length) delete ent.comp;
      return;
    }
    case "motion": {
      // Sugar: motion is just the `motion` component, common enough to be a
      // verb. The log stores FUNCTIONS OF TIME (pendulum params, a path, a
      // spin rate), never frames — clients evaluate f(now - t0). One entry
      // buys minutes of consistent, replayable movement. {type: null} = rest.
      const ent = st.entities[a?.id];
      if (!ent) return;
      const { id: _id, ...m } = a;
      // A motion with no epoch starts when it was SPOKEN — stamp the entry's
      // own ts, which is a pure function of the log, so every fold agrees.
      // (Fable's first pendulum had no t0 and stood frozen at phase zero.)
      if (m.type != null && m.t0 == null) m.t0 = e.ts;
      ent.comp ??= {};
      if (m.type == null) delete ent.comp.motion; else ent.comp.motion = m;
      if (!Object.keys(ent.comp).length) delete ent.comp;
      return;
    }
    case "mount": {
      if (!a?.id || !a?.to || a.id === a.to) return;
      const rel = {
        to: String(a.to),
        ...(a.slot ? { slot: String(a.slot) } : {}),
        ...(Array.isArray(a.offset) ? { offset: a.offset } : {}),
        ...(a.yaw != null ? { yaw: a.yaw } : {}),
      };
      const ent = st.entities[a.id];
      if (ent) ent.parent = rel;
      else { st.mounts ??= {}; st.mounts[a.id] = rel; }   // a body, not a thing
      return;
    }
    case "dismount": {
      if (!a?.id) return;
      const ent = st.entities[a.id];
      if (ent) {
        delete ent.parent;
        // Plane-transition invariant: the verb STAMPS absolute pose. The log
        // must never depend on reconstructing where the parent was.
        if (Array.isArray(a.pos)) ent.pos = a.pos;
        if (a.yaw != null) ent.yaw = a.yaw;
      }
      if (st.mounts) {
        delete st.mounts[a.id];
        if (!Object.keys(st.mounts).length) delete st.mounts;
      }
      return;
    }
    case "behavior": {
      // Bind (or unbind) a runtime script. The entry is the BINDING; the
      // code is content-addressed in the store, so this replays exactly.
      if (!a?.id) return;
      st.behaviors ??= {};
      if (a.remove) {
        delete st.behaviors[a.id];
        if (!Object.keys(st.behaviors).length) delete st.behaviors;
        return;
      }
      if (typeof a.src !== "string") return;
      st.behaviors[a.id] = {
        src: a.src,
        ...(a.runtime === "client" ? { runtime: "client" } : {}),
        ...(a.attach ? { attach: String(a.attach) } : {}),
        ...(a.caps ? { caps: a.caps } : {}),
        ...(a.knobs ? { knobs: a.knobs } : {}),
        author: String(a.by ?? e.actor),   // by = the human/agent behind a bhv:-authored rebind
        ts: e.ts,
        // a rebind keeps nothing: fresh code starts with fresh state unless
        // the same id folds a later bstate
      };
      return;
    }
    case "bstate": {
      // A script's persisted kv — server-authored (actor bhv:<id>), coalesced
      // one-per-activation. Folding it here is what makes script state
      // survive restarts, replays, and forks like everything else does.
      const rec = st.behaviors?.[a?.id];
      if (rec && a.data && typeof a.data === "object") rec.state = a.data;
      return;
    }
    // `use` deliberately has no case: it is a CAUSE, not an effect — it folds
    // nothing, but the log keeps it (who pushed the swing is history). Effects
    // are the reaction's own logged entries.
    default: return;   // unknown verbs shape nothing; the log still keeps them
  }
}

/** Turn a folded snapshot back into the verbs that would have produced it.
 *
 *  Deliberately NOT a second way of building a world: the state goes back
 *  through whatever consumes ordinary entries, so there is exactly one code
 *  path that gives a snapshot meaning. Order matters the way it does in a
 *  log: ground before the things standing on it; every spawn before
 *  anything lands on one. Synthetic entries carry negative seq (they are
 *  pre-history, not positions in it) — EXCEPT chat, which keeps its real
 *  seq because the scrollback cursor derives from it.
 *
 *  One implementation, every species: the browser client and the mcpl agent
 *  each carried a hand-mirrored copy of this ("must stay in step…" — the
 *  drift that crashed look() for every agent in a world is the incident in
 *  the comment both copies carried). The flags encode the agents' deliberate
 *  omissions EXPLICITLY, so an absence stays a decision instead of a drift:
 *  - roles/behaviors: the agent has no local reader for either;
 *  - collide: browser-only collider state riding the spawn verb;
 *  - bodyMountRel 'seat' + bodyMountActor 'rider': text-tier perception
 *    wants "who sits where", not offsets — and attributes the sitting to
 *    the sitter.
 *
 *  @param {WorldState} state
 *  @param {{ skipChatFromSeq?: number, roles?: boolean, behaviors?: boolean,
 *            collide?: boolean, bodyMountRel?: 'full'|'seat',
 *            bodyMountActor?: 'world'|'rider', now?: number }} [opts] */
export function stateToEntries(state, {
  skipChatFromSeq = Infinity, roles = true, behaviors = true, collide = true,
  bodyMountRel = 'full', bodyMountActor = 'world', now = Date.now(),
} = {}) {
  if (!state) return [];
  const out = [];
  let seq = -1;
  const add = (verb, args, actor = 'world', ts = now) =>
    out.push({ seq: seq--, ts, actor, verb, args });

  if (roles) {
    for (const [id, r] of Object.entries(state.roles ?? {})) {
      add('grant', { id, role: r.role, ...(r.gen ? { gen: true } : {}) });
    }
  }
  if (state.epoch) add('epoch', { sim: state.epoch.sim, tickMs: state.epoch.tickMs },
    'world', state.epoch.ts ?? now);
  if (state.terrain) add('terrain', state.terrain);
  if (state.grass) add('grass', state.grass);
  if (state.sky) add('sky', state.sky, 'world', state.sky.ts ?? now);
  for (const a of state.assets ?? []) add('asset', a);
  for (const [id, e] of Object.entries(state.entities ?? {})) {
    if (e.kind === 'light') {
      // folded lights have no lib — synthesizing one crashes every consumer
      // that trusts `lib` on a spawn (Fable's porchlight vs look(), 07-30)
      add('light', { id, pos: e.pos, color: e.color, intensity: e.intensity, range: e.range,
        ...(e.keep ? { keep: true } : {}),
        ...(e.day === false ? { day: false } : {}) },
        e.actor ?? 'world', e.ts ?? now);
      // the light verb carries no yaw/scale (PROTOCOL §3): a transform a
      // `place` stamped onto the light re-enters the way it arrived — as a
      // place — or the snapshot roundtrip silently drops what the light-on-
      // light merge just learned to preserve. pos rides along (idempotent
      // over the light entry) because a pos-less place is legal but at least
      // one consumer (mcpl applyEntry) assigns args.pos unguarded.
      if (e.yaw != null || e.scale != null) {
        add('place', { id, pos: e.pos,
          ...(e.yaw != null ? { yaw: e.yaw } : {}),
          ...(e.scale != null ? { scale: e.scale } : {}) },
          e.actor ?? 'world', e.ts ?? now);
      }
    } else {
      add('spawn', {
        id, lib: e.lib, pos: e.pos, yaw: e.yaw,
        ...(e.scale != null ? { scale: e.scale } : {}),
        // the spawn verb's collide override decides exact-vs-box; dropping
        // it made the same object walkable or solid depending on when you
        // arrived (the drift house rule 1 forbids)
        ...(collide && e.collide != null ? { collide: e.collide } : {}),
      }, e.actor ?? 'world', e.ts ?? now);
    }
  }
  // components and attachments, after every spawn exists — without the comp
  // entries a post-fold joiner can be REFUSED for a lock it was never shown,
  // and every socket, reaction and emitter authored before the fold is
  // missing until someone rewrites it (#71)
  for (const [id, e] of Object.entries(state.entities ?? {})) {
    for (const [type, data] of Object.entries(e.comp ?? {})) add('comp', { id, type, data });
    if (e.parent) add('mount', { id, ...e.parent });
  }
  // body mounts: without these a rejoined body doesn't know it is sitting on
  // anything — "standing up" never dismounts (#61, princess on the crate)
  for (const [rid, m] of Object.entries(state.mounts ?? {})) {
    const rel = bodyMountRel === 'seat'
      ? { to: m.to, ...(m.slot ? { slot: m.slot } : {}) }
      : m;
    add('mount', { id: rid, ...rel }, bodyMountActor === 'rider' ? rid : 'world');
  }
  if (behaviors) {
    for (const [id, b] of Object.entries(state.behaviors ?? {})) {
      add('behavior', { id, src: b.src, ...(b.runtime ? { runtime: b.runtime } : {}),
        ...(b.knobs ? { knobs: b.knobs } : {}), by: b.author }, b.author ?? 'world', b.ts ?? now);
    }
  }
  // Anything the tail will replay must not also be rendered from the
  // snapshot. Chat keeps its REAL seq, unlike the world-shaping entries
  // above: it is the only part of a snapshot that is a position in history
  // rather than a description of the present.
  for (const m of state.recentChat ?? []) {
    if ((m.seq ?? -1) >= skipChatFromSeq) continue;
    out.push({ seq: typeof m.seq === 'number' ? m.seq : seq--, ts: m.ts, actor: m.actor,
               verb: 'say', args: { text: m.text } });
  }
  return out;
}
