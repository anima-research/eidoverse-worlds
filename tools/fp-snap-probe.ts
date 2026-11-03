// fp-snap-probe — the #75 behavioral receipt, end to end and A/B-able.
//
//   bun tools/fp-snap-probe.ts                # owns a scratch server (probe-harness ownedWorld) and a headless renderer
//   RECEIPTS=/tmp/fp75 bun tools/fp-snap-probe.ts
//
// Run it on this branch and on a throwaway main worktree: the MOUNTED
// first-person cases fail on main (the fixed root+1.52 snap camera sits
// inside the big-head rig's own mesh and nothing hides it), and pass here.
// That pixel difference — a marker the eye can or cannot see — is the
// fail-on-main evidence for #75; tools/fp-view-test.ts pins the unit
// contract but is link-novelty on main.
//
// What it does:
//   1. builds the head-volume test rig (claude.vrm with its head bone ×5 —
//      tools/make-bighead-vrm.ts) into assets/opt, and spawns a scratch
//      server with the probe's world founded, owned by "puppet";
//   2. joins two WorldAgent bodies: "puppet" wearing the big-head rig
//      (nonhumanoid head-volume case) and "ctl" wearing stock claude.vrm
//      (humanoid control);
//   3. authors a tower crate with a ground socket and a raised socket (as high
//      as a seat may be reached from the ground, 1.6 m), magenta light markers
//      on each seat's eye line, and a red crate on the ground line — every
//      first-person case has something it MUST see;
//   4. opens a headless renderer session (probe-harness launchBrowser);
//   5. walks the acceptance grid — on foot / ground socket / raised
//      socket × first (marker REQUIRED), third + selfie (body in frame,
//      frame must differ from first), detach (first restored), and an
//      oscillate pass where the camera must ride the moving socket;
//   6. saves every frame to RECEIPTS and exits non-zero on any violation.
//
// Wire facts it leans on: the world is founded before anyone joins; a body joins with replica: true; building is
// requests (create/set/delete, placeholders for ids); sitting is the attach tool (a `use` of the socket, then presence);
// /snap?world&follow&view needs a renderer in-world and the door's key as a Bearer header.

import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ownedWorld, launchBrowser } from "./probe-harness.mjs";
import { WorldAgent } from "../mcpl/agent.ts";
import { HANDLERS } from "../mcpl/tools.ts";

const WORLD = process.env.WORLD ?? `fp75-${Math.random().toString(36).slice(2, 7)}`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
const RECEIPTS = process.env.RECEIPTS ?? `/tmp/fp75-receipts-${WORLD}`;
mkdirSync(RECEIPTS, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const verdicts: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  const line = `${cond ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  verdicts.push(line); console.log(line);
  cond ? pass++ : fail++;
}
function note(name: string, detail: string) {
  const line = `  ··  ${name} — ${detail}`;
  verdicts.push(line); console.log(line);
}

// ---- 1. test rig + server ---------------------------------------------------

const rigOut = join(ROOT, "assets/opt/eidoverse/assets/vrms/bighead75.vrm");
const rigSrc = join(EIDOVERSE_DIR, "eidoverse/assets/vrms/claude.vrm");
// process.execPath, not "bun": on Windows the PATH "bun" is an npm .cmd
// shim whose pid is not the real process — killing the shim orphans the
// child (two abandoned sequencers were once found holding ports this way)
const mk = Bun.spawnSync([process.execPath, join(ROOT, "tools/make-bighead-vrm.ts"), rigSrc, rigOut, "5"]);
if (mk.exitCode !== 0) { console.error(mk.stderr.toString()); process.exit(1); }

const world = await ownedWorld({ worlds: [WORLD], owner: "puppet", env: { TRUST_NAMES: "1", EIDOVERSE_DIR } });
const BASE = world.origin, AUTH = { headers: { authorization: `Bearer ${world.key}` } };
console.log(`[probe] server at ${BASE} (world ${WORLD}) — library ${EIDOVERSE_DIR}`);
const { browser, page } = await launchBrowser();
const agents: WorldAgent[] = [];
const finish = async (code: number) => { for (const a of agents) { try { a.close(); } catch { /* gone */ } } await browser.close(); await world.close(); process.exit(code); };

// ---- 2. bodies ----------------------------------------------------------------

process.env.WORLD_TOKEN = world.key;   // a body's door key rides its join, from env
async function joinBody(name: string, avatar: string, x: number, z: number): Promise<WorldAgent> {
  const ag = new WorldAgent({ url: `${BASE.replace("http", "ws")}/ws`, name, world: WORLD, avatar, agentToken: "" });
  await ag.connect(); agents.push(ag);
  await ag.walkTo(x, z); ag.face(x, z + 10);   // everything it must see sits at +z
  return ag;
}
const puppet = await joinBody("puppet", "eidoverse/assets/vrms/bighead75.vrm", -3, -3);   // beside the tower, not behind it
const ctl = await joinBody("ctl", "eidoverse/assets/vrms/claude.vrm", 3, -3);
console.log("[probe] bodies joined");
// a refused request is a finding, named
async function req(verb: string, args: Record<string, unknown>) {
  const r = await puppet.request(verb, args);
  if (!r?.ok) check(`${verb} ${JSON.stringify(args).slice(0, 80)} is accepted`, false, JSON.stringify(r?.refused ?? r).slice(0, 240));
  return r;
}
async function tool(ag: WorldAgent, name: "attach" | "detach", args: Record<string, unknown>) {
  const r: any = await HANDLERS[name](ag as any, args, {} as any, name);
  if (r?.isError) check(`${ag.name} ${name} ${JSON.stringify(args)}`, false, r.content?.[0]?.text ?? "");
}

// ---- 3. scene -------------------------------------------------------------------
// Tower at origin, seats facing +z. Eye lines: ground socket seat y=0.8 →
// head ≈ 1.9; raised socket seat y=1.5 → head ≈ 2.6. Markers 4m ahead on
// those lines; a red crate on the ground for the on-foot case.

const made = await req("create", { id: "$tower", model: "eidoverse/assets/models/crate_large_yellow.glb", at: { pos: [0, 0, 0], yaw: 0 } });
const TOWER = made?.ids?.$tower;
if (!TOWER) { console.error("the tower was not created"); await finish(1); }
await req("set", { id: TOWER, component: "sockets", value: {
  low: { pos: [0, 0.8, 0], body: { action: "sit", pose: "sitchair" } }, high: { pos: [0, 1.5, 0], body: { action: "sit", pose: "sitchair" } } } });
await req("create", { components: { light: { color: 0xff00ff, intensity: 26, range: 8 } }, at: { pos: [0, 1.9, 4] } });
await req("create", { components: { light: { color: 0xff00ff, intensity: 26, range: 8 } }, at: { pos: [0, 2.6, 4] } });
await req("create", { model: "eidoverse/assets/models/crate_large_red.glb", at: { pos: [0, 0, 5], yaw: 0 } });
await sleep(600);
console.log("[probe] scene authored");

// ---- 4. renderer ------------------------------------------------------------

{
  const pg = await page();
  await pg.goto(`${BASE}/?renderer&name=probe&world=${WORLD}&key=${world.key}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    const r = await fetch(`${BASE}/snap?world=${WORLD}&follow=puppet&view=first`, AUTH);
    if (r.ok) ready = true; else await sleep(500);
  }
  if (!ready) { console.error("no renderer served a frame within 2 minutes"); await finish(1); }
}
// let the renderer finish materializing both VRMs before judging pixels
await sleep(6_000);
console.log("[probe] renderer serving");

