// tools/protocol/modhole-check.ts — nothing a world sends runs as code in a visitor's browser (security pass 3; the
// private world-mods note of 09-28: on upstream main a world could offer a client mod, and one "run once" could make
// itself a permanent autorun local mod). This branch removed world-offered mods (client/lib/mods.js header); this check
// keeps it that way.
//
//   MH1  every place the client turns something into running code — a dynamic import of a non-literal, eval, new
//        Function, importScripts, a Worker from anything but a fixed URL, a blob: URL — is on the list below, with what
//        it loads and why that's ours (a fixed path on this server, or your own local mod). A new one fails here until
//        someone writes down why it can't be fed by a world.
//   MH2  the mod runner (runSource) is reached only from mods.js: your 🧩 panel, your autoruns, EW.mods.run
//   MH3  nothing in the client's message handling (net.js and the modules it emits to) touches the mod store or runner
//   MH4  EW.mods.put and EW.mods.run need your hand (transient user activation), and no world-offer code is left
//   MH5  the server has no message that carries a client mod
// usage: bun tools/protocol/modhole-check.ts   (static, a second; the browser half is xss-probe's D stage)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ENGINE = path.resolve(import.meta.dir, "../..");
const CLIENT = path.join(ENGINE, "client");
let pass = 0, fail = 0;
const ok = (c: any, what: string, detail?: any) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };

const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (["node_modules", "vendor", "voices"].includes(e.name)) continue;
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|html)$/.test(e.name)) files.push(p); } };
walk(CLIENT);
const code = (p: string) => fs.readFileSync(p, "utf8").split("\n").map((l, i) => ({ n: i + 1, l, t: l.trim() }))
  .filter(({ t }) => !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"));

// ---- MH1 ----
const LOADS = [/\bimport\(\s*(?!['"])/, /(^|[^.\w$])eval\s*\(/, /\(0,\s*eval\)/, /new Function\s*\(/, /importScripts\s*\(/, /new (Shared)?Worker\(\s*(?!new URL\()/, /createObjectURL\(/];
// [file, the line, why it can't be fed by a world]
const ALLOWED: [string, RegExp, string][] = [
  ["lib/assets.js", /\(0, eval\)\(src\)/, "loadEidoModule: a toolkit module by a FIXED name its caller writes (terrain.js, particles.js, sky_worlds.js) from /library/eidoverse/ — the operator's library; uploads are content-addressed images/audio/models, never .js"],
  ["lib/mods.js", /createObjectURL\(new Blob\(\[source\]/, "runSource: YOUR local mod's source, from your own IndexedDB (🧩 panel, autorun, EW.mods.run — by hand)"],
  ["lib/mods.js", /await import\(\/\* @vite-ignore \*\/ url\)/, "…the same local mod, imported from that blob"],
  ["lib/engines.js", /await import\(p\)/, "voice engines: the literal './engine-*.js' list in this file"],
  ["lib/engine-piper.js", /await import\(\/\* @vite-ignore \*\/ url\)/, "onnxruntime's webgpu bundle: a fixed new URL('../node_modules/…') beside it"],
  ["lib/phon.worker.js", /await import\(wasmPaths\.js\)/, "the phonemizer's own module: piperphon.js builds wasmPaths from fixed /vendor/piper URLs"],
];
const found: string[] = [];
for (const f of files) for (const { n, l, t } of code(f)) for (const r of LOADS) if (r.test(l)) {
  const rel = path.relative(CLIENT, f);
  if (!ALLOWED.some(([af, ar]) => af === rel && ar.test(l))) found.push(`${rel}:${n}: ${t.slice(0, 160)}`);
  break;
}
ok(found.length === 0, "MH1 every place the client turns data into running code is one we've written down (a fixed path, or your own mod)", found);
for (const [af, ar] of ALLOWED) ok(code(path.join(CLIENT, af)).some(({ l }) => ar.test(l)), `MH1 (the list is current) ${af} still has ${ar}`);

// ---- MH2 ----
const runners = files.filter((f) => code(f).some(({ l }) => /\brunSource\b/.test(l))).map((f) => path.relative(CLIENT, f));
ok(runners.length === 1 && runners[0] === "lib/mods.js", "MH2 the mod runner is reached only from mods.js", runners);

// ---- MH3 ----
const netSrc = code(path.join(CLIENT, "lib/net.js")).map(({ l }) => l).join("\n");
ok(!/mods\.js|modsApi|EW\.mods|ew-mods/.test(netSrc), "MH3 the client's message handling (net.js) never reaches the mod store or runner");
const handlers = files.filter((f) => /bus\.on\(\s*['"](?:mod|mods|offer|script)[\w-]*['"]/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(CLIENT, f));
ok(handlers.length === 0, "MH3 …and no module listens for a 'mod…'/'offer…' message from the wire", handlers);

// ---- MH4 ----
const mods = code(path.join(CLIENT, "lib/mods.js")).map(({ l }) => l).join("\n");
ok(/put:\s*\(rec\)\s*=>\s*\{\s*byHand\('put'\)/.test(mods) && /run:\s*\(name, source\)\s*=>\s*\{\s*byHand\('run'\)/.test(mods) && /userActivation\.isActive/.test(mods),
  "MH4 EW.mods.put and EW.mods.run need your hand (transient user activation)");
ok(!/runOffer|offerMod|offers?\s*\(|grantFor|consentFor/.test(mods), "MH4 no world-offer code is left in mods.js");

// ---- MH5 ----
const srv = ["server/messages.ts", "server/server.ts", "server/requestwire.ts"].map((f) => fs.readFileSync(path.join(ENGINE, f), "utf8")).join("\n");
const types = [...srv.matchAll(/type:\s*"([\w-]+)"/g)].map((m) => m[1]).filter((t) => /mod-?offer|client-?mod|^mods$|offer-?mod/i.test(t));   // ("mod" is moderation text, not a mod)
ok(types.length === 0, "MH5 the server sends no message that carries a client mod", types);

console.log(`[modhole-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
