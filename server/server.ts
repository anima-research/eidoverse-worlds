// eidoverse-worlds sequencer.
// The server is a sequencer and archivist, NOT a simulator:
//  - orders + persists per-world event logs (the authored plane)
//  - relays presence (the embodied plane, never persisted)
//  - serves the browser client and the eidoverse-video asset library
// No world manifest: everything about a world arrives through its log.

import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve, normalize, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { verifyToken, JtiCache } from "./aid1.ts";
import { BehaviorHost, wireBehaviorGate, wireBehaviorStore, behaviorLimits, type BehaviorRec } from "./behaviors.ts";
import { summarizeGlb } from "./geometry.ts";
// Pure and dependency-free — the same fold the browser client and the mcpl
// agent run, which is what keeps all three planes' skies in agreement.
import { foldSkyEntry } from "../client/lib/forecast.js";
// Likewise for the `particles` component: one validator, so the flight
// recorder's opinion about an emitter is the renderer's own opinion.
import { normalizeParticles } from "../client/lib/particles.js";

const PORT = Number(process.env.PORT ?? 8940);
// Show-night door policy. Empty = open (dev on a tailnet). On a public box you
// MUST set this — the boot log shouts if you forgot. Checked at join and upload.
const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
const UPLOAD_CAP = Number(process.env.UPLOAD_CAP_MB ?? 20) * 1_000_000;
// ---- archipelago-home identity (docs/home-node.md §7) ----------------------
// The second door, alongside JOIN_TOKEN: humans log in with Discord at the
// home node, arrive at /auth with an aid1 token in the URL fragment, swap it
// for a session cookie here, and join with a VERIFIED identity. Verification
// is offline (issuer pubkey below); the home node down = existing sessions
// and the JOIN_TOKEN door keep working.
//   HN_ISSUER_KEY   pinned issuer pubkey `ed25519:…` — unset disables the door
//   HN_ISS          issuer domain            (default id.animalabs.ai)
//   HN_LOGIN_URL    where "Login with Discord" sends people
//   HN_REQUIRE_LOGIN=1  browser clients without a session are sent to login
//                       (JOIN_TOKEN joins still pass — invite links keep working)
const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
const HN_AUD = "eidoverse";
const HN_LOGIN_URL = process.env.HN_LOGIN_URL ?? `https://${HN_ISS}/login?audience=${HN_AUD}`;
const HN_REQUIRE_LOGIN = process.env.HN_REQUIRE_LOGIN === "1";
const SESSION_TTL_MS = 12 * 60 * 60_000; // event-length; re-login is two clicks

type HnSession = { sub: string; name: string; scopes: string[]; claims?: Record<string, unknown>; exp: number };
const hnSessions = new Map<string, HnSession>();
const hnJti = new JtiCache();
function sessionFromCookie(cookie: string | null): HnSession | null {
  const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(cookie ?? "");
  if (!m) return null;
  const s = hnSessions.get(m[1]!);
  if (!s) return null;
  if (s.exp < Date.now()) { hnSessions.delete(m[1]!); return null; }
  return s;
}
// RECORD_FRAMES=1 appends every broadcast stage frame (plus roster deltas) to
// worlds/<name>/frames-<bootTs>.jsonl. World log + frames file + asset store =
// enough to re-render the whole performance offline, at production quality,
// forever. Clients are told at join — recording is never invisible.
const RECORD = process.env.RECORD_FRAMES === "1";
const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the
// live worlds' logs (they are append-only and forever — a stray dev spawn is
// permanent). Default keeps the production path unchanged.
const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
const OPT_DIR = join(ROOT, "assets", "opt");
// Optimized shadows of store uploads (draco+webp@1024, see server/optimize.ts).
// Originals in store/ are never touched; /library serving prefers a store-min
// sibling when one exists. `.failed` markers stop hopeless files from being
// retried every boot.
const STORE_MIN = join(OPT_DIR, "store-min");

mkdirSync(WORLDS_DIR, { recursive: true });

// ---- session persistence ----------------------------------------------------
// Sessions used to be memory-only, so every deploy logged the whole show out
// and sent verified humans back to the door mid-event. They survive restarts
// now. The file holds bearer-equivalent session ids — 0600 and gitignored,
// same posture as mcpl/tokens.json.
const SESSIONS_FILE = join(ROOT, ".sessions.json");
function saveSessions() {
  try {
    const live = [...hnSessions].filter(([, s]) => s.exp > Date.now());
    writeFileSync(`${SESSIONS_FILE}.tmp`, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 });
    renameSync(`${SESSIONS_FILE}.tmp`, SESSIONS_FILE); // atomic — a crash mid-write never truncates the live file
  } catch (e) { console.log(`[auth] session save failed: ${e}`); }
}
try {
  if (existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<string, HnSession>;
    for (const [sid, s] of Object.entries(raw)) {
      if (/^[a-f0-9]{64}$/.test(sid) && s.exp > Date.now()) hnSessions.set(sid, s);
    }
    if (hnSessions.size) console.log(`[auth] restored ${hnSessions.size} live session(s)`);
  }
} catch (e) { console.log(`[auth] session restore failed (starting empty): ${e}`); }

// ---- global bans ------------------------------------------------------------
// Per-world bans live in each world's log (the `ban` verb — event-sourced,
// auditable, fork-copied, like roles). There is no global log, so the
// instance-wide list is a JSON file INSIDE WORLDS_DIR (not ROOT): bans are
// world data, and a dev sequencer pointed at a scratch WORLDS_DIR must get a
// scratch ban list too — same doctrine as the logs themselves. Keyed by
// lowercased display id, carrying the durable principal `sub` when it was
// known at ban time (a name is evadable by /name; a sub is not).
type BanRec = { by: string; ts: number; reason?: string; sub?: string };
const BANS_FILE = join(WORLDS_DIR, ".bans.json");
const globalBans: Record<string, BanRec> = {};
function saveGlobalBans() {
  try {
    writeFileSync(`${BANS_FILE}.tmp`, JSON.stringify(globalBans, null, 2), { mode: 0o600 });
    renameSync(`${BANS_FILE}.tmp`, BANS_FILE);
  } catch (e) { console.log(`[mod] global ban save failed: ${e}`); }
}
try {
  if (existsSync(BANS_FILE)) {
    const raw = JSON.parse(readFileSync(BANS_FILE, "utf8")) as Record<string, BanRec>;
    for (const [id, b] of Object.entries(raw)) if (b && typeof b.by === "string") globalBans[id.toLowerCase()] = b;
    if (Object.keys(globalBans).length) console.log(`[mod] ${Object.keys(globalBans).length} global ban(s) loaded`);
  }
} catch (e) { console.log(`[mod] global ban restore failed (starting empty): ${e}`); }

/** Does this ban list hit this identity? Checked under both handles, same
 *  doctrine as rightsOf: the display id (case-insensitive) and the durable
 *  principal sub. Ban lists are small; the sub scan is nothing. */
function findBan(map: Record<string, BanRec> | undefined, id: string, sub?: string): BanRec | null {
  if (!map) return null;
  const hit = map[id.toLowerCase()];
  if (hit) return hit;
  if (sub) for (const b of Object.values(map)) if (b.sub === sub) return b;
  return null;
}

// ---------------------------------------------------------------- world logs

type LogEntry = {
  seq: number;
  ts: number;
  actor: string;
  verb: string;
  args: Record<string, unknown>;
};

/** The world as it IS, rather than everything that ever happened to it.
 *
 *  A log is history and grows forever — that is the point of it, and it is why
 *  a world is forkable and re-filmable. But replaying all of history to show
 *  someone a room is the wrong cost: joining should scale with how much is in
 *  the world now, not with how long the world has existed.
 *
 *  So this is a DERIVED CACHE, never a source of truth. Delete every snapshot
 *  file and the worlds are identical after the next boot, just slower to load.
 *  Nothing here is allowed to be information the log does not contain. */
type WorldState = {
  entities: Record<string, {
    kind?: "light"; pos: number[]; actor: string; ts: number;
    lib?: string; yaw?: number; scale?: number;                 // things
    color?: number; intensity?: number; range?: number;         // lights
    keep?: boolean;   // lights: exempt from the client perf governor's shedding
    /** Generic component bag, written by `comp` verbs. The server folds these
     *  BLINDLY — it never learns what a component means. Meaning lives in
     *  client-side evaluators (motion, sockets, reactions, …), so a new
     *  component type is client code + emitted verbs, zero server changes. */
    comp?: Record<string, unknown>;
    /** Scene-graph attachment: this entity rides another (cargo on a truck,
     *  a lantern on a swing). Transform becomes parent-relative. */
    parent?: { to: string; slot?: string; offset?: number[]; yaw?: number };
  }>;
  /** Attachments of non-entity bodies (avatars) — a sitter on a swing seat, a
   *  passenger on a deck. Same shape as entity.parent, keyed by principal. */
  mounts?: Record<string, { to: string; slot?: string; offset?: number[]; yaw?: number }>;
  terrain: Record<string, unknown> | null;
  grass: Record<string, unknown> | null;
  sky: (Record<string, unknown> & { ts?: number }) | null;
  assets: { name: string; path: string }[];
  /** A little conversational context for arrivals. NOT the chat archive —
   *  the log holds that. */
  /** seq is carried so a joiner can tell which of these the TAIL will also
   *  deliver — state and tail overlap whenever a world has not folded recently,
   *  and without it every such message renders twice. */
  recentChat: { actor: string; text: string; ts: number; seq: number }[];
  /** Everything ever said here, so a joiner can be told that what it is
   *  looking at is a window and not the whole conversation. */
  chatTotal: number;
  /** Per-world permissions, fed by owner-authored `grant` verbs in the log —
   *  event-sourced like everything else, so roles replay, fold, and audit.
   *  A world with NO owner in this map is OPEN (everyone builds — the
   *  pre-permissions behaviour, and what a scratch world should be).
   *  The moment an owner exists, unlisted ids are visitors.
   *  `gen` is the spend capability: bringing NEW assets into the world's
   *  vocabulary (the `asset` verb — where Orrery generations land). */
  roles: Record<string, { role: "owner" | "builder" | "visitor"; gen?: boolean;
    /** durable subject binding: when present, only this sub wears the grant */
    sub?: string }>;
  /** Per-world bans, fed by owner-authored `ban`/`unban` verbs in the log —
   *  event-sourced like roles, so a ban replays, folds, audits, and rides a
   *  fork. Keyed by lowercased display id; `sub` (when the target was present
   *  to be identified at ban time) makes the ban survive a rename. Optional
   *  because snapshots from before this verb lack the map. */
  bans?: Record<string, { by: string; ts: number; reason?: string; sub?: string }>;
  /** Runtime scripts bound into this world by `behavior` entries. The script
   *  BYTES live in the content-addressed store; this holds the binding
   *  (src, attach, caps, knobs, author) plus each script's persisted kv
   *  (`state`, folded from bstate entries). See server/behaviors.ts. */
  behaviors?: Record<string, BehaviorRec>;
};
const RECENT_CHAT = 40;
/** How many entries may accumulate past a snapshot before folding again.
 *  Small enough that a joiner's tail stays trivial, large enough that a busy
 *  world is not writing a snapshot per action. */
const FOLD_EVERY = Number(process.env.FOLD_EVERY ?? 150);
/** Authored verbs allowed per client per 4s. A griefer gets silence; a person
 *  arranging furniture must not. Configurable because a build session and a
 *  show night want different answers. */
const VERB_RATE = Number(process.env.VERB_RATE ?? 12);
/** All messages per client per second — 15Hz of pose plus verbs plus slack. */
const MSG_RATE = Number(process.env.MSG_RATE ?? 60);

