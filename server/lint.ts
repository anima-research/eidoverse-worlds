// eidoverse-worlds sequencer — advisory lint (TEL0S_NOTES §15, step 7a).
// The flight-recorder courtesy for spawns, motion and particles, plus the
// ONE resolveLibFile (§15.1 named the /geom duplicate; it imports this now).
// The linters take a structural {state, debug} — the same two things they
// ever read off the World — so this module needs geometry and shared code,
// never server.ts.

import { statSync } from "node:fs";
import { join, normalize } from "node:path";
import { LADDER } from "./config.ts";
import { summarizeGlb } from "./geometry.ts";
// Likewise for the `particles` component: one validator, so the flight
// recorder's opinion about an emitter is the renderer's own opinion.
import { normalizeParticles, emitterKeyProblem } from "../shared/particles.js";
import type { LogEntry, WorldState } from "../shared/fold.js";

/** What the linters need from a world: folded state to read, the flight
 *  recorder to write. server.ts's World satisfies it structurally. */
type LintHost = { state: WorldState; debug(kind: string, detail: Record<string, unknown>): void };

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

export const MOTION_TYPES: Record<string, Set<string>> = {
  pendulum: new Set(["type", "axis", "pivot", "amp", "amplitude", "period", "phase", "damp", "maxAmp", "t0", "part", "cause", "by"]),
  spin: new Set(["type", "axis", "pivot", "degPerSec", "rpm", "phase", "t0", "part", "cause", "by"]),
  orbit: new Set(["type", "center", "radius", "degPerSec", "phase", "face", "t0", "part", "cause", "by"]),
  bob: new Set(["type", "axis", "amp", "amplitude", "period", "phase", "t0", "part", "cause", "by"]),
  path: new Set(["type", "points", "speed", "duration", "loop", "face", "t0", "part", "cause", "by"]),
};

/** The disk path, relative to each rung, that /library/<encoded> serves, or
 *  null when the request must be refused. `encoded` is the still-encoded
 *  remainder of URL.pathname: the /library route passes its own, and
 *  libraryPath() passes the one the client's URL would carry, so the route
 *  and every resolver read a name the same way. A file whose name has a
 *  space ("Frosted Glass Window Seat.glb" → %20) or an accent lives on disk
 *  under its decoded name, so each run of escapes in the path is decoded on
 *  its own, with three guards:
 *  - a raw path that already names an entry on ANY rung of the ladder wins
 *    (a model literally called "box%41.glb" must not turn into "boxA.glb");
 *  - a run that's malformed, or decodes to a NUL, keeps its own characters,
 *    and a bare "%", which a URL leaves as it is, stays, so the rest of the
 *    name still decodes: "50% off.glb" arrives as "50%%20off.glb" and loads;
 *  - a ".." segment after decoding is refused outright. This, not the
 *    normalize()+startsWith(base) check in onLadder() and the route, is what
 *    stops "..%2f": that check is a string prefix, so "..%2flibrary-backup%2fx"
 *    would pass it and reach a SIBLING directory whose name starts with the
 *    base's.
 *  So a literal %xx name loads as itself when nothing else in it is encoded.
 *  A name with both a space and a literal "%41" decodes whole, "A" included:
 *  its request encodes the space and leaves the "%41", and nothing tells
 *  that "%41" from one a client encoded. */
export function libraryRel(encoded: string): string | null {
  let rel = encoded;
  if (rel.includes("%") && !LADDER.some(base => entryAt(join(base, rel)) !== null)) {
    rel = rel.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try { const d = decodeURIComponent(run); return d.includes("\0") ? run : d; } catch { return run; }
    });
  }
  return rel.split(/[\/\\]/).includes("..") ? null : rel;
}

/** The /library path a lib names, as the asset route will look it up, or
 *  null when it names none with that extension. Mirrors the client's
 *  /library/<lib> URL: percent-encoding of spaces/Unicode, and query and
 *  fragment removed; then libraryRel() decodes it back to the disk name
 *  exactly as the route does. A parent-traversal segment is refused; a name
 *  that merely contains two dots, such as robot..v2.glb, is served and kept. */
