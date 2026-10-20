// mcpl/alias-test.ts — old tool names resolve to the new ones with a note; an unknown name gets a did-you-mean (STRIKES A-S1-2)
// run: bun mcpl/alias-test.ts
import { resolveTool, nearestTool, TOOL_ALIASES } from "./tools.ts";
let fails = 0; const ok = (c: boolean, what: string, d?: unknown) => { if (c) console.log("  ok", what); else { fails++; console.log("  FAIL", what, d === undefined ? "" : JSON.stringify(d)); } };
ok(resolveTool("move")?.name === "move" && !resolveTool("move")?.note, "a current name resolves to itself, no note");
for (const [old, now] of Object.entries(TOOL_ALIASES)) ok(resolveTool(old)?.name === now && /is now called/.test(resolveTool(old)?.note ?? ""), `${old} → ${now}, with a note`);
ok(resolveTool("teleport") === null, "a name that never existed resolves to nothing");
ok(nearestTool("screenshoot")?.[0] === "screenshot", "the nearest declared tool for a typo", nearestTool("screenshoot"));
// the old ARGUMENT shapes translate too (an alias that ran the right tool with the wrong words was a shape error, 10-15)
import { TOOL_ALIAS_ARGS } from "./tools.ts";
// every alias translates its old shape (emote's {name} too: its gestures played once)
for (const old of Object.keys(TOOL_ALIASES)) ok(typeof TOOL_ALIAS_ARGS[old] === "function", `${old} has an argument translation`);
ok(JSON.stringify(TOOL_ALIAS_ARGS.emote({ name: "dance" })) === JSON.stringify({ name: "dance", mode: "once" }), "emote {name: dance} → anim {name: dance, mode: once}: a gesture, not a loop");
ok(JSON.stringify(TOOL_ALIAS_ARGS.emote({ name: "dance", mode: "loop" })) === JSON.stringify({ name: "dance", mode: "loop" }), "emote with a mode keeps it");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, y: null, z: 2 })) === JSON.stringify({ to: [1, 2] }), "walk_to {x, y: null, z} → move {to: [x, z]}: a null y is no y, not the floor at 0");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, z: 2, run: true, tolerance: 0.2 })) === JSON.stringify({ to: [1, 2], run: true, tolerance: 0.2 }), "walk_to {x, z, run, tolerance} → move {to: [x, z], run, tolerance}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, z: 2 })) === JSON.stringify({ to: [1, 2] }), "walk_to {x, z} alone → move {to}");
// the stack's walk_to (#236 y, #239 to: a name) reaches move with its words intact (the protocol merge, 10-15)
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ to: "lookout/balcony", run: true })) === JSON.stringify({ to: "lookout/balcony", run: true }), "walk_to {to: \"thing/place\"} → move {to: \"thing/place\"} (a name passes through untouched)");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ to: "?" })) === JSON.stringify({ to: "?" }), "walk_to {to: \"?\"} → move {to: \"?\"} (the list of places)");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, y: 3.3, z: 2, tolerance: 0.1 })) === JSON.stringify({ to: [1, 3.3, 2], tolerance: 0.1 }), "walk_to {x, y, z} → move {to: [x, y, z]} (y picks the floor)");
ok(JSON.stringify(TOOL_ALIAS_ARGS.check_model({ id: "tower" })) === JSON.stringify({ id: "tower", check: true }), "check_model {id} → measure {id, check: true}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.spawn({ lib: "a.glb", x: 1, z: 2 })) === JSON.stringify({ model: "a.glb", at: [1, 2] }), "spawn {lib, x, z} → create {model, at: [x, z]}");
{ const t: any = TOOL_ALIAS_ARGS.spawn({ lib: "a.glb", x: 1, y: 3, z: 2, yaw: 1.5, id: "k" });   // writers never choose ids (R 10-17): the old id is the thing's label
  ok(JSON.stringify(t) === JSON.stringify({ model: "a.glb", components: { label: "k" }, at: { pos: [1, 3, 2], yaw: 1.5 } }) && !("id" in t),
    "spawn with y, yaw and id → create {model, components: {label: id}, at: {pos, yaw}}, no id sent (the authority mints it)", t); }
{ const t: any = TOOL_ALIAS_ARGS.spawn({ lib: "a.glb", x: 1, z: 2, yaw: 1.5 }); const f = t.place?.facing ?? [];
  ok(t.model === "a.glb" && t.at === undefined && JSON.stringify(t.place?.at) === "[1,2]" && Math.abs(Math.atan2(f[0] - 1, f[1] - 2) - 1.5) < 1e-9,
    "spawn {lib, x, z, yaw} → create {model, place: {at: [x, z], facing along yaw}} (seated on what's under it, as without yaw; review r2 F8)", t); }
ok(JSON.stringify(TOOL_ALIAS_ARGS.spawn({ lib: "a.glb" })) === JSON.stringify({ model: "a.glb" }), "spawn {lib} alone → create {model} (2 m in front, as before)");
{ const t = (TOOL_ALIAS_ARGS.spawn({ query: "lamp" }) as any).refuse;
  ok(/library \{query/.test(t) && /then create \{model\}/.test(t), "spawn {query} refuses and teaches library {query} then create", t); }
ok(TOOL_ALIAS_ARGS.snapshot({ view: "third" }).view === "third" && TOOL_ALIAS_ARGS.world_verb({ verb: "say", args: { text: "hi" } }).verb === "say", "snapshot and world_verb keep their shapes");
// through the dispatcher: each alias runs its new tool with the translated words, and says so
import { handleTool, HANDLERS, TOOL_FOLDS, TOOL_REMOVED } from "./tools.ts";
const ctx: any = { agent: {} };
for (const [old, now] of Object.entries(TOOL_ALIASES)) {
  const real = HANDLERS[now]; let got: any = null;
  HANDLERS[now] = (async (_ag: any, a: any) => { got = a; return { content: [{ type: "text", text: "ran" }] }; }) as any;
  const args = old === "walk_to" ? { x: 1, z: 2 } : old === "spawn" ? { lib: "a.glb" } : old === "posture" ? { kind: "sit" } : { name: "wave" };
  const out: any = await handleTool(ctx, old, args);
  HANDLERS[now] = real;
  ok(!out.isError && got !== null && JSON.stringify(got) === JSON.stringify(TOOL_ALIAS_ARGS[old](args)) && out.content[0].text === `(${old} is now called ${now}; this ran ${now})\nran`,
    `${old} reaches ${now} through the dispatcher with its translated words`, { got, out }); }
// a refused translation ran nothing, and its note says so
{ const real = HANDLERS.create; let ran = false; HANDLERS.create = (async () => { ran = true; return { content: [] }; }) as any;
  const out: any = await handleTool(ctx, "spawn", { query: "lamp" }); HANDLERS.create = real;
  ok(out.isError && !ran && /nothing ran/.test(out.content[0].text) && !/this ran/.test(out.content[0].text), "a refused alias says nothing ran, and runs nothing", out); }
// every tool main served is served, aliased, folded or named as removed (world_access and whisper had fallen through)
// (main's v1 verb tool is an alias, so the alias loop above already drives it)
const MAIN_TOOLS = "body_state look snapshot walk_to name_place check_model take_off climb_to glide_to land_at rehearse_down rehearse_recover fold_wings unfold_wings flight_status face stop say catch_up activity whisper pose clear_pose emote reach clear_reach posture ragdoll animate set_avatar library_sheet library_preview list_library spawn place light remove worlds travel measure world_history world_debug kick ban unban list_bans world_access".split(" ");
const lost = MAIN_TOOLS.filter((n) => !HANDLERS[n] && !TOOL_ALIASES[n] && !TOOL_FOLDS[n] && !TOOL_REMOVED[n]);
ok(lost.length === 0, "every tool main served is served, aliased, folded or named as removed", lost);
for (const [n, says] of [["world_access", /^world_access folded into a general tool: .*@world.* — nothing ran$/], ["whisper", /^whisper was removed: world chat has no private channel .* — nothing ran$/]] as const) {
  const out: any = await handleTool(ctx, n, {}); ok(out.isError && says.test(out.content[0].text) && !/did you mean/.test(out.content[0].text), `${n} says where it went, not a did-you-mean`, out); }
console.log(`alias-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