const emptyState = (): WorldState => ({
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
 *  within a speaker; fairness decides between them. */
function trimRecentChat(rc: WorldState["recentChat"]): void {
  while (rc.length > RECENT_CHAT) {
    const counts = new Map<string, number>();
    for (const m of rc) counts.set(m.actor, (counts.get(m.actor) ?? 0) + 1);
    let victim = -1;
    let worst = 1;
    for (let i = 0; i < rc.length; i++) {
      const n = counts.get(rc[i].actor)!;
      if (n > worst) { worst = n; victim = i; }      // oldest line of the loudest
    }
    rc.splice(victim >= 0 ? victim : 0, 1);          // everyone tied at 1: oldest goes
  }
}

/** Fold one entry into the running state. This is the ONLY place that knows how
 *  a verb changes the world's shape, and it must stay a pure function of the
 *  log — if it ever disagrees with the client's applyEntry, joiners see a world
 *  that never existed. */
function foldEntry(st: WorldState, e: LogEntry): void {
  const a = e.args as any;
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
      // light exempt from the client perf governor's shedding (keep: false
      // clears it). A non-light already holding the id is replaced wholesale,
      // same as before — the id namespace is flat.
      const prev = st.entities[a.id];
      const base = prev?.kind === "light" ? prev : null;
      const keep = a.keep ?? base?.keep;
      st.entities[a.id] = {
        kind: "light", pos: a.pos ?? base?.pos ?? [0, 1, 0],
        color: a.color ?? base?.color ?? 0xffd9a0,
        intensity: a.intensity ?? base?.intensity ?? 16,
        range: a.range ?? base?.range ?? 10,
        ...(keep ? { keep: true } : {}),
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
      const cur = st.roles[a.id] ?? { role: "builder" as const };
      const role = ROLE_RANK[a.role as string] != null ? a.role : cur.role;
      const gen = a.gen != null ? Boolean(a.gen) : cur.gen;
      // Durable ink (Hesperus finding #1): when the grant was written while
      // its subject's durable sub was KNOWN, the grant carries it — and only
      // that sub can wear it. A display name is a nameplate, not a deed;
      // before this, anyone reusing an offline owner's nick inherited the
      // world. Grants without a sub (unauthenticated ids, pre-fix history)
      // keep their old name-keyed meaning.
      st.roles[a.id] = { role, ...(gen ? { gen: true } : {}),
        ...(a.sub ? { sub: String(a.sub) } : (cur as any).sub ? { sub: (cur as any).sub } : {}) };
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

// ---------------------------------------------------------------- motion lint
//
// The fold is blind and the evaluator is client-side — which means a motion
// whose params the evaluator can't read fails as pure SILENCE: rights-legal,
// shape-legal, folded, and perfectly still. Fable spent a night debugging
// exactly that, reading a flight recorder that truthfully contained nothing,
// because the server had no opinion and the one component type it DOES
// understand (it stamps t0, computes impulses) never shared what it knew.
//
// This is the sharing. Advisory only — the entry has already folded and
// nothing here can (or should) block it. Runs detached from the verb path;
// findings land in the recorder within a second, kind "motion-lint".

const MOTION_TYPES: Record<string, Set<string>> = {
  pendulum: new Set(["type", "axis", "pivot", "amp", "amplitude", "period", "phase", "damp", "maxAmp", "t0", "part", "cause", "by"]),
  spin: new Set(["type", "axis", "pivot", "degPerSec", "rpm", "phase", "t0", "part", "cause", "by"]),
  orbit: new Set(["type", "center", "radius", "degPerSec", "phase", "face", "t0", "part", "cause", "by"]),
  bob: new Set(["type", "axis", "amp", "amplitude", "period", "phase", "t0", "part", "cause", "by"]),
  path: new Set(["type", "points", "speed", "duration", "loop", "face", "t0", "part", "cause", "by"]),
};

function resolveLibFile(lib: string): string | null {
  const rel = normalize(lib).replace(/^\/+/, "");
  if (rel.includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
  for (const base of [OPT_DIR, LIBRARY_DIR]) {
    const p = normalize(join(base, rel));
    if (p.startsWith(base) && existsSync(p)) return p;
  }
  return null;
}

function lintMotion(w: World, entry: LogEntry): void {
  // detached on purpose: geometry parsing is async and the verb path is not
  void (async () => {
    try {
      const a = entry.args as Record<string, unknown>;
      const m: Record<string, unknown> = entry.verb === "motion" ? a
        : (a?.data as Record<string, unknown>) ?? {};
      const type = m.type;
      if (type == null) return;                       // coming to rest — nothing to lint
      const id = String(a.id ?? "");
      const part = typeof m.part === "string" ? m.part
        : entry.verb === "comp" && String(a.type ?? "").startsWith("motion:") ? String(a.type).slice(7) : null;
      const known = MOTION_TYPES[String(type)];
      if (!known) {
        w.debug("motion-lint", { entity: id, by: entry.actor,
          why: `motion type "${type}" is unknown to current clients (${Object.keys(MOTION_TYPES).join("/")}) — the thing will stand still until an evaluator learns it` });
        return;
      }
      const ignored = Object.keys(m).filter((k) => k !== "id" && !known.has(k) && !k.startsWith("_"));
      if (ignored.length) {
        w.debug("motion-lint", { entity: id, by: entry.actor,
          why: `params the evaluator will ignore on ${type}: ${ignored.join(", ")} (accepted: ${[...known].filter((k) => !["cause", "by", "part", "type"].includes(k)).join(", ")})` });
      }
      if (part) {
        const ent = w.state.entities[id];
        const file = ent?.lib ? resolveLibFile(ent.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        if (sum) {
          const names = sum.nodes.map((n) => n.name);
          if (!names.includes(part)) {
            const orphanNote = sum.orphans?.includes(part)
              ? ` — "${part}" IS in the file but attached to no scene: an export leftover no client renders`
              : "";
            w.debug("motion-lint", { entity: id, by: entry.actor,
              why: `part "${part}" is not among ${id}'s rendered parts [${names.join(", ")}]${orphanNote}` });
          }
        }
      }
    } catch { /* lint must never hurt anything */ }
  })();
}

/** The same courtesy for `particles`, from the same shared module the browser
 *  host and the mcpl agent validate with — so what the recorder says is
 *  exactly what a renderer will do, not a second opinion about it. Advisory:
 *  the component has already folded, and an unrenderable emitter still
 *  persists and still reads as an emitter in text-tier perception. */
function lintParticles(w: World, entry: LogEntry): void {
  try {
    const a = entry.args as Record<string, unknown>;
    const id = String(a.id ?? "");
    if (a.data == null) return;                      // put out — nothing to lint
    const r = normalizeParticles(a.data, { entityId: id });
    if (!r.ok) {
      w.debug("particles-lint", { entity: id, by: entry.actor, why: r.why });
      return;
    }
    if (r.notes.length) {
      w.debug("particles-lint", { entity: id, by: entry.actor, why: r.notes.join(" · ") });
    }
  } catch { /* lint must never hurt anything */ }
}

// ---------------------------------------------------------------- reactions
//
// The first slice of the behavior runtime: an entity's `reactions` component
// maps a use-action to an effect. The shape is the general one — triggers in,
// ordinary logged verbs out, cause carried in the entry — even though only one
// effect kind exists so far (a pendulum impulse: the swing). Reactions run
// with WORLD authority precisely because the trigger is rank 0: a visitor may
// push the swing, and the push moving the swing is the AUTHOR's standing
// decision (they attached the component), not the visitor's rights.
//
// Wrapped whole in try/catch: no reaction may ever take the server down
// (lesson of the 4f82250 crash loop — a ws handler must never leak a throw).

function reactToUse(w: World, cause: LogEntry): void {
  const a = cause.args as Record<string, unknown>;
  const id = String(a?.id ?? "");
  const action = String(a?.action ?? "use");
  try {
    const ent = w.state.entities[id];
    if (!ent) {
      w.debug("reaction-skip", { entity: id, action, by: cause.actor, why: "no such entity" });
      return;
    }
    const rx = (ent.comp?.reactions as Record<string, any> | undefined)?.[action];
    if (!rx) {
      w.debug("reaction-skip", { entity: id, action, by: cause.actor,
        why: ent.comp?.reactions ? `no reaction for "${action}" (has: ${Object.keys(ent.comp.reactions as object).join(", ")})`
          : "entity has no reactions component" });
      return;
    }
    if (rx.impulse != null) {
      const m = (ent.comp?.motion as Record<string, unknown>) ?? {};
      if (m.type != null && m.type !== "pendulum") {   // impulses push pendulums (so far)
        w.debug("reaction-skip", { entity: id, action, by: cause.actor,
          why: `impulse needs a pendulum motion, found "${m.type}"` });
        return;
      }
      const next = pendulumImpulse(m, Number(rx.impulse), cause.ts);
      const entry = w.append("world", "motion",
        { id: a.id, ...next, cause: cause.seq, by: cause.actor });
      w.broadcast({ type: "log", entry });
      w.debug("reaction", { entity: id, action, by: cause.actor, cause: cause.seq, effect: entry.seq });
      return;
    }
    w.debug("reaction-skip", { entity: id, action, by: cause.actor,
      why: `reaction has no effect this server knows (${Object.keys(rx).join(", ")})` });
  } catch (err) {
    console.error(`[world:${w.name}] reaction failed (never fatal)`, err);
    w.debug("reaction-error", { entity: id, action, by: cause.actor, error: String(err) });
  }
}

/** Closed-form pendulum push: evaluate angle and angular velocity at the push
 *  instant, add the impulse to velocity, re-express as fresh (amp, phase, t0).
 *  Pushing against the motion does little; pushing with it builds — a real
 *  swing's feel, in one logged entry. Damping is applied to amplitude between
 *  pushes and ignored in the instantaneous velocity term (small for the damp
 *  values that look right).
 *  ⚠ MIRRORED in client/lib/motion.js (evalPendulum) — keep the math in sync,
 *  or joiners see a swing that disagrees with the one being pushed. */
function pendulumImpulse(m: Record<string, unknown>, impulse: number, ts: number) {
  const period = Number(m.period ?? 3.5);
  const w0 = (2 * Math.PI) / period;
  // mirrored with pendulumTheta: missing damp = 0 = perpetual. Friction is
  // opt-in; pushable-swing recipes set it explicitly because decay-between-
  // pushes is part of that design.
  const damp = Number(m.damp ?? 0);
  const t = m.t0 != null ? Math.max(0, (ts - Number(m.t0)) / 1000) : 0;
  // generous reader, mirrored with the client: `amplitude` is amp too
  const amp = Number(m.amp ?? (m as any).amplitude ?? 0) * Math.exp(-damp * t);
  const ph = w0 * t + Number(m.phase ?? 0);
  const theta = amp * Math.cos(ph);
  const vel = -amp * w0 * Math.sin(ph) + (Number.isFinite(impulse) ? impulse : 0);
  const maxAmp = Number(m.maxAmp ?? 1.1);
  const namp = Math.min(maxAmp, Math.hypot(theta, vel / w0));
  const nphase = Math.atan2(-(vel / w0), theta);
  return {
    type: "pendulum",
    axis: (m.axis as number[]) ?? [1, 0, 0],
    pivot: (m.pivot as number[]) ?? [0, 2, 0],
    period, damp,
    ...(m.maxAmp != null ? { maxAmp } : {}),
    amp: Math.round(namp * 1000) / 1000,
    phase: Math.round(nphase * 1000) / 1000,
    t0: ts,
  };
}

// ---------------------------------------------------------------- permissions
//
// Per-world roles, aligned with connectome/docs/home-node.md: the id in the
// roles map is the principal — today a self-asserted name (humans) or a
// token-verified agent name; when archipelago-home lands, aid1 `sub`s slot in
// here without the model changing. Rights ladder:
//   visitor  present, talk, emote           (say)
//   builder  + spawn / place / remove / drag         (build)
//   owner    + terrain / grass / sky / weather / grant  (shape the world)
//   gen      orthogonal capability: introduce NEW assets (`asset` verb) —
//            the landing point of Orrery generations, i.e. "spend".
// A world with no owner is OPEN: everyone is builder+gen (pre-permissions
// behaviour; scratch worlds stay frictionless). First embodied joiner of a
// brand-new world is auto-granted owner.
const ROLE_RANK: Record<string, number> = { visitor: 0, builder: 1, owner: 2 };
// Operators (comma-separated ids) who are owner+gen EVERYWHERE — the
// bootstrap for pre-permissions worlds and the lockout recovery.
const ADMIN_IDS = new Set((process.env.WORLD_ADMIN ?? "").split(",").map((s) => s.trim()).filter(Boolean));

function worldHasOwner(st: WorldState): boolean {
  for (const [id, r] of Object.entries(st.roles ?? {})) {
    if (id !== "*" && r.role === "owner") return true;
  }
  return false;
}
function rightsOf(w: World, id: string, sub?: string): { role: string; gen: boolean } {
  // Grants are honored under either handle: the display id (what owners see
  // and type) or the durable principal sub (what survives a rename —
  // home-node.md §5: key state by sub). WORLD_ADMIN accepts both too.
  if (ADMIN_IDS.has(id) || (sub && ADMIN_IDS.has(sub))) return { role: "owner", gen: true };
  if (!worldHasOwner(w.state)) return { role: "builder", gen: true };   // open world
  // In an OWNED world, unlisted ids take the wildcard default: builder
  // WITHOUT gen unless the owner says otherwise. Editing stays frictionless
  // for drop-in company; introducing new assets (spend) is what's restricted
  // by default. `/grant * visitor` closes the world; `/grant * +gen` opens
  // generation to everyone.
  let r = (sub ? w.state.roles?.[sub] : undefined) ?? w.state.roles?.[id] ?? w.state.roles?.["*"] ?? { role: "builder" as const };
  // a name-keyed grant that KNOWS its subject's sub is worn only by that sub
  if ((r as any).sub && (r as any).sub !== sub) {
    r = w.state.roles?.["*"] ?? { role: "builder" as const };
  }
  return { role: r.role, gen: r.role === "owner" || Boolean(r.gen) };
}
/** What each verb demands. `asset` is the spend gate; `grant` is owner-only. */
const VERB_NEEDS: Record<string, { rank: number; gen?: boolean }> = {
  say: { rank: 0 },
  // Using the world is for everyone; only authoring it is gated.
  use: { rank: 0 },
  // mount/dismount are rank 1 for THINGS (loading cargo is building) but the
  // gate drops them to rank 0 when you mount YOURSELF — sitting on a swing is
  // using the world, not editing it. See the verb handler.
  mount: { rank: 1 }, dismount: { rank: 1 },
  comp: { rank: 1 }, motion: { rank: 1 },
  // Binding a runtime script is building — the sandbox, capability mask,
  // author-rights-at-emit, and budgets are what make builder-rank safe.
  // (`bstate` is deliberately absent: only the server writes script state.)
  behavior: { rank: 1 },
  spawn: { rank: 1 }, place: { rank: 1 }, remove: { rank: 1 }, light: { rank: 1 },
  // An instantaneous radial push (blast, gust). Authoring a physical event is
  // building; whether any BODY moves stays each body's own consent (pushable,
  // client-side) — this rank only stops visitors from spamming detonations.
  force: { rank: 1 },
  // Punting a thing is USING the world (docs/leases.md): the verb is the
  // CAUSE — logged, attributed, replay-inert — and any present client with a
  // physics plugin volunteers to simulate it (the lease table arbitrates the
  // race). This is why agents need no special tool: world_verb punt. (It is
  // `punt`, not `kick`, on the wire — `kick` is moderation's remove-a-person,
  // and one log word meaning two acts by referent type is a landmine.)
  punt: { rank: 0 },
  asset: { rank: 1, gen: true },
  terrain: { rank: 2 }, grass: { rank: 2 }, sky: { rank: 2 }, weather: { rank: 2 },
  grant: { rank: 2 },
  // Moderation is owner power, exactly like grant — and agents get it through
  // the same gate, so an agent OWNING a world can moderate it with no extra
  // capability machinery. (Global bans are not verbs at all: see "global-ban".)
  kick: { rank: 2 }, ban: { rank: 2 }, unban: { rank: 2 },
};

/** WORLD_ADMIN under either handle — the same doctrine as rightsOf. */
function isAdminId(id: string, sub?: string): boolean {
  return ADMIN_IDS.has(id) || (sub != null && ADMIN_IDS.has(sub));
}

/** Is this verb trying to move or destroy a nailed-down thing?
 *
 *  `comp {id, type: "lock", data: true}` nails an entity in place: while the
 *  lock is on, nothing may move it (place, punt, cargo-mount), replace it
 *  (spawn/light onto the same id), or remove it. It is an ACCIDENT guard, not
 *  a rights system — anyone builder+ can toggle it, and the deliberate
 *  unlock (`data: null`) is exactly what converts an accident into an intent.
 *  Everything that doesn't relocate the thing stays open: sitting ON it
 *  (self-mount), use, motion, behaviors, other comps — content, not carpentry.
 *  Applies to everyone including the locker: your own stray drag is the
 *  original accident (a build-mode fallthrough once relocated Fable's swing). */
const LOCK_GUARDED = new Set(["place", "remove", "punt", "mount", "spawn", "light"]);
function lockRefusal(w: World, verb: string, args: Record<string, unknown> | undefined): string | null {
  if (!LOCK_GUARDED.has(verb)) return null;
  const id = String(args?.id ?? "");
  const ent = id ? w.state.entities[id] : undefined;   // people aren't entities — self-mount passes here
  if (!ent?.comp?.lock) return null;
  const act = verb === "remove" ? "remove" : verb === "spawn" || verb === "light" ? "replace" : "move";
  return `"${id}" is locked — unlock it first (comp {id: "${id}", type: "lock", data: null}) to ${act} it`;
}

// Behavior sandbox wiring: a script's emit is gated by its AUTHOR's live
// rights (revoke the grant, the behavior loses its teeth) through the same
// table as everyone else. The store path is where `?as=script` uploads land.
wireBehaviorStore(join(ROOT, "assets", "opt"));
wireBehaviorGate((w, author, verb, args) => {
  const needs = VERB_NEEDS[verb];
  if (!needs) return `verb not allowed: ${verb}`;
  const rights = rightsOf(w as unknown as World, author);
  if (ROLE_RANK[rights.role] < needs.rank || (needs.gen && !rights.gen)) {
    return `"${verb}" needs more than ${author}'s "${rights.role}" role here`;
  }
  // a locked thing refuses scripts by the same rule as hands (a behavior
  // nudging a nailed-down bench is still an accident vector)
  return lockRefusal(w as unknown as World, verb, args);
});

// Agent identity: the MCPL door (mcpl/tokens.json) already holds per-agent
// bearer tokens. The sequencer reads the same file so (a) an agent's name is
// RESERVED — a plain browser join cannot claim it — and (b) a join carrying
// the right token is a verified agent. Hot-reloaded by mtime, like the MCPL
// server does.
const AGENT_TOKENS_PATH = join(ROOT, "mcpl", "tokens.json");
let agentTokCache: { mtime: number; byToken: Map<string, string>; names: Set<string> } | null = null;
function agentTokens() {
  try {
    const mtime = existsSync(AGENT_TOKENS_PATH) ? Math.round(Bun.file(AGENT_TOKENS_PATH).lastModified) : 0;
    if (!agentTokCache || agentTokCache.mtime !== mtime) {
      const byToken = new Map<string, string>();
      const names = new Set<string>();
      if (mtime) {
        const raw = JSON.parse(readFileSync(AGENT_TOKENS_PATH, "utf8")) as Record<string, { id?: string }>;
        for (const [tok, v] of Object.entries(raw)) {
          if (!v?.id) continue;
          byToken.set(tok, v.id);
          names.add(v.id.toLowerCase());
        }
      }
      agentTokCache = { mtime, byToken, names };
    }
  } catch (e) {
    console.error("[perm] mcpl/tokens.json unreadable:", (e as Error).message);
    agentTokCache ??= { mtime: 0, byToken: new Map(), names: new Set() };
  }
  return agentTokCache;
}

/** A pose as it should be handed to SOMEONE ELSE — the settled result rather
 *  than whatever frame the body happened to be in.
 *
 *  Two callers, and they used to disagree, which was the bug (#61): the join
 *  snapshot's `restore` (your own body) went through rememberPose and came back
 *  normalized, while `present` (everyone else's bodies) shipped lastPose raw.
 *  So a resident mid-ragdoll looked fine to herself and arrived collapsed for
 *  every joiner — for weeks, with no way to tell from inside her own session.
 *
 *  - emote: a one-shot is a moment, not a place. Replaying it at every wake
 *    would make a wave into a tic.
 *  - ragdoll: physics in flight, not an enacted pose. The get-up path only
 *    exists in the session that fell, so anyone receiving it is stuck with a
 *    body hung in tumble bones. Sleep standing.
 *  Held bones (pose.pose) survive both: an enacted pose is a place. */
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { emote: _emote, ...still } = pose as Record<string, unknown>;
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}

class World {
  name: string;
  entries: LogEntry[] = [];
  clients = new Set<Client>();
  /** Poses received since the last stage-frame tick — latest value wins.
   *  The embodied plane is batched: N performers × M spectators must not be
   *  N×M×15Hz individual sends (24×200 would be 72k msgs/s); it's one frame
   *  per world per tick, fanned out once. */
  dirty = new Map<string, unknown>();
  /** Entity animation leases (docs/leases.md): who may animate each object
   *  right now, and the last transform they streamed — the server's memory,
   *  so a crashed or preempted simulator never loses an object. Presence
   *  plane: never persisted; outcomes commit as `place` verbs. */
  leases = new Map<string, { holder: Client; lastState: { p: number[]; yaw?: number; q?: number[] } | null; lastAt: number }>();

  /** Commit-and-forget one entity lease (docs/leases.md): the last streamed
   *  transform becomes an ordinary `place` entry — server-authored like a
   *  reaction effect, the cause in args — so nothing is ever lost to a
   *  crashed, preempted, or stale simulator. */
  settleLease(id: string, final?: { p?: number[] | null; yaw?: number | null }) {
    const L = this.leases.get(id);
    if (!L) return;
    const p = final?.p ?? L.lastState?.p ?? null;
    const yaw = final?.yaw ?? L.lastState?.yaw;
    this.leases.delete(id);
    if (p && this.state.entities[id]) {
      const entry = this.append("world", "place", {
        id, pos: p, ...(yaw != null ? { yaw } : {}), by: L.holder.id, via: "lease",
      });
      this.broadcast({ type: "log", entry });
    }
    this.broadcast({ type: "lease", op: "released", id });
  }
  /** The runtime's flight recorder — the "why didn't it work" surface.
   *
   *  The world log holds what HAPPENED; this ring holds what DIDN'T and why:
   *  denied verbs, rejected shapes, rate limits, reactions that fired /
   *  skipped / failed. In-memory only, capped, never persisted — it is
   *  diagnosis, not history. Readable by anyone in the world (ws `debug`,
   *  `/debug` in the client, `world_debug` over MCPL): the log is public, so
   *  the reasons things bounced off it are public too. */
  debugLog: Record<string, unknown>[] = [];
  debug(kind: string, detail: Record<string, unknown>): void {
    this.debugLog.push({ ts: Date.now(), kind, ...detail });
    if (this.debugLog.length > 300) this.debugLog.splice(0, this.debugLog.length - 300);
  }
  frameSeq = 0;
  recPath: string | null = null; // frames archive, created lazily on first recorded frame
  lastRoster = "";               // last written roster line — deltas only
  /** The folded world. Kept live: every append updates it, so writing a
   *  snapshot is O(1) rather than a replay. */
  state: WorldState = emptyState();
  /** Runtime-script host — sandboxes, budgets, per-behavior log rings. */
  bhv!: BehaviorHost;
  /** How much of the log the snapshot already accounts for. Entries after this
   *  are the tail a joiner still has to be told about. */
  snapSeq = -1;
  private snapBytes = 0;      // byte offset in log.jsonl just past snapSeq
  private logBytes = 0;
  private dirtySinceFold = 0;
  private logPath: string;
  private posesPath: string;
  private snapPath: string;
  /** Where each identity last stood — the world remembers your resting place
   *  across disconnects, restarts, and hosts. Presence is ephemeral; the
   *  place you fell asleep is yours. */
  poses: Record<string, unknown> = {};

  constructor(name: string) {
    this.name = name;
    const dir = join(WORLDS_DIR, name);
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "log.jsonl");
    this.posesPath = join(dir, "poses.json");
    this.snapPath = join(dir, "snapshot.json");

    // Boot = snapshot + the bytes after it. The offset is what keeps startup
    // proportional to the TAIL rather than to the whole history: without it we
    // would still parse every line ever written just to find where to resume.
    if (existsSync(this.snapPath)) {
      try {
        const snap = JSON.parse(readFileSync(this.snapPath, "utf8"));
        if (snap?.state && typeof snap.seq === "number") {
          this.state = snap.state;
          this.snapSeq = snap.seq;
          this.snapBytes = snap.bytes ?? 0;
        }
      } catch { /* a corrupt cache is not a corrupt world — rebuild below */ }
    }
    if (existsSync(this.logPath)) {
      const buf = readFileSync(this.logPath);
      this.logBytes = buf.length;
      // If the offset is not credible (log truncated, forked, or snapshot from
      // another timeline) fall back to reading everything. The log is truth.
      const usable = this.snapSeq >= 0 && this.snapBytes > 0 && this.snapBytes <= buf.length;
      if (!usable) { this.state = emptyState(); this.snapSeq = -1; this.snapBytes = 0; }
      const text = buf.toString("utf8", usable ? this.snapBytes : 0);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as LogEntry;
        this.entries.push(e);
        foldEntry(this.state, e);
      }
      this.dirtySinceFold = this.entries.length;
    }
    if (existsSync(this.posesPath)) {
      try { this.poses = JSON.parse(readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ }
    }
    // A brand-new world's first entry names the log dialect — the one fix
    // with a deadline, because it only helps logs written after it exists
    // (Hesperus finding #5). Old readers fold it as an unknown verb: nothing.
    if (this.logBytes === 0 && this.snapSeq < 0) {
      this.append("world", "genesis", { v: 2, dialect: "eidoverse-log" });
    }
    // Runtime scripts wake with the world — a behavior keeps behaving with
    // nobody connected (timers), which is the point of running server-side.
    this.bhv = new BehaviorHost(this);
    this.bhv.sync();
    const total = this.snapSeq + 1 + this.entries.length;
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, `
      + `${this.entries.length} tail entr${this.entries.length === 1 ? "y" : "ies"}`
      + (this.snapSeq >= 0 ? ` (snapshot through seq ${this.snapSeq}, ${total} total)` : "")
      + `, ${Object.keys(this.poses).length} remembered poses`);
  }

  /** Write the folded state beside the log. Atomic, and recording the byte
   *  offset so the next boot can seek instead of scan. */
  fold(reason = "threshold") {
    const bytes = this.logBytes;
    const seq = this.snapSeq + this.entries.length;
    if (seq < 0) return;
    const payload = JSON.stringify({ v: 1, seq, bytes, ts: Date.now(), state: this.state });
    try {
      writeFileSync(this.snapPath + ".tmp", payload);
      renameSync(this.snapPath + ".tmp", this.snapPath);
      this.snapSeq = seq;
      this.snapBytes = bytes;
      this.entries = [];          // history lives in the file; memory holds the tail
      this.dirtySinceFold = 0;
      console.log(`[world:${this.name}] folded through seq ${seq} (${reason})`);
    } catch (err) {
      console.error(`[world:${this.name}] fold failed`, err);
    }
  }

  /** Erase the world back to zero.
   *
   *  The log is append-only and forever — so a reset ARCHIVES, it never
   *  destroys. Everything the world was (log, snapshot, remembered poses)
   *  moves into worlds/<name>/erased-<ts>/, recoverable by hand, and the
   *  live world starts over from an empty state. Frames recordings stay
   *  where they are: they are performances, not world state.
   *
   *  Returns the archive directory. The caller decides who owns the fresh
   *  world and how to tell everyone standing in it. */
  reset(): string {
    const dir = join(WORLDS_DIR, this.name);
    const arch = join(dir, `erased-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(arch, { recursive: true });
    for (const f of ["log.jsonl", "snapshot.json", "poses.json"]) {
      const p = join(dir, f);
      if (existsSync(p)) renameSync(p, join(arch, f));
    }
    this.entries = [];
    this.state = emptyState();
    this.snapSeq = -1;
    this.snapBytes = 0;
    this.logBytes = 0;
    this.dirtySinceFold = 0;
    this.poses = {};
    this.bhv.disposeAll();
    this.bhv.sync();
    this.append("world", "genesis", { v: 2, dialect: "eidoverse-log" });
    return arch;
  }

  /** A page of history, newest-first paging via `before`.
   *
   *  Folding bounds what a JOIN costs; it does not delete anything, so this is
   *  how anyone gets at what came before: a human scrolling chat upward, or an
   *  agent asking what happened while it was not thinking. The tail is served
   *  from memory; older pages read the log, which is O(file) per request and
   *  the obvious place a real index goes when that starts to hurt. */
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null }) {
    const out: LogEntry[] = [];
    const seen = new Set<number>();
    const want = (e: LogEntry) => e.seq < before && e.seq > after && (!verbs || verbs.has(e.verb));

    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (want(e)) { out.push(e); seen.add(e.seq); }
    }
    // older than what is in memory — go to the file
    const oldestInMemory = this.entries.length ? this.entries[0].seq : Infinity;
    if (out.length < limit && before > 0 && oldestInMemory > 0 && existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        let e: LogEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (seen.has(e.seq) || !want(e)) continue;
        out.push(e); seen.add(e.seq);
      }
    }
    out.reverse();                                   // hand back in world order
    const oldest = out.length ? out[0].seq : null;
    return { entries: out, oldestSeq: oldest, hasMore: oldest !== null && oldest > 0 };
  }

  /** What a joiner needs: the world as it is, plus anything since. */
  joinPayload() {
    return { state: this.state, tail: this.entries, throughSeq: this.snapSeq };
  }

  rememberPose(id: string, pose: unknown) {
    if (!pose) return;
    const still = settledPose(pose)!;
    this.poses[id] = still;
    writeFileSync(this.posesPath + ".tmp", JSON.stringify(this.poses));
    renameSync(this.posesPath + ".tmp", this.posesPath);
  }

  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry {
    // seq is global across the world's whole history, not an index into what
    // happens to be in memory — folding must not renumber the past.
    const seq = this.snapSeq + this.entries.length + 1;
    const entry: LogEntry = { seq, ts: Date.now(), actor, verb, args };
    this.entries.push(entry);
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.logPath, line);
    this.logBytes += Buffer.byteLength(line);
    foldEntry(this.state, entry);
    if (++this.dirtySinceFold >= FOLD_EVERY) this.fold();
    return entry;
  }

  broadcast(msg: unknown, except?: Client) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }
}

