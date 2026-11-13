// test/client/one-binding-test.ts — a shared constant, grammar or table has ONE binding: the module that owns it. Every other
// file imports it and carries no literal copy; no file outside the owner binds the thing's input.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/one-binding-test.ts
//
// One table over every such source grep. A row's `forbidden` patterns are scanned in every file of the four roots
// (shared/, server/, client/lib/, mcpl/) except the owner and its `exempt`, or only in `scope` when it names files;
// `requires` pins the import each named importer must carry. Comments are stripped before a scan. The executed halves
// (the values, the corpus loops) stay in their own suites (physconst, role-grammar, rot, quadcolour, namereveal).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mkCheck } from "../harness/harness.ts";

const { check, tally } = mkCheck();
const ROOT = join(import.meta.dir, "..", "..");
const walk = (d: string, out: string[] = []) => { for (const n of readdirSync(join(ROOT, d))) { if (n === "node_modules" || n === "vendor" || n.startsWith(".")) continue; const p = `${d}/${n}`;
  if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.(js|mjs|ts)$/.test(n) && !/\.min\./.test(n)) out.push(p); } return out; };
const files = ["shared", "server", "client/lib", "mcpl"].flatMap((d) => walk(d));
const raw = new Map<string, string>();
const src = (f: string) => { if (!raw.has(f)) raw.set(f, readFileSync(join(ROOT, f), "utf8")); return raw.get(f)!; };
// line comments (not inside a string's `//`, e.g. a URL) and block comments
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).split("\n").map((l) => /^\s*(\/\/|\*)/.test(l) ? "" : l.replace(/(^|[^:'"\\])\/\/.*$/, "$1")).join("\n");

// a forbidden pattern is a regex or a predicate, tested on each line
type Pat = RegExp | ((line: string) => boolean);
const hit = (p: Pat, l: string) => typeof p === "function" ? p(l) : p.test(l);
const RUNG = /\b(none|visitor|builder|moderator|owner)\s*:\s*-?\d+\b/g;
type Row = { name: string; owner: string[]; forbidden: Pat[]; scope?: string[]; exempt?: string[]; requires?: [file: string, re: RegExp][]; raw?: boolean };
const PHYS = "shared/protocol/physconst.js", ROUND = "shared/protocol/round.js";
const ROWS: Row[] = [
  { name: "a reach or hand number is physconst.js's", owner: [PHYS], forbidden: [/\bREACH\s*=\s*[\d.]/, /\bHAND_Y\s*=\s*[\d.]/, /\bMAX_HELD\s*=\s*\d/, /\bKICK\s*=\s*\{/,
    /\bUSE_REACH\s*=\s*[\d.]/, /\bBODY_RANGE[^=\n]*=\s*\{/, /\bHAND_REACH\s*=\s*[\d.]/],
    requires: [["shared/protocol/authority.js", /from "\.\/physconst\.js"/], ["client/lib/thingphysics.js", /from '\.\.\/\.\.\/shared\/protocol\/physconst\.js'/],
      ["client/lib/useprompt.js", /from '\.\.\/\.\.\/shared\/protocol\/physconst\.js'/], ["client/lib/commands/handlers.js", /from '\.\.\/\.\.\/\.\.\/shared\/protocol\/physconst\.js'/],
      ["server/messages.ts", /from "\.\.\/shared\/protocol\/physconst\.js"/], ["shared/grab.js", /from '\.\/protocol\/physconst\.js'/]] },
  { name: "a 3-place rounding or −0 scrub is round.js's", owner: [ROUND], forbidden: [/\bconst r3\s*=\s*\(/, /\bnoNeg0\s*=\s*\(/, /\bunNegZero\s*=\s*\(/, /\bconst r9\s*=\s*\(/],
    requires: [["shared/protocol/authority.js", /from "\.\/round\.js"/], ["client/lib/thingphysics.js", /from '\.\.\/\.\.\/shared\/protocol\/round\.js'/],
      ["shared/protocol/launchplan.js", /from "\.\/round\.js"/], ["shared/protocol/simlayer.js", /from "\.\/round\.js"/], ["shared/hierarchy.js", /from '\.\/protocol\/round\.js'/],
      ["tools/import-v1/translate-v1.js", /from "\.\.\/\.\.\/shared\/protocol\/round\.js"/], ["mcpl/agent.ts", /from "\.\.\/shared\/protocol\/round\.js"/],
      ["server/modelcatalogue.ts", /from "\.\.\/shared\/protocol\/round\.js"/], ["shared/blueprint.js", /from '\.\/protocol\/round\.js'/]] },
  { name: "the importers of round.js carry no hand-rolled rounding of their own", owner: [ROUND],
    scope: ["shared/protocol/simlayer.js", "shared/hierarchy.js", "tools/import-v1/translate-v1.js"],
    forbidden: [/Math\.round\(n \* 1000\) \/ 1000/, /Math\.round\(n \* 100\) \/ 100/, /(?<!factorWas: \+raw\.)toFixed\(4\)/, /\bunNegZero\s*=\s*\(/] },   // factorWas: a clamp report's figure, not a stored value
  { name: "a throw is planned by planLaunch, the one planner", owner: ["shared/protocol/launchplan.js"], scope: ["client/lib/thingphysics.js"], forbidden: [/planVelocity\(/],
    requires: [["client/lib/thingphysics.js", /planLaunch\(/]] },
  // a rung list of two or more ranks on one line, the id grammar's regex, the reserved-word list (the v1 importer's
  // ladder is the old protocol's own and is outside the roots)
  { name: "the rank ladder and the role-id grammar are roles.js's", owner: ["shared/protocol/roles.js"],
    forbidden: [(l) => new Set([...l.matchAll(RUNG)].map((m) => m[1])).size >= 2, (l) => l.includes("[a-z][a-z0-9-]{0,23}"), /['"]guest['"]\s*,\s*['"]everyone['"]\s*,\s*['"]ghost['"]/], raw: true },
  { name: "rot.js owns its numerics: no host transcendental", owner: [], scope: ["shared/rot.js"], forbidden: [/Math\.(sin|cos|tan|atan2?|asin|acos|pow|exp|log|hypot)\b/] },
  { name: "the quad shader reads the ACES inverse arrays, no literals of its own", owner: [], scope: ["client/lib/xr/quadcolour.js"], forbidden: [/1\.76474097|0\.64303825/],
    requires: [["client/lib/xr/quadcolour.js", /mat3\(\.\.\.ACES_OUT_INV\)/], ["client/lib/xr/quadcolour.js", /mat3\(\.\.\.ACES_IN_INV\)/]] },
  { name: "N (names) is bound in namereveal.js alone", owner: ["client/lib/namereveal.js"], scope: walk("client").filter((f) => f.endsWith(".js")),
    forbidden: [/['"]KeyN['"]|key === ['"][nN]['"]/], raw: true },
  { name: "no controller button reveals names (xr.js never calls setReveal)", owner: [], scope: ["client/lib/xr/xr.js"], forbidden: [/setReveal\(/] },
  { name: "a retired command's line is said before dispatch", owner: [], scope: [], forbidden: [], requires: [["client/lib/chat.js", /row\?\.retired\)\s*\{\s*logChat\('\*',\s*row\.retired\)/]] },
  // a sky's ts, a role's until, an access list's end are the authority's stamps (test/client/server-clock-readers-test.ts runs inspect.js's)
  { name: "a server stamp is read on serverNow, never this machine's Date.now()", owner: ["client/lib/serverclock.js"],
    scope: ["client/lib/sky.js", "client/lib/edit/skypanel.js", "client/lib/materials.js", "client/lib/rolespanels.js", "client/lib/edit/panels.js", "client/lib/edit/inspect.js"], forbidden: [/\bDate\.now\(\)/] },
  { name: "an HTML escaper is markup.js's escapeHtml (it escapes ')", owner: ["client/lib/markup.js"], scope: walk("client").filter((f) => /\.(js|mjs)$/.test(f)),
    forbidden: [/\.replace\(\/\[&<>"'?\]\/g/] },
  // exempt: the boot trip keys read the live URL (a rename's replaceState changes ?name); breadcrumbs and warmqueue are leaves
  { name: "the page's query is CONFIG.params (base.js), read once", owner: ["client/lib/base.js"], scope: walk("client").filter((f) => /\.(js|mjs)$/.test(f)),
    exempt: ["client/lib/boot.js", "client/lib/litechoice.js", "client/lib/gpulost.js", "client/lib/breadcrumbs.js", "client/lib/warmqueue.js"],
    forbidden: [/new URLSearchParams\((globalThis\.)?(win\.)?location\??\.search/] },
  { name: "a client event rides the bus (base.js), never a window CustomEvent", owner: ["client/lib/base.js"], scope: walk("client").filter((f) => /\.(js|mjs)$/.test(f)),
    forbidden: [/new CustomEvent\(/] },
  // exempt: breadcrumbs is a boot trace, sent before the join on purpose
  { name: "the world socket is written by net.js's senders (sendJoined), never raw", owner: ["client/lib/net.js"], scope: walk("client").filter((f) => /\.(js|mjs)$/.test(f)),
    exempt: ["client/lib/breadcrumbs.js"], forbidden: [/\bnet\.ws\??\.send\(/] },
  // the world-name grammar: one regex for every server door, the agent door's included (it once lacked the sequencer's /i)
  { name: "the world-name grammar is limits.ts's WORLD_NAME_RE", owner: ["server/limits.ts"], scope: files.filter((f) => /^(server|mcpl)\//.test(f)), forbidden: [(l) => l.includes("[a-z0-9_-]{1,64}")],
    requires: [["mcpl/net-server.ts", /WORLD_NAME_RE\.test\(/], ["server/world.ts", /WORLD_NAME_RE\.test\(/], ["server/routes.ts", /WORLD_NAME_RE\.test\(/]] },
];
for (const row of ROWS) {
  const scan = (row.scope ?? files).filter((f) => !row.owner.includes(f) && !(row.exempt ?? []).includes(f));
  const hits: string[] = [];
  for (const f of scan) (row.raw ? src(f) : code(f)).split("\n").forEach((l, i) => { if (row.forbidden.some((p) => hit(p, l))) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 60)}`); });
  if (row.forbidden.length) check(`${row.name}: no copy in ${scan.length === 1 ? scan[0] : `${scan.length} files`}`, scan.length > 0 && !hits.length, hits.join(" | "));
  for (const [f, re] of row.requires ?? []) check(`${row.name}: ${f} carries ${re}`, re.test(code(f)));
}
// "every site has X": B/Y (button 5) is read in one place, the quick hide
{
  const lines = code("client/lib/xr/xr.js").split("\n").filter((l) => /buttons\[5\]/.test(l));
  check("VR: B/Y (button 5) is read in one place, the quick hide", lines.length === 1 && /xrPanelsHideToggle|menuBtnWas|const by = /.test(lines[0]), lines.join(" | "));
}
// every refusal the optimizer CLI exits 2 with names its KIND on a [verdict] line, read from the emitter itself
{
  const cli = src("server/optimize.ts"), main = cli.slice(cli.indexOf("if (import.meta.main)"));
  const exits = [...main.matchAll(/process\.exit\(2\)/g)].map((m) => main.slice(Math.max(0, m.index! - 400), m.index!));
  const bare = exits.filter((pre) => !/console\.error\(verdictLine\([^\n]*\);\s*$/.test(pre));
  check(`every exit-2 site in the optimizer CLI (${exits.length}) emits a typed [verdict] line just before it`, exits.length >= 6 && bare.length === 0,
    bare.map((b) => b.split("\n").slice(-2).join(" ").trim().slice(0, 120)).join(" | "));
}
// descriptors / components / worldentity / editschema declare no field limit or unit of their own (the registry's)
{
  const lines = (f: string) => code(f).split("\n");
  const lit = /\b(min|max|unit):\s*(?!(?:undefined|null)\b)[-'"\w.]/;
  const LIMITS: [string, (l: string) => boolean][] = [
    ["shared/descriptors.js", (l) => lit.test(l) && !/const lim = |\.\.\.lim|unit \}|\{ min: r\.min \}|\{ min: r\.gt \}|\{ max: r\.max \}/.test(l)],
    ["shared/components.js", (l) => lit.test(l) && !/p\.min = |p\.max = |p\.unit = |max: COMPONENTS\./.test(l)],
    ["shared/worldentity.js", (l) => /k: '(amplitude|size|segments|flatRadius|density|height|width|depth)'/.test(l) && /\b(min|max|unit):/.test(l)],
    // editschema's own literals are the Transform channels', a socket body's look limits, the draft Material's and the light's sliders (their max grows with the value)
    ["shared/editschema.js", (l) => /\b(min|max):\s*-?\d/.test(l) && !/scale|quat|look|roughness|metalness|emissive|opacity|yaw|pitch|readLine|Math\.max\(\d+, src\./.test(l)],
  ];
  for (const [f, bad] of LIMITS) { const hit = lines(f).filter(bad); check(`${f} declares no field limit or unit of its own (the registry's)`, !hit.length, hit.slice(0, 4).join(" | ")); }
}
// negative controls: a planted copy is seen by the same scan
{
  const planted = "export const r = 1;\nconst REACH = 1.5;";
  check("control: the scan sees a planted copy", planted.split("\n").some((l) => ROWS[0].forbidden.some((p) => hit(p, l))));
  check("control: the ladder predicate sees two rungs on a line, not one", hit(ROWS[4].forbidden[0], "{ visitor: 0, builder: 1 }") && !hit(ROWS[4].forbidden[0], "visitor: 0"));
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
