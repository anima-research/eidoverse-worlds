// residency — the `residency` component's MEANING, as one pure module.
//
// A `comp {id, type: "residency", data: {...}}` entry declares that an entity
// is a HOST SYSTEM's marker in this world: a waystone saying which machine
// lives here, which mind runs it, and which agents it fields. It is the
// state-shaped extension lane doing exactly what AGENTS.md says it is for —
// no verb, no protocol amendment, no fold change: the fold stays blind and
// this file is the evaluator.
//
// Why a world needs one at all: an agent ecosystem is otherwise invisible.
// The log records that `harbor.wright` spawned a crate, and nothing anywhere
// says that body is one of six an instance called Harbor fields, or that
// Harbor is a coordinator mind on a ExampleHost install, or that the install
// considers this world somewhere it LIVES rather than somewhere it visited.
// That is the difference between an actor id and a resident. The declaration
// carries the identity; the log carries the proof (see `traceResidents` —
// the roster is a claim, the acts are the evidence, and they are reported
// separately on purpose).
//
// Nothing here touches THREE, the DOM, the network or the clock; it is
// imported verbatim by
//
//   mcpl/agent.ts       text-tier perception: look()
//   server/lint.ts      the advisory lint that says why a record won't read
//   server/routes.ts    GET /residency — the projection other instances poll
//   tools/residency-plant.ts   descriptor → the verbs that plant it
//
// so a browser, a late joiner, a resident who perceives by reading and the
// instance that planted the marker cannot disagree about who lives here.
// Same discipline as particles.js and forecast.js: shared facts out of one
// function, no second opinions.
//
// The DATA belongs to the instance, not to this repo: a descriptor is a
// host system's own identity, kept wherever that host keeps its instance data
// (residency/README.md), and passed to the planter as a path. What lives here
// is only what could not live anywhere else — the meaning a world gives it.
//
// NOTHING IN A RESIDENCY RECORD IS A CREDENTIAL OR AN ADDRESS. The bag is
// public, permanent, replayed to everyone who ever joins, and forkable — so
// the model deliberately has no field for a hostname, an IP, a tailnet name,
// a token, or a person. An instance identifies itself by a name it chose.
//
// Unit-tested in tools/residency-test.ts.

/** The roles an ecosystem's members announce themselves in, and how each
 *  reads in prose. A role outside this list is never erased — it reads
 *  quoted, the same forward-compatibility the component bag has everywhere
 *  else — because the vocabulary of a hosting stack is not this world's to
 *  fix. */
export const RESIDENT_ROLES = Object.freeze({
  'coordinator': 'coordinator',
  planner: 'planner',
  builder: 'builder',
  reviewer: 'reviewer',
  scribe: 'scribe',
  sentinel: 'sentinel',
  courier: 'courier',
  researcher: 'researcher',
  operator: 'operator',
});

/** A roster is a marker, not a directory: an instance that fields hundreds of
 *  ephemeral workers names the standing ones. The cap is well under the 8KB
 *  the component bag allows, so a record that hits it is a modelling mistake
 *  rather than a size problem. */
export const RESIDENCY_MAX_AGENTS = 24;

/** The one asset every checkout of the library has (every test tool spawns
 *  it). A marker whose declared asset can't be a library path falls back
 *  here rather than failing to plant: a visible wrong box beats an invisible
 *  right one, and the note says which happened. */
export const RESIDENCY_MARKER_FALLBACK = 'eidoverse/assets/models/crate_large_red.glb';

const LIMITS = { instance: 64, system: 64, name: 64, about: 200, lore: 400, id: 96 };

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A key that only exists when it has content: an absent field and an empty
 *  one are the same thing in a record, and storing `""` would make a reader
 *  believe someone wrote it down. */
const some = (key, value) => (value ? { [key]: value } : {});

/** A library path, or null. Same shape rule the sequencer's resolveLibFile
 *  enforces (no ascent, .glb/.vrm), applied here so a descriptor is judged
 *  the same way on a machine with no library checked out at all. */
