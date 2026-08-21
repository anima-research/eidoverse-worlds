// image-container-check — every embedded image in every GLB/VRM under the
// serving roots, checked against its own declared mimeType.
//
// The optimizer now refuses to WRITE a file whose images are not images
// (server/optimize.ts, #122). This is the other half: variants written before
// that guard existed are still on disk and still being served, and nothing
// else in the tree ever looks at them again. One sweep says whether the
// library is clean.
//
//   bun run tools/image-container-check.ts              # OPT_DIR + LIBRARY_DIR
//   bun run tools/image-container-check.ts <dir|file>…  # explicit roots
//   bun run tools/image-container-check.ts --host https://…  # a live server
//
// Exit 0 clean, 1 if anything lies about its own bytes. The --host form reads
// /library-list and fetches each entry with ?ktx2=1, which is the shape a
// capable browser actually receives — the only view that would have caught the
// threshold-lantern.

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findImageLies } from "../server/optimize.ts";
import { OPT_DIR, LIBRARY_DIR } from "../server/config.ts";

const argv = process.argv.slice(2);
const hostFlag = argv.indexOf("--host");
const host = hostFlag >= 0 ? argv[hostFlag + 1] : null;
// `hostFlag + 1` is 0 when --host is absent, which would silently swallow the
// first positional root — the check must not quietly examine fewer files than
// it was handed.
const roots = argv.filter((a, i) => !a.startsWith("--") && !(hostFlag >= 0 && i === hostFlag + 1));

let checked = 0, broken = 0, unreadable = 0;

function report(label: string, bytes: Uint8Array) {
  checked++;
  let lies;
  try { lies = findImageLies(bytes); }
  catch (e) {
    // Not every .glb on disk is a container we can walk (a .failed marker's
    // sibling, a partial write). Say so rather than counting it clean.
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
  const list = await (await fetch(`${host.replace(/\/$/, "")}/library-list`)).json() as { path: string }[];
  const models = list.filter((f) => /\.(glb|vrm)$/i.test(f.path));
  console.log(`image container check — ${models.length} model(s) from ${host} (as a KTX2-capable client sees them)\n`);
  for (const f of models) {
    const r = await fetch(`${host.replace(/\/$/, "")}/library/${f.path}?ktx2=1`);
    if (!r.ok) { console.log(`  ? ${f.path} — HTTP ${r.status}`); unreadable++; continue; }
    report(f.path, new Uint8Array(await r.arrayBuffer()));
  }
} else {
  const bases = roots.length ? roots : [OPT_DIR, LIBRARY_DIR];
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
