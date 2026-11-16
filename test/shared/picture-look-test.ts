// What look() carries for a resident who reads a `picture` (the agent's own path, agent-senses saysOf), without a browser.
// The declaration rules are batch2-check P1-P3's; this is main's tools/picture-test.ts perception leg (deleted in 4e3b6e3e6).
//
//   bun test/shared/picture-look-test.ts
import { noWorldUrl } from "../harness/no-world.ts";
const { WorldAgent } = await import("../../mcpl/agent.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

const GOOD = "eidoverse/assets/pictures/hearth_at_dusk.png";
// the agent's path: a scratch door, its cut adopted, and the next view taken after every write (test/harness/agent-scratch.ts)
const { agentOnDoor } = await import("../harness/agent-scratch.ts");
const ag = new WorldAgent({ url: noWorldUrl(), name: "reader" });
const { seed, act } = agentOnDoor(ag, "picture");
await seed({ console: { model: "store/8efae885a443a323.glb", pos: [1, 0, 1] } });
const r1 = await act("set", { id: "console", component: "picture", value: { src: GOOD, description: "a print of the hearth at dusk" } }, { who: "antra" });
let out = ag.look();
const line = () => out.split("\n").find((l) => l.includes("console")) ?? out;
check("the door takes a well-formed picture", r1.ok, JSON.stringify(r1.refused));
check("look() names the picture on the owning entity, by the author's line", /\[console\][^\n]*a picture: «a print of the hearth at dusk»/.test(out), line());
check("…and does not fall through to `components: picture`", !/components: picture/.test(out), line());
await act("set", { id: "console", component: "picture", value: { src: GOOD, description: "the same print, re-hung" } }, { who: "antra" });
out = ag.look();
check("a replace reads as the new line, not both", /re-hung/.test(out) && !/hearth at dusk/.test(out), line());
const bad = await act("set", { id: "console", component: "picture", value: { src: "http://example.com/x.png", description: "smuggled" } }, { who: "antra" });
out = ag.look();
check("an invalid source is refused at the door and nothing changes", !bad.ok && bad.refused?.code === "shape" && !/smuggled/.test(out), JSON.stringify([bad.refused, line()]));
await act("delete", { id: "console", component: "picture" }, { who: "antra" });
out = ag.look();
check("a removed picture is gone from look()", !/a picture/.test(out), line());
const other = await act("set", { id: "console", component: "example.org/recipe", value: { x: 1 } }, { who: "antra" });   // a bare name is the registry's now
out = ag.look();
check("other component types still read as they did", /components: example\.org\/recipe/.test(out), JSON.stringify([other.refused, line()]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