function markerLib(lib) {
  const s = typeof lib === 'string' ? lib.trim() : '';
  if (!s || s.includes('..') || s.startsWith('/') || !/\.(glb|vrm)$/i.test(s)) return null;
  return s;
}

/** The display id an identity WEARS in a world, derived from its durable one:
 *  `agent:harbor.wright@example` → `harbor.wright`. Bodies join under short
 *  names; rosters are written with durable ones; this is the seam between
 *  them, and it is exported because the trace matcher and the planter must
 *  agree about it exactly. An explicit `as` on the roster entry always wins —
 *  derivation is a default, never an override. */
export function wornName(id) {
  return String(id ?? '').replace(/^[a-z]+:/i, '').split('@')[0].trim().toLowerCase();
}

/** How a role reads. Unknown roles stay legible rather than disappearing. */
export const roleReads = (role) => (typeof role === 'string' && Object.hasOwn(RESIDENT_ROLES, role)
  ? RESIDENT_ROLES[role] : role ? `"${role}"` : 'unspecified role');

/** Epoch ms from either an epoch or an ISO date. `Date.parse` is a pure
 *  function of its argument — this module still never asks what time it is. */
function sinceMs(v, notes) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15) return Math.floor(v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  notes.push('since must be epoch ms or an ISO date — dropped');
  return null;
}

/** A role outside the vocabulary is kept and noted, never corrected: the
 *  vocabulary of a hosting stack is not this world's to fix. */
function noteRole(role, who, notes) {
  if (role && !Object.hasOwn(RESIDENT_ROLES, role)) {
    notes.push(`role "${role}" on ${who} is not one this world has a phrase for (${Object.keys(RESIDENT_ROLES).join('/')}) — it reads quoted`);
  }
  return role;
}

/**
 * Normalize an authored `residency` bag into the record every consumer reads.
 *
 * Returns `{ok: true, residency, notes}` — `notes` naming everything that was
 * clamped, dropped or defaulted — or `{ok: false, why}` when the bag names no
 * instance or no mind. As with particles, a failure here is never a fold
 * failure: the component still persists and still reads as *someone's* marker
 * (`describeResidency`). It only means the record is not machine-usable.
 *
 * @param {unknown} data
 * @param {{entityId?: string}} [opts]
 */
