// server/mainknew.ts — which account the main-era server recorded for a name, so a translation can bind a name-only
// owner, and moderation.ts a name-only server ban, to an account. Read:
//   - WORLDS_DIR/.principals.json {sub: {name, kind, first, last}}: every account a verified door saw, by case-insensitive name;
//   - every other main-era log in WORLDS_DIR (log.jsonl, or log.original.jsonl once translated in place): the {id, sub} pairs
//     main stamped on grants, bans, genesis roles, placers and behaviours.
// Not read: .sessions.json (secrets), .bans.json (keyed by the typed name), .founding.json (timestamps only).
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
