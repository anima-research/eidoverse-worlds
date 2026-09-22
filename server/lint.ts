// eidoverse-worlds sequencer — advisory lint (TEL0S_NOTES §15, step 7a).
// The flight-recorder courtesy for motion and particles components, plus the
// ONE resolveLibFile (§15.1 named the /geom duplicate; it imports this now).
// The linters take a structural {state, debug} — the same two things they
// ever read off the World — so this module needs geometry and shared code,
// never server.ts.

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { OPT_DIR, LIBRARY_DIR } from "./config.ts";
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

export function resolveLibFile(lib: string): string | null {
  const rel = normalize(lib).replace(/^\/+/, "");
  if (rel.includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
  for (const base of [OPT_DIR, LIBRARY_DIR]) {
    const p = normalize(join(base, rel));
    if (p.startsWith(base) && existsSync(p)) return p;
  }
  return null;
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
  void (async () => {
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
      if (r.emitter.part) {
        const part = r.emitter.part;
        const ent = w.state.entities[id];
        const file = ent?.lib ? resolveLibFile(ent.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        const names = sum?.nodeNames;
        if (!names || !names.includes(part)) {
          w.debug("particles-lint", { entity: id, by: entry.actor,
            why: names
              ? `part "${part}" is not among ${id}'s rendered parts [${names.join(", ")}] — using the entity frame`
              : `part "${part}" could not be checked because ${id}'s geometry is unavailable — clients use the entity frame if the part is missing` });
        }
      }
    } catch { /* lint must never hurt anything */ }
  })();
}