// ---- 5. frames + pixel classifiers -----------------------------------------

type Stats = { w: number; h: number; magenta: number; red: number; skyTop: number; mean: [number, number, number]; raw: Buffer };
async function snap(follow: string, view: string, tag: string): Promise<Stats | { error: string }> {
  // a renderer still loading (503) or slow (504) says so: ask again for up to a minute, so a verdict is about pixels
  let png: Buffer | null = null, why = "";
  for (let i = 0; i < 20 && !png; i++) {
    await sleep(2_300);   // the broker's per-renderer cooldown
    const r = await fetch(`${BASE}/snap?world=${WORLD}&follow=${follow}&view=${view}`, AUTH);
    if (r.ok) png = Buffer.from(await r.arrayBuffer());
    else { why = `${r.status} ${(await r.text()).slice(0, 160)}`; if ((r.status !== 503 && r.status !== 504) || /GPU lost/.test(why)) break; }
  }
  if (!png) return { error: why };
  writeFileSync(join(RECEIPTS, `${tag}.png`), png);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let magenta = 0, red = 0, skyTop = 0; const mean = [0, 0, 0];
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const o = i * info.channels, r8 = data[o], g8 = data[o + 1], b8 = data[o + 2];
    mean[0] += r8; mean[1] += g8; mean[2] += b8;
    if (r8 > 120 && b8 > 120 && g8 < 0.6 * Math.min(r8, b8)) magenta++;
    if (r8 > 110 && g8 < 80 && b8 < 80) red++;
    if (i < px / 3 && b8 > 130 && b8 > r8 && b8 >= g8 - 6) skyTop++;
  }
  return {
    w: info.width, h: info.height, magenta, red, skyTop,
    mean: [mean[0] / px, mean[1] / px, mean[2] / px] as [number, number, number], raw: data,
  };
}
const meanDiff = (a: Stats, b: Stats) =>
  Math.hypot(a.mean[0] - b.mean[0], a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]);
const fmt = (s: Stats) => `magenta=${s.magenta} red=${s.red} skyTop=${s.skyTop}`;
const MARKER = 40;   // px — the gizmo alone is hundreds at these ranges

// ---- 6. the acceptance grid -------------------------------------------------

console.log("\n#75 acceptance — big-head rig (nonhumanoid head-volume case)");

const footFirst = await snap("puppet", "first", "bighead-foot-first");
if ("error" in footFirst) check("on foot: first-person renders", false, footFirst.error);
else check("on foot: first-person sees the world past its own head", footFirst.magenta + footFirst.red > MARKER, fmt(footFirst));