export function libraryPath(lib: unknown, extension: RegExp): string | null {
  if (typeof lib !== "string") return null;
  if (lib.split(/[?#]/, 1)[0].includes("\0")) return null;
  const pathname = new URL("/library/" + lib, "http://library.invalid").pathname;
  if (!pathname.startsWith("/library/")) return null;
  const encoded = normalize(pathname.slice("/library/".length)).replace(/^\/+/, "");
  if (encoded.split("/").includes("..")) return null;
  const rel = libraryRel(encoded);
  return rel === null || !extension.test(rel) ? null : rel;
}

const MODEL = /\.(glb|vrm)$/i;
const modelPath = (lib: unknown) => libraryPath(lib, MODEL);

/** What a rung holds at `p`, as the route's existsSync sees it: a regular
 *  file, some other entry (a directory named like a model), or nothing.
 *  statSync throws for more than a missing entry: a path through a file
 *  (ENOTDIR, in bun) and a name past the filesystem's limit (ENAMETOOLONG).
 *  existsSync reports each as nothing, and a spawner's long name must not
 *  turn a lookup into a throw. */
function entryAt(p: string): "file" | "other" | null {
  try { return statSync(p).isFile() ? "file" : "other"; } catch { return null; }
}

/** The file /library serves for `rel`. The route takes the first rung where
 *  any entry exists, so a directory named like a model there is no model,
 *  even over a file of that name on a lower rung: the route answers it with
 *  an error, not the lower file. */
export function onLadder(rel: string): string | null {
  for (const base of LADDER) {
    const p = normalize(join(base, rel));
    if (!p.startsWith(base)) continue;
    const entry = entryAt(p);
    if (entry !== null) return entry === "file" ? p : null;
  }
  return null;
}

// The recorder is a bounded diagnosis, not another copy of arbitrary args.
// Keep normal values verbatim; the committed seq points to the full input.
function diagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) + "… [truncated]" : value;
  if (value && typeof value === "object") return Array.isArray(value) ? "[array]" : "[object]";
  return value;
}

export function resolveLibFile(lib: string): string | null {
  const rel = modelPath(lib);
  // Geometry and route callers deliberately see the same patched/upload/base
  // bytes as /library, not a different unpatched model behind the same name.
  return rel === null ? null : onLadder(rel);
}

// The recorder is a 300-entry ring shared by every kind: a script spawning
// the same unresolvable lib again and again must not evict everything else.
// One record per world, lib and reason a minute. The next record's `repeats`
// counts the spawns of that lib, for that reason, that went unrecorded since
// the previous record; a burst that stops is counted only when the lib is
// spawned again after the minute.
const SPAWN_LINT_WINDOW_MS = 60_000;
const spawnLintSeen = new WeakMap<object, Map<string, { at: number; since: number }>>();

/** A spawn still folds when its library cannot resolve. Tell the author why
 * through world_debug instead of leaving only every joiner's failed fetch.
 * Run after dispatch, contain every failure, and never edit world history. */
export function lintSpawn(w: LintHost, entry: LogEntry, now: () => number = Date.now): void {
  queueMicrotask(() => {
    try {
      const a = entry.args;
      // Match the fold's spawn guard: these entries never create or replace
      // an entity, so do not diagnose its unchanged model as malformed.
      if (!a?.id || !a.lib) return;
      const lib = a.lib;
      const malformed = modelPath(lib) === null;
      if (!malformed && resolveLibFile(lib as string)) return;
      const reason = malformed ? "malformed" : "not-found";
      let seen = spawnLintSeen.get(w);
      if (!seen) { seen = new Map(); spawnLintSeen.set(w, seen); }
      const key = reason + "\0" + (typeof lib === "string" ? lib : JSON.stringify(diagnosticValue(lib)));
      const last = seen.get(key), at = now();
      if (last && at - last.at < SPAWN_LINT_WINDOW_MS) { last.since++; return; }
      seen.set(key, { at, since: 0 });
      w.debug("spawn-lint", {
        // The fold keys an entity by String(id); name it by that key.
        entity: diagnosticValue(String(a.id)), by: diagnosticValue(entry.actor), seq: entry.seq, lib: diagnosticValue(lib),
        reason,
        ...(last?.since ? { repeats: last.since } : {}),
        why: malformed
          ? "spawn lib is malformed: use a library-relative .glb or .vrm path without parent traversal"
          : "spawn lib was not found in the patched assets, upload overlay or asset library; check the path or upload the asset",
      });
    } catch (err) {
      // Advisory lint must never escape into the sequencer, and a broken one
      // must not look like a quiet world.
      console.error("[lint] spawn-lint failed for seq " + entry.seq + ":", err);
    }
  });
}

export function lintMotion(w: LintHost, entry: LogEntry): void {
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
export function lintParticles(w: LintHost, entry: LogEntry): void {
  try {
    const a = entry.args as Record<string, unknown>;
    const id = String(a.id ?? "");
    const key = typeof a.type === "string" ? a.type : "particles";
    // which emitter, when it isn't the default one — a hearth with three
    // emitters needs the lint to say WHICH bag was clamped
    const which = key === "particles" ? {} : { component: key };
    const bad = emitterKeyProblem(key);
    if (bad) { w.debug("particles-lint", { entity: id, by: entry.actor, ...which, why: bad }); return; }
    if (a.data == null) return;                      // put out — nothing to lint
    const r = normalizeParticles(a.data, { entityId: id, key });
    if (!r.ok) {
      w.debug("particles-lint", { entity: id, by: entry.actor, ...which, why: r.why });
      return;
    }
    if (r.notes.length) {
      w.debug("particles-lint", { entity: id, by: entry.actor, ...which, why: r.notes.join(" · ") });
    }
  } catch { /* lint must never hurt anything */ }
}
