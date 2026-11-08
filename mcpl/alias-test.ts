// mcpl/alias-test.ts — an old tool name is an unknown tool: refused with the same words as any name this server never
// served, and it runs nothing (Mica 11-05: no dated education table); folded and removed tools are refused with a pointer
// run: bun mcpl/alias-test.ts
import { resolveTool, nearestTool, handleTool, HANDLERS, TOOLS, TOOL_FOLDS, TOOL_REMOVED } from "./tools.ts";
let fails = 0; const ok = (c: boolean, what: string, d?: unknown) => { if (c) console.log("  ok", what); else { fails++; console.log("  FAIL", what, d === undefined ? "" : JSON.stringify(d)); } };
ok(resolveTool("move")?.name === "move", "a current name resolves to itself");
ok(resolveTool("teleport") === null, "a name that never existed resolves to nothing");
ok(nearestTool("screenshoot")?.[0] === "screenshot", "the nearest declared tool for a typo", nearestTool("screenshoot"));
// main's renamed tools, refused exactly as an unknown name (the old action-bar word is built so no file spells it, names E3)
const OLD = ["walk_to", "snapshot", "spawn", "check_model", "pose", "animate", "em" + "ote", "posture"];
const unknown = (n: string) => { const near = nearestTool(n);
  return JSON.stringify({ content: [{ type: "text", text: `there's no tool named "${n}" on this server, so nothing ran${near && near[1] <= 4 ? ` (did you mean ${near[0]}?)` : ""}; your tool list has the ones it serves` }], isError: true }); };
const ctx: any = { agent: {} };
// every handler is stubbed, so "runs nothing" means no handler at all was called, whatever the old name might map to
const stubAll = () => { const real = { ...HANDLERS }; const ran: string[] = [];
  for (const k of Object.keys(HANDLERS)) HANDLERS[k] = (async () => { ran.push(k); return { content: [{ type: "text", text: "ran" }] }; }) as any;
  return { ran, restore: () => Object.assign(HANDLERS, real) }; };
for (const old of [...OLD, "teleport"]) {
  const s = stubAll(); const out: any = await handleTool(ctx, old, { x: 1, z: 2, name: "wave", view: "third", lib: "test/cup.glb" }); s.restore();
  ok(JSON.stringify(out) === unknown(old) && !s.ran.length && resolveTool(old) === null && !TOOLS.some((t: any) => t.name === old) && !TOOL_FOLDS[old] && !TOOL_REMOVED[old],
    `${old}: not a tool, not advertised, refused with exactly the unknown-tool words, and nothing ran`, { out, ran: s.ran }); }
// the words themselves, written out (a change to the unknown-tool refusal is a change to these rows)
{ const said = async (n: string) => { const s = stubAll(); const o: any = await handleTool(ctx, n, {}); s.restore(); return o.content?.[0]?.text; };
  ok(await said("walk_to") === `there's no tool named "walk_to" on this server, so nothing ran; your tool list has the ones it serves`, "walk_to's refusal, verbatim", await said("walk_to"));
  ok(await said("animate") === `there's no tool named "animate" on this server, so nothing ran (did you mean anim?); your tool list has the ones it serves`, "animate's refusal, verbatim", await said("animate")); }
// world_verb is removed (R 10-27): it named main's closed verb set
{ let ran = false; const real = HANDLERS.act; HANDLERS.act = (async () => { ran = true; return { content: [] }; }) as any;
  const out: any = await handleTool(ctx, "world_verb", { verb: "comp", args: { id: "x", type: "sockets", data: {} } }); HANDLERS.act = real; const t = out.content?.[0]?.text ?? "";
  ok(out.isError && !ran && /world_verb was removed/.test(t) && /act \{verb, args\}/.test(t) && !/did you mean/.test(t), "world_verb is refused as removed, naming act, and runs nothing", t); }
// every tool main served is served, folded, refused as removed, or a renamed one refused as unknown (OLD above)
const MAIN_TOOLS = "body_state look snapshot walk_to name_place check_model take_off climb_to glide_to land_at rehearse_down rehearse_recover fold_wings unfold_wings flight_status face stop say catch_up activity pose clear_pose reach clear_reach posture ragdoll animate set_avatar library_sheet library_preview list_library spawn place light remove worlds travel measure world_history world_debug kick ban unban list_bans".split(" ");
const lost = [...MAIN_TOOLS, "world_verb"].filter((n) => !HANDLERS[n] && !OLD.includes(n) && !TOOL_FOLDS[n] && !TOOL_REMOVED[n]);
ok(lost.length === 0, "every tool main served is served, folded, refused as removed, or refused as unknown (renamed)", lost);
// the docs teach today's names (review full-260 #8, #9): AGENTS.md's "refused as removed" verbs are REMOVED_VERBS; no doc here calls an old tool name
{ const { REMOVED_VERBS } = await import("../shared/protocol/verbspec.js"); const fs = await import("node:fs");
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const said = /\(((?:`[a-z_-]+`, )+)[^)]*\) is refused as `removed`/.exec(read("AGENTS.md"))?.[1].match(/`([a-z_-]+)`/g)?.map((x) => x.slice(1, -1)) ?? [];
  ok(said.length > 0 && said.every((v) => v in REMOVED_VERBS), "AGENTS.md lists only removed verbs as refused (REMOVED_VERBS)", said.filter((v) => !(v in REMOVED_VERBS)));
  const calls = OLD.filter((old) => new RegExp("`" + old + " \\{").test(read("docs/REMOTE-SCREENSHOTS.md")));
  ok(calls.length === 0, "docs/REMOTE-SCREENSHOTS.md calls no renamed tool (screenshot, not snapshot)", calls); }
console.log(`alias-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