/** Remove a client from its world NOW — the kick/ban primitive, same shape as
 *  the identity-takeover block in `join`. All four bookkeeping steps or a ghost
 *  is left behind: world roster, global client map, the socket, and the leave
 *  broadcast (close(ws) will not fire it — the client is already unmapped).
 *  4006 is the "removed by moderation" close code; the browser client and
 *  WorldAgent both know not to auto-reconnect on it. */
function expel(w: World, target: Client, why: string) {
  try { target.ws.send(JSON.stringify({ type: "error", error: why })); } catch { /* going anyway */ }
  const wasEmbodied = !target.spectator;
  if (wasEmbodied && target.lastPose) w.rememberPose(target.id, target.lastPose); // they may be back
  target.superseded = true;   // the close path must not double-handle this body
  w.clients.delete(target);
  clients.delete(target.ws);
  target.world = null;
  target.ws.close?.(4006, "removed by moderation");
  if (wasEmbodied) { w.broadcast({ type: "leave", id: target.id }); w.bhv.onPresence("leave", target.id); }
}

// Operator-log census: people are people, eyes are eyes.
function describe(w: World): string {
  const real = [...w.clients].filter((c) => !c.spectator).length;
  const eyes = w.clients.size - real;
  return `${real} present${eyes ? `, ${eyes} watching` : ""}`;
}

const worlds = new Map<string, World>();

// One clock drives every world's script timers. This is what makes a
// behavior keep behaving with NOBODY connected — the ferry runs, the
// lighthouse blinks, the greeter is ready — which is the point of scripts
// living server-side rather than in any client.
setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    try { w.bhv.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
}, 1000);

// Boot sweep: worlds load lazily on first touch, but a world with scripts
// must wake WITH the server, not with its first visitor — otherwise a
// restart leaves every lighthouse dark until someone happens to sail past.
// Cheap peek before paying for a real load: the snapshot names its
// behaviors; a world with no snapshot yet gets a byte-scan of its log for
// the verb. (A world whose behaviors were all since removed may load once
// for nothing — harmless, and it folds a fresh snapshot on shutdown.)
try {
  let woken = 0;
  for (const name of readdirSync(WORLDS_DIR)) {
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(name)) continue;
      const dir = join(WORLDS_DIR, name);
      if (!existsSync(join(dir, "log.jsonl"))) continue;
      let hasScripts = false;
      const snapPath = join(dir, "snapshot.json");
      if (existsSync(snapPath)) {
        try {
          const snap = JSON.parse(readFileSync(snapPath, "utf8"));
          hasScripts = Object.keys(snap?.state?.behaviors ?? {}).length > 0;
        } catch { /* corrupt snapshot: fall through to the log scan */ }
      }
      if (!hasScripts && readFileSync(join(dir, "log.jsonl"), "utf8").includes('"verb":"behavior"')) {
        hasScripts = true;
      }
      if (hasScripts) { getWorld(name); woken++; }
    } catch (err) { console.error(`[boot] world ${name} peek failed`, err); }
  }
  if (woken) console.log(`[boot] ${woken} scripted world(s) woken — their behaviors run without visitors`);
} catch (err) { console.error("[boot] world sweep failed", err); }
function getWorld(name: string): World {
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) throw new Error(`bad world name: ${name}`);
  let w = worlds.get(name);
  if (!w) { w = new World(name); worlds.set(name, w); }
  return w;
}

/** Copy a world into a brand-new name. The log IS the world, so a fork is a
 *  byte-copy of the log plus its derived snapshot (whose byte offset stays
 *  valid because the copy is identical) and the remembered poses — a complete
 *  copy, roles and ownership included, since grants live in the log like every
 *  other fact. The whole copy is one synchronous block on a single-threaded
 *  event loop: no append can interleave, so log and snapshot cannot drift. */
function forkWorld(src: World, to: string): { ok: true; world: World } | { ok: false; err: string } {
  if (!/^[a-z0-9_-]{1,64}$/i.test(to)) return { ok: false, err: `bad world name "${to}" — letters, digits, - and _ only` };
  if (to === src.name) return { ok: false, err: "a world cannot be copied onto itself" };
  const destDir = join(WORLDS_DIR, to);
  if (worlds.has(to) || existsSync(destDir)) return { ok: false, err: `world "${to}" already exists` };
  const srcDir = join(WORLDS_DIR, src.name);
  if (!existsSync(join(srcDir, "log.jsonl"))) return { ok: false, err: `"${src.name}" has no history to copy yet` };
  mkdirSync(destDir, { recursive: true });
  for (const f of ["log.jsonl", "snapshot.json", "poses.json"]) {
    const p = join(srcDir, f);
    if (existsSync(p)) copyFileSync(p, join(destDir, f));
  }
  return { ok: true, world: getWorld(to) };   // load it now: a fork that cannot boot should fail loudly here
}

// ------------------------------------------------------------------- clients

type Client = {
  id: string;          // participant id (v1: self-declared; later: key-derived)
  ws: { send(data: string): void; close?(code?: number, reason?: string): void; getBufferedAmount?(): number };
  world: World | null;
  avatar: string;      // VRM library path chosen at join
  lastPose: unknown;   // latest pose, forwarded to late joiners so they see everyone immediately
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  agent?: boolean;     // self-declared: an MCPL body, not a person at a keyboard
  auth?: HnSession;    // archipelago-home session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover — don't let its stale pose overwrite the successor's
  renderer?: boolean;  // donates rendering: can answer snap requests for its world
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgWin: number; msgCount: number;   // all messages, per second
  verbWin: number; verbCount: number; // authored verbs, per 4s
};

// ---- snapshots: the world serves views of itself ---------------------------
// GET /snap?world=W&follow=ID → the sequencer asks a renderer client (an
// invisible hub-spectator on some GPU box, dialed OUT to us like any client)
// to jump its camera to ID's head and return one frame. Clients never know
// rendering exists as a separate thing — it's just the world's API.
type PendingSnap = { resolve: (r: { ok: true; png: Uint8Array } | { ok: false; err: string; status: number }) => void };
const pendingSnaps = new Map<string, PendingSnap>();
let nextSnapId = 1;

function requestSnap(world: World, follow: string, view = "first"): Promise<{ ok: true; png: Uint8Array } | { ok: false; err: string; status: number }> {
  const renderer = [...world.clients].find((c) => c.renderer);
  if (!renderer) return Promise.resolve({ ok: false, err: `no renderer is currently serving world "${world.name}"`, status: 503 });
  const target = [...world.clients].find((c) => c.id === follow && !c.spectator);
  if (!target) return Promise.resolve({ ok: false, err: `"${follow}" is not present in "${world.name}"`, status: 404 });
  if (!["first", "third", "selfie"].includes(view)) view = "first";
  const id = `snap-${nextSnapId++}`;
  return new Promise((resolve) => {
    pendingSnaps.set(id, { resolve });
    renderer.ws.send(JSON.stringify({ type: "snap", id, follow, view }));
    setTimeout(() => {
      if (pendingSnaps.delete(id)) resolve({ ok: false, err: "renderer timed out", status: 504 });
    }, 12_000);
  });
}