export function normalizeResidency(data, { entityId = '' } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'residency data must be an object {instance, system, mind, agents?, …}' };
  }
  const d = /** @type {Record<string, any>} */ (data);
  const instance = text(d.instance, LIMITS.instance);
  if (!instance) return { ok: false, why: 'residency needs an `instance` — the name the hosting system calls itself (never a hostname or an address)' };
  const mindName = text(d.mind?.name, LIMITS.name);
  if (!mindName) return { ok: false, why: 'residency needs `mind.name` — the mind that runs the instance; a system with nobody home is not a residency' };

  const notes = [];
  const seen = new Set();
  const agents = [];
  for (const raw of Array.isArray(d.agents) ? d.agents : []) {
    if (agents.length >= RESIDENCY_MAX_AGENTS) {
      notes.push(`roster truncated to ${RESIDENCY_MAX_AGENTS} — a marker names an instance's standing agents, not every worker it ever spawns`);
      break;
    }
    const id = text(typeof raw === 'string' ? raw : raw?.id, LIMITS.id);
    if (!id) { notes.push('an agent entry with no id was dropped'); continue; }
    const wears = text(raw?.as, LIMITS.id).toLowerCase() || text(raw?.wears, LIMITS.id).toLowerCase() || wornName(id);
    if (seen.has(wears)) { notes.push(`two agents wear "${wears}" here — the later one was dropped`); continue; }
    seen.add(wears);
    const role = noteRole(text(raw?.role, 32), id, notes);
    agents.push({ id, wears, ...some('role', role), ...some('about', text(raw?.about, LIMITS.about)) });
  }

  const mindRole = noteRole(text(d.mind?.role, 32), mindName, notes);
  const lib = markerLib(d.marker?.lib);
  if (d.marker?.lib != null && !lib) {
    notes.push(`marker.lib ${JSON.stringify(d.marker.lib)} is not a library path (.glb/.vrm, no ascent) — using ${RESIDENCY_MARKER_FALLBACK}`);
  }
  const scale = Number(d.marker?.scale);
  const yaw = Number(d.marker?.yaw);

  const mindId = text(d.mind?.id, LIMITS.id);
  const residency = {
    instance,
    ...some('system', text(d.system, LIMITS.system)),
    mind: {
      name: mindName,
      ...some('role', mindRole),
      ...some('about', text(d.mind?.about, LIMITS.about)),
      wears: text(d.mind?.as, LIMITS.id).toLowerCase() || text(d.mind?.wears, LIMITS.id).toLowerCase() || wornName(mindId || mindName),
      ...some('id', mindId),
    },
    agents,
    ...some('lore', text(d.lore, LIMITS.lore)),
    marker: {
      lib: lib ?? RESIDENCY_MARKER_FALLBACK,
      ...(Number.isFinite(scale) && scale > 0 ? { scale: Math.min(8, scale) } : {}),
      ...(Number.isFinite(yaw) ? { yaw } : {}),
    },
  };
  const since = sinceMs(d.since, notes);
  if (since != null) residency.since = since;
  // A durable id for the record itself, so two markers planted by the same
  // instance in two worlds are recognizably the same residency.
  residency.key = `${instance}:${residency.mind.wears}`;
  if (entityId) residency.entity = entityId;
  return { ok: true, residency, notes };
}

// ---- perception ------------------------------------------------------------

/**
 * How a residency reads in prose, from the RAW component bag.
 *
 * Deliberately tolerant where `normalizeResidency` is strict: a record this
 * world cannot fully parse still says whose marker it is, for the same reason
 * an unknown particle preset still reads as an emitter. Names the semantic
 * thing on the entity that owns it — never a bare `components: residency`.
 */
export function describeResidency(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a residency marker (malformed record)';
  const d = /** @type {Record<string, any>} */ (data);
  const mind = text(d.mind?.name, LIMITS.name);
  const instance = text(d.instance, LIMITS.instance) || 'an unnamed system';
  const system = text(d.system, LIMITS.system);
  const who = mind ? `${mind} (${roleReads(d.mind?.role)})` : 'nobody named';
  const roster = (Array.isArray(d.agents) ? d.agents : [])
    .map((a) => text(typeof a === 'string' ? a : a?.id, LIMITS.id))
    .filter(Boolean);
  const bits = [`instance ${instance}${system ? ` (${system})` : ''}`, `mind ${who}`];
  bits.push(roster.length
    ? `${roster.length} agent${roster.length === 1 ? '' : 's'}: ${roster.map(wornName).join(', ')}`
    : 'no agents declared');
  const since = sinceMs(d.since, []);
  // The DATE, never "N days ago": this module is not allowed to know what
  // time it is, and a perception line that silently ages is not replayable.
  if (since != null) bits.push(`resident since ${new Date(since).toISOString().slice(0, 10)}`);
  const lore = text(d.lore, LIMITS.lore);
  // The claim is deliberately thin. A residency record asserts that a system
  // says it lives here — not that anything of it is RUNNING here, not that
  // its agents are present, and not that any of them ever acted. The log
  // answers all three (traceResidents), and a resident who reads "5 agents"
  // as "5 agents are here" would act on it.
  return `residency: ${bits.join('; ')} — a declaration, not a presence${lore ? ` · “${lore.length > 120 ? `${lore.slice(0, 119)}…` : lore}”` : ''}`;
}

