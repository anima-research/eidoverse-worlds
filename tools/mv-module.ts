// tools/mv-module.ts — move engine files and rewrite every path that names them: resolved, never substituted blind.
//   bun tools/mv-module.ts <from> <to> [<from> <to> …]     a file to a file, or a directory to a directory
//   bun tools/mv-module.ts --check                            only verify: every relative specifier in the tree resolves
// For each tracked text file (docs/history, spec/history and CHANGELOGs keep the paths of their day):
//   1. a relative import specifier (from/import/export, import(), new URL(…, import.meta.url), require) is resolved from
//      the importer's OLD place and rewritten from its NEW place to the target's NEW place: a moved importer and a moved
//      target are the same case, and an untracked target (../node_modules/…) keeps pointing at the same file;
//   2. a repo citation (client/lib/… at any prefix: ../../client/lib/…, engine/client/lib/…) becomes the new path;
//   3. a served URL (/lib/x.js, /shared/x.js, a page-relative ./lib/x.js) becomes the new URL.
// Then it prints what it could not rewrite: template specifiers in moved files, and quoted bare basenames and lib/-relative
// strings in test/ tools/ bench/ (path.join pieces), for a person to read. One commit per family; the script goes with D2.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const git = (...a: string[]) => { const r = spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout; };
const tracked = () => git("ls-files", "-z").split("\0").filter(Boolean);
const HISTORY = [/^docs\/history\//, /^spec\/history\//, /CHANGELOG[^/]*\.md$/];
const TEXT = /\.(md|ts|js|mjs|cjs|json|jsonl|sh|html|css|ya?ml|txt|toml)$/;
const CODE = /\.(ts|js|mjs|cjs|html)$/;
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*|\brequire\s*\(\s*|new\s+URL\s*\(\s*|import\.meta\.resolve\s*\(\s*)(['"])(\.\.?\/[^'"\n]*)\2/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const args = process.argv.slice(2);
if (args[0] === "--check") process.exit(check() ? 0 : 1);
if (!args.length || args.length % 2) { console.error("usage: mv-module.ts <from> <to> [<from> <to> …] | --check"); process.exit(2); }

const before = tracked(), have = new Set(before);
// every moved FILE, old repo path → new repo path (a directory move expands to its tracked files)
const move = new Map<string, string>(), dirMoves: [string, string][] = [];
for (let i = 0; i < args.length; i += 2) {
  const [from, to] = [args[i].replace(/\/$/, ""), args[i + 1].replace(/\/$/, "")];
  if (have.has(from)) { move.set(from, to); continue; }
  const under = before.filter((f) => f.startsWith(from + "/"));
  if (!under.length) throw new Error(`${from}: not a tracked file or directory`);
  dirMoves.push([from, to]); for (const f of under) move.set(f, to + f.slice(from.length));
}
for (const [, to] of move) if (have.has(to)) throw new Error(`${to} exists`);
const moved = (p: string) => { if (move.has(p)) return move.get(p)!; for (const [a, b] of dirMoves) if (p === a || p.startsWith(a + "/")) return b + p.slice(a.length); return p; };
const newOf = (f: string) => move.get(f) ?? f;

const counts = { spec: 0, cite: 0, url: 0 }, touched = new Set<string>(), notes: string[] = [];
const out = new Map<string, string>();   // new path → new text
for (const f of before) {
  if (!TEXT.test(f) || /(^|\/)node_modules\//.test(f)) continue;
  let src: string; try { src = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  let s = src;
  const nf = newOf(f);
  // 1. relative specifiers, resolved from the old place
  if (CODE.test(f)) s = s.replace(SPEC, (m, pre, q, spec, at) => {
    if (/^new/.test(pre) && !/^\s*,\s*import\.meta\.url/.test(src.slice(at + m.length))) return m;   // new URL(x, location): not file-relative
    const [, bare, tail] = spec.match(/^([^?#]*)(.*)$/)!;
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(f), bare));
    const target = moved(abs);
    let ns = path.posix.relative(path.posix.dirname(nf), target) + (bare.endsWith("/") ? "/" : "");
    if (!ns.startsWith(".")) ns = "./" + ns;
    if (ns + tail === spec) return m;
    counts.spec++; touched.add(nf); return `${pre}${q}${ns}${tail}${q}`;
  });
  // 2 and 3. citations and served URLs, outside history
  if (!HISTORY.some((h) => h.test(f))) {
    for (const [a, b] of move) {
      if (!s.includes(a.split("/").pop()!)) continue;
      const cite = new RegExp(`(?<![\\w-])${esc(a)}(?![\\w-])`, "g");
      s = s.replace(cite, () => { counts.cite++; touched.add(nf); return b; });
      const served = (p: string) => p.startsWith("client/lib/") ? p.slice("client".length) : p.startsWith("shared/") ? "/" + p : null;
      const ua = served(a), ub = served(b);
      // a quoted /lib/… URL, and a page-relative ./lib/… one in a browser test's evaluate (never ../lib/…: that is a specifier)
      if (ua && ub) s = s.replace(new RegExp(`(?<![\\w.-])(\\.?)${esc(ua)}(?![\\w-])`, "g"), (m, dot) => { counts.url++; touched.add(nf); return dot + ub; });
    }
    for (const [a, b] of dirMoves) s = s.replace(new RegExp(`(?<![\\w-])${esc(a)}/`, "g"), (m, i) => {
      // a directory citation (client/lib/avatar/bodyruntimes/); a file under it was already rewritten above
      if (s.startsWith(b + "/", i)) return m; counts.cite++; touched.add(nf); return b + "/";
    });
  }
  if (s !== src || nf !== f) out.set(nf, s);
}

// git mv (directories by their files, so a partly-moved directory works), then write the rewritten text
for (const [a, b] of move) { fs.mkdirSync(path.dirname(path.join(ROOT, b)), { recursive: true }); git("mv", a, b); }
for (const [f, s] of out) fs.writeFileSync(path.join(ROOT, f), s);

// what a person has to read
const after = tracked(), movedNew = new Set(move.values());
for (const f of after) {
  if (!TEXT.test(f) || /(^|\/)node_modules\//.test(f) || HISTORY.some((h) => h.test(f))) continue;
  const s = fs.readFileSync(path.join(ROOT, f), "utf8"), lines = s.split("\n");
  lines.forEach((l, i) => {
    if (movedNew.has(f) && CODE.test(f) && /\bimport\s*\(\s*`|new\s+URL\s*\(\s*`|new\s+Worker\s*\(\s*['"`]/.test(l)) notes.push(`template/worker specifier  ${f}:${i + 1}: ${l.trim().slice(0, 140)}`);
    if (!/^(test|tools|bench)\//.test(f) || f === "tools/mv-module.ts") return;
    for (const [a] of move) {
      const base = a.split("/").pop()!;
      if (new RegExp(`['"\`]${esc(base)}['"\`]`).test(l)) notes.push(`bare basename ${base}  ${f}:${i + 1}: ${l.trim().slice(0, 140)}`);
      if (new RegExp(`(?<![\\w/-])lib/${esc(a.replace(/^client\/lib\//, ""))}`).test(l) && !l.includes("/lib/")) notes.push(`lib-relative ${base}  ${f}:${i + 1}: ${l.trim().slice(0, 140)}`);
    }
  });
}
console.log(`moved ${move.size} files; rewrote ${counts.spec} specifiers, ${counts.cite} citations, ${counts.url} served URLs in ${touched.size} files`);
for (const n of [...new Set(notes)]) console.log("READ  " + n);
process.exit(check() ? 0 : 1);

/** Every relative specifier in every tracked code file names a file that exists (or an untracked one beside node_modules). */
function check(): boolean {
  const bad: string[] = [];
  for (const f of tracked()) {
    if (!CODE.test(f) || /(^|\/)node_modules\//.test(f)) continue;
    let s: string; try { s = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const m of s.matchAll(SPEC)) {
      if (/^new/.test(m[1]) && !/^\s*,\s*import\.meta\.url/.test(s.slice(m.index! + m[0].length))) continue;
      const bare = m[3].replace(/[?#].*$/, ""), abs = path.join(ROOT, path.dirname(f), bare);
      if (/\$\{|\*|<|…/.test(bare)) continue;
      if (fs.existsSync(abs) || [".ts", ".js", ".mjs"].some((e) => fs.existsSync(abs + e))) continue;
      bad.push(`${f}:${s.slice(0, m.index).split("\n").length} ${m[3]}`);
    }
  }
  for (const b of bad) console.log("UNRESOLVED " + b);
  console.log(bad.length ? `${bad.length} relative specifiers resolve nothing` : "every relative specifier resolves");
  return !bad.length;
}
