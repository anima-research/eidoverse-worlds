// defs-smoke — the def registry lane, proven end to end (charter §3, §24).
//
//   bun tools/defs-smoke.ts              # headless Chrome, own scratch sequencer
//   bun tools/defs-smoke.ts --headed
//   bun tools/defs-smoke.ts --console
//
// What it proves (see the section banners): the registry contract (novel
// def served, broken def refused loudly, round-trip exact, sidecars), the
// avatar + animation overlays, engine hydration ENGAGEMENT, hot reload
// under a live client, a def-only species rendering, the def-composed
// mojave biome, and unknown-species failing loudly while the boot stands.
//
// Scaffolding: tools/harness.ts (R2 — the shared scratch bench).

import { mkdtempSync, readFileSync, readdirSync, copyFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchBench, readSequencerLog, mkCheck, bold, dim, sleep, ROOT } from "./harness.ts";

const HEADED = process.argv.includes("--headed");
const ECHO = process.argv.includes("--console");

// the scratch DEFS_DIR exists BEFORE the sequencer that serves it
const DEFS = mkdtempSync(join(tmpdir(), "ew-defsmoke-defs-"));
for (const domain of readdirSync(join(ROOT, "defs"))) {
  const src = join(ROOT, "defs", domain);
  let st; try { st = statSync(src); } catch { continue; }
  if (!st.isDirectory()) continue;
  mkdirSync(join(DEFS, domain), { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith(".json")) copyFileSync(join(src, f), join(DEFS, domain, f));
  }
}

console.log(`\n${bold("defs-smoke")} — defs in ${DEFS}`);
const { PORT, BASE, SCRATCH, cws, cdp, evalJson, cleanup, die } =
  await scratchBench("defsmoke", { headed: HEADED, portFrom: 8955, serverEnv: { DEFS_DIR: DEFS } });
const { check, tally } = mkCheck();

// ---- the scratch def registry ----------------------------------------------

// underscore files (_colors.json) are domain sidecars, not species defs
const REPO_COUNT = readdirSync(join(DEFS, "flora")).filter((f) => !f.startsWith("_")).length;
// the def-only species: exists in NO .js file — if it renders, the lane works
writeFileSync(join(DEFS, "flora", "smoketest_lavender.json"), JSON.stringify({
  doc: "defs-smoke's witness species — a burgundy meadow no engine file knows.",
  archetype: "blades", maps: "blades_meadow", leafRecolor: "burgundy",
  blades: { perBunch: 8, bunchR: 0.5, h: 0.38, w: 0.042, lean: 0.42 },
  colors: { jitter: 0.22 }, baseScale: [0.8, 1.3], density: 6.0, clump: 1.0,
  wind: { base: 0.35, gust: 0.7, gustFreq: 0.3, flutter: 0.5 },
  sss: 0.5, rough: 0.6, pushScale: 1.0,
}, null, 2));
writeFileSync(join(DEFS, "flora", "broken.json"), JSON.stringify({ doc: "no archetype — must be refused" }));
await sleep(1300);   // past the registry TTL — the server booted before these writes

// ---- server contract --------------------------------------------------------

console.log(`\n${bold("── server")}`);
const reg = await (await fetch(`${BASE}/defs`)).json();
const names = Object.keys(reg.flora ?? {}).sort();
check("registry serves repo defs + the novel species", names.length === REPO_COUNT + 1,
  `${names.length} served (${REPO_COUNT} repo + smoketest_lavender)`);
