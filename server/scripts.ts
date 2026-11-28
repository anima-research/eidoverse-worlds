// server/scripts.ts — World.scripts: the server's calls into the authority's `script:<name>` components (shared/protocol/authority.js).
//   tick         the authority's timers, on the server's 1 s clock (server.ts system "behaviors");
//   onPresence   enter / leave events, by identity;
//   inspect/list the authority's status view, plus an imported world's old behaviours, which report needing re-install as script:<name>.
import type { WorldLog } from "./worldlog.ts";

type Any = any;
/** What World.scripts is. */
export interface ScriptHost {
  sync(): void;
  disposeAll(): void;
  onPresence(kind: "enter" | "leave", id: string, actorId?: string): void;
  tick(now: number): void;
  inspect(id: string, floor?: number | null): { status: string; ring: { ts: number; line: string }[] } | null;
  list(): { id: string; status: string; attach?: string; src: string; timers: number }[];
}

export class WorldScripts implements ScriptHost {
  constructor(private log: WorldLog) {}
  sync() { /* the authority reads script:<name> from the fold on every activation: nothing to load or reconcile */ }
  disposeAll() { /* each activation is its own sandbox, disposed when it ends */ }
  onPresence(kind: "enter" | "leave", _id: string, actorId?: string) { if (actorId) this.log.presenceScripts(kind, actorId); }
  tick(_now: number) { this.log.tickScripts(); }
  /** One script's console ring + status: id is "<entity>/<name>" (or "<entity>" for its first script). */
  inspect(id: string, floor: number | null = null) {   // floor: the asker's say floor (world.ts sayFloorFor)
    const [ent, name] = String(id).split("/");
    const v = this.log.scriptsView(ent, floor);
    const s = (v.scripts as Any[]).find((x) => !name || x.script === `script:${name}`);
    if (!s) { const b = (v.imported as Any[] ?? []).find((x) => x.behavior === `imported-behavior:${name ?? ent}` || x.behavior === `imported-behavior:${ent}`); return b ? { status: `${b.status}: ${b.why}`, ring: [] } : null; }
    return { status: `${s.status}${s.why ? `: ${s.why}` : ""}`, ring: (s.last ?? []).map((l: Any) => ({ ts: l.ts, line: `${l.on}: ${l.status}${l.hidden ? ` (${l.hidden})` : ""}${l.code ? ` ${l.code}` : ""}${l.why ? ` — ${l.why}` : ""}${Array.isArray(l.logs) && l.logs.length ? `\n  ${l.logs.map((x: unknown) => typeof x === "string" ? x : JSON.stringify(x)).join("\n  ")}` : ""}` })) };   // an activation's console.log lines ride along
  }
  list() {
    const v = this.log.scriptsView();
    return [...(v.scripts as Any[]).map((s) => ({ id: `${s.id}/${String(s.script).slice(7)}`, status: s.status, attach: s.id, src: s.src, timers: s.every ? 1 : 0, ...(s.why ? { why: s.why } : {}) })),
      ...((v.imported as Any[]) ?? []).map((b) => ({ id: b.behavior, status: b.status, attach: b.attach ?? undefined, src: b.src ?? "", timers: 0, why: b.why }))];
  }
}