/** Whispers waiting for someone who wasn't here. Memory only, deliberately:
 *  see the `whisper` message case.
 *
 *  The key is built in ONE place because it is written on one code path and
 *  read on another — they drifted once already (a stray separator character
 *  made every held whisper unreachable, silently), and the failure mode is a
 *  private message that simply never arrives. */
const pendingWhispers = new Map<string, unknown[]>();
const whisperKey = (world: string, recipient: string) => `${world}\u0000${recipient}`;
const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";

let clientVersionCache: { at: number; v: string } | null = null;
let nextClientNum = 1;
const clients = new Map<unknown, Client>();
const uploadWin = new Map<string, { t: number; n: number }>(); // per-IP upload rate windows

// ---- store optimization -----------------------------------------------------
// Every uploaded GLB (drag-drop, Orrery conjures) gets a draco+webp shadow in
// store-min/, built by a SUBPROCESS — draco encoding is CPU-seconds of
// synchronous wasm, and inside this process it would freeze pose relay for
// every world. One file at a time; the sequencer never waits on it.
const optQueue: string[] = [];
let optRunning = false;
function queueOptimize(absPath: string) {
  if (!optQueue.includes(absPath)) { optQueue.push(absPath); pumpOptimize(); }
}
async function pumpOptimize() {
  if (optRunning) return;
  optRunning = true;
  try {
    while (optQueue.length) {
      const src = optQueue.shift()!;
      const base = basename(src);                      // <hash>.glb
      const dest = join(STORE_MIN, base);
      const failed = join(STORE_MIN, `${base}.failed`);
      if (!existsSync(src) || existsSync(dest) || existsSync(failed)) continue;
      mkdirSync(STORE_MIN, { recursive: true });
      // process.execPath = the running bun binary — PATH under systemd has no bun
      const proc = Bun.spawn([process.execPath, "run", join(ROOT, "server", "optimize.ts"), src, dest],
        { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      const err = (await new Response(proc.stderr).text()).trim();
      if (code === 0) {
        const ratio = (Bun.file(src).size / Math.max(1, Bun.file(dest).size)).toFixed(1);
        console.log(`[store] optimized ${base} (${ratio}x)`);
      } else if (code === 2) {
        // already lean — mark so the boot sweep stops re-measuring it
        writeFileSync(failed, "not-smaller");
        console.log(`[store] ${base} already lean — serving original`);
      } else {
        // Environmental failures (deps not installed yet) must NOT mark the
        // file — that would permanently skip every upload made before the
        // first successful `bun install`. Only content failures stick.
        const envFail = /cannot find module|cannot resolve|error: script not found/i.test(err);
        if (!envFail) writeFileSync(failed, err.slice(0, 2000) || `exit ${code}`);
        console.error(`[store] optimize ${envFail ? "unavailable (deps?)" : `FAILED ${base}`}: ${err.split("\n")[0] || `exit ${code}`}`);
        if (envFail) { optQueue.length = 0; break; } // no point grinding the rest
      }
    }
  } finally { optRunning = false; }
}
// Boot sweep: whatever accumulated before this shipped (or failed mid-queue
// last run) gets its shadow now. Deferred so boot stays about serving worlds.
setTimeout(() => {
  const dir = join(OPT_DIR, "store");
  if (!existsSync(dir)) return;
  const pending = readdirSync(dir).filter((f) => f.endsWith(".glb")
    && !existsSync(join(STORE_MIN, f)) && !existsSync(join(STORE_MIN, `${f}.failed`)));
  if (!pending.length) return;
  console.log(`[store] boot sweep: ${pending.length} unoptimized upload(s) queued`);
  for (const f of pending) queueOptimize(join(dir, f));
}, 5000);

// -------------------------------------------------------------- http + ws

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".hdr")) return "application/octet-stream";
  return "application/octet-stream";
}

const gzCache = new Map<string, { mtime: number; gz: Uint8Array }>();

