// tools/protocol/import-v1/mainknew.ts — which account the main-era server recorded for a NAME, outside the log being
// translated: what lets a translation bind a name-only owner to the account they sign in with (owners sprint, R 10-28).
// What main recorded (upstream main ccd5c53f), and what this reads:
//   - WORLDS_DIR/.principals.json {sub: {name, kind: human|agent, first, last}}: every account a verified door saw, under the
//     credential's name at its last sighting (server/access.ts notePrincipal; since 10-17). Main's own grant looked a name up
//     here, case-insensitively, and bound it only on ONE match (verbs.ts resolveName). Read, the same rule.
//   - every other main-era log in WORLDS_DIR (log.jsonl, or log.original.jsonl once translated in place): the pairs main's
//     server stamped itself (verbs.ts): a grant's or ban's {id, sub}, genesis roles' sub, a placer {id, sub}, a behaviour's bySub.
// Not read: .sessions.json (bearer secrets; every verified session also wrote .principals.json), .bans.json (keyed by the
// name the BANNER typed, its sub from the same lookup; a ban is no reason to bind anyone), .founding.json (timestamps only).
import fs from "node:fs";
import path from "node:path";

type Any = any;
const ACCOUNTISH = /^(human|agent|aid1|local|service):/;
export type Known = { subs: string[]; from: string[] };   // distinct raw subs main recorded for the name, and where

/** name (any case) → what main recorded for it. `self`: the world being translated (its own log is read by the mapper). */
export function mainKnowledge(worldsDir: string, { self }: { self?: string } = {}) {
  const by = new Map<string, Map<string, Set<string>>>();   // lowercased name → sub → sources
  const note = (name: unknown, sub: unknown, from: string) => {
    if (typeof name !== "string" || !name || typeof sub !== "string" || !ACCOUNTISH.test(sub) || ACCOUNTISH.test(name)) return;
    const k = name.toLowerCase(); let m = by.get(k); if (!m) by.set(k, (m = new Map()));
    let s = m.get(sub); if (!s) m.set(sub, (s = new Set())); s.add(from); };
  const pf = path.join(worldsDir, ".principals.json");
  try { if (fs.existsSync(pf)) for (const [sub, p] of Object.entries<Any>(JSON.parse(fs.readFileSync(pf, "utf8")) ?? {}))
    if (p && typeof p.name === "string" && (p.kind === "human" || p.kind === "agent")) note(p.name, sub, ".principals.json"); }
  catch { /* unreadable: main's own restore started empty too */ }
  for (const w of fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir).sort() : []) {
    if (w.startsWith(".") || w === self) continue;
    const d = path.join(worldsDir, w); let f = path.join(d, "log.jsonl");
    try { if (fs.lstatSync(d).isSymbolicLink() || !fs.statSync(d).isDirectory()) continue; } catch { continue; }
    if (fs.existsSync(path.join(d, "world.jsonl")) || !fs.existsSync(f)) f = path.join(d, "log.original.jsonl");
    if (!fs.existsSync(f)) continue;
    const from = `${w}'s log`;
    for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!/"sub"|Sub"/.test(l)) continue;
      let e: Any; try { e = JSON.parse(l); } catch { continue; } const a = e?.args ?? {};
      if ((e?.verb === "grant" || e?.verb === "ban") && typeof a.id === "string") note(a.id, a.sub, from);
      if (e?.verb === "genesis") for (const [k, v] of Object.entries<Any>(a.roles ?? {})) if (k !== "*") note(k, v?.sub, from);
      if (e?.verb === "spawn" || e?.verb === "light") note(a.placer?.id, a.placer?.sub, from);
      if (e?.verb === "behavior" && !["door", "world", "sim"].includes(e.actor) && !/^bhv:/i.test(String(e.actor))) note(e.actor, a.bySub, from); }
  }
  return (name: string): Known | null => { const m = by.get(String(name).toLowerCase()); if (!m) return null;
    return { subs: [...m.keys()].sort(), from: [...new Set([...m.values()].flatMap((s) => [...s]))].sort() }; };
}
