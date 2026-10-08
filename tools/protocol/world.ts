// tools/protocol/world.ts — found a world, or translate an old (v1) world once into a NEW world.
//
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts found <name> --owner <your id> [--title "…"]
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <v1 world> <new name> --founder-key <ed25519:…> | --no-founder-key
//   bun tools/protocol/world.ts owner-key <ed25519:…> <signature>      (the ceremony's check: import-v1/README.md)
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts info <name>
//
// The server never makes a world by itself (it serves only worlds in this protocol, and refuses a directory holding only an old log). A directory is a world because it holds world.jsonl
// whose line 0 is a genesis saying {dialect, v: 4}, and only this tool writes one (shell access to the host, like every other operator
// act on world files). `found` runs the authority's own `new` request, so genesis names the owner and the founding act
// writes @world (about, bounds, roles:<owner>) through admit. --owner is the name you join with; it is stamped through
// names.js exactly as the live authority stamps you, so you are the owner when you arrive.
// `translate` reads <v1 world>/log.jsonl, never writes it (R9: the original is kept), runs the importer
// (tools/protocol/import-v1/: 0 divergences required), re-reads the output with the strict reader, and only then writes
// <new name>/world.jsonl. The old directory stays on disk as it was; the server doesn't serve it.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WORLDS_DIR } from "../../server/config.ts";
import { foundWorld, isWorldSaved } from "../../server/worldlog.ts";
import { translateV1World } from "./import-v1/world.ts";
import { openLive } from "../../server/livehost.ts";
import { digest, keyOk } from "../../shared/protocol/fold.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const NAME = /^[a-z0-9_-]{1,64}$/i;
const die = (m: string) => { console.error(m); process.exit(1); };

if (cmd === "found") {
  const name = rest[0], owner = flag("owner");
  if (!name || !NAME.test(name) || !owner) die("usage: found <name> --owner <your id> [--title …]");
  const r = foundWorld(path.join(WORLDS_DIR, name), name, owner!, flag("title"));
  console.log(`founded world "${name}" in ${WORLDS_DIR}: world id ${r.worldId}, owner ${r.owner}, ${r.entries} entries`);
} else if (cmd === "owner-key") {
  // the ceremony's check (import-v1/README.md): the founder signed "eidoverse-owner-key:<their key>" with the key's
  // private half, on their own machine. A key that verifies is theirs and is spelled right; genesis holds it forever.
  const [key, sig] = rest;
  if (!key || !sig) die("usage: owner-key <ed25519:…> <signature, base64 or base64url>");
  if (!keyOk(key)) die(`${key}: not a governance key (ed25519:<base64url of 32 bytes>, PROTOCOL §13)`);
  const raw = Buffer.from(key.slice(8), "base64url");
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const msg = `eidoverse-owner-key:${key}`;
  let good = false; try { good = crypto.verify(null, Buffer.from(msg), pub, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")); } catch { good = false; }
  if (!good) die(`the signature doesn't verify for ${key} over "${msg}": nothing is wrong with the world, but this key can't be used until it does`);
  console.log(`ok: ${key} signed "${msg}". Use it: bun tools/protocol/world.ts translate <old> <new> --founder-key ${key}`);
} else if (cmd === "translate") {
  const [src, dest] = rest;
  if (!src || !dest || !NAME.test(src) || !NAME.test(dest)) die("usage: translate <v1 world> <new name> (--founder-key <ed25519:…> | --no-founder-key)");
  if (isWorldSaved(src)) die(`${src} is already a world`);
  // PROTOCOL §13 GOV-5: nobody can add a key to an empty tier 0 later, so the founder's key goes in now or never
  const founderKey = flag("founder-key");
  if (!founderKey && !rest.includes("--no-founder-key")) die("translate needs the founder's own governance key for tier 0: --founder-key <ed25519:…> (made on their machine and checked with owner-key; import-v1/README.md, \"The Commons ceremony\"). "
    + "--no-founder-key founds it with tier 0 empty, which can never be filled later (§13 GOV-5)");
  const before = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
  const r = translateV1World(path.join(WORLDS_DIR, src), path.join(WORLDS_DIR, dest), { founderKey });
  const after = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
  console.log(`translated "${src}" (${r.stats.in} old entries) → world "${dest}" (${r.entries} entries, ${r.stats.change} change, `
    + `0 divergences, ${r.stats.renamed} actor names escaped, ${r.stats.tsClamped ?? 0} ts clamped); digest ${r.digest}`);
  if (r.renamedBlobs?.length) console.log(`NOTE: ${r.renamedBlobs.length} store blob(s) no longer hash to their names (rewritten after upload); their addresses are of the bytes this host has: ${r.renamedBlobs.join(", ")}`);
  if (r.stats.modelsRewritten !== undefined) console.log(`models: ${r.stats.modelsRewritten} path(s) are now content addresses (eido:sha256/…)${r.stats.modelsKept.length ? `; ${r.stats.modelsKept.length} kept as paths (no bytes on this host): ${r.stats.modelsKept.join(", ")}` : ""}`);
  console.log(`the old log was read, not written: ${before.size} bytes, mtime unchanged: ${before.mtimeMs === after.mtimeMs}; ${r.poses} remembered place(s) carried over by identity`);
  // PROTOCOL §5: v1 `guard` merges into `lock`, which drops its authorship protection by design. Say so, so the
  // world's owners can be told what changed (and which things to look at).
  if (r.stats.guards) console.log(`NOTE for the owners: ${r.stats.guards} guarded thing(s) in the v1 world became locked (${r.stats.guardsLive} still guarded at the end). `
    + `Now a lock binds everyone, the placer too, and any builder may lift it; the guard's "only the placer or an owner may change it" is gone (§5).`);
} else if (cmd === "info") {
  const name = rest[0]; if (!name || !NAME.test(name)) die("usage: info <name>");
  if (!isWorldSaved(name)) die(`${name} is not a world (no world.jsonl with a genesis)`);
  const w = openLive(path.join(WORLDS_DIR, name), name);
  const st = w.state();
  console.log(JSON.stringify({ name, worldId: w.worldId, entries: w.entries.length, status: st.status, things: Object.keys(st.entities).length - 1,
    roles: Object.fromEntries(Object.entries(st.entities["@world"].c).filter(([k]) => k.startsWith("roles:"))), digest: digest(st) }, null, 1));
} else die("usage: found <name> --owner <id> [--title …] | translate <v1 world> <new name> (--founder-key <key> | --no-founder-key) | owner-key <key> <sig> | info <name>   (WORLDS_DIR=<dir>)");
