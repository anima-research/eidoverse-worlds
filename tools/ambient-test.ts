// ambient — the #31 contract, executed: same-origin provenance, bounded
// gain/radius, real lifecycle events (comp attach/replace, entity
// kind:'remove', world-reset), and category composition (world slider
// governs the place, voices slider does not).
//
//   bun tools/ambient-test.ts

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://lab.test/" });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- fakes ----------------------------------------------------------------
class FakeAudioEl {
  src: string; loop = false; crossOrigin = ""; paused = true;
  constructor(src: string) { this.src = src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
(globalThis as Record<string, unknown>).Audio = FakeAudioEl;

const gains: { value: number; lastTarget: number | null }[] = [];
class FakeCtx {
  currentTime = 0; state = "running";
  destination = {};
  resume() { return Promise.resolve(); }
  createMediaElementSource() { return { connect: (n: unknown) => n, disconnect() {} }; }
  createGain() {
    const g = { value: 0, lastTarget: null as number | null,
      setTargetAtTime(v: number) { g.lastTarget = v; } };
    gains.push(g);
    return { gain: g, connect: (n: unknown) => ({ connect() {} }), disconnect() {} };
  }
}
(globalThis as Record<string, unknown>).AudioContext = FakeCtx;

// ---- module stubs ---------------------------------------------------------
const handlers = new Map<string, ((p: unknown) => void)[]>();
const bus = {
  on(ev: string, fn: (p: unknown) => void) { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)!).push(fn); },
  emit(ev: string, p: unknown) { for (const fn of handlers.get(ev) ?? []) fn(p); },
};
const entities = new Map<string, { position: { distanceTo: (o: unknown) => number } }>();
const myState = { pos: {} };
const vols: Record<string, number> = { world: 1, voices: 1 };
const stub = {
  bus, entities, myState, report: () => {},
  volumeFor: (cat: string) => vols[cat] ?? 1,
};
const { mock } = await import("bun:test");
for (const m of ["core", "world", "controller", "voiceconsent"])
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stub);

const amb = await import("../client/lib/ambient.js");

const at = (d: number) => ({ position: { distanceTo: () => d } });
const comp = (id: string, data: unknown) => bus.emit("comp", { id, type: "ambient", data });

const OGG = "store/audio/0123456789abcdef.ogg";
const OGG2 = "store/audio/fedcba9876543210.ogg";

// ---- provenance: store paths only -----------------------------------------
check("a store path resolves to its /library URL",
  amb.ambientSrc(OGG) === `/library/${OGG}`);
check("a URL is refused outright", amb.ambientSrc("https://evil.example/track.mp3") === null);
check("an arbitrary same-origin path is refused (no GET-endpoint audio)",
  amb.ambientSrc("api/export?fmt=ogg") === null);
check("a path-traversal dressed as a store path is refused",
  amb.ambientSrc("store/audio/../../secrets.ogg") === null);
comp("spy", { src: "https://evil.example/track.mp3" });
check("a refused component attaches NOTHING (no fetch, no IP leak)",
  amb.ambientCount() === 0, `${amb.ambientCount()}`);
check("…and the refusal is LEGIBLE, not silent",
  /store\/audio/.test(amb.ambientDebug().refused["spy"] ?? ""),
  JSON.stringify(amb.ambientDebug().refused));

// ---- loop-only ------------------------------------------------------------
comp("oneshot", { src: OGG, loop: false });
check("loop:false is refused (late join would replay it)",
  amb.ambientCount() === 0 && /loop-only/.test(amb.ambientDebug().refused["oneshot"] ?? ""),
  JSON.stringify(amb.ambientDebug().refused));

// ---- lifecycle ------------------------------------------------------------
entities.set("fount", at(0));
comp("fount", { src: OGG, gain: 0.5, radius: 10 });
check("attach: one source for one component", amb.ambientCount() === 1);
comp("fount", { src: OGG2 });
check("replace: same entity re-authored stays ONE source", amb.ambientCount() === 1);
check("replace actually swapped the media",
  amb.ambientDebug().playing["fount"].src === OGG2, JSON.stringify(amb.ambientDebug().playing));
check("a valid replace clears any earlier refusal record",
  amb.ambientDebug().refused["fount"] === undefined);
bus.emit("entity", { id: "fount", kind: "remove" });
check("entity kind:'remove' detaches promptly (the {gone} listener bug, fixed)",
  amb.ambientCount() === 0, `${amb.ambientCount()}`);

entities.set("a", at(0)); entities.set("b", at(0));
comp("a", { src: OGG }); comp("b", { src: OGG2 });
check("both attached pre-reset", amb.ambientCount() === 2);
bus.emit("world-reset", {});
check("world-reset detaches everything", amb.ambientCount() === 0, `${amb.ambientCount()}`);

// ---- bounds + composition -------------------------------------------------
entities.set("loud", at(0));
comp("loud", { src: OGG, gain: 99, radius: 9999 });
amb.updateAmbient();
const g = () => gains.at(-1)!.lastTarget;
check("authored gain 99 is clamped: target never exceeds 1×world", (g() ?? 99) <= 1, `${g()}`);
vols.world = 0.4;
amb.updateAmbient();
check("the WORLD slider governs the place", Math.abs((g() ?? 0) - 0.4) < 1e-9, `${g()}`);
vols.voices = 0;
amb.updateAmbient();
check("the VOICES slider does not (categories stay split)", Math.abs((g() ?? 0) - 0.4) < 1e-9, `${g()}`);
entities.delete("loud");
amb.updateAmbient();
check("an entity that vanished mid-frame detaches on the next tick", amb.ambientCount() === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
