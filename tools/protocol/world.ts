// tools/protocol/world.ts — found a world, or translate an old (v1) world once into a NEW world.
//
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts found <name> --owner <your id> [--title "…"]
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <v1 world> <new name>
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts info <name>
//
// The server never makes a world by itself (it serves only worlds, and refuses a directory holding only an old log). A world is v4 because its directory holds world.jsonl
// whose line 0 is a genesis, and only this tool writes one (shell access to the host, like every other operator
// act on world files). `found` runs the authority's own `new` request, so genesis names the owner and the founding act
// writes @world (about, bounds, roles:<owner>) through admit. --owner is the name you join with; it is stamped through
// names.js exactly as the live authority stamps you, so you are the owner when you arrive.
// `translate` reads <v1 world>/log.jsonl, never writes it (R9: the original is kept), runs the importer
// (tools/protocol/import-v1/: 0 divergences required), re-reads the output with the strict reader, and only then writes
// <new name>/world.jsonl. The old directory stays on disk as it was; the server doesn't serve it.
import fs from "node:fs";
import path from "node:path";
import { WORLDS_DIR } from "../../server/config.ts";
import { foundWorld, isWorldSaved } from "../../server/worldlog.ts";
import { translateV1World } from "./import-v1/world.ts";
import { openLive } from "../../server/livehost.ts";
import { digest } from "../../shared/protocol/fold.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const NAME = /^[a-z0-9_-]{1,64}$/i;
const die = (m: string) => { console.error(m); process.exit(1); };

if (cmd === "found") {
  const name = rest[0], owner = flag("owner");
  if (!name || !NAME.test(name) || !owner) die("usage: found <name> --owner <your id> [--title …]");
  const r = foundWorld(path.join(WORLDS_DIR, name), name, owner!, flag("title"));
  console.log(`founded world "${name}" in ${WORLDS_DIR}: world id ${r.worldId}, owner ${r.owner}, ${r.entries} entries`);
} else if (cmd === "translate") {
  const [src, dest] = rest;
  if (!src || !dest || !NAME.test(src) || !NAME.test(dest)) die("usage: translate <v1 world> <new name>");
  if (isWorldSaved(src)) die(`${src} is already a world`);
  const before = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
  const r = translateV1World(path.join(WORLDS_DIR, src), path.join(WORLDS_DIR, dest));
  const after = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
  console.log(`translated "${src}" (${r.stats.in} old entries) → world "${dest}" (${r.entries} entries, ${r.stats.change} change, `
    + `0 divergences, ${r.stats.renamed} actor names escaped, ${r.stats.tsClamped ?? 0} ts clamped); digest ${r.digest}`);
  console.log(`the old log was read, not written: ${before.size} bytes, mtime unchanged: ${before.mtimeMs === after.mtimeMs}; ${r.poses} remembered place(s) carried over by identity`);
  // PROTOCOL §5: v1 `guard` merges into `lock`, which drops its authorship protection by design. Say so, so the
  // world's owners can be told what changed (and which things to look at).
  if (r.stats.guards) console.log(`NOTE for the owners: ${r.stats.guards} guarded thing(s) in the v1 world became locked (${r.stats.guardsLive} still guarded at the end). `
    + `In v4 a lock binds everyone, the placer too, and any builder may lift it; the guard's "only the placer or an owner may change it" is gone (§5).`);
} else if (cmd === "info") {
  const name = rest[0]; if (!name || !NAME.test(name)) die("usage: info <name>");
  if (!isWorldSaved(name)) die(`${name} is not a world (no world.jsonl with a genesis)`);
  const w = openLive(path.join(WORLDS_DIR, name), name);
  const st = w.state();
  console.log(JSON.stringify({ name, worldId: w.worldId, entries: w.entries.length, status: st.status, things: Object.keys(st.entities).length - 1,
    roles: Object.fromEntries(Object.entries(st.entities["@world"].c).filter(([k]) => k.startsWith("roles:"))), digest: digest(st) }, null, 1));
} else die("usage: found <name> --owner <id> [--title …] | translate <v1 world> <new name> | info <name>   (WORLDS_DIR=<dir>)");