/** begin / change / end, from the two component states around a live `comp`.
 *  `null` on either side means there was no record. Returns null when nothing
 *  perceptible happened (an identical re-author). Mirrors particles.js
 *  exactly — one shape for every "a component changed near you" narration. */
export function residencyTransition(prev, next) {
  const p = prev && typeof prev === 'object' ? prev : null;
  const n = next && typeof next === 'object' ? next : null;
  if (!p && !n) return null;
  const nameOf = (x) => text(x?.mind?.name, LIMITS.name) || text(x?.instance, LIMITS.instance) || 'a system';
  if (!p) return { kind: 'begin', who: nameOf(n) };
  if (!n) return { kind: 'end', who: nameOf(p) };
  if (JSON.stringify(p) === JSON.stringify(n)) return null;
  return { kind: 'change', who: nameOf(n), from: nameOf(p) };
}

/** The one ambient line a live attach/replace/remove produces. `who` is the
 *  line's subject; the caller supplies the tags and the radius gate. */
export function residencyLine(actor, entityId, transition) {
  if (!transition) return null;
  if (transition.kind === 'begin') return `${actor} records ${transition.who}'s residency on [${entityId}] (residency)`;
  if (transition.kind === 'end') return `${actor} withdraws ${transition.who}'s residency from [${entityId}] (residency)`;
  return transition.from && transition.from !== transition.who
    ? `${actor} rededicates [${entityId}]: ${transition.from} → ${transition.who} (residency)`
    : `${actor} revises ${transition.who}'s residency record on [${entityId}] (residency)`;
}

// ---- traces ----------------------------------------------------------------

/**
 * What the LOG says about the roster: per member, what they actually did here.
 *
 * This is the evidence half of the model and it is kept scrupulously apart
 * from the claim half. Anyone with builder rights can write a residency
 * record naming anyone; nobody can write someone else's acts into the log,
 * because the sequencer stamps `actor` from the connection. So the record
 * says who an instance CLAIMS to field and this says who was here — and a
 * member with `acts: 0` is reported as declared-but-unseen rather than
 * quietly dropped, which is the only way the difference stays visible.
 *
 * Pure over the entries handed in: the caller decides how much history to
 * read (a page, a window, the whole file), and the result says so.
 *
 * @param {{actor?: string, verb?: string, ts?: number, seq?: number}[]} entries
 * @param {unknown} data raw residency bag
 * @returns {{id: string, wears: string, role?: string, mind: boolean,
 *            acts: number, verbs: Record<string, number>, first: number|null,
 *            last: number|null, lastSeq: number|null}[]}
 */
export function traceResidents(entries, data) {
  const r = normalizeResidency(data);
  if (!r.ok) return [];
  const roster = [
    { id: r.residency.mind.id ?? r.residency.mind.name, wears: r.residency.mind.wears,
      role: r.residency.mind.role, mind: true },
    ...r.residency.agents.map((a) => ({ id: a.id, wears: a.wears, role: a.role, mind: false })),
  ];
  const byWorn = new Map();
  const traces = roster.map((m) => {
    const t = { ...m, acts: 0, verbs: /** @type {Record<string, number>} */ ({}), first: null, last: null, lastSeq: null };
    if (m.role == null) delete t.role;
    // Two rosters wearing one name is already a normalization note; here the
    // first claimant simply keeps the acts rather than both counting them.
    if (!byWorn.has(m.wears)) byWorn.set(m.wears, t);
    return t;
  });
  for (const e of Array.isArray(entries) ? entries : []) {
    const actor = String(e?.actor ?? '').toLowerCase();
    if (!actor) continue;
    const t = byWorn.get(actor);
    if (!t) continue;
    const verb = String(e?.verb ?? 'unknown');
    t.acts++;
    t.verbs[verb] = (t.verbs[verb] ?? 0) + 1;
    const ts = typeof e?.ts === 'number' && Number.isFinite(e.ts) && Math.abs(e.ts) <= 8.64e15 ? e.ts : null;
    if (ts != null) {
      if (t.first == null || ts < t.first) t.first = ts;
      if (t.last == null || ts > t.last) t.last = ts;
    }
    if (typeof e?.seq === 'number' && (t.lastSeq == null || e.seq > t.lastSeq)) t.lastSeq = e.seq;
  }
  return traces;
}

