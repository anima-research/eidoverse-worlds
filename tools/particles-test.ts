// The `particles` component's meaning + lifecycle, without a browser.
//
//   bun run tools/particles-test.ts
//
// Three legs, matching eidoverse-worlds #25's acceptance list:
//
//   1. DECLARATION  — declared presets, bounded overrides, unknown values that
//      fail LEGIBLY, and a seed that is deterministic, persistent and shared.
//   2. LIFECYCLE    — attach → replace → remove → late join, with no duplicate
//      per-frame hooks and no leaked GPU resources, driven against a stand-in
//      for the upstream builder that behaves exactly as it does today
//      (pushes its update into the global array, hands back no dispose).
//   3. PERCEPTION   — what look() says, and what a live change narrates as.
//
// Every check here fails against the old behavior by construction: none of
// this existed.

import {
  PARTICLE_PRESETS, PARTICLE_MAX_COUNT, normalizeParticles, resolvedCount,
  describeParticles, emitterTransition, transitionLine, emitterSeed,
  mulberry32, withSeededRandom,
} from "../shared/particles.js";
import {
  makeEmitterRegistry, retireEmitter, retireRawSystem, adoptSystem,
} from "../client/lib/emitter_field.js";
import {
  autoHooks, ownHook, pushHostHook, releaseHook, isHostOwned, claimUnowned,
} from "../client/lib/autohooks.js";