check("def-only species is served", names.includes("smoketest_lavender"));
check("broken def is NOT served", !names.includes("broken"));
{
  const disk = JSON.parse(readFileSync(join(ROOT, "defs", "flora", "grass.json"), "utf8"));
  check("grass def round-trips exactly", JSON.stringify(reg.flora.grass) === JSON.stringify(disk));
  const log = readSequencerLog(SCRATCH);
  check("broken def refused LOUDLY", log.includes("REFUSED") && log.includes("broken.json"));
  check("sky presets ride the registry", ["dawn", "noon", "golden", "dusk", "night"]
    .every((n) => reg.skyPresets?.[n]?.hours != null), Object.keys(reg.skyPresets ?? {}).join(", "));
  check("structure palette rides the registry", reg.structurePalette?.wall?.finish === "plaster"
    && reg.structurePalette?.glass?.opacity === 0.22, Object.keys(reg.structurePalette ?? {}).join(", "));
  check("ground palette rides the registry", reg.groundPalette?.tints?.meadow?.layer === "#4a5d33"
    && reg.groundPalette?.plantings?.meadow?.blade === true
    && reg.groundPalette?.plantings?.["mojave desert"]?.args?.preset === "mojave"
    && reg.groundPalette?.shapes?.rugged === 6.0,
  Object.keys(reg.groundPalette ?? {}).join(", "));
  check("sky clocks ride the registry (tz validated against host IANA)",
    reg.skyClocks?.["los angeles"]?.tz === "America/Los_Angeles",
    Object.keys(reg.skyClocks ?? {}).join(", "));
  check("help def rides the registry", typeof reg.uiHelp?.title === "string"
    && Array.isArray(reg.uiHelp?.keys) && reg.uiHelp.keys.length >= 15
    && Array.isArray(reg.uiHelp?.sections) && reg.uiHelp.sections.length >= 4,
  `${reg.uiHelp?.keys?.length ?? 0} keys, ${reg.uiHelp?.sections?.length ?? 0} sections`);
  check("the emote vocabulary rides the registry (order = key order)",
    reg.emotes?.wave?.clip === "raise" && reg.emotes?.talk?.listed === false
    && Object.keys(reg.emotes ?? {})[0] === "wave", Object.keys(reg.emotes ?? {}).join(", "));
}

// ---- animation overlay ------------------------------------------------------
// Same contract as avatars: declared beats discovered, unresolvable paths
// cost the roster nothing.

console.log(`\n${bold("── animations")}`);
{
  const before: { name: string; path: string; size: number }[] =
    await (await fetch(`${BASE}/animations`)).json();
  if (!before.length) {
    check("roster has at least one discovered clip", false, "empty roster — no .vrma in library?");
  } else {
    const first = before[0];
    mkdirSync(join(DEFS, "animations"), { recursive: true });
    writeFileSync(join(DEFS, "animations", "defsmoke_wave.json"),
      JSON.stringify({ doc: "defs-smoke clip alias", vrma: first.path.split("?")[0], tags: ["smoke"] }));
    writeFileSync(join(DEFS, "animations", "defsmoke_ghost.json"),
      JSON.stringify({ vrma: "eidoverse/assets/animations/does_not_exist.vrma" }));
    await sleep(1300);   // past the registry TTL
    const after: typeof before = await (await fetch(`${BASE}/animations`)).json();
    const alias = after.find((a) => a.name === "defsmoke_wave");
    check("alias def declares a clip the scan wouldn't find",
      !!alias && alias.size === first.size && /\?v=\d+$/.test(alias.path), JSON.stringify(alias));
    check("unresolvable vrma costs the roster nothing",
      !after.find((a) => a.name === "defsmoke_ghost") && after.length === before.length + 1,
      `${after.length} vs ${before.length}+1`);
    const reg3 = await (await fetch(`${BASE}/defs`)).json();
    check("/defs serves the animations domain (tags ride there)",
      reg3.animations?.defsmoke_wave?.tags?.[0] === "smoke",
      JSON.stringify(reg3.animations ?? {}));
  }
}

// ---- avatar overlay ---------------------------------------------------------
// Defs overlay the DISCOVERED roster (declared beats discovered): an
// override def restates a scanned avatar's height, an alias def points a
// new name at an existing .vrm, and a def with an unresolvable path is
// refused without costing the roster anything.

