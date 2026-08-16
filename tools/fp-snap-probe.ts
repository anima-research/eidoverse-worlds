// fp-snap-probe — the #75 behavioral receipt, end to end and A/B-able.
//
//   bun tools/fp-snap-probe.ts                # spawns its own scratch sequencer
//   PORT=8987 RECEIPTS=/tmp/fp75 bun tools/fp-snap-probe.ts
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
//      sequencer on PORT with an open door;
//   2. joins two raw-ws puppets: "puppet" wearing the big-head rig
//      (nonhumanoid head-volume case) and "ctl" wearing stock claude.vrm
//      (humanoid control);
//   3. authors a tower crate with a ground socket and an elevated socket,
//      magenta light markers on each seat's eye line, and a red crate on the
//      ground line — every first-person case has something it MUST see;
//   4. opens a renderer session (agent-browser if available, else waits for
//      one to be opened by hand at /?renderer&name=probe&world=<world>);
//   5. walks the acceptance grid — on foot / ground socket / elevated
//      socket × first (marker REQUIRED), third + selfie (body in frame,
//      frame must differ from first), dismount (first restored), and a
//      bob-motion pass where the camera must ride the moving socket;
//   6. saves every frame to RECEIPTS and exits non-zero on any violation.
//
// Wire facts it leans on (server.ts): join {type:'join',world,id,avatar,token},
// verbs ≤12/4s per client, mount is self-rank for args.id === self,
// /snap?world&follow&view needs a c.renderer client in-world.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PORT = Number(process.env.PORT ?? 8987);
const BASE = `http://127.0.0.1:${PORT}`;
const WORLD = process.env.WORLD ?? "fp75";
const RECEIPTS = process.env.RECEIPTS ?? `/tmp/fp75-receipts-${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
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

// ---- 1. test rig + sequencer ----------------------------------------------

const rigOut = join(ROOT, "assets/opt/eidoverse/assets/vrms/bighead75.vrm");
const rigSrc = join(EIDOVERSE_DIR, "eidoverse/assets/vrms/claude.vrm");
// process.execPath, not "bun": on Windows the PATH "bun" is an npm .cmd
// shim whose pid is not the real process — killing the shim orphans the
// child (paritybench found two abandoned sequencers holding ports this way)
const mk = Bun.spawnSync([process.execPath, join(ROOT, "tools/make-bighead-vrm.ts"), rigSrc, rigOut, "5"]);
if (mk.exitCode !== 0) { console.error(mk.stderr.toString()); process.exit(1); }

console.log(`[probe] sequencer on :${PORT} (world ${WORLD}) — library ${EIDOVERSE_DIR}`);
const seq = Bun.spawn([process.execPath, join(ROOT, "server/server.ts")], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR, WORLDS_DIR: join(RECEIPTS, "worlds") },
  stdout: Bun.file(join(RECEIPTS, "sequencer.log")),
  stderr: Bun.file(join(RECEIPTS, "sequencer.log")),
});
process.on("exit", () => { try { seq.kill(); } catch { /* gone */ } });
{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${BASE}/avatars`)).ok; } catch { await sleep(250); }
  }
  if (!up) { console.error("sequencer never came up — see sequencer.log"); process.exit(1); }
}

// ---- 2. puppets -------------------------------------------------------------

