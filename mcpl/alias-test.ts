// mcpl/alias-test.ts — old tool names resolve to the new ones with a note; an unknown name gets a did-you-mean (STRIKES A-S1-2)
// run: bun mcpl/alias-test.ts
import { resolveTool, nearestTool, TOOL_ALIASES } from "./tools.ts";
let fails = 0; const ok = (c: boolean, what: string, d?: unknown) => { if (c) console.log("  ok", what); else { fails++; console.log("  FAIL", what, d === undefined ? "" : JSON.stringify(d)); } };
ok(resolveTool("move")?.name === "move" && !resolveTool("move")?.note, "a current name resolves to itself, no note");
for (const [old, now] of Object.entries(TOOL_ALIASES)) ok(resolveTool(old)?.name === now && /is now called/.test(resolveTool(old)?.note ?? ""), `${old} → ${now}, with a note`);
ok(resolveTool("teleport") === null, "a name that never existed resolves to nothing");
ok(nearestTool("screenshoot")?.[0] === "screenshot", "the nearest declared tool for a typo", nearestTool("screenshoot"));
console.log(`alias-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