console.log(`\n${bold("── avatars")}`);
{
  const before: { name: string; path: string; height: number | null }[] =
    await (await fetch(`${BASE}/avatars`)).json();
  if (!before.length) {
    check("roster has at least one discovered avatar", false, "empty roster — no .vrm in library?");
  } else {
    const first = before[0];
    mkdirSync(join(DEFS, "avatars"), { recursive: true });
    writeFileSync(join(DEFS, "avatars", `${first.name}.json`),
      JSON.stringify({ doc: "defs-smoke height override", height: 9.99 }));
    writeFileSync(join(DEFS, "avatars", "defsmoke_alias.json"),
      JSON.stringify({ doc: "defs-smoke alias", vrm: first.path.split("?")[0], height: 1.23 }));
    writeFileSync(join(DEFS, "avatars", "defsmoke_broken.json"),
      JSON.stringify({ vrm: "eidoverse/assets/vrms/does_not_exist.vrm" }));
    await sleep(1300);   // past the registry TTL
    const after: typeof before = await (await fetch(`${BASE}/avatars`)).json();
    const over = after.find((a) => a.name === first.name);
    const alias = after.find((a) => a.name === "defsmoke_alias");
    check("def height overrides the discovered avatar", over?.height === 9.99,
      `${first.name} height ${over?.height}`);
    check("alias def declares an avatar the scan wouldn't find",
      !!alias && alias.height === 1.23 && /\?v=\d+$/.test(alias.path), JSON.stringify(alias));
    check("unresolvable vrm def costs the roster nothing",
      !after.find((a) => a.name === "defsmoke_broken") && after.length === before.length + 1,
      `${after.length} vs ${before.length}+1`);
    // the broken def VALIDATES (the registry can't stat the library) — the
    // roster is where its path fails to resolve, loudly
    const reg2 = await (await fetch(`${BASE}/defs`)).json();
    check("/defs serves the avatars domain", Object.keys(reg2.avatars ?? {}).length === 3,
      Object.keys(reg2.avatars ?? {}).join(", "));
    const log2 = readSequencerLog(SCRATCH);
    check("unresolvable vrm refused LOUDLY", log2.includes(`avatar "defsmoke_broken"`));
  }
}

// ---- driver: author the three worlds ---------------------------------------

type Driver = { verb(v: string, a: unknown): Promise<void>; close(): void };
function joinDriver(world: string, id: string): Promise<Driver> {
  return new Promise((resolveP, reject) => {
    const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const self: Driver = {
      verb: async (v, a) => { dws.send(JSON.stringify({ type: "verb", verb: v, args: a })); await sleep(420); },
      close: () => { try { dws.close(); } catch { /* fine */ } },
    };
    dws.onopen = () => dws.send(JSON.stringify({ type: "join", world, id, token: "" }));
    dws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") resolveP(self);
      if (m.type === "error") console.log(dim(`  ${id} refused: ${m.error}`));
    };
    dws.onerror = (e) => reject(new Error(`socket ${id}: ${String(e)}`));
    setTimeout(() => reject(new Error(`${id} never got a snapshot`)), 15_000);
  });
}
const stamp = Math.random().toString(36).slice(2, 7);
const WORLDS = { std: `defsmoke-std-${stamp}`, novel: `defsmoke-novel-${stamp}`,
  preset: `defsmoke-preset-${stamp}`, bogus: `defsmoke-bogus-${stamp}` };
for (const [kind, name] of Object.entries(WORLDS)) {
  const d = await joinDriver(name, "defsdriver");
  await d.verb("terrain", { size: 64 });
  if (kind === "preset") {
    await d.verb("grass", { preset: "mojave", width: 36, depth: 36, center: [0, 0], density: 0.5 });
  } else {
    const species = kind === "std" ? "grass" : kind === "novel" ? "smoketest_lavender" : "bogus_nope";
    await d.verb("grass", { species, width: 40, depth: 40, center: [0, 0], height: 0.42, density: 1.0 });
  }
  d.close();
}

// ---- browser ----------------------------------------------------------------

let consoleLines: string[] = [];
let pageErrors: string[] = [];
let bootReady = "";
const textOf = (a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "";
cws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map(textOf).join(" ");
    if (ECHO) console.log(dim(`    [page ${m.params.type}] ${line}`));
    consoleLines.push(line);
    if (line.startsWith("[boot] ready")) bootReady = line;
    if (m.params.type === "error") pageErrors.push(line);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push(String(d?.exception?.description ?? d?.text ?? "(exception)"));
  }
});
async function bootInto(world: string) {
  bootReady = ""; consoleLines = []; pageErrors = [];
  await cdp.send("Page.navigate", { url: `${BASE}/?name=defsbot&world=${world}` });
  for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
  if (!bootReady) throw new Error(`client never booted into ${world}`);
}
/** Poll the tile-level draw truth until the field exists and draws. */
async function grassDrawn(timeoutS = 45): Promise<{ drawn: number; mode: string } | null> {
  for (let i = 0; i < timeoutS * 2; i++) {
    const s = await evalJson(`(() => { try {
      const st = EW.grass()?.strokes ?? [];
      return st.length ? { drawn: st[0].drawn, mode: st[0].mode } : null;
    } catch { return null } })()`);
    if (s && s.drawn > 0) return s;
    await sleep(500);
  }
  return null;
}

