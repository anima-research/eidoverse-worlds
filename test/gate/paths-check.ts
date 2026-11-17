// test/gate/paths-check.ts — every repo path a tracked doc, script or comment cites resolves (CONTRIBUTING.md, "Style").
//   bun test/gate/paths-check.ts
// A citation starts with a top-level directory and ends in a known extension or a slash. It resolves when it is tracked
// (or a tracked file's directory) from the root or any directory above the citing file, or is gitignored (a runtime
// file). A Markdown link resolves from its own file. `rev:path`, git's own form, names another tree and is not checked.
// A served URL in quotes (a browser test's import of '/lib/…' or '/shared/…') resolves to client/lib/… or shared/…, as the server answers it.
// HISTORY and ALLOW are the only exceptions.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ENGINE } from "./common.ts";
import { suite } from "./suite.ts";

const { check, done } = suite("paths");
const git = (args: string[], input?: string) => spawnSync("git", ["-C", ENGINE, ...args], { encoding: "utf8", input, maxBuffer: 1 << 28 });

// history keeps the paths of its day: not checked
const HISTORY = [/^docs\/history\//, /^spec\/history\//, /CHANGELOG[^/]*\.md$/];
// a file (or a directory/) whose citations of these paths are on purpose; null = all of them
const ALLOW: [where: string, paths: string[] | null, why: string][] = [
  ["tools/import-v1/", null, "the v1 importer describes the v1 tree it reads; fold.js and frozen/ are hashed into v1FoldBuild (build.ts)"],
  ["docs/design/", null, "proposals: they name files still to be written and the tree they were written against"],
  ["docs/decisions/CUTOVER-ARTIFACTS.md", ["client/lib/voice.js", "tools/voice-lifecycle-test.ts"], "its removal list names the files the cutover deleted"],
  ["test/protocol/nov1-check.ts", null, "its GONE list names deleted v1 files that must not come back"],
  ["test/gate/hygiene-check.ts", null, "its fixtures are made-up paths"],
  ["test/protocol/procgroup-check.ts", ["client/b.txt", "client/c.txt"], "scratch files it writes"],
  ["test/protocol/catalogue-check.ts", ["shared/protocol/labmodels.js"], "checks that it is gone"],
  ["test/shared/shape-import-test.ts", ["shared/protocol/shaperepair.js"], "checks that it is gone"],
  ["test/protocol/build-check.ts", ["client/lib/newscript.js"], "its fallback imports the planner by its pre-reorg name, for an older tree"],
  ["test/protocol/roles-check.ts", ["tools/protocol/import-v1/translate-v1.js", "shared/protocol/translate-v1.js"], "the translator's homes in an older --tree"],
  ["test/protocol/drive-check.ts", ["tools/protocol/import-v1/translate-v1.js"], "the translator's home in an older --tree"],
  ["docs/operator/RUNNING-A-SERVER.md", ["tools/protocol/run.ts"], "names the runner the pre-reorg deploy script calls, to explain why that deploy stops"],
  ["shared/oldformat.js", ["docs/TRANSLATING-OLD-WORLDS.md"], "the URL server/routes.ts serves that doc at"],
  ["test/protocol/upgrade-check.ts", ["docs/TRANSLATING-OLD-WORLDS.md"], "the URL server/routes.ts serves that doc at"],
  ["test/client/named-pose-test.ts", ["defs/animations/idle.json"], "a file in the scratch asset library it builds"],
  ["test/mcpl/body-state-test.ts", ["defs/animations/idle.json", "defs/animations/sitting_normal_chair.json"], "files in the scratch asset library it builds"],
  ["test/protocol/describe-particles-check.ts", ["tools/protocol/import-v1/translate-v1.js", "client/lib/particlefx.js", "client/lib/emitters.js"], "their pre-reorg homes, for an older --tree"],
  ["test/shared/voice-wire-test.ts", ["defs/animations/idle.json"], "a file in the scratch asset library it builds"],
  ["bench/seatlab/", ["/lib/seatlab.js"], "the bench is copied under client/lib/ to run (its README)"],
];
const EXT = /\.(md|ts|js|mjs|cjs|json|jsonl|sh|html|css|py|ya?ml|txt|toml|conf|service|template|lock|glb|gltf|vrm|png|jpe?g|svg|wasm|onnx|ktx2|hdr)$/i;
const SCANNED = /\.(md|ts|js|mjs|json|sh|html)$/;

const tracked = git(["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
const have = new Set(tracked), dirs = new Set<string>();
for (const f of tracked) { const p = f.split("/"); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join("/")); }
const TOP = [...new Set(tracked.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith("."));
const CITE = new RegExp(`(?<![\\w./@~$:-])((?:${TOP.join("|")})/(?:[\\w.-]+/)*[\\w.-]*\\w)(/?)`, "g");
const PATTERN = /^\/?[*{<$…\[%]/;   // a glob, a placeholder or a template string goes on after the match: not one path

/** The repo paths `src` cites, each with its line: what CITE matches, minus patterns, prose and node_modules. */
function citations(src: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  for (const m of src.matchAll(CITE)) {
    const end = m.index! + m[0].length, p = m[1];
    if (PATTERN.test(src.slice(end, end + 2)) || (!m[2] && !EXT.test(p)) || p.includes("node_modules/")) continue;
    out.push({ path: p, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}
const URL_RE = /(["'`])(\/(?:lib|shared)\/[\w./-]+?\.m?js)(?=[?#"'`])/g;   // '/lib/net.js', `/shared/structure.js?x`
/** The served URLs `src` names, each with the repo file the server answers it from (server/routes.ts: /lib/ from client/, /shared/ from shared/). */
function servedUrls(src: string): { url: string; file: string; line: number }[] {
  return [...src.matchAll(URL_RE)].map((m) => ({ url: m[2], file: m[2].startsWith("/lib/") ? "client" + m[2] : m[2].slice(1), line: src.slice(0, m.index).split("\n").length }));
}
const LINK = /\]\(([^()\s#]+)(?:#[^()\s]*)?\)/g;   // [text](target#anchor)
/** A Markdown file's relative links, repo-relative; null where one climbs out of the repo. */
function links(f: string, src: string): { path: string | null; raw: string; line: number }[] {
  const out: { path: string | null; raw: string; line: number }[] = [];
  for (const m of src.matchAll(LINK)) {
    let t = m[1]; try { t = decodeURI(t); } catch {} if (/^[a-z][a-z0-9+.-]*:|^\/|^</i.test(t)) continue;   // a URL, mailto:, root-absolute or <placeholder>
    const parts = f.split("/").slice(0, -1);
    for (const s of t.replace(/\/$/, "").split("/")) if (s === "..") { if (!parts.length) { parts.push("\0"); break; } parts.pop(); } else if (s !== ".") parts.push(s);
    out.push({ path: parts.includes("\0") ? null : parts.join("/"), raw: t, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}
const resolves = (from: string, p: string) => {
  for (let d = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    const q = d ? `${d}/${p}` : p; if (have.has(q) || dirs.has(q)) return true; if (!d) return false;
  }
};
const SELF = "test/gate/paths-check.ts";
/** The ALLOW entry (its `where`) that excuses `p` cited in `f`, or null; this file's own ALLOW table cites what it lists. */
const excuse = (f: string, p: string) => f === SELF ? (ALLOW.some(([, ps]) => ps?.includes(p)) ? SELF : null)
  : ALLOW.find(([w, ps]) => (w.endsWith("/") ? f.startsWith(w) : f === w) && (!ps || ps.includes(p)))?.[0] ?? null;

const unresolved: { f: string; line: number; path: string }[] = [], used = new Set<string>();
let cited = 0, urls = 0;
const unservable: { f: string; line: number; path: string }[] = [];
for (const f of tracked) {
  if (!SCANNED.test(f) || /(^|\/)(node_modules|vendor)\//.test(f) || HISTORY.some((h) => h.test(f))) continue;
  const src = fs.readFileSync(ENGINE + f, "utf8");
  if (f.endsWith(".md")) for (const l of links(f, src)) {
    cited++; if (l.path !== null && (have.has(l.path) || dirs.has(l.path) || l.path === "")) continue;
    const a = l.path && excuse(f, l.path); if (a) { used.add(a); continue; }
    unresolved.push({ f, line: l.line, path: l.path ?? l.raw });
  }
  for (const c of citations(src)) {
    cited++; if (resolves(f, c.path)) continue;
    const a = excuse(f, c.path); if (a) { used.add(a); continue; }
    unresolved.push({ f, ...c });
  }
  for (const u of servedUrls(src)) {
    urls++; if (have.has(u.file)) continue;
    const a = excuse(f, u.url); if (a) { used.add(a); continue; }
    unservable.push({ f, line: u.line, path: u.url });
  }
}
const ignored = new Set(git(["check-ignore", "--no-index", "--stdin"], [...new Set(unresolved.map((u) => u.path))].join("\n") + "\n").stdout.split("\n").filter(Boolean));
const broken = unresolved.filter((u) => !ignored.has(u.path));

const T = (a: string, b: string) => a + "/" + b;   // fixtures built apart, so this file doesn't cite them
const probe = citations([`see ${T("tools", "gone-test.ts")} and ${T("test", "gate")}/`, `${T("client", "lib")}/*.js ${T("docs", "x")}-<date>.md`,
  `306a00b0:${T("server", "verbs.ts")} https://example.com/${T("shared", "a.js")} the ${T("client", "server")} split`].join("\n"));
check("P1 the extractor takes a cited file and a cited directory, and skips globs, placeholders, rev:path, URLs and prose",
  JSON.stringify(probe) === JSON.stringify([{ path: T("tools", "gone-test.ts"), line: 1 }, { path: T("test", "gate"), line: 1 }]), probe);
const lprobe = links(T("docs", "a.md"), `[x](../${T("tools", "y.md")}#s) [u](https://e.com) [r](/abs) [a](#sec) [up](../../out.md) [h](<b>)`).map((l) => l.path);
check("P1b a Markdown link resolves from its own file; URLs, root-absolute links and anchors are not repo paths",
  JSON.stringify(lprobe) === JSON.stringify([T("tools", "y.md"), null]), lprobe);
check("P2 the scan read the tree (more than 1000 citations)", cited > 1000, cited);
check("P3 every repo path a tracked doc, script or comment cites resolves", !broken.length, broken.map((b) => `${b.f}:${b.line} ${b.path}`).join("; "));
const uprobe = servedUrls([`import('${"/lib"}/net.js') import("${"/shared"}/protocol/fold.js?v=2") \`${"/lib"}/\${m}.js\``, `'${"/lib"}/eidoverse/a.glb' "/x${"/lib"}/y.js"`].join("\n"));
check("P5a the URL extractor takes a quoted /lib/ or /shared/ module, query and all, and skips templates, non-modules and longer paths",
  JSON.stringify(uprobe.map((u) => u.file)) === JSON.stringify(["client/lib/net.js", "shared/protocol/fold.js"]), uprobe);
check("P5b the scan saw the browser tests' served URLs (more than 500)", urls > 500, urls);
check("P5c every served URL a tracked file names in quotes (/lib/… or /shared/…) is a file the server can answer", !unservable.length, unservable.map((b) => `${b.f}:${b.line} ${b.path}`).join("; "));
check("P4 every ALLOW entry still excuses something (a fixed site leaves the list)", ALLOW.every(([w]) => used.has(w)), ALLOW.filter(([w]) => !used.has(w)).map(([w]) => w));
done();
