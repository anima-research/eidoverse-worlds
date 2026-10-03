// eidoverse-worlds sequencer — advisory lint (TEL0S_NOTES §15, step 7a).
// The flight-recorder courtesy for spawns, motion and particles, plus the
// ONE resolveLibFile (§15.1 named the /geom duplicate; it imports this now).
// The linters take a structural {state, debug} — the same two things they
// ever read off the World — so this module needs geometry and shared code,
// never server.ts.

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { LADDER } from "./config.ts";
import { summarizeGlb } from "./geometry.ts";
// Likewise for the `particles` component: one validator, so the flight
// recorder's opinion about an emitter is the renderer's own opinion.
import { normalizeParticles } from "../shared/particles.js";
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

function modelPath(lib: unknown): string | null {
  if (typeof lib !== "string") return null;
  // Mirror the client's /library/<lib> URL, including percent-encoding of
  // spaces/Unicode and removal of query/fragment. The asset route uses
  // URL.pathname verbatim (it does not decode it back to a disk filename).
  if (lib.split(/[?#]/, 1)[0].includes("\0")) return null;
  const pathname = new URL("/library/" + lib, "http://library.invalid").pathname;
  if (!pathname.startsWith("/library/")) return null;
  const rel = normalize(pathname.slice("/library/".length)).replace(/^\/+/, "");
  return rel.includes("..") || !/\.(glb|vrm)$/i.test(rel) ? null : rel;
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
  if (rel === null) return null;
  // Geometry and route callers deliberately see the same patched/upload/base
  // bytes as /library, not a different unpatched model behind the same name.
  for (const base of LADDER) {
    const p = normalize(join(base, rel));
    if (p.startsWith(base) && existsSync(p)) return p;
  }
  return null;
}

/** A spawn still folds when its library cannot resolve. Tell the author why
 * through world_debug instead of leaving only every joiner's failed fetch.
 * Run after dispatch, contain every failure, and never edit world history. */
export function lintSpawn(w: LintHost, entry: LogEntry): void {
  queueMicrotask(() => {
    try {
      const a = entry.args;
      // Match the fold's spawn guard: these entries never create or replace
      // an entity, so do not diagnose its unchanged model as malformed.
      if (!a?.id || !a.lib) return;
      const lib = a.lib;
      const malformed = modelPath(lib) === null;
      if (!malformed && resolveLibFile(lib as string)) return;
      w.debug("spawn-lint", {
        entity: String(diagnosticValue(a.id)), by: diagnosticValue(entry.actor), seq: entry.seq, lib: diagnosticValue(lib),
        reason: malformed ? "malformed" : "not-found",
        why: malformed
          ? "spawn lib is malformed: use a library-relative .glb or .vrm path without parent traversal"
          : "spawn lib was not found in the patched assets, upload overlay or asset library; check the path or upload the asset",
      });
    } catch { /* advisory lint must never escape into the sequencer */ }
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
