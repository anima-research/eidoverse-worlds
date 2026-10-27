// tools/protocol/nov1-check.ts — the branch runs the current protocol only (R 2026-10-06: "There should be no more v1 anywhere"). Every
// runtime file a client, an agent or the server runs (client/, mcpl/, server/, shared/), and the long-running bots that
// join worlds (DEPLOYED), is scanned; it fails on:
//   - runtime code reaching the old-world importer (tools/protocol/import-v1/): a relative
//     import, a side-effect import, a dynamic or template import, new URL(…, import.meta.url), require(), a served
//     absolute path, or any line of code that names import-v1. The importer reads an old log once, at the operator's
//     command (tools/protocol/world.ts translate); only tools load it, and the server never serves tools/;
//   - a deleted v1 module that exists again (GONE);
//   - the old protocol on the wire or in code, sending OR receiving: v1 verb / lease messages, world_verb, the v1
//     fold's, rights' and log bus's entry points (in comments too);
//   - the word "v1" (any case, and as a name prefix: v1View) in code or comments, outside the few lines where it names
//     something else, listed in UNRELATED below with why.
// Tests in the runtime directories are scanned too, except for the word rule.
// usage: bun tools/protocol/nov1-check.ts        (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME = ["client", "mcpl", "server", "shared"];
// the bots that join worlds in production (deploy/*.service): they speak the protocol too
const DEPLOYED = ["tools/chatbridge", "tools/voicebot", "tools/captionbot"];
const SKIP_DIR = new Set(["node_modules", "vendor", "dist", ".git"]);
const EXT = /\.(m?js|cjs|ts|mts|cts|html)$/;
const isTest = (f) => /(^|\/)[^/]*[-.](test|bench|probe)\.[mc]?[jt]s$/.test(f) || f.includes("/test/") || f.includes("/tests/");

// deleted with v1: none may come back
const GONE = ["shared/fold.js", "shared/rightsfold.js", "shared/force.js", "shared/pace.js", "shared/protocol/fromv1.js", "shared/protocol/translate-v1.js", "shared/protocol/translate-d3.js",
  "shared/protocol/import-v1", "server/verbs.ts", "server/rights.ts", "server/reactions.ts", "server/events.ts", "server/lint.ts", "server/behaviors.ts", "server/boxes.ts",
  "server/build.ts", "client/lib/realize/ported.js", "client/lib/placer.js", "sdk", "docs/leases.md"];