console.log(`\n${bold("── standard meadow")}  ${dim(`world ${WORLDS.std}`)}`);
await bootInto(WORLDS.std);
{
  const g = await grassDrawn();
  const hyd = consoleLines.find((l) => l.includes("flora defs hydrated"));
  check("engine hydrated from /defs (engagement proof)", !!hyd, hyd ?? "no hydration line");
  check(`hydrated the full registry`, !!hyd && hyd.includes(`${REPO_COUNT + 1} species`), hyd ?? "");
  check("grass builds and draws", !!g && g.drawn > 0, g ? `drawn ${g.drawn}` : "no drawn instances");
  check("blades mode still opaque (§22m)", g?.mode === "opaque", `mode ${g?.mode}`);
}

// ---- hot reload -------------------------------------------------------------
// Edit a def on disk while a client stands in the meadow: the defs-watch
// tick pushes `defs-updated`, the client re-hydrates and regrows from the
// SAME authored args — no reboot, no log entry, new content.
console.log(`\n${bold("── hot reload")}  ${dim("editing grass.json under a live client")}`);
{
  const before = await evalJson(`(() => { try {
    const s = EW.grass()?.strokes ?? []; return s.length ? s[0].planted : null;
  } catch { return null } })()`);
  const gp = join(DEFS, "flora", "grass.json");
  const gdef = JSON.parse(readFileSync(gp, "utf8"));
  gdef.density = 5.0;   // 22 → 5: the regrown field plants far fewer
  writeFileSync(gp, JSON.stringify(gdef, null, 2));
  let after: number | null = null;
  for (let i = 0; i < 60 && after === null; i++) {
    await sleep(1000);
    const p = await evalJson(`(() => { try {
      const s = EW.grass()?.strokes ?? []; return s.length ? s[0].planted : null;
    } catch { return null } })()`);
    if (p != null && p !== before) after = p;
  }
  const refreshed = consoleLines.find((l) => l.includes("flora defs refreshed"));
  check("client re-hydrated on the push", !!refreshed, refreshed ?? "no refresh line");
  check("meadow regrew from the edited def (no reboot)", after != null && after < (before ?? 0),
    `planted ${before} → ${after}`);
}

console.log(`\n${bold("── def-only species")}  ${dim(`world ${WORLDS.novel}`)}`);
await bootInto(WORLDS.novel);
{
  const g = await grassDrawn();
  check("a species no .js file knows RENDERS", !!g && g.drawn > 0, g ? `drawn ${g.drawn}, mode ${g.mode}` : "no drawn instances");
  // the lavender's leafRecolor names "burgundy" — resolvable only if the
  // palette sidecar (_colors.json) hydrated; a miss warns and drops it
  check("palette sidecar hydrated (no unknown-color warning)",
    !consoleLines.some((l) => l.includes("names unknown color")));
}

console.log(`\n${bold("── def-composed biome")}  ${dim(`world ${WORLDS.preset}`)}`);
await bootInto(WORLDS.preset);
{
  // the mojave recipe now lives in defs/flora/_presets.json — seven strokes
  // (galleta + 2 blackbrush + 2 creosote + sagebrush + yucca) composed from
  // the def's template vocabulary, no recipe in any .js file
  let strokes: any[] = [];
  for (let i = 0; i < 120 && strokes.length < 7; i++) {
    await sleep(500);
    strokes = (await evalJson(`(() => { try {
      return (EW.grass()?.strokes ?? []).map(s => ({ label: s.stroke, planted: s.planted }));
    } catch { return [] } })()`)) ?? [];
  }
  const planted = strokes.reduce((n, s) => n + (s.planted ?? 0), 0);
  check("mojave composes 7 strokes from the def", strokes.length === 7,
    `${strokes.length} strokes: ${strokes.map((s) => s.label).join(" ")}`);
  check("the biome plants", planted > 0, `${planted} planted`);
}

console.log(`\n${bold("── unknown species")}  ${dim(`world ${WORLDS.bogus}`)}`);
await bootInto(WORLDS.bogus);
{
  await sleep(6000);   // give the flora build time to fail
  const complaint = [...pageErrors, ...consoleLines].find((l) => l.includes("unknown species"));
  check("fails LOUDLY", !!complaint, complaint ? complaint.slice(0, 90) : "no 'unknown species' complaint");
  check("the world still stands", !!bootReady);
}

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
await cleanup();
process.exit(tally.failed ? 1 : 0);