await puppet.walkTo(-1.5, -2);   // a seat is taken from within reach (3.5 m across the ground)
await tool(puppet, "attach", { to: TOWER, socket: "low" });
await sleep(800);
const lowFirst = await snap("puppet", "first", "bighead-low-first");
if ("error" in lowFirst) check("ground socket: first-person renders", false, lowFirst.error);
else check("ground socket: own head does not occlude (marker visible)", lowFirst.magenta + lowFirst.red > MARKER, fmt(lowFirst));

await tool(puppet, "detach", {});
await tool(puppet, "attach", { to: TOWER, socket: "high" });
await sleep(800);
const highFirst = await snap("puppet", "first", "bighead-high-first");
if ("error" in highFirst) check("raised socket: first-person renders", false, highFirst.error);
else check("raised socket: own head does not occlude", highFirst.magenta > MARKER, fmt(highFirst));

const highThird = await snap("puppet", "third", "bighead-high-third");
const highSelfie = await snap("puppet", "selfie", "bighead-high-selfie");
if ("error" in highThird || "error" in highFirst) check("third view still renders while mounted", !("error" in highThird), (highThird as { error?: string }).error ?? "");
else check("third view differs from first (body back in frame)", meanDiff(highThird, highFirst) > 6, `Δmean=${meanDiff(highThird, highFirst).toFixed(1)}`);
if ("error" in highSelfie || "error" in highFirst) check("selfie still renders while mounted", !("error" in highSelfie), (highSelfie as { error?: string }).error ?? "");
else check("selfie differs from first (avatar is the subject)", meanDiff(highSelfie, highFirst) > 6, `Δmean=${meanDiff(highSelfie, highFirst).toFixed(1)}`);

// moving socket: bob the tower; the eye must ride it. Two frames half a
// period apart must differ far more than two frames of a still scene.
await req("set", { id: TOWER, component: "motion", value: { type: "oscillate", amp: 0.7, period: 2.4 } });
await sleep(600);
const bobA = await snap("puppet", "first", "bighead-bob-a");
await sleep(1200);
const bobB = await snap("puppet", "first", "bighead-bob-b");
await req("delete", { id: TOWER, component: "motion" });
await sleep(400);
const stillA = await snap("puppet", "first", "bighead-still-a");
const stillB = await snap("puppet", "first", "bighead-still-b");
if ("error" in bobA || "error" in bobB || "error" in stillA || "error" in stillB) {
  check("moving socket: frames captured", false, "snap error during bob pass");
} else {
  const moved = meanDiff(bobA, bobB), still = meanDiff(stillA, stillB);
  check("moving socket: the eye rides the bob (moving ≫ still)", moved > still * 3 + 2,
    `Δmoving=${moved.toFixed(2)} Δstill=${still.toFixed(2)}`);
}

await tool(puppet, "detach", {});
await puppet.walkTo(-3, -3); puppet.face(-3, 10);
await sleep(800);
const backFirst = await snap("puppet", "first", "bighead-dismount-first");
if ("error" in backFirst) check("dismount: first-person renders", false, backFirst.error);
else check("detach restores ordinary first-person without reload", backFirst.magenta + backFirst.red > MARKER, fmt(backFirst));

console.log("\n#75 acceptance — stock humanoid control");
const ctlFoot = await snap("ctl", "first", "ctl-foot-first");
if ("error" in ctlFoot) check("control on foot: first-person renders", false, ctlFoot.error);
else check("control on foot: world visible", ctlFoot.magenta + ctlFoot.red > MARKER, fmt(ctlFoot));

await ctl.walkTo(1.5, -2);   // a seat is taken from within reach (3.5 m across the ground)
// the puppet's detach is presence: the seat is free once its next frame lands
for (let i = 0; i < 20 && !ctl.myOccupancy; i++) { const r: any = await HANDLERS.attach(ctl as any, { to: TOWER, socket: "high" }, {} as any, "attach"); if (r?.isError) await sleep(500); }
check("ctl takes the raised seat the puppet left", !!ctl.myOccupancy);
await sleep(800);
const ctlHigh = await snap("ctl", "first", "ctl-high-first");
if ("error" in ctlHigh) check("control on raised socket: first-person renders", false, ctlHigh.error);
else check("control on raised socket: marker visible", ctlHigh.magenta > MARKER, fmt(ctlHigh));
const ctlSelfie = await snap("ctl", "selfie", "ctl-high-selfie");
if (!("error" in ctlSelfie) && !("error" in ctlHigh)) {
  check("control selfie differs from first (body shown)", meanDiff(ctlSelfie, ctlHigh) > 6, `Δmean=${meanDiff(ctlSelfie, ctlHigh).toFixed(1)}`);
}

if ("error" in highFirst) note("sky", "no elevated frame to judge");
else note("sky from the raised seat", `skyTop=${highFirst.skyTop} px (Sill's original complaint: could not see the horizon)`);

// ---- 7. verdict -------------------------------------------------------------

writeFileSync(join(RECEIPTS, "verdict.txt"), verdicts.join("\n") + "\n");
console.log(`\n${pass} passed, ${fail} failed — frames + verdict in ${RECEIPTS}`);
await finish(fail ? 1 : 0);