function serveFrom(base: string, rel: string, cache = false, req?: Request, immutable = false): Response {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return new Response("forbidden", { status: 403 });
  // A missing file must be a 404, not a Bun.file stream blowing up into a 500 —
  // prod 08-02: an asset absent from the VPS library (rsync gap) turned every
  // spawn of it into "Internal Server Error" instead of an honest not-found.
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const f = Bun.file(path);
  const headers: Record<string, string> = { "content-type": contentType(path) };
  // ETag from size+mtime: makes no-cache revalidation a 304, not a re-download
  // (an 11MB avatar re-pulled per reload is invisible on localhost and rude
  // over tailnet).
  if (f.size > 0) {
    const etag = `"${f.size}-${f.lastModified}"`;
    headers["etag"] = etag;
    if (req?.headers.get("if-none-match") === etag) {
      // cache-control must ride along on the 304 (it refreshes the stored response's lifetime)
      headers["cache-control"] = immutable ? "public, max-age=31536000, immutable"
        : cache && !path.endsWith(".vrm") ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
      return new Response(null, { status: 304, headers });
    }
  }
  // client code must never be heuristically cached (stale main.js = ghost bugs);
  // library assets cache hard — EXCEPT avatars: .vrm files get iterated on
  // (rig fixes, re-exports) and a 24h-stale avatar is a debugging nightmare
  // (2026-07-22: "sydney's arms are swapped" was three of us looking at three
  // different cached rigs). no-cache = revalidate each load, still cheap.
  const hard = cache && !path.endsWith(".vrm");
  headers["cache-control"] = immutable ? "public, max-age=31536000, immutable"
    : hard ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
  // gzip the JS modules: three.webgpu.js is 2.1MB raw / ~500KB gzipped, and
  // over a DERP-relayed tailnet link that difference is seconds.
  //
  // .vrma and .vrm are here too, and the old comment claiming "binary assets
  // are already compressed" was only half right. Measured 2026-07-26: GLB
  // models compress to 0.99 (already Draco/webp packed inside — genuinely
  // pointless), but VRM bodies hit 0.50 and the VRMA animation clips 0.44,
  // because their float animation tracks and mesh data are stored raw. Seven
  // clips at ~1.9MB each was the second-largest slice of a cold boot; half of
  // it was air.
  if (/\.(m?js|json|css|html|vrma|vrm)$/.test(path) && req?.headers.get("accept-encoding")?.includes("gzip") && f.size > 10_000) {
    let entry = gzCache.get(path);
    if (!entry || entry.mtime !== f.lastModified) {
      entry = { mtime: f.lastModified, gz: Bun.gzipSync(new Uint8Array(require("node:fs").readFileSync(path))) };
      gzCache.set(path, entry);
    }
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(entry.gz, { headers });
  }
  return new Response(f, { headers });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Session rides the upgrade: browsers attach cookies to WS upgrades, so
      // the join below can carry a VERIFIED identity without the client ever
      // seeing a token. (fkm web-ui precedent: "the WS is the authentication
      // event" — here inverted, the cookie is, and the WS rides it.)
      const session = sessionFromCookie(req.headers.get("cookie"));
      if (srv.upgrade(req, { data: { session } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    }
    // ---- archipelago-home doors (docs/home-node.md §7) ----
    if (url.pathname === "/authcfg") {
      return new Response(
        JSON.stringify({ login: HN_ISSUER_KEY ? HN_LOGIN_URL : null, required: HN_REQUIRE_LOGIN && Boolean(HN_ISSUER_KEY) }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/whoami") {
      const s = sessionFromCookie(req.headers.get("cookie"));
      if (!s) return new Response(JSON.stringify({ error: "no session" }), { status: 401, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sub: s.sub, name: s.name, scopes: s.scopes, claims: s.claims ?? {} }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (url.pathname === "/auth" && req.method === "GET") {
      // The landing spot for the home node's redirect. The token is in the URL
      // FRAGMENT (never reaches this server's logs); this page posts it back.
      return new Response(`<!doctype html><meta charset="utf-8"><title>entering…</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#ddd;background:#111}</style>
<p id=m>entering…</p><script>
(async () => {
  const m = document.getElementById('m');
  const tok = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!tok) { m.textContent = 'no token — start again from the login page'; return; }
  history.replaceState(null, '', '/auth');
  const r = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { m.textContent = 'welcome, ' + j.name; location.replace('/'); }
  else m.textContent = 'login failed: ' + (j.error ?? r.status) + ' — start again from the login page';
})();
</script>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/auth" && req.method === "POST") {
      if (!HN_ISSUER_KEY) return new Response(JSON.stringify({ error: "identity door not configured" }), { status: 503, headers: { "content-type": "application/json" } });
      let tok = "";
      try { tok = String(((await req.json()) as { token?: string }).token ?? ""); } catch { /* fall through */ }
      const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD });
      if (!v.ok) {
        console.log(`[auth] login token rejected: ${v.reason}`);
        return new Response(JSON.stringify({ error: v.reason }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const p = v.payload;
      if (p.jti && !hnJti.claim(p.jti, p.exp)) {
        console.log(`[auth] login token replayed: ${p.sub}`);
        return new Response(JSON.stringify({ error: "token already used" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const sid = randomBytes(32).toString("hex");
      // opportunistic sweep — one entry per login, the map stays small
      for (const [k, s] of hnSessions) if (s.exp < Date.now()) hnSessions.delete(k);
      hnSessions.set(sid, { sub: p.sub, name: p.name, scopes: p.scopes, claims: p.claims, exp: Date.now() + SESSION_TTL_MS });
      saveSessions();
      const secure = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https" ? "; Secure" : "";
      console.log(`[auth] session for ${p.sub} ("${p.name}") [${p.scopes.join(" ")}]`);
      return new Response(JSON.stringify({ ok: true, name: p.name, sub: p.sub }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `ew_sess=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
        },
      });
    }
    if (url.pathname === "/logout") {
      const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(req.headers.get("cookie") ?? "");
      if (m && hnSessions.delete(m[1]!)) saveSessions();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "set-cookie": "ew_sess=; Path=/; HttpOnly; Max-Age=0" },
      });
    }
    if (url.pathname === "/geom") {
      // Geometry as DATA, for beings who perceive by reading. Three tiers:
      //   /geom?lib=<path>           one asset: bbox, flat zones, named parts
      //   /geom?world=W&id=<entity>  that asset + the entity's world transform
      //   /geom?world=W              the whole scene: every entity + transform
      //                              (+local bbox; &boxes=0 to skip the parses)
      // Raw bytes stay at GET /library/<lib> for local processing; this is
      // the parsed tier. Same trust level as the world log: public reads.
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const resolveLib = (lib: string): string | null => {
        const rel = normalize(lib).replace(/^\/+/, "");
        if (rel.includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
        for (const base of [OPT_DIR, LIBRARY_DIR]) {
          const p = normalize(join(base, rel));
          if (p.startsWith(base) && existsSync(p)) return p;
        }
        return null;
      };
      const wname = url.searchParams.get("world");
      if (!wname) {
        const lib = url.searchParams.get("lib") ?? "";
        const file = resolveLib(lib);
        if (!file) return j({ error: `no such asset: ${lib}` }, 404);
        const sum = await summarizeGlb(file);
        return sum ? j({ lib, ...sum }) : j({ error: "geometry parsing unavailable" }, 503);
      }
      // read-only: answer for LOADED or on-disk worlds, never create one
      if (!/^[a-z0-9_-]{1,64}$/i.test(wname)
        || (!worlds.has(wname) && !existsSync(join(WORLDS_DIR, wname, "log.jsonl")))) {
        return j({ error: "no such world" }, 404);
      }
      const w = getWorld(wname);
      const id = url.searchParams.get("id");
      if (id) {
        const e = w.state.entities[id];
        if (!e) return j({ error: `no entity "${id}" in ${wname}` }, 404);
        const file = e.lib ? resolveLib(e.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        return j({ id, lib: e.lib ?? null, pos: e.pos, yaw: e.yaw ?? 0, scale: e.scale ?? 1,
          parent: e.parent ?? null, comp: e.comp ?? {},
          geometry: sum,   // local frame — compose with pos/yaw/scale for world space
          note: "geometry coords are the MODEL's local frame; sockets use the same frame, so a topSurface center is a socket pos verbatim" });
      }
      const withBoxes = url.searchParams.get("boxes") !== "0";
      const out = [];
      for (const [eid, e] of Object.entries(w.state.entities)) {
        const file = withBoxes && e.lib ? resolveLib(e.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        out.push({ id: eid, lib: e.lib ?? null, kind: e.kind ?? "thing",
          pos: e.pos, yaw: e.yaw ?? 0, scale: e.scale ?? 1,
          parent: e.parent ?? null, comp: e.comp ?? {},
          ...(sum ? { bbox: sum.bbox, tris: sum.tris } : {}) });
      }
      return j({ world: wname, entities: out, mounts: w.state.mounts ?? {} });
    }
    if (url.pathname === "/upload" && req.method === "POST") {
      // Live asset ingestion. Two destinations:
      //  - models (default): content-addressed into assets/opt/store/<hash>.glb —
      //    immutable by construction, so spawn verbs can reference the path
      //    forever and clients cache it forever. DESIGN.md's "content-addressed
      //    assets" plane, made real.
      //  - ?as=avatar&name=foo: named into the overlay vrms dir, because the
      //    roster is name-keyed and people re-export their bodies (mtime
      //    versioning handles the cache).
      // Trust model: the door token, any per-agent bearer from
      // mcpl/tokens.json, OR an aid1 credential the home node vouches for
      // (so Orrery and agents can push generated GLBs here directly — the
      // store is content-addressed and inert; what enters a WORLD is still
      // the `asset`/`spawn` verbs, which per-world roles gate), plus per-IP
      // rate limiting — live generation is the feature, an upload flood is
      // not. `?by=` is attribution for the console trail.
      const upTok = url.searchParams.get("token") ?? "";
      let upAgent = agentTokens().byToken.get(upTok);
      // The aid1 leg the join door has: guests enrolled via archipelago-home
      // carry no tokens.json entry, but the scripting tier's `behavior` verb
      // is already reachable to them through world_verb — the bytes it binds
      // must be landable by the same identity, or the tier is half-open.
      // Same audience/scope/slug derivation as the two doors, no jti burn
      // (an aid1 credential is reusable until expiry at every door).
      if (!upAgent && HN_ISSUER_KEY && upTok.startsWith("aid1.")) {
        const v = verifyToken(upTok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
        if (v.ok) upAgent = v.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || v.payload.sub;
      }
      if (JOIN_TOKEN && upTok !== JOIN_TOKEN && !upAgent)
        return new Response("token required", { status: 401 });
      const upBy = (url.searchParams.get("by") ?? upAgent ?? "?").slice(0, 64);
      // Behind the show's nginx front every socket is 127.0.0.1 — the real
      // client address rides X-Real-IP. (Spoofable only when directly exposed,
      // which is the tailnet dev case where rate limits hardly matter.)
      const ip = req.headers.get("x-real-ip") ?? srv.requestIP(req)?.address ?? "?";
      const u = uploadWin.get(ip) ?? { t: 0, n: 0 };
      if (Date.now() - u.t > 60_000) { u.t = Date.now(); u.n = 0; }
      u.n++; uploadWin.set(ip, u);
      if (u.n > 4) return new Response("upload rate limit (4/min)", { status: 429 });
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length > UPLOAD_CAP) return new Response(`too large (${UPLOAD_CAP / 1e6}MB cap)`, { status: 413 });
      if (url.searchParams.get("as") === "script") {
        // Runtime-script ingestion: plain UTF-8 JS, content-addressed like
        // models, so a `behavior` entry pins exact bytes forever. The store
        // is inert — what RUNS is still gated by the behavior verb + sandbox.
        if (body.length > 64 * 1024) return new Response("script too large (64KB cap)", { status: 413 });
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch {
          return new Response("script must be UTF-8 text", { status: 415 });
        }
        if (!text.trim()) return new Response("empty script", { status: 415 });
        const shash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
        const sdir = join(OPT_DIR, "store", "scripts");
        mkdirSync(sdir, { recursive: true });
        const srel = `store/scripts/${shash}.js`;
        if (!existsSync(join(OPT_DIR, srel))) writeFileSync(join(OPT_DIR, srel), body);
        console.log(`[upload] script ${srel} (${body.length}B) by ${upBy}`);
        return new Response(JSON.stringify({ path: srel }),
          { headers: { "content-type": "application/json" } });
      }
      if (body.length < 12 || new DataView(body.buffer).getUint32(0, true) !== 0x46546c67)
        return new Response("not a GLB container (glb/vrm)", { status: 415 });
      if (url.searchParams.get("as") === "avatar") {
        const raw = url.searchParams.get("name") ?? "unnamed";
        const name = raw.replace(/\.vrm$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unnamed";
        const dir = join(OPT_DIR, "eidoverse/assets/vrms");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.vrm`), body);
        console.log(`[upload] avatar "${name}" (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
        // Live cache invalidation: avatars are name-keyed and mutable (people
        // iterate on their bodies), so every connected client — all worlds —
        // learns the file changed; wearers hot-swap with the fresh version.
        const rel = `eidoverse/assets/vrms/${name}.vrm`;
        const update = JSON.stringify({ type: "avatar-updated", name, path: rel, v: Date.now() });
        let notified = 0;
        for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
        if (notified) console.log(`[upload] avatar-updated "${name}" → ${notified} client(s)`);
        return new Response(JSON.stringify({ name, path: rel }),
          { headers: { "content-type": "application/json" } });
      }
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
      const dir = join(OPT_DIR, "store");
      mkdirSync(dir, { recursive: true });
      const rel = `store/${hash}.glb`;
      if (!existsSync(join(OPT_DIR, rel))) writeFileSync(join(OPT_DIR, rel), body);
      queueOptimize(join(OPT_DIR, rel)); // draco+webp shadow, built off the request path
      // The store is content-addressed, so the human name arrives ONLY here —
      // record it, or the catalog can never list this object as anything but
      // a hash (an orrery send used to vanish into exactly that black hole).
      const upName = (url.searchParams.get("name") ?? "").replace(/\.glb$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
      {
        const mp = join(dir, "manifest.json");
        let man: Record<string, { name?: string; by: string; ts: number }> = {};
        try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
        man[hash] = { ...(upName ? { name: upName } : {}), by: upBy, ts: Date.now() };
        writeFileSync(`${mp}.tmp`, JSON.stringify(man));
        renameSync(`${mp}.tmp`, mp);
      }
      console.log(`[upload] model ${rel}${upName ? ` ("${upName}")` : ""} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
      return new Response(JSON.stringify({ path: rel }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/snap") {
      const w = worlds.get(url.searchParams.get("world") ?? "commons");
      const follow = url.searchParams.get("follow") ?? "";
      if (!w) return new Response("unknown world", { status: 404 });
      const r = await requestSnap(w, follow, url.searchParams.get("view") ?? "first");
      if (!r.ok) return new Response(r.err, { status: r.status });
      return new Response(r.png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    }
    if (url.pathname === "/avatars") {
      // Roster = Skye's library vrms + our overlay (assets/opt/...) — drop a
      // .vrm into either and it's an avatar, live, no restart, no manifest.
      const seen = new Map<string, string>();
      for (const base of [LIBRARY_DIR, OPT_DIR]) {
        const dir = join(base, "eidoverse/assets/vrms");
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          // ?v=mtime makes the URL content-versioned: clients cache it forever,
          // and any re-export mints a new URL. Invalidation by construction.
          if (f.endsWith(".vrm")) seen.set(f.replace(".vrm", ""), `eidoverse/assets/vrms/${f}?v=${Math.round(Bun.file(join(dir, f)).lastModified)}`);
        }
      }
      // stature metadata, contributed alongside portraits (see POST /thumb)
      let hmeta: Record<string, { h: number }> = {};
      try {
        const mp = join(OPT_DIR, "thumbs", "meta.json");
        if (existsSync(mp)) hmeta = JSON.parse(readFileSync(mp, "utf8"));
      } catch { /* roster works without heights */ }
      return new Response(
        JSON.stringify([...seen].map(([name, path]) => ({ name, path, height: hmeta[name.replace(/[^a-zA-Z0-9_-]/g, "_")]?.h ?? null }))),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }
    if (url.pathname.startsWith("/thumb/")) {
      // Avatar thumbnails. VRMs have no shipped previews, and a name-only
      // roster where each choice costs a multi-megabyte download is a blind
      // pick. So thumbnails are CONTRIBUTED: whoever wears a body renders one
      // off its own loaded VRM and posts it back. The roster fills in as people
      // use it — no build step, no manifest, no bulk render job.
      const name = decodeURIComponent(url.pathname.slice("/thumb/".length)).replace(/\.png$/, "");
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      const f = Bun.file(join(OPT_DIR, "thumbs", `${safe}.png`));
      if (!(await f.exists())) return new Response("no thumb", { status: 404 });
      return new Response(f, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/perflog" && req.method === "POST") {
      // Load-performance beacon (client/lib/loadwork.js): jank + load lines
      // from real visits, because Safari's console is unreachable and most
      // visitors never open one. Append-only JSONL beside the worlds, capped —
      // diagnosis data, not surveillance; it holds only timing lines and a UA.
      try {
        const body = await req.text();
        if (body.length < 100_000) {
          const dest = join(WORLDS_DIR, ".perflogs.jsonl");
          const big = existsSync(dest) && Bun.file(dest).size > 5_000_000;
          if (!big) {
            const ip = req.headers.get("x-real-ip") ?? srv.requestIP(req)?.address ?? "?";
            appendFileSync(dest, JSON.stringify({ ts: Date.now(), ip, ...JSON.parse(body) }) + "\n");
          }
        }
      } catch { /* malformed beacon: drop */ }
      return new Response("ok");
    }
    if (url.pathname === "/thumb" && req.method === "POST") {
      if (JOIN_TOKEN && url.searchParams.get("token") !== JOIN_TOKEN)
        return new Response("token required", { status: 401 });
      const safe = (url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      if (!safe) return new Response("name required", { status: 400 });
      const dir = join(OPT_DIR, "thumbs");
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${safe}.png`);
      // The portrait carries the body's measured stature (skeleton-derived,
      // client-side) — kept beside the images so /avatars can hand catalogs a
      // roster drawn to a common scale.
      const height = Number(url.searchParams.get("height"));
      if (Number.isFinite(height) && height > 0.2 && height < 20) {
        const metaPath = join(dir, "meta.json");
        let meta: Record<string, { h: number }> = {};
        try { if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* fresh */ }
        meta[safe] = { h: Math.round(height * 100) / 100 };
        writeFileSync(`${metaPath}.tmp`, JSON.stringify(meta));
        renameSync(`${metaPath}.tmp`, metaPath);
      }
      // First contributor wins (re-posting on every join would be pointless
      // write traffic) — unless a re-mint pass explicitly forces the refresh.
      const force = url.searchParams.get("force") === "1";
      if (existsSync(dest) && !force) return new Response(JSON.stringify({ ok: true, existed: true }),
        { headers: { "content-type": "application/json" } });
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length > 400_000) return new Response("thumb too large", { status: 413 });
      if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) return new Response("not a PNG", { status: 415 });
      writeFileSync(dest, body);
      console.log(`[thumb] ${safe} (${(body.length / 1000).toFixed(0)}KB${force ? ", forced" : ""})`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/library-list") {
      // Directory listing over the library. The browser host primes Skye's
      // toolkit modules into a virtual filesystem before eval-loading them
      // (they read assets synchronously, Deno-style), and it should DISCOVER
      // what to prime rather than carry a hardcoded manifest — the no-manifest
      // rule applies to the client too.
      const rel = url.searchParams.get("dir") ?? "";
      const out: { path: string; size: number }[] = [];
      const walk = (base: string, sub: string, depth: number) => {
        if (depth > 4) return;
        const abs = normalize(join(base, sub));
        if (!abs.startsWith(base) || !existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const childRel = sub ? `${sub}/${e.name}` : e.name;
          if (e.isDirectory()) walk(base, childRel, depth + 1);
          else out.push({ path: childRel, size: Bun.file(join(abs, e.name)).size });
        }
      };
      // opt first: /library/ serving prefers the optimized mirror, so the
      // listed size must describe the file a client will actually receive —
      // the prefetcher sorts and budgets by these numbers, and the raw-library
      // size of a draco+webp'd model is off by ~30x.
      for (const base of [OPT_DIR, LIBRARY_DIR]) walk(base, rel, 0);
      // opt mirror shadows the library at the same path — dedupe, first wins
      const seen = new Set<string>();
      const uniq = out.filter((f) => !seen.has(f.path) && seen.add(f.path));
      return new Response(JSON.stringify(uniq), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/library-models") {
      // The catalog agents already had (mcpl `list_library`), served to humans.
      // Filename token scoring — crude, but it is what ranks the agent-side
      // search today and parity matters more than cleverness here.
      const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const dirs = [join(LIBRARY_DIR, "eidoverse/assets/models"), join(OPT_DIR, "eidoverse/assets/models")];
      const files = new Map<string, number>();
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          if (!f.endsWith(".glb")) continue;
          const low = f.toLowerCase();
          const score = q.length ? q.filter((t) => low.includes(t)).length : 1;
          if (score > 0) files.set(f, Math.max(files.get(f) ?? 0, score));
        }
      }
      const hits = [...files]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 60)
        .map(([f]) => {
          // Skye ships a _preview.jpg beside every model. Picking from a list of
          // `stylized_yucca_joshua_tree_desert_cactus_plant.glb` is not picking;
          // with the previews it becomes an actual catalog.
          const prev = f.replace(/\.glb$/i, "_preview.jpg");
          const hasPrev = dirs.some((d) => existsSync(join(d, prev)));
          return {
            path: `eidoverse/assets/models/${f}`,
            // strip the SEO-soup filenames into something a person can read
            name: f.replace(/\.glb$/i, "").replace(/_/g, " ").slice(0, 48),
            preview: hasPrev ? `eidoverse/assets/models/${prev}` : null,
          };
        });
      // Conjured/delivered objects (the content-addressed store) are catalog
      // too — an orrery send should land somewhere findable, not in a black
      // hole only its hash can name. Newest first, names from the manifest.
      const storeDir = join(OPT_DIR, "store");
      if (existsSync(storeDir)) {
        let man: Record<string, { name?: string; by?: string; ts?: number }> = {};
        try { man = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8")); } catch { /* unnamed */ }
        const store = readdirSync(storeDir)
          .filter((f) => f.endsWith(".glb"))
          .map((f) => {
            const hash = f.replace(/\.glb$/i, "");
            const m = man[hash];
            return {
              path: `store/${f}`,
              name: (m?.name ?? `conjured ${hash.slice(0, 8)}`).slice(0, 48),
              preview: null as string | null,
              ts: m?.ts ?? 0,
              score: q.length ? q.filter((t) => (m?.name ?? "").toLowerCase().includes(t)).length : 1,
            };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30)
          .map(({ path, name, preview }) => ({ path, name, preview }));
        hits.push(...store);
      }
      return new Response(JSON.stringify(hits), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/library/")) {
      const rel = url.pathname.slice("/library/".length);
      // optimized mirror first (draco+webp): same path, ~30x smaller
      const versioned = url.searchParams.has("v") || rel.startsWith("store/"); // content-addressed = immutable
      // store uploads: prefer the store-min shadow — same address, the
      // original stays as provenance and as the fallback while (or if) the
      // optimize pass hasn't landed for this hash
      if (rel.startsWith("store/")) {
        const minRel = `store-min/${rel.slice("store/".length)}`;
        const min = normalize(join(OPT_DIR, minRel));
        if (min.startsWith(OPT_DIR) && existsSync(min)) return serveFrom(OPT_DIR, minRel, true, req, true);
      }
      const opt = normalize(join(OPT_DIR, rel));
      if (opt.startsWith(OPT_DIR) && existsSync(opt)) return serveFrom(OPT_DIR, rel, true, req, versioned);
      return serveFrom(LIBRARY_DIR, rel, true, req, versioned);
    }
    if (url.pathname.startsWith("/node_modules/"))
      return serveFrom(join(ROOT, "client"), url.pathname.slice(1), true, req);
    if (url.pathname === "/client-version") {
      // A marker the renderer watchdog polls: the newest mtime across the
      // client files. A deploy (or a dev edit) moves it, so a hung-uptime-free
      // renderer still reloads for new code. Cheap, cached 5s.
      const now = Date.now();
      if (!clientVersionCache || now - clientVersionCache.at > 5000) {
        let newest = 0;
        const dir = join(ROOT, "client");
        const walk = (d: string, depth: number) => {
          if (depth > 3) return;
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name === "node_modules") continue;
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else newest = Math.max(newest, Bun.file(p).lastModified);
          }
        };
        try { walk(dir, 0); } catch { /* best effort */ }
        clientVersionCache = { at: now, v: String(newest) };
      }
      return new Response(clientVersionCache.v, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
    if (url.pathname === "/favicon.ico") {
      // Browsers ask for this unprompted; the static handler threw ENOENT and
      // answered 500, so every page load logged a server error for a file
      // nobody asked us to have.
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
           <rect width="32" height="32" rx="7" fill="#0c1720"/>
           <circle cx="16" cy="16" r="6" fill="#8fe8c8"/>
           <circle cx="16" cy="16" r="10.5" fill="none" stroke="#8fe8c8" stroke-opacity=".45" stroke-width="1.5"/>
         </svg>`,
        { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
      );
    }
    if (url.pathname.toLowerCase() === "/agents.md") {
      // The closed-verb-set error says "see AGENTS.md" — so the file has to be
      // reachable from the world itself, not just the repo. Any casing works
      // (/AGENTS.md, /agents.md): agents type both, and a 404 on the spelling
      // the error message taught you is a locked door with a sign on it.
      return serveFrom(ROOT, "AGENTS.md", false, req);
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return serveFrom(join(ROOT, "client"), "index.html");
    return serveFrom(join(ROOT, "client"), url.pathname.slice(1));
  },
  websocket: {
    open(ws) {
      const c: Client = { id: `anon-${nextClientNum++}`, ws, world: null, avatar: "", lastPose: null, spectator: false,
        msgWin: 0, msgCount: 0, verbWin: 0, verbCount: 0 };
      const sess = (ws as unknown as { data?: { session?: HnSession | null } }).data?.session;
      if (sess && sess.exp > Date.now()) { c.auth = sess; c.sub = sess.sub; }
      clients.set(ws, c);
    },
    close(ws) {
      const c = clients.get(ws);
      if (!c) return;
      clients.delete(ws);
      // dev crash forensics (?bc=1 clients): the last thing a dying renderer
      // was doing, printed at the only moment we learn it died
      if ((c as any).bcRing?.length) {
        console.log(`[bc] ${c.id} last breadcrumbs: ${(c as any).bcRing.join(" | ")}`);
      }
      // a vanished simulator's objects land exactly where its last frame put
      // them — the lease's whole promise (docs/leases.md)
      if (c.world) for (const [lid, L] of [...c.world.leases]) if (L.holder === c) c.world.settleLease(lid);
      if (c.world) {
        c.world.clients.delete(c);
        if (!c.spectator) {
          if (!c.superseded) c.world.rememberPose(c.id, c.lastPose); // sleep where you stood
          c.world.broadcast({ type: "leave", id: c.id });
          c.world.bhv.onPresence("leave", c.id);
        }
        console.log(`[world:${c.world.name}] ${describe(c.world)} — ${c.id} ${c.spectator ? "stopped watching" : "left"}`);
      }
    },
    message(ws, raw) {
      const c = clients.get(ws);
      if (!c) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      // message-rate cap: 15Hz poses + verbs + slack. Excess is dropped
      // silently — closing would just trigger the client's auto-reconnect.
      const now = Date.now();
      if (now - c.msgWin > 1000) { c.msgWin = now; c.msgCount = 0; }
      if (++c.msgCount > MSG_RATE) return;

      // No message may ever kill the process. An uncaught throw in Bun's ws
      // callback EXITS THE SERVER, and a client in a reconnect loop turns one
      // bad request into a crash loop for everyone (measured 2026-08-02: a
      // world name carrying a stray ")" from a chat-linkified URL took prod
      // down 16 restarts in a row). Refusals are messages, failures are logs —
      // neither is an exit.
      try {
      switch (msg.type) {
        case "join": {
          // Two doors (home-node.md §7): a verified session (cookie at
          // upgrade) passes without the door key; everyone else needs
          // JOIN_TOKEN as before. Both may be live at once — invite links for
          // the show, Discord login for everyone with the role.
          const auth = c.auth && c.auth.exp > Date.now() ? c.auth : null;
          if (!auth && JOIN_TOKEN && String(msg.token ?? "") !== JOIN_TOKEN) {
            ws.send(JSON.stringify({ type: "error", error: "bad or missing join token" }));
            c.ws.close?.(4003, "bad token");
            return;
          }
          if (auth) {
            const need = msg.spectate ? ["worlds:spectate", "worlds:join"] : ["worlds:join"];
            if (!need.some((s) => auth.scopes.includes(s))) {
              ws.send(JSON.stringify({ type: "error", error: msg.spectate ? "your login lacks spectate access" : "your login lacks embodied access — try ?spectate" }));
              c.ws.close?.(4003, "insufficient scope");
              return;
            }
          }
          // leave previous world (travel is: leave A, join B)
          if (c.world) {
            c.world.clients.delete(c);
            if (!c.spectator) { c.world.broadcast({ type: "leave", id: c.id }); c.world.bhv.onPresence("leave", c.id); }
          }
          // A malformed world name is a bad LINK, not a bad actor — refuse it
          // with an explanation and a close code the client knows not to retry
          // (retrying a name that can never exist is just a polite DoS).
          const wname = String(msg.world ?? "commons");
          if (!/^[a-z0-9_-]{1,64}$/i.test(wname)) {
            ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
            c.ws.close?.(4005, "bad world name");
            return;
          }
          const w = getWorld(wname);
          // Identity: a verified session OWNS the id — the client's msg.id is
          // ignored (the name came from Discord via the home node, and the
          // sub underneath it survives renames).
          c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, 64);
          // Actor names are the log's ink — refuse the ones that forge system
          // or script authorship ("world" authors grants; "bhv:*" authors
          // script effects; the behavior loop-guard trusts that prefix), and
          // strip control characters that would corrupt every future reader.
          // (Hesperus finding #3: an unauthenticated join as "world" produced
          // entries indistinguishable from the sequencer's own.)
          c.id = c.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
          if (!c.id || /^(world|\*)$/i.test(c.id) || /^bhv:/i.test(c.id)) {
            ws.send(JSON.stringify({ type: "error", error: `that name is reserved for the world itself` }));
            ws.close(4004, "reserved name");
            return;
          }
          c.avatar = String(msg.avatar ?? "eidoverse/assets/vrms/claude.vrm");
          c.spectator = Boolean(msg.spectate);
          c.agent = Boolean(msg.agent);
          c.renderer = Boolean(msg.renderer);
          if (c.renderer) c.spectator = true; // renderers are invisible by definition
          // Same display name, different PERSON (two guild members can share a
          // nick): suffix the newcomer rather than letting takeover fight.
          if (auth && !c.spectator) {
            for (const other of w.clients) {
              if (other !== c && !other.spectator && other.id === c.id && other.sub && other.sub !== c.sub) {
                c.id = `${c.id}-${c.sub!.replace(/\D/g, "").slice(-4) || "2"}`.slice(0, 64);
                break;
              }
            }
          }
          // Agent names are RESERVED: an id that appears in mcpl/tokens.json
          // is claimable only with that agent's own bearer token (the MCPL
          // door forwards it). Closes the "fable spoofable" hole for names we
          // actually know; humans stay self-asserted until archipelago-home.
          {
            const at = agentTokens();
            const tokStr = String(msg.agentToken ?? "");
            let tokId = at.byToken.get(tokStr);
            // The archipelago door forwards the agent's aid1 credential. An
            // identity the home node vouches for satisfies the reservation
            // exactly like a tokens.json bearer — same slug derivation as the
            // MCPL door, so the two doors agree on who "fable" is.
            if (!tokId && HN_ISSUER_KEY && tokStr.startsWith("aid1.")) {
              const v = verifyToken(tokStr, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
              if (v.ok) tokId = v.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || v.payload.sub;
            }
            if (at.names.has(c.id.toLowerCase()) && tokId?.toLowerCase() !== c.id.toLowerCase()) {
              console.log(`[perm] join refused: "${c.id}" is a reserved agent name (token ${tokStr ? "unrecognized" : "missing"})`);
              ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
              c.ws.close?.(4004, "reserved name");
              return;
            }
          }
          // Bans — checked once identity is SETTLED (id/sub/reserved names all
          // resolved above), before the body enters. A global ban closes every
          // door; a per-world ban closes this one. Spectating counts: a ban is
          // exclusion, not just silencing. WORLD_ADMIN passes everywhere — an
          // operator can never be locked out, which is also the unban path of
          // last resort.
          {
            const gb = findBan(globalBans, c.id, c.sub);
            const ban = gb ?? findBan(w.state.bans, c.id, c.sub);
            if (ban && !isAdminId(c.id, c.sub)) {
              console.log(`[world:${w.name}] join refused: ${c.id} is banned ${gb ? "globally" : "here"} (by ${ban.by})`);
              ws.send(JSON.stringify({ type: "error", error: `you are banned from ${gb ? "these worlds" : `"${w.name}"`}${ban.reason ? ` — ${ban.reason}` : ""} (by ${ban.by})` }));
              c.ws.close?.(4006, "banned");
              return;
            }
          }
          c.world = w;
          // identity takeover: ONE body per id per world — a stale session
          // (half-open socket, zombie reconnect) is kicked when its identity
          // reconnects, instead of the two rubberbanding over one avatar.
          // No leave broadcast: the identity isn't leaving, it's re-arriving.
          if (!c.spectator) {
            for (const other of [...w.clients]) {
              if (other !== c && other.id === c.id && !other.spectator) {
                other.superseded = true;
                w.clients.delete(other);
                clients.delete(other.ws);
                other.ws.close?.(4002, "session takeover");
                console.log(`[world:${w.name}] ${c.id} takeover — stale session kicked`);
              }
            }
          }
          w.clients.add(c);
          // A brand-new world belongs to whoever first walks into it embodied:
          // the grant goes through the log like any other fact, actor "world".
          // (Pre-existing ownerless worlds stay OPEN — granting their first
          // owner is a deliberate act by a WORLD_ADMIN, not a land-rush.)
          // ("brand-new" tolerates the genesis dialect marker every fresh log
          // now opens with — a world whose only history is its birth certificate
          // still belongs to whoever steps in first)
          if (!c.spectator && w.snapSeq < 0
            && w.entries.every((e) => e.verb === "genesis")) {
            const entry = w.append("world", "grant",
              { id: c.id, role: "owner", gen: true, ...(c.sub ? { sub: c.sub } : {}) });
            w.broadcast({ type: "log", entry });
            console.log(`[world:${w.name}] new world — ${c.id} is its owner`);
          }
          // snapshot = full log replay (folding comes later) + who's present now
          const jp = w.joinPayload();
          ws.send(JSON.stringify({
            type: "snapshot",
            world: w.name,
            you: c.id,
            recording: RECORD,
            // The world as it is, then only what has happened since. A joiner's
            // cost is now the size of the WORLD, not the length of its history.
            state: jp.state,
            throughSeq: jp.throughSeq,
            entries: jp.tail,
            // what YOU may do here, as of now (live grants update it client-side).
            // `open` = no owner exists, so rights are the everyone-builds default.
            yourRights: { ...rightsOf(w, c.id, c.sub), open: !worldHasOwner(w.state) },
            // wake where you fell asleep — the world's memory of your body
            restore: c.spectator ? null : (w.poses[c.id] ?? null),
            present: [...w.clients].filter(o => o !== c && !o.spectator).map(o => ({
              // settledPose, not lastPose: a joiner must not inherit someone
              // else's mid-ragdoll frame (#61). Same normalization `restore`
              // above already gets via rememberPose.
              id: o.id, avatar: o.avatar, pose: settledPose(o.lastPose), agent: o.agent,
            })),
          }));
          if (!c.spectator) w.broadcast({ type: "arrive", id: c.id, avatar: c.avatar, agent: c.agent }, c);
          if (!c.spectator) w.bhv.onPresence("enter", c.id);
          // Whispers that arrived while this identity was away. Held in memory
          // only — see the `whisper` case for why they must never reach the log.
          if (!c.spectator) {
            const held = pendingWhispers.get(whisperKey(w.name, c.id));
            if (held?.length) {
              for (const m of held) ws.send(JSON.stringify(m));
              pendingWhispers.delete(whisperKey(w.name, c.id));
              console.log(`[world:${w.name}] delivered ${held.length} held whisper(s) to ${c.id}`);
            }
          }
          console.log(`[world:${w.name}] ${describe(w)}${c.spectator ? ` — ${c.id} watching` : ` — ${c.id} joined`}`);
          break;
        }
        case "verb": {
          if (!c.world) return;
          // spectators watch; authoring needs a body. (This is the entire
          // show-night moderation model: the audience cannot touch the stage.)
          if (c.spectator) {
            ws.send(JSON.stringify({ type: "error", error: "spectators can't author — join embodied to build" }));
            return;
          }
          if (now - c.verbWin > 4000) { c.verbWin = now; c.verbCount = 0; }
          if (++c.verbCount > VERB_RATE) {
            if (c.verbCount === VERB_RATE + 1) c.world.debug("rate-limit", { who: c.id });
            ws.send(JSON.stringify({ type: "error", error: "slow down — verb rate limit" }));
            return;
          }
          // verb allow-list + per-world rights (see the permissions block).
          const needs = VERB_NEEDS[msg.verb as string];
          if (!needs) {
            c.world.debug("denied", { who: c.id, verb: String(msg.verb), why: "verb not allowed" });
            // the refusal teaches the lanes: the verb set is closed ON PURPOSE
            // and each kind of extension has a designed door
            ws.send(JSON.stringify({ type: "error",
              error: `verb not allowed: ${msg.verb} — the verb set is closed by design; extend state with comp {id, type, data}, interactions with use {id, action}, semantics with behavior scripts (see AGENTS.md). New verbs are protocol amendments.` }));
            return;
          }
          // Mounting or dismounting YOURSELF (sit on the swing, step off the
          // ferry) is a visitor act — using the world, not editing it. Moving
          // OTHER things (cargo onto a truck) stays building.
          const selfMount = (msg.verb === "mount" || msg.verb === "dismount")
            && String((msg.args as Record<string, unknown> | undefined)?.id ?? "") === c.id;
          const needRank = selfMount ? 0 : needs.rank;
          const rights = rightsOf(c.world, c.id, c.sub);
          if (ROLE_RANK[rights.role] < needRank || (needs.gen && !rights.gen)) {
            const why = needs.gen && ROLE_RANK[rights.role] >= needs.rank
              ? "bringing new assets into this world needs the gen capability — ask its owner"
              : `"${msg.verb}" needs ${needs.rank >= 2 ? "the world's owner" : "builder rights"} here — you are a ${rights.role}`;
            c.world.debug("denied", { who: c.id, verb: String(msg.verb), why });
            ws.send(JSON.stringify({ type: "error", error: why }));
            return;
          }
          // the lock gate sits AFTER rank (a visitor's refusal should teach
          // rank, not locks) and BEFORE shape-checks/append: a locked thing
          // refuses everyone identically, locker included
          const lockedWhy = lockRefusal(c.world, msg.verb as string, msg.args as Record<string, unknown> | undefined);
          if (lockedWhy) {
            c.world.debug("denied", { who: c.id, verb: String(msg.verb), why: "locked" });
            ws.send(JSON.stringify({ type: "error", error: lockedWhy }));
            return;
          }
          let args = (msg.args ?? {}) as Record<string, unknown>;
          if (msg.verb === "grant") {
            // shape-check before it becomes history: {id, role?, gen?}
            const id = String(args.id ?? "").slice(0, 64);
            const role = args.role != null ? String(args.role) : undefined;
            const gen = args.gen != null ? Boolean(args.gen) : undefined;
            if (!id || (role == null && gen == null) || (role != null && ROLE_RANK[role] == null)) {
              ws.send(JSON.stringify({ type: "error", error: "grant wants {id, role: owner|builder|visitor} and/or {gen: true|false}" }));
              return;
            }
            if (id === "*" && role === "owner") {
              ws.send(JSON.stringify({ type: "error", error: "everyone cannot own a world" }));
              return;
            }
            // resolve-at-grant: if the subject is PRESENT with a durable sub,
            // bind the grant to it — authority follows the person, not the nick
            const subject = [...c.world.clients].find((o) => o.id === id && o.sub);
            args = { id, ...(role != null ? { role } : {}), ...(gen != null ? { gen } : {}),
              ...(subject?.sub ? { sub: subject.sub } : {}) };
          }
          if (msg.verb === "force") {
            // shape-check before it becomes history: {at:[x,y,z], radius?,
            // power?}. Bounded HARD — the receiver caps what it applies to
            // itself, but the log should never carry a number that reads as a
            // weapon, and a replayed entry must be as harmless as a live one
            // is consensual.
            const at = Array.isArray(args.at) ? (args.at as unknown[]).map(Number) : null;
            if (!at || at.length !== 3 || at.some((n) => !Number.isFinite(n))) {
              ws.send(JSON.stringify({ type: "error", error: "force wants {at: [x,y,z], radius?, power?}" }));
              return;
            }
            const radius = Math.min(30, Math.max(0.5, Number(args.radius ?? 4)));
            const power = Math.min(12, Math.max(0.2, Number(args.power ?? 3)));
            args = { at, radius, power };
          }
          if (msg.verb === "punt") {
            // shape-check before it becomes history: {id, dir?, power?}. The
            // target must exist, the power is bounded, and the kicker must be
            // NEAR the thing — an arm's-length act like /push, checked here
            // because agents reach this verb with no client-side gate. The
            // object's LIVE position counts (a leased ball is where its sim
            // says, not where the log left it).
            const id = String(args.id ?? "").slice(0, 64);
            if (!id || !c.world.state.entities[id]) {
              ws.send(JSON.stringify({ type: "error", error: `nothing here called "${id}" to kick` }));
              return;
            }
            const at = c.world.leases.get(id)?.lastState?.p ?? c.world.state.entities[id].pos;
            const me = c.lastPose?.p;
            if (!me || Math.hypot(me[0] - at[0], me[2] - at[2]) > 4) {
              c.world.debug("denied", { who: c.id, verb: "punt", why: `${id} is out of reach` });
              ws.send(JSON.stringify({ type: "error", error: `${id} is too far away to kick` }));
              return;
            }
            const power = Math.min(10, Math.max(0.5, Number(args.power ?? 5)));
            const dir = Array.isArray(args.dir) ? (args.dir as unknown[]).slice(0, 3).map(Number) : null;
            args = { id, power, ...(dir && dir.length === 3 && dir.every(Number.isFinite) ? { dir } : {}) };
          }
          if (msg.verb === "comp") {
            // shape-check before it becomes history: {id, type, data|null}.
            // data is opaque but BOUNDED — components are parameters, not
            // payloads; anything bigger belongs in /upload + a path here.
            const id = String(args.id ?? "").slice(0, 64);
            const type = String(args.type ?? "").slice(0, 32);
            if (!id || !type) {
              c.world.debug("rejected", { who: c.id, verb: "comp", why: "malformed — wants {id, type, data|null}" });
              ws.send(JSON.stringify({ type: "error", error: "comp wants {id, type, data|null}" }));
              return;
            }
            if (args.data !== undefined && args.data !== null
              && JSON.stringify(args.data).length > 8192) {
              c.world.debug("rejected", { who: c.id, verb: "comp", why: `data too large (8KB max) on ${id}.${type}` });
              ws.send(JSON.stringify({ type: "error", error: "component data too large (8KB max) — put big things in /upload and reference the path" }));
              return;
            }
            args = { id, type, data: args.data ?? null };
          }
          if (msg.verb === "mount") {
            const id = String(args.id ?? "").slice(0, 64);
            const to = String(args.to ?? "").slice(0, 64);
            if (!id || !to || id === to || !c.world.state.entities[to]) {
              c.world.debug("rejected", { who: c.id, verb: "mount",
                why: !c.world.state.entities[to] ? `no entity "${to}" to mount onto` : "malformed mount" });
              ws.send(JSON.stringify({ type: "error", error: "mount wants {id, to: <existing entity>, slot?, offset?, yaw?}" }));
              return;
            }
          }
          if (msg.verb === "kick" || msg.verb === "ban" || msg.verb === "unban") {
            // Moderation verbs: {id, reason?}. Owner-rank, checked above like
            // grant. Shape-checked and TARGET-checked before they become
            // history: no self-moderation, no wildcard, and the power ladder
            // does not eat itself — operators are untouchable, and one owner
            // cannot ban another (a WORLD_ADMIN can; that is what it is for).
            const id = String(args.id ?? "").trim().slice(0, 64);
            if (!id || id === "*") {
              ws.send(JSON.stringify({ type: "error", error: `${msg.verb} wants {id, reason?} — a specific participant, not everyone` }));
              return;
            }
            if (id.toLowerCase() === c.id.toLowerCase()) {
              ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
              return;
            }
            // The durable principal, when the target is standing right here —
            // a ban keyed only to a display name is evaded by /name; carrying
            // the sub makes it stick to the person, not the label.
            const targetC = [...c.world.clients].find((o) => o.id.toLowerCase() === id.toLowerCase());
            const targetSub = targetC?.sub;
            if (!isAdminId(c.id, c.sub)) {
              if (isAdminId(id, targetSub)) {
                ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — operators cannot be ${msg.verb === "kick" ? "kicked" : "banned"}` }));
                return;
              }
              if (msg.verb !== "unban" && rightsOf(c.world, id, targetSub).role === "owner") {
                ws.send(JSON.stringify({ type: "error", error: `${id} also owns this world — owners cannot ${msg.verb} each other (a WORLD_ADMIN can)` }));
                return;
              }
            }
            const reason = args.reason != null ? String(args.reason).slice(0, 200) : undefined;
            args = { id, ...(reason ? { reason } : {}), ...(msg.verb === "ban" && targetSub ? { sub: targetSub } : {}) };
          }
          if (msg.verb === "behavior") {
            // Bind a runtime script: {id, src, attach?, caps?, knobs?} or
            // {id, remove: true}. src must be a content-addressed script
            // upload — the binding pins exact bytes, so replay is exact.
            const id = String(args.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
            if (!id) { ws.send(JSON.stringify({ type: "error", error: "behavior wants {id, src|remove}" })); return; }
            if (args.remove) { args = { id, remove: true }; }
            else {
              // runtime "client" = a MOD OFFER (docs/leases.md §self-animation):
              // code visitors may choose to run in their own clients, each by
              // per-script consent. Publishing code for OTHERS' machines is an
              // owner act — a stricter gate than binding a sandboxed behavior.
              const runtime = args.runtime != null ? String(args.runtime) : undefined;
              if (runtime !== undefined && runtime !== "client") {
                ws.send(JSON.stringify({ type: "error", error: 'behavior runtime must be "client" (or absent for the server sandbox)' }));
                return;
              }
              if (runtime === "client" && ROLE_RANK[rightsOf(c.world, c.id, c.sub).role] < 2 && !isAdminId(c.id, c.sub)) {
                c.world.debug("denied", { who: c.id, verb: "behavior", why: "client-runtime mods are owner-only" });
                ws.send(JSON.stringify({ type: "error", error: "offering mods to visitors' clients is for this world's owner" }));
                return;
              }
              const src = String(args.src ?? "");
              if (!/^store\/scripts\/[a-f0-9]{16}\.js$/.test(src) || !existsSync(join(ROOT, "assets", "opt", src))) {
                c.world.debug("rejected", { who: c.id, verb: "behavior", why: `no such script: ${src} — upload with POST /upload?as=script first` });
                ws.send(JSON.stringify({ type: "error", error: "src must be an uploaded script path (POST /upload?as=script → store/scripts/<hash>.js)" }));
                return;
              }
              const nBehaviors = Object.keys(c.world.state.behaviors ?? {}).length;
              if (!c.world.state.behaviors?.[id] && nBehaviors >= behaviorLimits.MAX_BEHAVIORS_PER_WORLD) {
                ws.send(JSON.stringify({ type: "error", error: `this world already runs ${nBehaviors} behaviors (cap ${behaviorLimits.MAX_BEHAVIORS_PER_WORLD})` }));
                return;
              }
              const attach = args.attach != null ? String(args.attach).slice(0, 64) : undefined;
              if (attach && !c.world.state.entities[attach]) {
                ws.send(JSON.stringify({ type: "error", error: `nothing here called "${attach}" to attach to` }));
                return;
              }
              if (args.knobs != null && JSON.stringify(args.knobs).length > 4096) {
                ws.send(JSON.stringify({ type: "error", error: "knobs too large (4KB)" }));
                return;
              }
              const capsIn = (args.caps ?? {}) as Record<string, unknown>;
              const caps = {
                ...(Array.isArray(capsIn.verbs) ? { verbs: capsIn.verbs.map(String).slice(0, 16) } : {}),
                ...(capsIn.selfOnly != null ? { selfOnly: Boolean(capsIn.selfOnly) } : {}),
              };
              args = { id, src, ...(attach ? { attach } : {}),
                ...(runtime === "client" ? { runtime: "client" } : {}),
                ...(Object.keys(caps).length ? { caps } : {}),
                ...(args.knobs != null ? { knobs: args.knobs } : {}) };   // author = entry.actor, never client-supplied
            }
          }
          if (msg.verb === "say") {
            // Spoken-say protocol: `spoken`/`utt`/`t0` are display metadata for
            // a voice that already performed as captions. t0 is a REORDER key
            // on every client, so it is never trusted raw — it exists only
            // inside the spoken protocol, must be finite, and is clamped to a
            // bounded utterance window ending at arrival. Ordinary says get all
            // three stripped: a confused client degrades to normal chat rather
            // than breaking.
            const a = args as Record<string, unknown>;
            const now = Date.now();
            const MAX_UTTER_MS = 300_000;
            const uttN = Number(a.utt);
            const t0N = Number(a.t0);
            if (a.spoken === true && Number.isSafeInteger(uttN) && uttN >= 0) {
              a.spoken = true;
              a.utt = uttN;
              if (Number.isFinite(t0N)) {
                a.t0 = Math.min(now, Math.max(now - MAX_UTTER_MS, t0N));
              } else delete a.t0;
            } else { delete a.spoken; delete a.utt; delete a.t0; }
          }
          const entry = c.world.append(c.id, msg.verb, args);
          c.world.broadcast({ type: "log", entry }); // everyone, including author (authoritative echo)
          // A `use` is a cause; reactions turn it into logged effects.
          if (msg.verb === "use") reactToUse(c.world, entry);
          // Runtime scripts hear causes too — and a (re)bind reconciles sandboxes.
          if (msg.verb === "behavior") c.world.bhv.sync();
          c.world.bhv.onEntry(entry);
          // a folded motion that can't move is a silence someone will debug
          // at 4am — lint it into the recorder while the fold is still warm
          if (msg.verb === "motion" || (msg.verb === "comp" && /^motion(:|$)/.test(String((args as any).type ?? "")))) {
            lintMotion(c.world, entry);
          }
          // Same courtesy for an emitter that won't emit: an unknown preset or
          // a clamped parameter is a silence the author would otherwise have
          // to discover by asking someone with a GPU what they can see.
          if (msg.verb === "comp" && String((args as any).type ?? "") === "particles") {
            lintParticles(c.world, entry);
          }
          // A ban or kick lands NOW on every matching body, not at some future
          // join — the fold recorded the fact; this is the fact taking effect.
          if (msg.verb === "ban" || msg.verb === "kick") {
            const tid = String((args as { id: string }).id).toLowerCase();
            const tsub = (args as { sub?: string }).sub;
            const treason = (args as { reason?: string }).reason;
            const w = c.world;
            for (const other of [...w.clients]) {
              if (other === c) continue;
              if (other.id.toLowerCase() !== tid && !(tsub && other.sub === tsub)) continue;
              expel(w, other, msg.verb === "ban"
                ? `you were banned from "${w.name}" by ${c.id}${treason ? ` — ${treason}` : ""}`
                : `you were removed from "${w.name}" by ${c.id}${treason ? ` — ${treason}` : ""}`);
              console.log(`[world:${w.name}] ${other.id} ${msg.verb === "ban" ? "banned" : "kicked"} by ${c.id}${treason ? ` (${treason})` : ""}`);
            }
          }
          break;
        }
        case "history": {
          // Deliberately available to spectators too: watching a show and
          // reading back what was said before you arrived is the same act.
          if (!c.world) return;
          const r = c.world.readHistory({
            before: typeof msg.before === "number" ? msg.before : Infinity,
            after: typeof msg.after === "number" ? msg.after : -Infinity,
            limit: Math.min(300, Math.max(1, Number(msg.limit ?? 50))),
            verbs: Array.isArray(msg.verbs) && msg.verbs.length ? new Set(msg.verbs.map(String)) : null,
          });
          ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, ...r }));
          break;
        }
        case "debug": {
          // The flight recorder (World.debugLog): why things bounced —
          // denials, rejections, rate limits, reaction outcomes. Open to
          // spectators for the same reason history is: the log is public,
          // so the reasons things failed to reach it are public too.
          if (!c.world) return;
          const limit = Math.min(300, Math.max(1, Number(msg.limit ?? 50)));
          if (msg.behavior != null) {
            // one script's own log ring + status — the author's console
            const b = c.world.bhv.inspect(String(msg.behavior));
            ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
              behavior: String(msg.behavior),
              status: b?.status ?? "no such behavior",
              events: (b?.ring ?? []).slice(-limit).map((r) => ({ ts: r.ts, kind: "script-log", line: r.line })) }));
            break;
          }
          if (msg.behaviors) {   // the roster: what runs here, and is it alive
            ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
              events: c.world.bhv.list().map((b) => ({ ts: 0, kind: "behavior", ...b })) }));
            break;
          }
          const kinds = Array.isArray(msg.kinds) && msg.kinds.length ? new Set(msg.kinds.map(String)) : null;
          const events = c.world.debugLog
            .filter((e) => !kinds || kinds.has(String(e.kind)))
            .slice(-limit);
          ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null, events }));
          break;
        }
        case "whisper": {
          if (!WHISPERS_ENABLED) {
            ws.send(JSON.stringify({ type: "error", error: "whispers are disabled in this world" }));
            break;
          }
          // A private message between two bodies.
          //
          // It must NEVER reach the world log. The log is append-only, public,
          // replayed in full to every future joiner, and forkable — a whisper
          // written there would be permanently readable by everyone who ever
          // enters this world, including people who weren't born yet when it
          // was sent. So whispers route point-to-point and are never appended.
          //
          // The cost of that choice is durability: there is no log to replay
          // from. So an undelivered whisper is held in MEMORY for a while and
          // handed over when its recipient next joins. Lost on restart, which
          // is the honest trade — a private message should be more willing to
          // vanish than to become permanent public record.
          if (!c.world || c.spectator) return;
          const to = String(msg.to ?? "").slice(0, 64);
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!to || !text) return;
          const packet = { type: "whisper", from: c.id, to, text, ts: Date.now() };
          const targets = [...c.world.clients].filter((o) => o.id === to && !o.spectator);
          for (const t of targets) t.ws.send(JSON.stringify(packet));
          ws.send(JSON.stringify({ ...packet, echo: true })); // your own sent copy
          if (!targets.length) {
            const key = whisperKey(c.world.name, to);
            const q = pendingWhispers.get(key) ?? [];
            q.push(packet);
            while (q.length > 20) q.shift();
            pendingWhispers.set(key, q);
            ws.send(JSON.stringify({ type: "error", error: `${to} isn't here — they'll get it when they arrive` }));
          }
          break;
        }
        case "anim": {
          // A one-off animation: relayed once to everyone, never logged. It is
          // a moment, not a fact about the world — presence, like a pose. Small
          // enough (a few KB of quaternions) that it needs no store; big enough
          // that it must not ride the 15Hz pose stream, so it is its own
          // message sent once.
          if (!c.world || c.spectator) return;
          if (typeof msg.dur !== "number" || typeof msg.tracks !== "object") return;
          // one guard against a pathological payload — poses are tiny, so
          // anything approaching a real asset is a mistake or an attack
          if (JSON.stringify(msg.tracks).length > 64_000) {
            ws.send(JSON.stringify({ type: "error", error: "animation too large — keep custom clips small and sparse" }));
            return;
          }
          c.world.broadcast({ type: "anim", id: c.id, dur: msg.dur, tracks: msg.tracks, loop: !!msg.loop }, c);
          break;
        }
        case "puppet": {
          // Ask another body to hold a pose or play an animation. Deliberately
          // ROUTED to the target rather than broadcast: DESIGN.md's invariant
          // is that each client owns its own avatar, so a puppet is a REQUEST
          // its target applies to itself (and then broadcasts through its own
          // presence, like any other input) — not a pose asserted onto it from
          // outside. The target decides whether to honour it.
          if (!c.world || c.spectator) return;
          const to = String(msg.target ?? "").slice(0, 64);
          const tc = [...c.world.clients].find((o) => o.id === to && !o.spectator);
          if (!tc) { ws.send(JSON.stringify({ type: "error", error: `${to || "target"} isn't here to pose` })); return; }
          // ragdoll rides as `true` (undirected knock-over, the old wire) or
          // {lean:[x,y,z]} m/s — which way the shove sends them. Sanitize to
          // exactly those two shapes; the receiver caps magnitude for itself.
          let rag: true | { lean: number[] } | null = null;
          if (msg.ragdoll === true) rag = true;
          else if (msg.ragdoll && Array.isArray((msg.ragdoll as { lean?: unknown }).lean)) {
            const lean = ((msg.ragdoll as { lean: unknown[] }).lean).map(Number);
            if (lean.length === 3 && lean.every(Number.isFinite)) rag = { lean };
          }
          tc.ws.send(JSON.stringify({ type: "puppet", by: c.id, pose: msg.pose ?? null, anim: msg.anim ?? null, ragdoll: rag }));
          break;
        }
        case "bc": {
          // dev crash forensics: keep the client's last N breadcrumbs in
          // memory, printed on disconnect (see close). Never persisted.
          const ring = ((c as any).bcRing ??= []);
          ring.push(String(msg.tag ?? "").slice(0, 64));
          if (ring.length > 40) ring.shift();
          return;
        }
        case "lease": {
          // Entity animation leases — docs/leases.md. The server arbitrates
          // (objects have no owning client), remembers the last streamed
          // transform, and COMMITS it when the holder releases, vanishes, or
          // goes stale. It never simulates: transforms in, transforms out,
          // one `place` verb at rest. Presence semantics: never logged.
          if (!c.world || c.spectator) return;
          const w = c.world;
          const id = String(msg.id ?? "").slice(0, 64);
          const op = String(msg.op ?? "");
          if (!id) return;

          const sane = (a: unknown, n: number): number[] | null => {
            if (!Array.isArray(a) || a.length !== n) return null;
            const v = (a as unknown[]).map(Number);
            return v.every(Number.isFinite) ? v : null;
          };
          if (op === "claim") {
            if (!w.state.entities[id]) {
              ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: "no such entity" }));
              return;
            }
            // physical play is USING the world (rank 0), like `use` — a
            // per-world knob can gate this later without protocol changes
            const cur = w.leases.get(id);
            if (cur && cur.holder !== c) {
              const stale = Date.now() - cur.lastAt > 5000;
              // proximity take: you can take what you can reach — the ball
              // being dribbled past you is kickable, the one across the
              // field is not. Distance vs the OBJECT's live position.
              const at = cur.lastState?.p ?? w.state.entities[id].pos;
              const me = c.lastPose?.p;
              const near = !!me && Math.hypot(me[0] - at[0], me[2] - at[2]) <= 3.5;
              if (!stale && !(msg.take && near)) {
                ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: `${cur.holder.id} is animating it` }));
                return;
              }
              cur.holder.ws.send(JSON.stringify({ type: "lease", op: "lost", id, to: c.id }));
            }
            // per-client cap: a runaway plugin must not lease a whole world
            let held = 0;
            for (const L of w.leases.values()) if (L.holder === c) held++;
            if (held >= 8 && !w.leases.has(id)) {
              ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: "too many live leases — release something" }));
              return;
            }
            w.leases.set(id, { holder: c, lastState: w.leases.get(id)?.lastState ?? null, lastAt: Date.now() });
            ws.send(JSON.stringify({ type: "lease", op: "granted", id, ...(w.leases.get(id)!.lastState ? { from: w.leases.get(id)!.lastState } : {}) }));
            w.broadcast({ type: "lease", op: "claimed", id, by: c.id }, c);
            return;
          }

          const L = w.leases.get(id);
          if (!L || L.holder !== c) return;      // a lost holder's tail, dropped

          if (op === "state") {
            const p = sane(msg.p, 3);
            if (!p) return;
            const yaw = Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : undefined;
            const q = sane(msg.q, 4) ?? undefined;
            L.lastState = { p, ...(yaw != null ? { yaw } : {}), ...(q ? { q } : {}) };
            L.lastAt = Date.now();
            w.broadcast({ type: "lease", op: "state", id, by: c.id, p, ...(yaw != null ? { yaw } : {}), ...(q ? { q } : {}) }, c);
            return;
          }
          if (op === "release") {
            w.settleLease(id, { p: sane(msg.p, 3), yaw: Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : null });
            return;
          }
          return;
        }
        case "bodydrag": {
          const okSim = (v: any) => {
            if (!v || typeof v !== "object") return false;
            const { j, p, q } = { j: v.j, p: v.p, q: v.v };
            if (!Array.isArray(j) || j.length === 0 || j.length > 24) return false;
            if (!Array.isArray(p) || !Array.isArray(q)) return false;
            if (p.length !== j.length * 3 || q.length !== j.length * 3) return false;
            return j.every((n: unknown) => typeof n === "string" && n.length <= 24)
              && p.every((n: unknown) => Number.isFinite(n))
              && q.every((n: unknown) => Number.isFinite(n));
          };
          // Interactive ragdoll drag — the takeover stream. A dragger runs the
          // body's sim on ITS machine and streams the result to the body's
          // owner, who applies it to itself and rebroadcasts through normal
          // presence (one source of truth; everyone else needs no new code).
          // Targeted like puppet, presence-plane semantics: never logged,
          // never queued, relayed as-is. The OWNER decides whether to honour
          // any of it — grab, stream and release are all just requests.
          if (!c.world || c.spectator) return;
          const raw = String(msg.pose ? JSON.stringify(msg.pose) : "");
          if (raw.length > 24_000) return;      // a pose is tiny; anything else is an attack
          const to = String(msg.target ?? "").slice(0, 64);
          const tc = [...c.world.clients].find((o) => o.id === to && !o.spectator);
          if (process.env.BD_DEBUG) console.log(`[bd] ${c.id} -> ${to} (${msg.grab ? "grab" : msg.end ? "end" : "sample"}) ${tc ? "relayed" : `NO TARGET among [${[...c.world.clients].map((o) => o.id).join(",")}]`}`);
          if (!tc) return;                       // dragging the departed: silently moot
          tc.ws.send(JSON.stringify({
            type: "bodydrag", by: c.id,
            ...(msg.grab != null ? { grab: msg.grab } : {}),
            ...(msg.end != null ? { end: true } : {}),
            ...(msg.pose != null ? { pose: msg.pose } : {}),
            ...(Array.isArray(msg.p) ? { p: (msg.p as unknown[]).slice(0, 3).map(Number) } : {}),
            ...(msg.yaw != null ? { yaw: Number(msg.yaw) } : {}),
            // persistent pins: nail-here (rides a release), pull-this-nail,
            // and the owner's current pin set (sent back on grab accept so
            // the dragger's takeover sim keeps enforcing the other nails)
            // the handover: joint names, positions and velocities, so the
            // receiver CONTINUES the sim instead of rebuilding a guess from
            // the bones. Bounded like everything else on this path — 24 joints,
            // three finite numbers each, or it does not travel.
            ...(okSim(msg.sim) ? { sim: msg.sim } : {}),
            ...(msg.pinAt != null ? { pinAt: msg.pinAt } : {}),
            ...(msg.unpin != null ? { unpin: msg.unpin } : {}),
            ...(Array.isArray(msg.pins) ? { pins: (msg.pins as unknown[]).slice(0, 16) } : {}),
          }));
          break;
        }
        case "caption": {
          // Live speech pacing: a voice agent STREAMS by nature, but streaming
          // into the log turns one utterance into six fragmentary pings for
          // every listening agent. So the sentences ride presence — relayed,
          // never persisted, same doctrine as typing — and the complete
          // utterance lands in the log as ONE say when the voice finishes.
          // Agents perceive a paragraph; humans watch it being spoken.
          if (!c.world || c.spectator) return;
          const capText = String(msg.text ?? "").slice(0, 500);
          if (!capText) return;
          const capUtt = Number(msg.utt);
          c.world.broadcast({ type: "caption", id: c.id, text: capText,
            utt: Number.isSafeInteger(capUtt) && capUtt >= 0 ? capUtt : 0 }, c);
          break;
        }
        case "rtc": {
          // Voice/media signaling: point-to-point like a whisper and never
          // logged for the same reason — but unlike a whisper, a stale SDP is
          // worthless (an offer for a peer who left answers nothing), so there
          // is no pending queue: absent recipient = silently dropped.
          if (!c.world || c.spectator) return;
          const rto = String(msg.to ?? "").slice(0, 64);
          if (!rto || msg.payload == null) return;
          if (JSON.stringify(msg.payload).length > 20000) return; // SDP-sized, not file-sized
          const rpacket = JSON.stringify({ type: "rtc", from: c.id, to: rto, payload: msg.payload });
          for (const t of c.world.clients) if (t.id === rto && !t.spectator) t.ws.send(rpacket);
          return;
        }
        case "typing": {
          // Pure presence: who is composing, right now. Never logged, never
          // queued, and irrelevant a second later.
          if (!c.world || c.spectator) return;
          // state: optional social affordance glyph for agents (ear = I hear
          // you, think = composing a reply, tool = working). Whitelisted so
          // presence stays presence.
          // mic = a live voice is coming from this body right now (R, 23:30)
          const st = typeof msg.state === "string" && ["ear", "think", "tool", "mic"].includes(msg.state) ? msg.state : null;
          c.world.broadcast({ type: "typing", id: c.id, to: msg.to ?? null, ...(st ? { state: st } : {}) }, c);
          break;
        }
        case "drag": {
          // Transient build feedback. DESIGN.md is explicit that dragging is
          // presence traffic and only the RELEASE commits a log entry — so this
          // is relayed and never persisted, exactly like a pose. Without it,
          // everyone else sees objects teleport on release instead of move.
          if (!c.world || c.spectator) return;
          // the RELEASE is a `place` verb the gate above checks; the live drag
          // must agree with it or visitors can slide props they can't commit
          if (ROLE_RANK[rightsOf(c.world, c.id, c.sub).role] < 1) return;
          c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, by: c.id }, c);
          break;
        }
        case "pose": {
          if (!c.world || c.spectator) return;
          c.lastPose = msg.pose;
          // presence: batched into stage frames by the tick loop, never persisted
          c.world.dirty.set(c.id, msg.pose);
          break;
        }
        case "snap-result": {
          const pending = pendingSnaps.get(msg.id);
          if (!pending || !c.renderer) return;
          pendingSnaps.delete(msg.id);
          if (typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/png;base64,")) {
            pending.resolve({ ok: true, png: Buffer.from(msg.dataUrl.slice("data:image/png;base64,".length), "base64") });
          } else {
            pending.resolve({ ok: false, err: String(msg.error ?? "renderer returned no image"), status: 502 });
          }
          break;
        }
        case "world-fork": {
          // Copy the world you are standing in to a new name. Owner-only
          // (rank 2, like shaping terrain): the fork carries ALL history —
          // every chat line ever said here — so duplicating it is the owner's
          // call, not any visitor's. WORLD_ADMIN passes everywhere, which is
          // also the only door for pre-permissions OPEN worlds.
          if (!c.world) return;
          if (c.spectator) {
            ws.send(JSON.stringify({ type: "error", error: "spectators can't copy worlds — join embodied" }));
            return;
          }
          const rights = rightsOf(c.world, c.id, c.sub);
          if (ROLE_RANK[rights.role] < 2) {
            ws.send(JSON.stringify({ type: "error", error: `copying a world needs its owner — you are a ${rights.role} here` }));
            return;
          }
          const to = String(msg.to ?? "").slice(0, 64);
          const r = forkWorld(c.world, to);
          if (!r.ok) {
            ws.send(JSON.stringify({ type: "error", error: r.err }));
            return;
          }
          console.log(`[world:${c.world.name}] copied → "${to}" by ${c.id}`);
          ws.send(JSON.stringify({ type: "world-forked", from: c.world.name, to }));
          break;
        }
        case "world-reset": {
          // Erase the world you are standing in back to zero. Owner-only, and
          // the message must carry the world's own name — the client makes you
          // type it, the server refuses anything else, so a stray click can
          // never be the thing that empties a world. History is archived, not
          // destroyed (see World.reset).
          if (!c.world) return;
          if (c.spectator) {
            ws.send(JSON.stringify({ type: "error", error: "spectators can't erase worlds — join embodied" }));
            return;
          }
          const rights = rightsOf(c.world, c.id, c.sub);
          if (ROLE_RANK[rights.role] < 2) {
            ws.send(JSON.stringify({ type: "error", error: `erasing a world needs its owner — you are a ${rights.role} here` }));
            return;
          }
          if (String(msg.name ?? "") !== c.world.name) {
            ws.send(JSON.stringify({ type: "error", error: `confirmation mismatch — reset must name "${c.world.name}"` }));
            return;
          }
          const w = c.world;
          // Who owned it, before the log goes: a reset world must not become a
          // land-rush — the same owners hold the fresh one. (An ADMIN resetting
          // an OPEN world leaves it open: no owners existed, none are minted.)
          const owners = Object.entries(w.state.roles ?? {})
            .filter(([id, r2]) => id !== "*" && r2.role === "owner")
            .map(([id]) => id);
          const arch = w.reset();
          for (const id of owners) {
            const entry = w.append("world", "grant", { id, role: "owner", gen: true });
            w.broadcast({ type: "log", entry });
          }
          console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
          w.broadcast({ type: "world-reset", world: w.name, by: c.id });
          break;
        }
        case "world-bans": {
          // Who is banned from the world you are standing in. Available to
          // anyone present — bans are log entries and the log is public; a
          // list nobody can read is not an audit trail.
          if (!c.world) return;
          const list = Object.entries(c.world.state.bans ?? {}).map(([id, b]) =>
            `${id} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
          ws.send(JSON.stringify({ type: "mod", text: list.length
            ? `banned from "${c.world.name}" (${list.length}):\n${list.join("\n")}`
            : `nobody is banned from "${c.world.name}"` }));
          break;
        }
        case "global-ban":
        case "global-unban":
        case "global-bans": {
          // Instance-wide moderation. Not world verbs — there is no global log
          // — so these are messages, gated on WORLD_ADMIN and persisted in
          // .bans.json (same posture as .sessions.json). Replies come back as
          // `mod` messages; refusals as `error`, like everything else.
          if (!isAdminId(c.id, c.sub)) {
            ws.send(JSON.stringify({ type: "error", error: "global moderation needs WORLD_ADMIN — per-world /ban is the owner tool" }));
            return;
          }
          if (msg.type === "global-bans") {
            const list = Object.entries(globalBans).map(([id, b]) =>
              `${id}${b.sub ? ` (${b.sub})` : ""} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
            ws.send(JSON.stringify({ type: "mod", text: list.length ? `global bans (${list.length}):\n${list.join("\n")}` : "no global bans" }));
            return;
          }
          const id = String(msg.id ?? "").trim().slice(0, 64);
          if (!id || id === "*") {
            ws.send(JSON.stringify({ type: "error", error: `${msg.type} wants {id, reason?} — a specific participant, not everyone` }));
            return;
          }
          if (msg.type === "global-unban") {
            const key = id.toLowerCase();
            const had = key in globalBans || Object.values(globalBans).some((b) => b.sub === id);
            delete globalBans[key];
            for (const [k, b] of Object.entries(globalBans)) if (b.sub === id) delete globalBans[k];
            saveGlobalBans();
            console.log(`[mod] ${c.id} lifted global ban on ${id}${had ? "" : " (was not banned)"}`);
            ws.send(JSON.stringify({ type: "mod", text: had ? `${id} is no longer banned globally` : `${id} was not globally banned` }));
            return;
          }
          // global-ban
          if (isAdminId(id)) {
            ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` }));
            return;
          }
          if (id.toLowerCase() === c.id.toLowerCase()) {
            ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
            return;
          }
          const reason = msg.reason != null ? String(msg.reason).slice(0, 200) : undefined;
          // catch the durable principal if the target is connected anywhere
          let tsub: string | undefined;
          for (const w2 of worlds.values()) {
            const t = [...w2.clients].find((o) => o.id.toLowerCase() === id.toLowerCase());
            if (t?.sub) { tsub = t.sub; break; }
          }
          globalBans[id.toLowerCase()] = { by: c.id, ts: Date.now(), ...(reason ? { reason } : {}), ...(tsub ? { sub: tsub } : {}) };
          saveGlobalBans();
          let expelled = 0;
          for (const w2 of worlds.values()) {
            for (const other of [...w2.clients]) {
              if (other === c) continue;
              if (other.id.toLowerCase() !== id.toLowerCase() && !(tsub && other.sub === tsub)) continue;
              expel(w2, other, `you were banned from these worlds by ${c.id}${reason ? ` — ${reason}` : ""}`);
              expelled++;
            }
          }
          console.log(`[mod] ${c.id} banned ${id} globally${reason ? ` (${reason})` : ""}${expelled ? ` — ${expelled} session(s) disconnected` : ""}`);
          ws.send(JSON.stringify({ type: "mod", text: `${id} is banned from all worlds${reason ? ` — ${reason}` : ""}${expelled ? ` (${expelled} live session${expelled === 1 ? "" : "s"} disconnected)` : ""}` }));
          return;
        }
      }
      } catch (err) {
        console.error(`[ws] "${String(msg?.type)}" from ${c.id} failed server-side:`, err);
        try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* socket already gone */ }
      }
    },
  },
});

// ---- stage-frame tick: the embodied plane's heartbeat ----------------------
// One frame per world per tick carrying every pose that changed since the last
// tick. Frames are disposable (latest-value-wins): a client whose socket is
// backed up skips ticks instead of queueing history it will only fast-forward
// through. Idle worlds cost one Map.size check.
const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Bytes of unsent backlog before we drop frames to a client. Keep TIGHT: with
// nginx fronting, its buffers + the kernel's absorb a lot before Bun's
// bufferedAmount rises at all (measured 2026-07-26: 33s of latency built up
// without ever tripping a 256KB threshold). 32KB ≈ half a second of frames —
// a slow client skips to current instead of drifting behind the show.
const FRAME_SKIP_BUFFERED = 32_000;
setInterval(() => {
  for (const w of worlds.values()) {
    if (w.dirty.size === 0) continue;
    const data = JSON.stringify({ type: "frame", seq: w.frameSeq++, t: Date.now(), poses: Object.fromEntries(w.dirty) });
    w.dirty.clear();
    if (RECORD) {
      if (!w.recPath) {
        w.recPath = join(WORLDS_DIR, w.name, `frames-${Date.now()}.jsonl`);
        console.log(`[world:${w.name}] ⏺ recording stage frames → ${w.recPath}`);
      }
      const roster = JSON.stringify([...w.clients].filter((c) => !c.spectator).map((c) => ({ id: c.id, avatar: c.avatar })));
      if (roster !== w.lastRoster) { w.lastRoster = roster; appendFileSync(w.recPath, `{"type":"roster","t":${Date.now()},"roster":${roster}}\n`); }
      appendFileSync(w.recPath, data + "\n");
    }
    for (const c of w.clients) {
      if ((c.ws.getBufferedAmount?.() ?? 0) > FRAME_SKIP_BUFFERED) continue; // stale frames die here, not in the kernel
      c.ws.send(data);
    }
  }
}, FRAME_MS);

// Stale-lease sweep: a holder that stops streaming (hung tab, wedged plugin)
// loses the object — committed at its last known transform, like a
// disconnect. Nothing hovers forever; nothing stays possessed.
setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    for (const [id, L] of [...w.leases]) {
      if (now - L.lastAt > 10_000) {
        w.debug("lease-swept", { id, holder: L.holder.id });
        w.settleLease(id);
      }
    }
  }
}, 5_000);

// Fold on the way out so a restart resumes from the snapshot rather than
// re-reading a tail that was already folded in memory.
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    for (const w of worlds.values()) {
      // ws close handlers never run on exit — everyone connected right now
      // sleeps where they stand, same as a normal leave. Without this, a
      // client that also vanished during the restart window woke at its
      // PREVIOUS remembered spot instead of where it stood.
      for (const c of w.clients) {
        if (!c.spectator && !c.superseded && c.lastPose) w.rememberPose(c.id, c.lastPose);
      }
      if (w.entries.length) w.fold("shutdown");
    }
    process.exit(0);
  });
}

console.log(`eidoverse-worlds sequencer on http://0.0.0.0:${PORT}`);
console.log(`  library: ${LIBRARY_DIR}`);
console.log(`  worlds:  ${WORLDS_DIR}`);
if (!JOIN_TOKEN) console.log("  ⚠ NO JOIN_TOKEN — the door is OPEN. Fine on a tailnet, wrong on a public box.");
