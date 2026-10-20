// bun mcpl/door-unit-test.ts — door tools' own logic against a stand-in body (no world): anim's held frame, a ragdoll
// asked of someone else, move's fallback after a stopped walk
import { handleTool, frameOf } from "./tools.ts";
let fails = 0;
const ok = (c: boolean, what: string, got?: unknown) => { if (!c) { fails++; console.log(`  FAIL ${what}`, got ?? ""); } else console.log(`  ok   ${what}`); };
const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

// a hold between two keys shows the frame the client plays there, slerped, not the earlier key
const s = Math.SQRT1_2, tracks = { hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, s, 0, s] }] };   // 0° → 90° about y
const q45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
ok(near(frameOf(tracks, 0.5).hips, q45), "at 0.5 s, halfway between 0° and 90° holds 45°", frameOf(tracks, 0.5).hips);
ok(near(frameOf(tracks, 0).hips, [0, 0, 0, 1]) && near(frameOf(tracks, 1).hips, [0, s, 0, s]), "on a key, that key");
ok(near(frameOf(tracks, 7).hips, [0, s, 0, s]) && near(frameOf(tracks, null).hips, [0, s, 0, s]), "past the last key, or with no at, the last key");
ok(near(frameOf({ hips: [{ t: 1, q: [0, s, 0, s] }, { t: 2, q: [0, 0, 0, 1] }] }, 0.2).hips, [0, s, 0, s]), "before the first key, the first key");
ok(near(frameOf({ hips: [{ t: 1, q: [0, s, 0, s] }, { t: 0, q: [0, 0, 0, 1] }] }, 0.5).hips, q45), "keys out of order are sorted first");
// the shorter way round, as the client's slerp takes it: q and -q are one rotation
ok(near(frameOf({ hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, -s, 0, -s] }] }, 0.5).hips, q45), "q and -q slerp the short way");

// a ragdoll asked of someone else leaves your own anims playing, whether they say yes or no
for (const refused of [true, false]) {
  const ended: string[] = []; let asked: unknown = null;
  const ag: any = { name: "me", lastRefusal: null as any, animEnded: (why: string) => ended.push(why), knockDown: () => ended.push("(fell)"),
    puppet: (to: string, p: unknown) => { asked = { to, p }; if (refused) ag.lastRefusal = { ts: Date.now(), text: "they said no" }; } };
  const out: any = await handleTool({ agent: ag } as any, "anim", { ragdoll: true, target: "u-other" });
  ok(JSON.stringify(asked) === JSON.stringify({ to: "u-other", p: { ragdoll: true } }) && ended.length === 0 && !!out.isError === refused,
    `anim {ragdoll, target} ${refused ? "refused" : "passed on"}: your own anims go on`, { ended, out });
}
{ const ended: string[] = [];
  const ag: any = { name: "me", animEnded: (why: string) => ended.push(why), knockDown: () => ended.push("(fell)") };
  await handleTool({ agent: ag } as any, "anim", { ragdoll: true });
  ok(ended[0] === "knocked over", "anim {ragdoll} on yourself ends your anims: you fell", ended); }

// a walk stopped while it waited for geometry ends move's tries; the fallback beside what holds the
// thing up would start the walk that was just stopped. A route refused still tries it (the control)
for (const why of ["superseded by a newer walk or a stop", "no route: the way there is sealed"]) {
  const walks: number[][] = [];
  const ag: any = { pos: { x: 0, z: 0 }, myOccupancy: null,
    destination: () => ({ x: 1, z: 1, y: 1, label: "cup", orBeside: { x: 2, z: 2, y: 0, label: "cup" } }),
    walkTo: async (x: number, z: number, _r: boolean, _t: number, _tol: number, _y: unknown, _n: unknown, receipt: any) => { walks.push([x, z]); receipt.refusal = why; return false; } };
  const out: any = await handleTool({ agent: ag } as any, "move", { to: "cup" });
  const stopped = why.startsWith("superseded");
  ok(walks.length === (stopped ? 1 : 2) && out.isError && out.content[0].text.includes(why),
    stopped ? "a stopped walk isn't tried again beside what holds it up, and says it was stopped" : "a refused route is tried again beside what holds it up", { walks, text: out.content[0].text });
}

console.log(`door-unit-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
