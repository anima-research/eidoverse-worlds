// mcpl/alias-test.ts — old tool names run nothing; each is refused naming the tool that does it now, until its date (R 10-28:
// "drop and educate the new aliases for one release, and then drop the education"); an unknown name gets a did-you-mean
// run: bun mcpl/alias-test.ts
import { resolveTool, nearestTool, handleTool, HANDLERS, TOOL_RENAMED, TOOL_RENAMED_UNTIL, TOOL_FOLDS, TOOL_REMOVED } from "./tools.ts";
let fails = 0; const ok = (c: boolean, what: string, d?: unknown) => { if (c) console.log("  ok", what); else { fails++; console.log("  FAIL", what, d === undefined ? "" : JSON.stringify(d)); } };
ok(resolveTool("move")?.name === "move", "a current name resolves to itself");
ok(resolveTool("teleport") === null, "a name that never existed resolves to nothing");
ok(nearestTool("screenshoot")?.[0] === "screenshot", "the nearest declared tool for a typo", nearestTool("screenshoot"));
// the table holds names and a date, nothing else: the education can't grow into code again (no argument translators)
const DATE = /^\d{4}-\d{2}-\d{2}$/;
for (const [old, e] of Object.entries(TOOL_RENAMED))
  ok(JSON.stringify(Object.keys(e).sort()) === '["to","until"]' && typeof e.to === "string" && !!HANDLERS[e.to] && DATE.test(e.until) && !HANDLERS[old] && resolveTool(old) === null,
    `${old}: only {to: ${e.to}, until}, the new tool exists, the old name resolves to nothing`, e);
// …and is dropped by its date: past it, this row goes red until the entries are deleted
const today = new Date().toISOString().slice(0, 10);
ok(Object.values(TOOL_RENAMED).every((e) => e.until >= today) && DATE.test(TOOL_RENAMED_UNTIL), `no old name is taught past its date (${TOOL_RENAMED_UNTIL}): then delete TOOL_RENAMED's entries`, today);
// through the dispatcher: an old name runs nothing and names the new tool
const ctx: any = { agent: {} };
for (const [old, { to }] of Object.entries(TOOL_RENAMED)) {
  const real = HANDLERS[to]; let ran = false;
  HANDLERS[to] = (async () => { ran = true; return { content: [{ type: "text", text: "ran" }] }; }) as any;
  const out: any = await handleTool(ctx, old, { x: 1, z: 2, name: "wave" }); HANDLERS[to] = real; const t = out.content?.[0]?.text ?? "";
  ok(out.isError && !ran && new RegExp(`${old} is now called ${to}: call ${to}`).test(t) && /nothing ran/.test(t) && !/did you mean/.test(t), `${old} runs nothing and teaches ${to}`, t); }
// world_verb is removed (R 10-27): it named main's closed verb set
{ let ran = false; const real = HANDLERS.act; HANDLERS.act = (async () => { ran = true; return { content: [] }; }) as any;
  const out: any = await handleTool(ctx, "world_verb", { verb: "comp", args: { id: "x", type: "sockets", data: {} } }); HANDLERS.act = real; const t = out.content?.[0]?.text ?? "";
  ok(!TOOL_RENAMED.world_verb && out.isError && !ran && /world_verb was removed/.test(t) && /act \{verb, args\}/.test(t) && !/did you mean/.test(t), "world_verb is refused as removed, naming act, and runs nothing", t); }
// every tool main served is served, taught, folded or refused as removed (none falls through to "no such tool")
const MAIN_TOOLS = "body_state look snapshot walk_to name_place check_model take_off climb_to glide_to land_at rehearse_down rehearse_recover fold_wings unfold_wings flight_status face stop say catch_up activity pose clear_pose reach clear_reach posture ragdoll animate set_avatar library_sheet library_preview list_library spawn place light remove worlds travel measure world_history world_debug kick ban unban list_bans".split(" ");
const lost = [...MAIN_TOOLS, "world_verb"].filter((n) => !HANDLERS[n] && !TOOL_RENAMED[n] && !TOOL_FOLDS[n] && !TOOL_REMOVED[n]);
ok(lost.length === 0, "every tool main served is served, taught, folded or refused as removed", lost);
// the docs teach today's names (review full-260 #8, #9): AGENTS.md's "refused as removed" verbs are REMOVED_VERBS; no doc here calls an old tool name
{ const { REMOVED_VERBS } = await import("../shared/protocol/verbspec.js"); const fs = await import("node:fs");
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const said = /\(((?:`[a-z_-]+`, )+)[^)]*\) is refused as `removed`/.exec(read("AGENTS.md"))?.[1].match(/`([a-z_-]+)`/g)?.map((x) => x.slice(1, -1)) ?? [];
  ok(said.length > 0 && said.every((v) => v in REMOVED_VERBS), "AGENTS.md lists only removed verbs as refused (REMOVED_VERBS)", said.filter((v) => !(v in REMOVED_VERBS)));
  const calls = Object.keys(TOOL_RENAMED).filter((old) => new RegExp("`" + old + " \\{").test(read("docs/REMOTE-SCREENSHOTS.md")));
  ok(calls.length === 0, "docs/REMOTE-SCREENSHOTS.md calls no renamed tool (screenshot, not snapshot)", calls); }
console.log(`alias-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