const Q = "[\"'`]";
const RULES = [
  [/\bsendVerbs?\s*\(/, "sends a v1 verb (sendVerb)"],
  [new RegExp(`type:\\s*${Q}verb${Q}|type\\s*===?\\s*${Q}verb${Q}|case\\s+${Q}verb${Q}`), "a v1 `verb` message (sent or handled)"],
  [new RegExp(`\\bsendLease\\s*\\(|type:\\s*${Q}lease${Q}|type\\s*===?\\s*${Q}lease${Q}|case\\s+${Q}lease${Q}`), "a v1 lease (sent or handled)"],
  // (v1's `log` message and its WorldLog class were retired with v1; the names pass of 2026-10-07 gave both names to the
  // current protocol: `log` is its entries stream, WorldLog its per-world log. A v1 client is refused at join, so it
  // never reads the new `log`; the v1 entry points below still mark old code.)
  [/\bworld_verb\b/, "names world_verb (the v1 verb tool)"],
  [/\b(foldEntry|stateToEntries|VERB_NEEDS|rightsIn|BehaviorHost|settleLease|publishEntry|onEntryCommitted)\b/, "a v1 fold / rights / log entry point"],
];
// "v1" where it names something that isn't the old protocol: file → a pattern the whole line must match, and why
const UNRELATED = [
  ["server/directory.ts", /directory|v1 → v2|v1 keyed an agent/, "the authority directory's own file format version (v1 → v2), not the protocol"],
  ["shared/blueprint.js", /blueprint|v1 = an original|nested cop/, "the blueprint RECORD format's version (kind eido.blueprint, v: 1)"],
  ["client/lib/seatcore.js", /SEAT_METHOD/, "a seat-measuring method's name"],
  ["server/store-variants.ts", /LOD v1|v1 contract/, "the geometry-LOD contract's version"],
  ["server/optimize.ts", /./, "glTF / encoder format versions"],
  ["server/sfu", /./, "SFU / dependency API versions"],
  ["client/lib/vegetation/", /./, "plant generators' UV names (LEAF.v1) and model versions"],
  ["client/lib/sky_baked.js", /./, "the sky bake's cache format version"],
  ["shared/rig.js", /./, "the VRM spec's version (VRM 0.x / 1.0)"],
  ["client/lib/xrbody.js", /./, "the WebXR / VRM versions"],
  ["client/lib/tts.js", /./, "a voice model's version"],
  ["client/lib/stt.js", /./, "a speech model's version"],
  ["client/index.html", /./, "a library version"],
];
// the wire rules' own exceptions, each with why
const RULES_EXEMPT: [string, RegExp, string][] = [   // (the first eidosim's entries retired 2026-10-09: it lives in the importer now)
  ["mcpl/tools.ts", /TOOL_ALIASES|renamed with no alias|is now called|^\s*world_verb: "act \{verb, args\}/, "the alias table: an old tool name still answers, and says what it is now called (STRIKES A-S1-2); world_verb's TOOL_REMOVED row refuses it (R 10-27)"],
  ["mcpl/tools.ts", /TOOL_ALIAS_ARGS/, "the alias ARGUMENT table (10-15): an old name's old argument shape translates to the new tool's"],
  ["mcpl/alias-test.ts", /TOOL_ALIAS_ARGS|is now called|TOOL_REMOVED|"world_verb"|world_verb (is|was) removed/, "the alias test drives each old name and its old shape, and world_verb's refusal (R 10-27)"],
];
const IMPORTS = [
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'`](\.{1,2}\/[^"'`$]+)["'`]/g,     // static, side-effect, dynamic, template (up to a ${), require
  /new\s+URL\s*\(\s*["'`](\.{1,2}\/[^"'`$]+)["'`]\s*,\s*import\.meta\.url/g,                  // workers and assets resolved from the module
  /(?:from\s+|import\s*\(\s*|import\s+)["'`](\/[^"'`$]+)["'`]/g,                               // a served absolute path (/shared/… is the repo's shared/)
];
const offences = [];
const unrelated = (rel, line) => UNRELATED.some(([f, re]) => (rel === f || rel.startsWith(f)) && re.test(line));
const scan = (p, { runtime }) => {
  const rel = path.relative(ROOT, p).split(path.sep).join("/");
  fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (runtime) {
      for (const re of IMPORTS) for (const m of line.matchAll(re)) {
        const to = m[1].startsWith("/") ? m[1].slice(1) : path.relative(ROOT, path.resolve(path.dirname(p), m[1])).split(path.sep).join("/");
        if (to.startsWith("tools/protocol/import-v1")) offences.push(`${at}  loads the old-world importer (${to}): only tools may`);
        if (GONE.some((g) => to === g || to.startsWith(g + "/"))) offences.push(`${at}  imports a deleted v1 module (${to})`);
      }
      if (/import-v1/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offences.push(`${at}  names the old-world importer in code`);
    }
    if (!RULES_EXEMPT.some(([f, re]) => rel === f && re.test(line))) for (const [re, what] of RULES) if (re.test(line)) offences.push(`${at}  ${what}`);
    if (runtime && !isTest(rel) && /\bv1\b|\bv1[A-Z_]|\bV1[A-Z_a-z]*\b/i.test(line.replaceAll("import-v1", "").replaceAll("translate-v1", "")) && !unrelated(rel, line))
      offences.push(`${at}  says "v1": ${line.trim().slice(0, 110)}`);
  });
};
const walk = (dir, opts) => {
  if (!fs.existsSync(dir)) return;
  if (fs.statSync(dir).isFile()) { if (EXT.test(dir)) scan(dir, opts); return; }
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p, opts); continue; }
    if (EXT.test(name)) scan(p, opts);
  }
};
for (const d of RUNTIME) walk(path.join(ROOT, d), { runtime: true });
for (const d of DEPLOYED) walk(path.join(ROOT, d), { runtime: false });
for (const f of GONE) if (fs.existsSync(path.join(ROOT, f))) offences.push(`${f}  exists again (deleted with v1)`);
for (const o of offences) console.log("  " + o);
console.log(`[nov1-check] ${offences.length ? `${offences.length} v1 offence(s)` : "no v1 at runtime or on the wire: the importer (tools/protocol/import-v1/) is the only reader of the old protocol, and only tools load it"}`);
process.exit(offences.length ? 1 : 0);
