// tools/v4/nov1-check.ts — the branch runs v4 only (R 2026-10-06: "There should be no more v1 anywhere"). Every
// runtime file a client, an agent or the server runs (client/, mcpl/, server/, shared/) is scanned; it fails on:
//   - an import of the old-world importer (shared/v4/import-v1/) from anywhere outside it: the importer reads an old
//     log once, at the operator's command (tools/v4/world.ts translate), and only tools may load it;
//   - a deleted v1 module that exists again;
//   - the old protocol on the wire or in code: v1 verb messages, leases, the v1 log message, world_verb, the v1 fold's
//     and rights' entry points;
//   - the word "v1" itself in code or comments (the old protocol has no runtime here to talk about), outside the
//     importer and the few lines where it names something else, listed in UNRELATED below with why.
// Tests in those directories are scanned too, except for the word rule.
// usage: bun tools/v4/nov1-check.ts        (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME = ["client", "mcpl", "server", "shared"];
const IMPORTER = "shared/v4/import-v1/";
const SKIP_DIR = new Set(["node_modules", "vendor", "dist", ".git"]);
const isTest = (f) => /(^|\/)[^/]*[-.](test|bench|probe)\.[mc]?[jt]s$/.test(f) || f.includes("/test/") || f.includes("/tests/");

// deleted with v1: none may come back
const GONE = ["shared/fold.js", "shared/rightsfold.js", "shared/force.js", "shared/v4/fromv1.js", "shared/v4/translate-v1.js", "shared/v4/translate-d3.js",
  "server/verbs.ts", "server/rights.ts", "server/reactions.ts", "server/events.ts", "server/lint.ts", "server/behaviors.ts", "server/boxes.ts", "server/v4/build.ts",
  "client/lib/realize/ported.js", "sdk/behavior.d.ts", "docs/leases.md"];
const RULES = [
  [/\bsendVerbs?\s*\(/, "sends a v1 verb (sendVerb)"],
  [/type:\s*["']verb["']/, "puts a v1 `verb` message on the wire"],
  [/\bsendLease\s*\(|type:\s*["']lease["']/, "a v1 lease"],
  [/type:\s*["']log["']/, "the v1 `log` message"],
  [/\bworld_verb\b/, "names world_verb (the v1 verb tool)"],
  [/\b(foldEntry|stateToEntries|VERB_NEEDS|rightsIn|WorldLog|BehaviorHost|settleLease|publishEntry|onEntryCommitted)\b/, "a v1 fold / rights / log entry point"],
];
// "v1" where it names something that isn't the old protocol: file → a pattern the whole line must match, and why
const UNRELATED = [
  ["server/v4/directory.ts", /directory|v1 → v2|v1 keyed an agent/, "the door directory's own file format version (v1 → v2), not the protocol"],
  ["shared/blueprint.js", /blueprint|v1 = an original|nested cop/, "the blueprint RECORD format's version (kind eido.blueprint, v: 1)"],
  ["client/lib/seatcore.js", /SEAT_METHOD/, "a seat-measuring method's name"],
  ["shared/v4/scriptrules.js", /upload cap|\(v1\)/, "a limit's provenance: the old sandbox's cap, kept as the number"],
  ["server/store-variants.ts", /LOD v1|v1 contract/, "the geometry-LOD contract's version"],
  ["server/optimize.ts", /./, "glTF / encoder format versions"],
  ["server/sfuguard.ts", /./, "a dependency's API version"],
  ["client/lib/vegetation/", /./, "plant generators' own model versions"],
  ["client/lib/sky_baked.js", /./, "the sky bake's cache format version"],
  ["shared/rig.js", /./, "the VRM spec's version (VRM 0.x / 1.0)"],
  ["client/lib/xrbody.js", /./, "the WebXR / VRM versions"],
  ["client/lib/tts.js", /./, "a voice model's version"],
  ["client/lib/stt.js", /./, "a speech model's version"],
  ["client/index.html", /./, "a library version"],
  ["server/sfu", /./, "SFU protocol versions"],
];
const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const offences = [];
const unrelated = (rel, line) => UNRELATED.some(([f, re]) => (rel === f || rel.startsWith(f)) && re.test(line));
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name); const rel = path.relative(ROOT, p);
    if (fs.statSync(p).isDirectory()) { if (!(rel + "/").startsWith(IMPORTER)) walk(p); continue; }
    if (!/\.(m?js|ts|html)$/.test(name)) continue;
    fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      for (const m of line.matchAll(IMPORT)) { const to = path.relative(ROOT, path.resolve(path.dirname(p), m[1]));
        if ((to + "/").startsWith(IMPORTER) || to.startsWith(IMPORTER)) offences.push(`${at}  imports the old-world importer (${to}): only tools may`);
        if (GONE.includes(to)) offences.push(`${at}  imports a deleted v1 module (${to})`); }
      const comment = /^\s*(\/\/|\*|\/\*)/.test(line);
      if (!comment) for (const [re, what] of RULES) if (re.test(line)) offences.push(`${at}  ${what}`);
      if (!isTest(rel) && /\bv1\b/.test(line.replaceAll("import-v1", "")) && !unrelated(rel, line)) offences.push(`${at}  says "v1": ${line.trim().slice(0, 110)}`);
    });
  }
};
for (const d of RUNTIME) walk(path.join(ROOT, d));
for (const f of GONE) if (fs.existsSync(path.join(ROOT, f))) offences.push(`${f}  exists again (deleted with v1)`);
for (const o of offences) console.log("  " + o);
console.log(`[nov1-check] ${offences.length ? `${offences.length} v1 offence(s)` : "no v1 at runtime: the importer (shared/v4/import-v1/) is the only reader of the old protocol, and only tools load it"}`);
process.exit(offences.length ? 1 : 0);