type Puppet = {
  id: string;
  send: (o: unknown) => void;
  verb: (verb: string, args: unknown) => Promise<void>;
  pose: (p: [number, number, number], yaw: number) => void;
  errors: string[];
};
function joinPuppet(id: string, avatar: string, p: [number, number, number], yaw: number): Promise<Puppet> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const errors: string[] = [];
    const send = (o: unknown) => ws.send(JSON.stringify(o));
    const self: Puppet = {
      id, send, errors,
      // verbs are rate-limited 12/4s — pace them so a refusal is a finding,
      // not an artifact of the window (locktest precedent)
      verb: async (verb, args) => { send({ type: "verb", verb, args }); await sleep(420); },
      pose: (pp, yaw2) => send({ type: "pose", pose: { p: pp, yaw: yaw2, clip: "idle" } }),
    };
    ws.onopen = () => send({ type: "join", world: WORLD, id, avatar, token: "" });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { self.pose(p, yaw); resolve(self); }
      if (m.type === "error") { errors.push(String(m.error)); console.log(`[${id}] world error: ${m.error}`); }
    };
    ws.onerror = (e) => reject(new Error(`ws ${id}: ${String(e)}`));
    setTimeout(() => reject(new Error(`${id} never got a snapshot`)), 10_000);
  });
}

// Both puppets face +z (yaw 0); everything they must see sits at +z.
const puppet = await joinPuppet("puppet", "eidoverse/assets/vrms/bighead75.vrm", [0, 0, -3], 0);
const ctl = await joinPuppet("ctl", "eidoverse/assets/vrms/claude.vrm", [3, 0, -3], 0);
console.log("[probe] puppets joined");

// ---- 3. scene ---------------------------------------------------------------
// Tower at origin, seats facing +z. Eye lines: ground socket seat y=0.8 →
// head ≈ 1.9; elevated socket seat y=4 → head ≈ 5.1. Markers 4m ahead on
// those lines; a red crate on the ground for the on-foot case.

await puppet.verb("spawn", { id: "tower", lib: "eidoverse/assets/models/crate_large_yellow.glb", pos: [0, 0, 0], yaw: 0 });
await puppet.verb("comp", {
  id: "tower", type: "sockets",
  data: { low: { pos: [0, 0.8, 0], yaw: 0, pose: "sitchair" }, high: { pos: [0, 4, 0], yaw: 0, pose: "sitchair" } },
});
await puppet.verb("light", { id: "m-low", pos: [0, 1.9, 4], color: "#ff00ff", intensity: 26, range: 8 });
await puppet.verb("light", { id: "m-high", pos: [0, 5.1, 4], color: "#ff00ff", intensity: 26, range: 8 });
await puppet.verb("spawn", { id: "m-crate", lib: "eidoverse/assets/models/crate_large_red.glb", pos: [0, 0, 5], yaw: 0 });
console.log("[probe] scene authored");

// ---- 4. renderer ------------------------------------------------------------

const rendererUrl = `${BASE}/?renderer&name=probe&world=${WORLD}`;
{
  const ab = Bun.spawnSync(["agent-browser", "open", rendererUrl]);
  if (ab.exitCode !== 0) {
    console.log(`[probe] agent-browser unavailable — open this yourself:\n        ${rendererUrl}`);
  }
}
{
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    const r = await fetch(`${BASE}/snap?world=${WORLD}&follow=puppet&view=first`);
    if (r.status !== 503) ready = true; else await sleep(500);
  }
  if (!ready) { console.error("no renderer joined within 2 minutes"); process.exit(1); }
}
// let the renderer finish materializing both VRMs before judging pixels
await sleep(6_000);
console.log("[probe] renderer serving");

// ---- 5. frames + pixel classifiers -----------------------------------------

