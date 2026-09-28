// bun tools/inspect-handler-test.ts — the "inspect" message (server/messages.ts) answers one
// entity's authored component bag to anyone in the world, refuses nothing else, paces
// per connection, and replaces oversized bags with their type list.
process.env.WORLDS_DIR ??= require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/inspect-handler-");
process.env.JOIN_TOKEN ??= "test-door";
const { MESSAGES } = await import("../server/messages.ts");
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const sent: any[] = [];
const entities: any = {
  crate: { lib: "a/crate.glb", comp: { reactions: { use: { say: "hi" } }, lock: true } },
  plain: { lib: "a/plain.glb" },
  huge: { lib: "a/huge.glb", comp: { blob: { s: "x".repeat(70000) } } },
};
const c: any = { id: "c1", spectator: true, world: { name: "w", state: { entities } } };
let now = 1000;
const ask = (m: any) => { MESSAGES["inspect"]({ c, ws: { send: (d: string) => sent.push(JSON.parse(d)) }, now, expel: () => {} } as any, m); now += 100; };
ask({ type: "inspect", id: "crate", reqId: 7 });
ok(sent[0]?.type === "inspect" && sent[0].id === "crate" && sent[0].reqId === 7, "reply echoes id and reqId");
ok(sent[0].comp?.lock === true && sent[0].comp?.reactions?.use?.say === "hi" && sent[0].lib === "a/crate.glb", "spectator reads the full bag");
ask({ type: "inspect", id: "plain" });
ok(JSON.stringify(sent[1].comp) === "{}", "no comps: empty bag");
ask({ type: "inspect", id: "nope" });
ok(sent[2].error === "not_found", "unknown id: not_found");
ask({ type: "inspect", id: "huge" });
ok(sent[3].error === "too_large" && sent[3].types?.[0] === "blob" && !sent[3].comp, "oversized bag: types only");
now -= 90; ask({ type: "inspect", id: "crate" });
ok(sent.length === 4, "paced: a second ask within 50 ms is dropped");
ask({ type: "inspect", id: 5 }); ask({ type: "inspect", id: "y".repeat(200) });
ok(sent.length === 4, "malformed ids answer nothing");
c.world = null; ask({ type: "inspect", id: "crate" });
ok(sent.length === 4, "outside a world: nothing");
console.log("inspect-handler: 8 ok");
import("node:fs").then((fs) => { try { fs.rmSync(process.env.WORLDS_DIR!, { recursive: true, force: true }); } catch {} });