/** The traces, in prose — one line per member, busiest first, the mind always
 *  leading. Relative ages need a clock, so the caller passes `now`; without
 *  one the lines carry dates, which is what a replay wants anyway. */
export function describeTraces(traces, { now = null } = {}) {
  const ago = (ts) => {
    if (ts == null || !Number.isFinite(ts) || Math.abs(ts) > 8.64e15) return '';
    if (now == null) return ` (last ${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)}Z)`;
    const s = Math.max(0, Math.round((now - ts) / 1000));
    const rel = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
    return ` (last acted ${rel} ago)`;
  };
  return [...(traces ?? [])]
    .sort((a, b) => (b.mind ? 1 : 0) - (a.mind ? 1 : 0) || b.acts - a.acts || a.wears.localeCompare(b.wears))
    .map((t) => {
      const head = `${t.wears}${t.role ? ` — ${roleReads(t.role)}` : ''}${t.mind ? ' (the mind)' : ''}`;
      if (!t.acts) return `${head}: declared, but has done nothing in the history read`;
      const verbs = Object.entries(t.verbs).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([v, n]) => `${v} ×${n}`).join(', ');
      return `${head}: ${t.acts} act${t.acts === 1 ? '' : 's'} — ${verbs}${ago(t.last)}`;
    });
}

// ---- projection ------------------------------------------------------------

/**
 * The verbs that plant a residency — descriptor in, ordinary log entries out.
 *
 * One projection, so the planting tool, a behavior script, and whatever an
 * instance writes for itself all put the SAME marker in the world: a spawn of
 * the declared asset, the record on it, and (by default) a `lock`, because a
 * marker that can be punted across the map is a marker that stops meaning
 * where a system lives. Emitting these is the caller's job; deciding what
 * they are is this module's.
 *
 * A planted marker is LOCKED by default, and the lock refuses a same-id
 * `spawn` — for everyone, including whoever locked it. That is the accident
 * guard doing its job, not an obstacle: re-authoring the record on a marker
 * that already stands is `skipSpawn: true`, which emits only the comps (a
 * locked entity accepts every component that doesn't relocate it).
 *
 * @param {unknown} descriptor
 * @param {{id?: string, pos?: number[], yaw?: number, lock?: boolean,
 *          skipSpawn?: boolean}} [opts]
 * @returns {{ok: true, id: string, entries: {verb: string, args: Record<string, unknown>}[], notes: string[]}
 *          | {ok: false, why: string}}
 */
export function residencyEntries(descriptor, { id = null, pos = [0, 0, 0], yaw = null, lock = true, skipSpawn = false } = {}) {
  const r = normalizeResidency(descriptor);
  if (!r.ok) return r;
  const res = r.residency;
  // Deterministic by default: re-planting the same instance's marker in the
  // same world re-authors the ONE entity rather than littering copies, which
  // is what makes this safe to run from a cron.
  const slug = res.instance.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const eid = id ?? `residency-${slug || 'marker'}`;
  const marker = res.marker;
  const { entity: _e, marker: _m, ...record } = res;
  const entries = [];
  if (!skipSpawn) {
    entries.push({ verb: 'spawn', args: { id: eid, lib: marker.lib, pos, yaw: yaw ?? marker.yaw ?? 0, ...(marker.scale != null ? { scale: marker.scale } : {}) } });
  }
  entries.push({ verb: 'comp', args: { id: eid, type: 'residency', data: record } });
  if (lock) entries.push({ verb: 'comp', args: { id: eid, type: 'lock', data: true } });
  return { ok: true, id: eid, entries, notes: r.notes };
}