let passed = 0, failed = 0;
function check(name: string, ok: unknown, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- 1. declaration --------------------------------------------------------
console.log("\ndeclaration — presets, bounds, legible failure\n");

const fire = normalizeParticles({ preset: "fire", origin: [0, 0.25, 0] }, { entityId: "hearth" });
check("a declared preset normalizes", fire.ok === true);
check("count defaults from the preset", fire.ok && fire.emitter.count === PARTICLE_PRESETS.fire.count);
check("origin is carried verbatim", fire.ok && JSON.stringify(fire.emitter.origin) === "[0,0.25,0]");

const bogus = normalizeParticles({ preset: "plasma" }, { entityId: "hearth" });
check("an unknown preset does not render", bogus.ok === false);
check("...and says WHY, by name, listing what would work",
  !bogus.ok && bogus.why.includes("plasma") && bogus.why.includes("fire"));
check("...and stays legible as an emitter anyway",
  describeParticles({ preset: "plasma" }).startsWith("emitting")
  && describeParticles({ preset: "plasma" }).includes("unknown"));

const huge = normalizeParticles({ preset: "fire", count: 5_000_000 }, { entityId: "hearth" });
check("an absurd count is clamped, not honoured", huge.ok && huge.emitter.count === PARTICLE_MAX_COUNT);
check("...and the clamp is reported", huge.ok && huge.notes.some((n: string) => n.includes("count clamped")));

const far = normalizeParticles({ preset: "fire", origin: [0, 0, 400] }, { entityId: "hearth" });
check("origin stays entity-relative (bounded)", far.ok && far.emitter.origin[2] === 8);
check("...and says so", far.ok && far.notes.some((n: string) => n.includes("entity-relative")));

const junk = normalizeParticles({ preset: "fire", wobble: 3, spin: true }, { entityId: "hearth" });
check("params the evaluator ignores are named, not dropped in silence",
  junk.ok && junk.notes.some((n: string) => n.includes("wobble") && n.includes("spin")));

const badTex = normalizeParticles({ preset: "fire", texture: "../../etc/passwd" }, { entityId: "hearth" });
check("a texture outside the particle library is refused", badTex.ok && badTex.emitter.texture === undefined);
const goodTex = normalizeParticles(
  { preset: "fire", texture: "eidoverse/assets/particle_textures/flame_05.png" }, { entityId: "hearth" });
check("a texture inside it is kept", goodTex.ok && goodTex.emitter.texture!.endsWith("flame_05.png"));

check("a non-object bag fails legibly", normalizeParticles(42 as unknown as object).ok === false);
check("origin nonsense degrades to the entity's own origin",
  (() => { const r = normalizeParticles({ preset: "fire", origin: "here" }, { entityId: "h" });
    return r.ok && JSON.stringify(r.emitter.origin) === "[0,0,0]"; })());

// determinism / persistence / sharedness of the seed
check("an authored seed is the seed",
  emitterSeed("hearth", { preset: "fire", seed: 1234 }) === 1234);
check("an unauthored seed is derived, not rolled",
  emitterSeed("hearth", { preset: "fire" }) === emitterSeed("hearth", { preset: "fire" }));
check("...and is per-entity (two hearths are not the same fire)",
  emitterSeed("hearth", { preset: "fire" }) !== emitterSeed("brazier", { preset: "fire" }));
check("...and survives a re-author of the same bag (replay-stable)",
  normalizeParticles({ preset: "fire" }, { entityId: "hearth" }).emitter.seed
  === normalizeParticles({ preset: "fire" }, { entityId: "hearth" }).emitter.seed);

const drawA: number[] = [], drawB: number[] = [];
withSeededRandom(99, () => { for (let i = 0; i < 8; i++) drawA.push(Math.random()); });
withSeededRandom(99, () => { for (let i = 0; i < 8; i++) drawB.push(Math.random()); });
check("the same seed draws the same spawn attributes on two clients",
  JSON.stringify(drawA) === JSON.stringify(drawB));
check("a different seed does not", (() => {
  const c: number[] = [];
  withSeededRandom(100, () => { for (let i = 0; i < 8; i++) c.push(Math.random()); });
  return JSON.stringify(c) !== JSON.stringify(drawA);
})());
const realRandom = Math.random;
withSeededRandom(1, () => {});
check("Math.random is put back afterwards", Math.random === realRandom);
try { withSeededRandom(1, () => { throw new Error("boom"); }); } catch { /* expected */ }
check("...even when the build throws", Math.random === realRandom);
check("the seeded stream is in range",
  Array.from({ length: 200 }, mulberry32(7)).every((v) => v >= 0 && v < 1));

// quality reduces DRAWN sprites only
const emitter = normalizeParticles({ preset: "fire", count: 200 }, { entityId: "hearth" }).emitter;
check("a low tier draws fewer sprites", resolvedCount(emitter, "low") === 50);
check("...while the declared count is unchanged (a shared fact)", emitter.count === 200);
check("an unknown tier draws everything", resolvedCount(emitter, "ludicrous") === 200);

// The two tiers COMPOSE, and neither may raise the other: the authored
// `quality` is a shared upper bound, the client tier a local budget.
const authoredLow = normalizeParticles({ preset: "fire", count: 200, quality: "low" }, { entityId: "h" }).emitter;
check("authored quality is carried", authoredLow.quality === "low");
check("authored low + client high stays low (an author's cap is not local)",
  resolvedCount(authoredLow, "high") === 50);
check("authored low + client auto stays low", resolvedCount(authoredLow, "auto") === 50);
const authoredHigh = normalizeParticles({ preset: "fire", count: 200, quality: "high" }, { entityId: "h" }).emitter;
check("authored high + client low obeys the LOCAL budget (the governor is not overruled)",
  resolvedCount(authoredHigh, "low") === 50);
check("authored med + client med does not compound", resolvedCount(
  normalizeParticles({ preset: "fire", count: 200, quality: "med" }, { entityId: "h" }).emitter, "med") === 100);
check("authored auto is an opinion-free identity",
  resolvedCount(emitter, "med") === 100 && resolvedCount(emitter, "auto") === 200);

// ---- 2. lifecycle ----------------------------------------------------------
console.log("\nlifecycle — attach, replace, remove, late join, no hook growth\n");

// Stand-in for eidoverse/particles.js AS IT IS TODAY: it makes a thing, pushes
// its update into the global hook array, and offers no way back out. If
// upstream grows a dispose(), this stub is what has to change first.
type Sys = { update: () => void; disposed: number; count: number; inScene: boolean };
function makeUpstreamStub(autos: (() => void)[]) {
  const built: Sys[] = [];
  return {
    built,
    build(emitter: { count: number }) {
      const sys: Sys = { update: () => {}, disposed: 0, count: emitter.count, inScene: true };
      autos.push(sys.update);                     // exactly what makeParticles does
      built.push(sys);
      return {
        update: sys.update,
        dispose() { sys.disposed++; sys.inScene = false; },
        sys,
      };
    },
  };
}

{
  const autos: (() => void)[] = [() => {}];       // the sky already has one
  const up = makeUpstreamStub(autos);
  const reg = makeEmitterRegistry({ autos, build: (e: any) => up.build(e) });
  const base = autos.length;

  const fireE = normalizeParticles({ preset: "fire" }, { entityId: "hearth" }).emitter;
  await reg.apply("hearth", fireE);
  check("attach registers exactly one hook", autos.length === base + 1);
  check("attach builds exactly one system", up.built.length === 1);

  await reg.apply("hearth", fireE);
  check("re-authoring the identical bag rebuilds nothing", up.built.length === 1);
  check("...and does not grow hooks", autos.length === base + 1);

  const smokeE = normalizeParticles({ preset: "smoke" }, { entityId: "hearth" }).emitter;
  await reg.apply("hearth", smokeE);
  check("replace builds the new emitter", up.built.length === 2);
  check("replace RETIRES the old one", up.built[0].disposed === 1);
  check("replace leaves one hook, not two", autos.length === base + 1);
  check("...and only the survivor is in the scene", up.built[0].inScene === false && up.built[1].inScene === true);

  reg.retire("hearth");
  check("remove disposes", up.built[1].disposed === 1);
  check("remove unhooks — the array is back where it started", autos.length === base);
  check("remove is idempotent", reg.retire("hearth") === false && autos.length === base);
  check("the registry is empty", reg.size === 0);

  // late join: the whole log replays, every entry through the same path
  await reg.apply("hearth", fireE);
  check("a late joiner folding the same log gets one emitter", reg.size === 1 && up.built.length === 3);
  check("...with the same seed the live clients have", up.built.length === 3 && fireE.seed === emitterSeed("hearth", { preset: "fire" }));
  check("...and one hook", autos.length === base + 1);

  // ten replaces in a row — the shape of someone tuning a live emitter
  for (let i = 0; i < 10; i++) {
    await reg.apply("hearth", normalizeParticles({ preset: "fire", size: 0.4 + i * 0.01 }, { entityId: "hearth" }).emitter);
  }
  check("ten tuning passes leave ONE hook", autos.length === base + 1);
  check("...and one live system", up.built.filter((s) => s.disposed === 0).length === 1);
  reg.retireAll();
  check("retireAll returns the hook array to the sky's own", autos.length === base);
}

{
  // A build that finishes after its entity was already replaced or removed.
  const autos: (() => void)[] = [];
  const up = makeUpstreamStub(autos);
  let release: (() => void) | null = null;
  const slow = new Promise<void>((r) => { release = r; });
  const reg = makeEmitterRegistry({
    autos,
    build: async (e: any) => { await slow; return up.build(e); },
  });
  const p = reg.apply("hearth", normalizeParticles({ preset: "fire" }, { entityId: "hearth" }).emitter);
  reg.retire("hearth");                            // removed while the texture downloads
  release!();
  await p;
  check("a build that lands after removal retires itself", up.built[0]?.disposed === 1);
  check("...and leaves no hook behind", autos.length === 0);
  check("...and no registry entry", reg.size === 0);
}

{
  // A failing build must not strand a slot or a hook.
  const autos: (() => void)[] = [];
  const reg = makeEmitterRegistry({ autos, build: () => { throw new Error("no scene"); }, onError: () => {} });
  await reg.apply("hearth", normalizeParticles({ preset: "fire" }, { entityId: "hearth" }).emitter);
  check("a failed build leaves nothing behind", reg.size === 0 && autos.length === 0);
}

{
  // Hooks come off by identity — an emitter must never unhook the sky's.
  const skyHook = () => {};
  const autos: (() => void)[] = [skyHook];
  const handle = { update: () => {}, dispose() {} };
  autos.unshift(handle.update);                    // registered BEFORE the sky's
  retireEmitter(handle as any, autos);
  check("retirement removes its own hook by identity", autos.length === 1 && autos[0] === skyHook);
  retireEmitter(handle as any, autos);
  check("retiring twice is a no-op", autos.length === 1 && autos[0] === skyHook);
}

// ---- 2b. a throw AFTER upstream allocation --------------------------------
console.log("\npost-allocation faults — the window between makeParticles() and a handle\n");

{
  // The exact shape of the leak: makeParticles has already added its mesh to
  // the scene and pushed its update; a host step after that throws, so no
  // handle is ever returned and the registry's catch has nothing to retire.
  const autos: (() => void)[] = [];
  const parent = { children: [] as unknown[], remove(o: unknown) { this.children = this.children.filter((c) => c !== o); } };
  let geoDisposed = 0, matDisposed = 0, texDisposed = 0;
  const texture = { dispose() { texDisposed++; } };            // BORROWED, cached, shared
  const makeRaw = () => {
    const update = () => {};
    const mesh: any = {
      parent, geometry: { dispose() { geoDisposed++; } },
      material: { dispose() { matDisposed++; }, map: texture },
      userData: {}, position: { set() {} },
    };
    parent.children.push(mesh);
    autos.push(update);                                        // upstream registers itself
    return { mesh, update };
  };

  for (const [name, failing] of [
    ["parenting", (s: any) => { throw new Error("parent.add failed"); }],
    ["the tier dial", (s: any) => { s.mesh.count = 1; throw new Error("setTier failed"); }],
    ["handle construction", (_s: any) => { throw new Error("handle failed"); }],
  ] as const) {
    const sys = makeRaw();
    const before = { autos: autos.length, kids: parent.children.length };
    let threw = false;
    try { adoptSystem(sys, autos, failing); } catch { threw = true; }
    check(`a throw in ${name} propagates`, threw);
    check(`...unhooks the raw system (${name})`, autos.length === before.autos - 1);
    check(`...detaches its mesh (${name})`, parent.children.length === before.kids - 1);
  }
  check("...and disposes the geometry and material it owns", geoDisposed === 3 && matDisposed === 3);
  check("...but NEVER the borrowed texture", texDisposed === 0);

  // and the happy path is untouched
  const good = makeRaw();
  const handle = adoptSystem(good, autos, (s: any) => ({ update: s.update, dispose() {} }));
  check("a build that succeeds keeps its hook and its mesh",
    autos.length === 1 && parent.children.length === 1 && handle.update === good.update);
  retireRawSystem(good, autos);
  check("retireRawSystem is idempotent", (retireRawSystem(good, autos), autos.length === 0));
}

// ---- 2c. hook OWNERSHIP across an async build ------------------------------
console.log("\nhook ownership — a subsystem that claims by diff must not adopt someone else's\n");

{
  // The interleaving Mica named: the sky snapshots, THEN an emitter registers
  // while the build is still awaiting, THEN the sky's own hook lands. An
  // identity diff alone calls both of them the sky's.
  const autos = autoHooks();
  autos.length = 0;
  const skyHookOld = () => {};
  autos.push(skyHookOld);                                   // a previous sky's hook

  const before = new Set(autos);                            // snapshotSceneOwnership()
  const emitterHook = pushHostHook(() => {});               // …registers DURING the build
  const skyHook = () => {}; autos.push(skyHook);            // …and the build finishes

  const claimed = claimUnowned(before, autos);
  check("the sky claims its own new hook", claimed.includes(skyHook));
  check("...and NOT the emitter's, which arrived during the build", !claimed.includes(emitterHook));
  check("...and not the one it already had", !claimed.includes(skyHookOld));

  for (const h of claimed) releaseHook(h, autos);            // teardownSky()
  check("teardown removes only the sky's hook",
    autos.length === 2 && autos.includes(skyHookOld) && autos.includes(emitterHook));
  check("the emitter is still registered and still ticking", autos.includes(emitterHook));
  check("...and still marked as its own", isHostOwned(emitterHook));

  releaseHook(emitterHook, autos);
  check("releasing drops the mark too", !isHostOwned(emitterHook) && !autos.includes(emitterHook));
  check("releasing twice is a no-op", releaseHook(emitterHook, autos) === false);

  // ownHook marks a hook upstream registered on our behalf (makeParticles)
  const upstreamRegistered = () => {}; autos.push(upstreamRegistered);
  ownHook(upstreamRegistered);
  check("a hook upstream pushed for us can still be claimed as ours",
    !claimUnowned(new Set([skyHookOld]), autos).includes(upstreamRegistered));
  autos.length = 0;
}

// ---- 3. perception ---------------------------------------------------------
console.log("\nperception — what look() names, and what a change narrates as\n");

const desc = describeParticles({ preset: "fire", origin: [0, 0.25, 0] });
check("look() names the semantic emitter", desc.startsWith("emitting fire"));
check("...says where on the entity it is, in local coordinates", desc.includes("local origin [0, 0.25, 0]"));
check("...says it is active", desc.includes("active"));
check("...does NOT enumerate sprites", !/\d{2,}\s*(sprites|particles\b\s*\d)/.test(desc) && !desc.includes("count"));
check("...and claims no heat, light, sound or contact",
  !/(warm|heat|hot|light|glow|sound|crackl|touch)/i.test(desc));
check("a bare `components: particles` is not what anyone sees", !desc.includes("components:"));

check("begin/change/end are distinguished",
  emitterTransition(null, { preset: "fire" })!.kind === "begin"
  && emitterTransition({ preset: "fire" }, { preset: "smoke" })!.kind === "change"
  && emitterTransition({ preset: "fire" }, null)!.kind === "end");
check("an identical re-author is not a change", emitterTransition({ preset: "fire" }, { preset: "fire" }) === null);
check("nothing to nothing is nothing", emitterTransition(null, null) === null);

const beginLine = transitionLine("antra", "hearth", emitterTransition(null, { preset: "fire" }));
check("the live line carries actor, entity and preset",
  beginLine!.includes("antra") && beginLine!.includes("[hearth]") && beginLine!.includes("fire"));
const changeLine = transitionLine("antra", "hearth", emitterTransition({ preset: "fire" }, { preset: "smoke" }));
check("a preset swap narrates as a change with both states",
  changeLine!.includes("fire") && changeLine!.includes("smoke"));
const tuneLine = transitionLine("antra", "hearth",
  emitterTransition({ preset: "fire", size: 0.5 }, { preset: "fire", size: 0.6 }));
check("a same-preset retune narrates as a retune", tuneLine!.includes("retunes"));
const endLine = transitionLine("antra", "hearth", emitterTransition({ preset: "fire" }, null));
check("an end narrates as an end", endLine!.includes("puts out"));
check("no line for a non-change", transitionLine("antra", "hearth", null) === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
