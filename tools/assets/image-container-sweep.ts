// image-container-sweep — a tool, not a gate test: every bufferView image in every GLB/VRM under the host's serving
// roots, checked against its declared mimeType (an image by uri, a data: URI included, isn't read: findImageLies). The optimizer refuses to write such a file (server/optimize.ts
// findImageLies, #122); this finds the variants written before that guard.
//   bun run tools/assets/image-container-sweep.ts              # PATCH_DIR + OPT_DIR + LIBRARY_DIR (config.ts LADDER)
//   bun run tools/assets/image-container-sweep.ts <dir|file>…  # explicit roots
//   bun run tools/assets/image-container-sweep.ts --host https://…  # a live server: /library-list, each entry fetched with the ktx2 key its /version publishes
// Exit 1 if anything lies about its own bytes, else 0 (an unreadable file is printed and counted, not failed).

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findImageLies } from "../../server/optimize.ts";
import { LADDER } from "../../server/config.ts";
import { keyFromVersion, negotiate } from "../../shared/ktx2.js";

const argv = process.argv.slice(2);
const hostFlag = argv.indexOf("--host");
const host = hostFlag >= 0 ? argv[hostFlag + 1] : null;
// without --host, hostFlag + 1 is 0: don't drop the first positional root
const roots = argv.filter((a, i) => !a.startsWith("--") && !(hostFlag >= 0 && i === hostFlag + 1));

let checked = 0, broken = 0, unreadable = 0;

function report(label: string, bytes: Uint8Array) {
  checked++;
  let lies;
  try { lies = findImageLies(bytes); }
  catch (e) {
    // a partial write or a .failed marker's sibling isn't a container: say so rather than count it clean
    unreadable++;
    console.log(`  ? ${label} — ${(e as Error).message}`);
    return;
  }
  if (!lies.length) return;
  broken++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  for (const l of lies) {
    console.log(`      image[${l.index}]${l.name ? ` "${l.name}"` : ""} declares ${l.declared}, bytes are ${l.actual}`);
    console.log(`         head: ${l.head}`);
  }
}

function walk(dir: string, base: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, base); continue; }
    if (!/\.(glb|vrm)$/i.test(e.name)) continue;
    report(relative(base, p), new Uint8Array(readFileSync(p)));
  }
}

if (host) {
  const base = host.replace(/\/$/, "");
  // the key this server publishes, as a client reads it (shared/ktx2.js): a retired one is an unflagged fetch of the original
  const key = keyFromVersion(await fetch(`${base}/version`).then((r) => r.json()).catch(() => null));
  if (!key) { console.log(`  ${base}/version publishes no ktx2Key: it serves no KTX2 variant to sweep`); process.exit(2); }
  const list = await (await fetch(`${base}/library-list`)).json() as { path: string }[];
  const models = list.filter((f) => /\.(glb|vrm)$/i.test(f.path));
  console.log(`image container check — ${models.length} model(s) from ${host} (as a KTX2-capable client sees them)\n`);
  for (const f of models) {
    const r = await fetch(negotiate(`${base}/library/${f.path}`, key));
    if (!r.ok) { console.log(`  ? ${f.path} — HTTP ${r.status}`); unreadable++; continue; }
    report(f.path, new Uint8Array(await r.arrayBuffer()));
  }
} else {
  const bases = roots.length ? roots : LADDER;
  console.log(`image container check — ${bases.join(", ")}\n`);
  for (const b of bases) {
    if (!existsSync(b)) { console.log(`  (skipped, absent: ${b})`); continue; }
    if (statSync(b).isDirectory()) walk(b, b);
    else report(b, new Uint8Array(readFileSync(b)));
  }
}

console.log(`\n${checked} file(s) checked, ${broken} serving images that are not what they claim`
  + (unreadable ? `, ${unreadable} unreadable` : ""));
process.exit(broken ? 1 : 0);
