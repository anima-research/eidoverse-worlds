// server/v4/scripts.ts — a world's scripts inside this server (research 41; shared/v4/door.js "behaviours").
//
// Scripts are `script:<name>` components the DOOR runs, each activation one act + one batch through admit. This class
// is World.scripts: the calls server.ts makes (onPresence, tick, inspect, list), routed to the door:
//   tick        the door's timers (sleep with nobody present unless `always`, one `wake` after) and their cascades,
//               on the server's 1 s clock (server.ts system "behaviors");
//   onPresence  enter / leave events, by the person's v4 identity;
//   inspect/list the door's status view (suspended / paused / stopped / dormant + why / asleep / active), plus the
//               old behaviours an imported world still names, which say plainly that they need re-installing as
//               script:<name>.
import type { V4Log } from "./world.ts";

type Any = any;
/** What World.scripts is. */
export interface ScriptHost {
  sync(): void;
  disposeAll(): void;
  onPresence(kind: "enter" | "leave", id: string, v4id?: string): void;
  tick(now: number): void;
  inspect(id: string): { status: string; ring: { ts: number; line: string }[] } | null;
  list(): { id: string; status: string; attach?: string; src: string; timers: number }[];
}

export class V4Scripts implements ScriptHost {
  constructor(private v4: V4Log) {}
  sync() { /* the door reads script:<name> from the fold on every activation: nothing to load or reconcile */ }
  disposeAll() { /* each activation is its own sandbox, disposed when it ends */ }
  onPresence(kind: "enter" | "leave", _id: string, v4id?: string) { if (v4id) this.v4.presenceScripts(kind, v4id); }
  tick(_now: number) { this.v4.tickScripts(); }
  /** One script's console ring + status: id is "<entity>/<name>" (or "<entity>" for its first script). */
  inspect(id: string) {
    const [ent, name] = String(id).split("/");
    const v = this.v4.scriptsView(ent);
    const s = (v.scripts as Any[]).find((x) => !name || x.script === `script:${name}`);
    if (!s) { const b = (v.imported as Any[] ?? []).find((x) => x.behavior === `imported-behavior:${name ?? ent}` || x.behavior === `imported-behavior:${ent}`); return b ? { status: `${b.status}: ${b.why}`, ring: [] } : null; }
    return { status: `${s.status}${s.why ? `: ${s.why}` : ""}`, ring: (s.last ?? []).map((l: Any) => ({ ts: l.ts, line: `${l.on}: ${l.status}${l.code ? ` ${l.code}` : ""}${l.why ? ` — ${l.why}` : ""}` })) };
  }
  list() {
    const v = this.v4.scriptsView();
    return [...(v.scripts as Any[]).map((s) => ({ id: `${s.id}/${String(s.script).slice(7)}`, status: s.status, attach: s.id, src: s.src, timers: s.every ? 1 : 0, ...(s.why ? { why: s.why } : {}) })),
      ...((v.imported as Any[]) ?? []).map((b) => ({ id: b.behavior, status: b.status, attach: b.attach ?? undefined, src: b.src ?? "", timers: 0, why: b.why }))];
  }
}
