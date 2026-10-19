// pose-release-probe — posing another person from the browser console, and letting them go, seen in two browsers.
//
//   bun tools/pose-release-probe.ts
//
// Needs a Chromium that tools/probe-harness.mjs can find. How long a run takes depends on the machine. Each page's
// load and join may wait up to three minutes, poser's page up to 90 s more to see held's avatar, and each of a step's
// four waits up to 30 s, so the waits come to about twenty minutes at most. A setup wait that runs out fails setup's
// check, and the run then skips every step.
//
// A scratch world this run owns (tools/probe-harness.mjs ownedWorld, proved by its nonce) serves a fixture body
// from a scratch library (tools/body-fixture.ts). Two people join it in the full client: "poser" and "held", and
// held allows posing (client/lib/consent.js). poser poses held by name from its console and lets go three ways:
// EW.clearPose('held'), EW.pose(null, 'held') and a replace with no bones named. Each request is a puppet message
// the world routes to held (server/messages.ts), which held's client applies to its own body
// (client/lib/localbody.js) and streams like any other pose. So each step is judged where a person sees it: on
// held's page, the pose its body holds (EW.myState.pose), the hint bar ("poser posed you", "poser released your
// pose") and its own avatar as drawn; on poser's page, held's avatar as poser's client draws it. A drawn avatar
// is read twice: its pose override (avatar.js setPose), the rotation each bone is eased to, and the arm's normalized
// bone, the rotation the renderer last drew it with.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, ownedWorld } from "./probe-harness.mjs";
import { fixture } from "./body-fixture.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  ok ? pass++ : fail++;
};