type Stats = { w: number; h: number; magenta: number; red: number; skyTop: number; mean: [number, number, number]; raw: Buffer };
async function snap(follow: string, view: string, tag: string): Promise<Stats | { error: string }> {
  const r = await fetch(`${BASE}/snap?world=${WORLD}&follow=${follow}&view=${view}`);
  if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 160)}` };
  const png = Buffer.from(await r.arrayBuffer());
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

await puppet.verb("mount", { id: "puppet", to: "tower", slot: "low" });
await sleep(800);
const lowFirst = await snap("puppet", "first", "bighead-low-first");
if ("error" in lowFirst) check("ground socket: first-person renders", false, lowFirst.error);
else check("ground socket: own head does not occlude (marker visible)", lowFirst.magenta + lowFirst.red > MARKER, fmt(lowFirst));

await puppet.verb("mount", { id: "puppet", to: "tower", slot: "high" });
await sleep(800);
const highFirst = await snap("puppet", "first", "bighead-high-first");
if ("error" in highFirst) check("elevated socket: first-person renders", false, highFirst.error);
else check("elevated socket (watchtower): own head does not occlude", highFirst.magenta > MARKER, fmt(highFirst));

const highThird = await snap("puppet", "third", "bighead-high-third");
const highSelfie = await snap("puppet", "selfie", "bighead-high-selfie");
if ("error" in highThird || "error" in highFirst) check("third view still renders while mounted", !("error" in highThird), (highThird as { error?: string }).error ?? "");
else check("third view differs from first (body back in frame)", meanDiff(highThird, highFirst) > 6, `Δmean=${meanDiff(highThird, highFirst).toFixed(1)}`);
if ("error" in highSelfie || "error" in highFirst) check("selfie still renders while mounted", !("error" in highSelfie), (highSelfie as { error?: string }).error ?? "");
else check("selfie differs from first (avatar is the subject)", meanDiff(highSelfie, highFirst) > 6, `Δmean=${meanDiff(highSelfie, highFirst).toFixed(1)}`);

// moving socket: bob the tower; the eye must ride it. Two frames half a
// period apart must differ far more than two frames of a still scene.
await puppet.verb("comp", { id: "tower", type: "motion", data: { type: "bob", amp: 0.7, period: 2.4 } });
await sleep(600);
const bobA = await snap("puppet", "first", "bighead-bob-a");
await sleep(1200);
const bobB = await snap("puppet", "first", "bighead-bob-b");
await puppet.verb("comp", { id: "tower", type: "motion", data: null });
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

await puppet.verb("dismount", { id: "puppet", pos: [0, 0, -3], yaw: 0 });
puppet.pose([0, 0, -3], 0);
await sleep(800);
const backFirst = await snap("puppet", "first", "bighead-dismount-first");
if ("error" in backFirst) check("dismount: first-person renders", false, backFirst.error);
else check("dismount restores ordinary first-person without reload", backFirst.magenta + backFirst.red > MARKER, fmt(backFirst));

console.log("\n#75 acceptance — stock humanoid control");
const ctlFoot = await snap("ctl", "first", "ctl-foot-first");
if ("error" in ctlFoot) check("control on foot: first-person renders", false, ctlFoot.error);
else check("control on foot: world visible", ctlFoot.magenta + ctlFoot.red > MARKER, fmt(ctlFoot));

await ctl.verb("mount", { id: "ctl", to: "tower", slot: "high" });
await sleep(800);
const ctlHigh = await snap("ctl", "first", "ctl-high-first");
if ("error" in ctlHigh) check("control on elevated socket: first-person renders", false, ctlHigh.error);
else check("control on elevated socket: marker visible", ctlHigh.magenta > MARKER, fmt(ctlHigh));
const ctlSelfie = await snap("ctl", "selfie", "ctl-high-selfie");
if (!("error" in ctlSelfie) && !("error" in ctlHigh)) {
  check("control selfie differs from first (body shown)", meanDiff(ctlSelfie, ctlHigh) > 6, `Δmean=${meanDiff(ctlSelfie, ctlHigh).toFixed(1)}`);
}

if ("error" in highFirst) note("sky", "no elevated frame to judge");
else note("sky from the watchtower", `skyTop=${highFirst.skyTop} px (Sill's original complaint: could not see the horizon)`);

// ---- 7. verdict -------------------------------------------------------------

writeFileSync(join(RECEIPTS, "verdict.txt"), verdicts.join("\n") + "\n");
console.log(`\n${pass} passed, ${fail} failed — frames + verdict in ${RECEIPTS}`);
seq.kill();
process.exit(fail ? 1 : 0);
