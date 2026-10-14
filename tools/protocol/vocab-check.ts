// tools/protocol/vocab-check.ts — one vocabulary for a thing's record, everywhere (R 2026-10-14: "we should be completely on
// a new and streamlined protocol system"). The view (shared/protocol/view.js) says a thing in the protocol's own names:
// its components flat (model, transform, sockets, label, light, …) plus the derived pos/q/yaw/scale/scale3/parent. Until
// 10-14 it spoke the old protocol's: the model as `lib`, every other component inside a `comp` bag — and 180-odd readers
// learned that spelling. This fails the build on a read of the old spelling in any runtime file (client/, mcpl/, server/,
// shared/) or deployed bot:
//   - `.lib` read on a record (a model's library path is `.model`);
//   - the `comp` bag: `.comp.x`, `.comp?.x`, `.comp[`, `.comp ?? {}`, `comp:` written on a record (a component sits flat).
// `op.comp` — the log op's field (PROTOCOL §3: set {id, comp, value}) — is the protocol, not the record, and is allowed by
// name: the variables that carry ops are listed in OPS. Other true exceptions go in EXEMPT, each with why.
// usage: bun tools/protocol/vocab-check.ts        (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME = ["client", "mcpl", "server", "shared"];
const DEPLOYED = ["tools/chatbridge", "tools/voicebot", "tools/captionbot"];
const SKIP_DIR = new Set(["node_modules", "vendor", "dist", ".git"]);
const EXT = /\.(m?js|cjs|ts|mts|cts)$/;
// names that carry a log OP (whose `comp` is the op's component name): these reads are the protocol's, not the record's
const OPS = "(?:op|o|b|x|hit|inst|ureq|a)";
const RULES: [RegExp, string][] = [
  [/(?<![\w$])(?!userData)[\w$\]\)]+\??\.lib\b(?!\s*[:(])/, "reads `.lib` on a record: a model's path is `.model`"],
  [new RegExp(`(?<!\\b${OPS})\\??\\.comp(\\?\\.|\\.|\\[|\\s*\\?\\?\\s*\\{)`), "reads the `comp` bag: a component sits flat on the record"],
  [new RegExp(`(?<!\\b${OPS})\\??\\.comp\\b(?![\\w$(:])`), "reads the `comp` bag bare (a record has no bag: recordComponents(rec))"],
  [/\bcomp:\s*(\{|[\w$]+\.comp\b)/, "writes a `comp` bag on a record"],
  [/\blib:\s*(libOf\(|[\w$.]+\.model\b)/, "writes a record's model under `lib` (a reader will say `.model`)"],
];
// true exceptions, each with why (file → a pattern the whole line must match)
const EXEMPT: [string, RegExp, string][] = [
  ["client/lib/", /userData\??\.lib\b/, "three.js userData.lib: the renderer's own tag on a loaded object, not a record"],
  ["client/lib/build.js", /ghost\.lib|params\.lib/, "the placement ghost's own field, and a catalogue entry's"],
  ["shared/components.js", /params:\s*\{\s*lib|p\.lib\b|type === 'Model'/, "the component LIST's Model params (its own schema, RFC #208): leaves with the schema-layer merge"],
  ["shared/editschema.js", /params\.lib|c\.type === 'Model'/, "the component LIST's Model params: leaves with the schema-layer merge"],
  ["shared/blueprint.js", /params\.lib/, "the component LIST's Model params: leaves with the schema-layer merge"],
  ["mcpl/tools.ts", /a\.lib\b|lib=\$\{/, "the find tool's own `lib` argument and the /library URL's query name"],
  ["server/routes.ts", /resolveLibFile|\/library/, "the library route's own file lookup"],
  ["shared/protocol/authority.js", /out\.comp = op\.comp|\bh\.comp\b|toggleOf\(h\)\.comp/, "an op being shaped (out) and a reaction handler (h) name the OP's component"],
  ["shared/protocol/authority.js", /activate\(w, id, name, \{ on: `changed:/, "a reaction's activation record names the OP's component (PROTOCOL §3), not a record's bag"],
  ["shared/sim.js", /sim\.boxes\[/, "the first eidosim's box table, keyed by library path (retires with it)"],
];
const offences: string[] = [];
const exempt = (rel: string, line: string) => EXEMPT.some(([f, re]) => (rel === f || rel.startsWith(f)) && re.test(line));
const scan = (p: string) => {
  const rel = path.relative(ROOT, p);
  if (rel === "tools/protocol/vocab-check.ts") return;
  fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;   // a comment may name the old spelling to say it is gone
    if (exempt(rel, line)) return;
    for (const [re, what] of RULES) if (re.test(line)) offences.push(`${rel}:${i + 1}  ${what}: ${line.trim().slice(0, 100)}`);
  });
};
const walk = (dir: string) => {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (EXT.test(name)) scan(p);
  }
};
for (const d of [...RUNTIME, ...DEPLOYED]) walk(path.join(ROOT, d));
for (const o of offences) console.log("  " + o);
console.log(`[vocab-check] ${offences.length ? `${offences.length} old-spelling read(s)` : "one vocabulary: every runtime reader speaks the record in the protocol's names"}`);
process.exit(offences.length ? 1 : 0);