const lib = mkdtempSync(join(tmpdir(), "pose-release-library-"));
mkdirSync(join(lib, "fixtures"));
writeFileSync(join(lib, "fixtures/body.vrm"), fixture());
const world = await ownedWorld({ env: { EIDOVERSE_DIR: lib } });
let browser: { close(): Promise<void> } | null = null;
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  const errs: Record<string, string[]> = { poser: [], held: [] };
  const join_ = async (name: string) => {
    const pg = await launched.page();
    pg.on("pageerror", (e: Error) => errs[name].push(e.message));
    pg.on("dialog", (d: any) => d.dismiss().catch(() => {}));
    await pg.goto(`${world.origin}/?world=commons&name=${name}&key=${world.key}&avatar=fixtures/body.vrm`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pg.waitForFunction(() => document.getElementById("splash")?.classList.contains("gone") && !!(globalThis as any).EW?.me?.(),
      null, { timeout: 120000 });
    return pg;
  };
  // A wait that runs out here is a failed check, so a slow machine ends with a count that says which.
  let held: any = null, poser: any = null, ready = false;
  try {
    held = await join_("held");
    poser = await join_("poser");
    await held.evaluate(() => (globalThis as any).EW.setPosable(true));
    // Every line the hint bar shows on held's page, each time it shows one: a flash lasts 2.6 s (ui.js flashHint),
    // and the same line shown again is recorded again.
    await held.evaluate(() => {
      const g = globalThis as any, bar = document.getElementById("hintbar")!;
      g.__hints = [] as string[];
      new MutationObserver(() => { const t = bar.textContent ?? ""; if (t) g.__hints.push(t); })
        .observe(bar, { childList: true, characterData: true, subtree: true });
    });
    await poser.waitForFunction(() => !!(globalThis as any).EW?.remotes?.get("held")?.avatar?.vrm?.humanoid, null, { timeout: 90000 });
    ready = true;
  } catch (e) {
    console.log(`  setup stopped: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
  }
  check("setup: both pages load and join, and poser's page sees held's avatar", ready);
  if (ready) {
    const arm = { leftUpperArm: [0, 0, 0.3, Math.sqrt(0.91)] };
    const heldPose = () => held.evaluate(() => JSON.stringify((globalThis as any).EW.myState.pose ?? null));
    const hints = () => held.evaluate(() => (globalThis as any).__hints.slice() as string[]);
    // held's avatar as a page draws it: "absent" when the page has none, else `targets`, each bone its pose override
    // holds with its target rotation while the pose eases in or holds (wantWeight 1, avatar.js setPose; clearPose sets
    // 0), `posed`, whether it holds a pose override at all (the ease-out drops it and hands the bones back), and
    // `bone`, the arm's normalized bone as the renderer last drew it (avatar.js eases each held bone to its target).
    // On poser's page that is held's remote avatar; on held's own page it is held's own avatar, which the client's
    // held-pose system checks against EW.myState.pose each frame and sets when the state changes (client/main.js).
    const read = (pg: any, self: boolean) => pg.evaluate((self: boolean) => {
      const g = globalThis as any, av = self ? g.EW.me() : g.EW.remotes.get("held")?.avatar;
      if (!av?.vrm?.humanoid) return "absent";
      const o = av._override, q = av.vrm.humanoid.getNormalizedBoneNode("leftUpperArm")?.quaternion;
      return {
        targets: o?.kind === "pose" && o.wantWeight === 1 ? Object.fromEntries([...o.targets].map(([b, t]: [string, any]) => [b, [t.x, t.y, t.z, t.w]])) : null,
        posed: o?.kind === "pose",
        bone: q ? [q.x, q.y, q.z, q.w] : null,
      };
    }, self);
    const drawn = () => read(poser, false), own = () => read(held, true);
    const near = (q: number[] | null | undefined, tol: number) => !!q && q.every((v, i) => Math.abs(v - arm.leftUpperArm[i]) < tol);
    // Holding the arm as sent: its one target is the rotation sent, within a millionth in each component, and the
    // drawn bone holds it, within a thousandth, since the renderer eases toward it.
    const holdsArm = (d: any) => d !== "absent" && !!d?.targets && Object.keys(d.targets).join() === "leftUpperArm"
      && near(d.targets.leftUpperArm, 1e-6) && near(d.bone, 1e-3);
    // Let go: the avatar is there, it holds no pose override, and the drawn bone has left the arm.
    const letGo = (d: any) => d !== "absent" && !!d && !d.posed && !!d.bone && !near(d.bone, 1e-3);
    const until = async (what: () => Promise<boolean>, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await what()) return true; await new Promise((r) => setTimeout(r, 100)); }
      return false;
    };
    // Each step counts the hint bar's lines before it sends its request, since held's page can show the hint before
    // a read taken after the request returns.
    const posed = async (how: string, request: () => Promise<unknown>) => {
      const from = (await hints()).length;
      await request();
      const applied = await until(async () => (await heldPose()) === JSON.stringify(arm));
      check(`${how}: held's body takes the pose`, applied, await heldPose());
      check("...its hint bar says poser posed it", await until(async () => (await hints()).slice(from).includes("poser posed you")), JSON.stringify((await hints()).slice(from)));
      check("...held's page draws its body holding it", await until(async () => holdsArm(await own())), JSON.stringify(await own()));
      check("...and poser's page draws held's avatar holding it", await until(async () => holdsArm(await drawn())), JSON.stringify(await drawn()));
    };
    // Each release starts from the pose drawn on both pages, read before the request goes, so letting go means it was
    // there and then wasn't.
    const released = async (how: string, request: () => Promise<unknown>) => {
      const from = (await hints()).length;
      const before = { own: await own(), drawn: await drawn() };
      await request();
      const let_go = await until(async () => (await heldPose()) === "null");
      check(`${how}: held's body lets the pose go`, let_go, await heldPose());
      check("...its hint bar says poser released it", await until(async () => (await hints()).slice(from).includes("poser released your pose")), JSON.stringify((await hints()).slice(from)));
      check("...held's page draws its body letting it go",
        holdsArm(before.own) && await until(async () => letGo(await own())), `before ${JSON.stringify(before.own)}, now ${JSON.stringify(await own())}`);
      check("...and poser's page draws held's avatar letting it go",
        holdsArm(before.drawn) && await until(async () => letGo(await drawn())), `before ${JSON.stringify(before.drawn)}, now ${JSON.stringify(await drawn())}`);
    };

    await posed("EW.pose(bones, 'held')", () => poser.evaluate((a) => (globalThis as any).EW.pose(a, "held"), arm));
    await released("EW.clearPose('held')", () => poser.evaluate(() => (globalThis as any).EW.clearPose("held")));
    await posed("EW.pose(bones, {target: 'held'})", () => poser.evaluate((a) => (globalThis as any).EW.pose(a, { target: "held" }), arm));
    await released("EW.pose(null, 'held')", () => poser.evaluate(() => (globalThis as any).EW.pose(null, "held")));
    await posed("posed again", () => poser.evaluate((a) => (globalThis as any).EW.pose(a, "held"), arm));
    await released("EW.pose(undefined, {replace: true, target: 'held'})",
      () => poser.evaluate(() => (globalThis as any).EW.pose(undefined, { replace: true, target: "held" })));
    // poser's own body is left alone throughout.
    check("poser's own body holds no pose", await poser.evaluate(() => (globalThis as any).EW.myState.pose == null));
  }
  check("neither page threw", !errs.poser.length && !errs.held.length, JSON.stringify(errs));
} finally {
  await browser?.close().catch(() => {});
  await world.close();
  rmSync(lib, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
