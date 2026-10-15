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
for (const old of Object.keys(TOOL_ALIASES)) ok(typeof TOOL_ALIAS_ARGS[old] === "function", `${old} has an argument translation`);
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, z: 2, run: true, tolerance: 0.2 })) === JSON.stringify({ to: [1, 2], run: true, tolerance: 0.2 }), "walk_to {x, z, run, tolerance} → move {to: [x, z], run, tolerance}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.walk_to({ x: 1, z: 2 })) === JSON.stringify({ to: [1, 2] }), "walk_to {x, z} alone → move {to}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.spawn({ lib: "a.glb", x: 1, z: 2 })) === JSON.stringify({ model: "a.glb", at: [1, 2] }), "spawn {lib, x, z} → create {model, at: [x, z]}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.spawn({ lib: "a.glb", x: 1, y: 3, z: 2, yaw: 1.5, id: "k" })) === JSON.stringify({ model: "a.glb", id: "k", at: { pos: [1, 3, 2], yaw: 1.5 } }), "spawn with y, yaw and id → create {model, id, at: {pos, yaw}}");
ok(JSON.stringify(TOOL_ALIAS_ARGS.spawn({ lib: "a.glb" })) === JSON.stringify({ model: "a.glb" }), "spawn {lib} alone → create {model} (2 m in front, as before)");
ok(/library \{query/.test((TOOL_ALIAS_ARGS.spawn({ query: "lamp" }) as any).refuse), "spawn {query} refuses and teaches library {query} then create");
ok(TOOL_ALIAS_ARGS.snapshot({ view: "third" }).view === "third" && TOOL_ALIAS_ARGS.world_verb({ verb: "say", args: { text: "hi" } }).verb === "say", "snapshot and world_verb keep their shapes");
console.log(`alias-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
