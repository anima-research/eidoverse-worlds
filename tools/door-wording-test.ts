// The door's refusals say what didn't happen, why, and what to do instead,
// with the agent's own value where that was the problem.
// Run: bun tools/door-wording-test.ts
import { mkCheck } from "./harness.ts";
import { handleTool, snapshotTool, TOOLS } from "../mcpl/tools.ts";
import { rawShapeError } from "../mcpl/shape.ts";
import { shown } from "../shared/shown.js";
import { VERB_NEEDS } from "../server/rights.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { BodyStateReader } from "../mcpl/body-state.ts";
import { ReachBody } from "../mcpl/physics.ts";
import { CONTACT_POINTS } from "../shared/contact.js";
import { CLIP_SLOTS } from "../shared/clipdefs.js";
import { SWIM_CLIPS } from "../shared/swimpose.js";
import { fixture, postureFixture } from "./body-fixture.ts";

const { check, tally } = mkCheck();
const said = (r: any) => String(r?.content?.[0]?.text ?? "");

// Bodies for body_state: the fixture rig, one without a left forearm, one
// with no humanoid skeleton at all, and one whose bones loop.
const glb = (g: any) => {
  let json = JSON.stringify(g);
  json += " ".repeat((4 - Buffer.byteLength(json) % 4) % 4);
  const b = Buffer.alloc(20 + Buffer.byteLength(json));
  b.writeUInt32LE(0x46546c67, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(b.length - 20, 12); b.writeUInt32LE(0x4e4f534a, 16); b.write(json, 20);
  return b;
};
const rigJson = () => JSON.parse(fixture().subarray(20).toString());
const oneArmed = rigJson(); delete oneArmed.extensions.VRMC_vrm.humanoid.humanBones.leftLowerArm;
const flat = rigJson(); delete flat.extensions; delete flat.extensionsUsed;
// the root hangs under the head, so the hips' ancestors come round to them again
const looped = rigJson(); looped.nodes[looped.extensions.VRMC_vrm.humanoid.humanBones.head.node].children.push(0);
// the neck named on the head's own node, as some models have it
const sharedNeck = rigJson(); sharedNeck.extensions.VRMC_vrm.humanoid.humanBones.neck.node = sharedNeck.extensions.VRMC_vrm.humanoid.humanBones.head.node;
const library = new Map<string, Uint8Array>([["body.vrm", fixture()], ["one-armed.vrm", glb(oneArmed)],
  ["flat.vrm", glb(flat)], ["looped.vrm", glb(looped)], ["shared-neck.vrm", glb(sharedNeck)],
  ["broken.vrm", new TextEncoder().encode("not a model at all")], ["idle.vrma", postureFixture("idle")]]);

// A stand-in world server: just the routes these tools read.
let roster: { name: string; path: string }[] = [{ name: "aria", path: "avatars/aria.vrm" }, { name: "bo", path: "avatars/bo.vrm" }];
const world = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/avatars") return Response.json(roster);
  if (u.pathname === "/library-models") return Response.json([]);
  if (u.pathname === "/snap") {
    // The broker's answers (server/snapshots.ts), in its order: the renderer asked for, then the
    // body followed. The body's name also picks how the world's renderers answer; any other name
    // finds none of the kind asked for serving.
    const renderer = u.searchParams.get("renderer"), follow = u.searchParams.get("follow");
    const [said, status] = renderer !== "auto" && renderer !== "browser" && renderer !== "unreal" ? ["renderer must be auto, unreal, or browser", 400]
      : follow === "gone" ? ['"gone" is not present in "w"', 404]
      : follow === "busy" ? ["renderers busy; retry in a few seconds", 429]
      : follow === "slow" ? ["renderer timed out", 504]
      : follow === "proxied" ? ["<html>\n  <h1>502 Bad Gateway</h1>\n</html>\n", 502]   // a proxy in front of the server
      : follow === "blank" ? [" \n ", 502]
      : renderer === "unreal" ? ['no unreal renderer is currently serving world "w"', 503]
      : ['no renderer is currently serving world "w"', 503];
    return new Response(said as string, { status: status as number });
  }
  if (u.pathname === "/worlds") return new Response("broken", { status: 500 });
  if (u.pathname === "/geom") return u.searchParams.get("id") === "err"
    ? Response.json({ error: 'no entity "err" in w' }, { status: 404 })
    : new Response("not json");
  if (u.pathname === "/animations") return Response.json([{ name: "idle", path: "idle.vrma" }]);
  if (u.pathname.startsWith("/library/")) {
    const bytes = library.get(decodeURIComponent(u.pathname.slice("/library/".length)));
    return bytes ? new Response(bytes) : new Response("no", { status: 404 });
  }
  return new Response("no", { status: 404 });
} });
const worldBase = `http://127.0.0.1:${world.port}`;
const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
const goneBase = `http://127.0.0.1:${gone.port}`;
gone.stop(true);

const agent: any = {
  httpBase: `http://127.0.0.1:${world.port}`, world: "w", name: "me",
  entities: new Map(), people: new Map(), pos: { x: 0, y: 0, z: 0 }, yaw: 0,
  heightAt: () => 0, verbs: [] as unknown[], verb(v: string, a: unknown) { this.verbs.push([v, a]); }, face() {},
};
const ctx: any = { agent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
const call = (name: string, args: Record<string, unknown> = {}) => handleTool(ctx, name, args);

try {
  console.log("\nTOOLS");
  const unknown = await call("fly_to_the_moon");
  check("an unknown tool is named, and nothing ran",
    unknown.isError === true && said(unknown) === `there's no tool named "fly_to_the_moon" on this door, so nothing ran; your tool list has the ones it serves`, said(unknown));
  check("a rehearsal tool that's off answers in exactly the same words",
    said(await call("rehearse_down")) === `there's no tool named "rehearse_down" on this door, so nothing ran; your tool list has the ones it serves`);
  check("face names the missing target",
    /^nothing here is called "ghost", so you didn't turn; look lists/.test(said(await call("face", { target: "ghost" }))));
  check("face with nothing to face shows both forms",
    /face \{x: 4, z: -2\} or face \{target:/.test(said(await call("face", {}))));
  const noText = await call("say", {});
  check("say without text says what was sent", noText.isError === true && /so nothing was said; you sent nothing$/.test(said(noText)), said(noText));
  check("...and a text that isn't a string shows its value", /you sent 42$/.test(said(await call("say", { text: 42 }))));
  const partial = await call("say", { text: "hi", utt: -1 });
  check("a broken spoken line names each part as sent",
    partial.isError === true && /\(you sent spoken nothing, utt -1, t0 nothing\)/.test(said(partial)) && /send only text/.test(said(partial)), said(partial));
  check("ragdoll without a target shows the call",
    /^ragdoll needs a target, the body to knock over, so nothing happened: ragdoll \{target:/.test(said(await call("ragdoll", {}))));
  const tracks = { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, -0.7, 0.7] }] };
  check("animate without dur says what was sent",
    /^animate needs dur, the length in seconds and more than 0, so nothing played; you sent nothing$/.test(said(await call("animate", { tracks }))));
  check("spawn with neither lib nor query names both",
    said(await call("spawn", {})) === "spawn needs lib (a model's path) or query (words to search the library), so nothing was spawned");
  const missed = said(await call("spawn", { query: "zzz" }));
  check("a query that found nothing says so, not that none was passed",
    /^no library model matches "zzz", so nothing was spawned; list_library/.test(missed), missed);
  // An empty lib names no model and lets a query search (door-is-error-test); a lib such as 0 skips the search.
  const noModel = said(await call("spawn", { lib: 0, query: "zzz" }));
  check("a lib that names no model, such as 0, skips the search and says so",
    noModel === `spawn's lib was 0, which names no model, so nothing was spawned; pass a model's path, or leave lib out and pass query to search the library`, noModel);
  const noId = said(await call("place", { x: 1, z: 1 }));
  check("place without an id names it and shows the call",
    noId === `place needs id, the entity to move, so nothing was placed: place {id: "lamp1", x: 3, z: -2}`, noId);
  const unseen = said(await call("place", { id: "ghost", x: 1, z: 1 }));
  check("place says which entity this body doesn't know of",
    unseen === `this body knows of no entity "ghost" in this world, so nothing was placed; look lists what's around you`, unseen);
  const noBody = said(await call("set_avatar", { avatar: "zed" }));
  check("set_avatar names the roster and what a slash means",
    /^no body named "zed" is on the roster, so you're still wearing your current body\. The roster has: aria, bo\. A path with a slash/.test(noBody), noBody);
  check("library_sheet past the end names the pages there are",
    said(await call("library_sheet", { kind: "avatars", page: 5 })) === "no page 5: there are 2 avatars on 1 page, so pass a page from 1 to 1");
  roster = [];
  check("...and an empty roster says there's nothing to show",
    said(await call("library_sheet", { kind: "avatars", page: 1 })) === "there are no avatars to show yet");
  const emptyRoster = said(await call("set_avatar", { avatar: "zed" }));
  check("set_avatar with an empty roster says it's empty, not an empty list",
    emptyRoster === `no body named "zed" is on the roster, so you're still wearing your current body. The roster is empty. A path with a slash names a library model instead.`, emptyRoster);
  const single = await call("travel", { world: "annex" });
  check("travel on a single-world door says the door fronts one world, which its operator chooses",
    single.isError === true && said(single) === "travel isn't available on this door: it fronts a single world, so you stayed where you are; its operator chooses that world (WORLD_NAME)", said(single));
  const snap = said(await snapshotTool(agent));
  check("a snapshot the server refused gives its status and its answer, with no quotes nested in ours",
    snap === `snapshot: no picture was taken; the world server answered 503 (no renderer is currently serving world "w"), so try again in a while`, snap);
  const unrealOnly = said(await snapshotTool(agent, "first", "unreal"));
  check("...an Unreal-only one with none there says to try again, or that browser can get one",
    unrealOnly === `snapshot: no picture was taken; the world server answered 503 (no unreal renderer is currently serving world "w"), so try again in a while, or ask for renderer "browser"`, unrealOnly);
  const unrealAway = said(await snapshotTool({ ...agent, name: "gone" }, "first", "unreal"));
  check("...but an Unreal-only one refused for another reason gets that reason's remedy",
    unrealAway === `snapshot: no picture was taken; the world server answered 404 ("gone" is not present in "w"), so calling again works only once what it says has changed`, unrealAway);
  const badRenderer = said(await snapshotTool(agent, "first", "Unreal"));
  check("...a renderer the server refuses says the same arguments won't change that",
    badRenderer === "snapshot: no picture was taken; the world server answered 400 (renderer must be auto, unreal, or browser), so calling again with the same arguments won't change that", badRenderer);
  const away = said(await snapshotTool({ ...agent, name: "gone" }));
  check("...a body that isn't in the world says calling again works once what the server said has changed",
    away === `snapshot: no picture was taken; the world server answered 404 ("gone" is not present in "w"), so calling again works only once what it says has changed`, away);
  const busy = said(await snapshotTool({ ...agent, name: "busy" }));
  check("...busy renderers say a few seconds",
    busy === "snapshot: no picture was taken; the world server answered 429 (renderers busy; retry in a few seconds), so try again in a few seconds", busy);
  const slow = said(await snapshotTool({ ...agent, name: "slow" }));
  check("...a renderer that timed out says a while",
    slow === "snapshot: no picture was taken; the world server answered 504 (renderer timed out), so try again in a while", slow);
  const proxied = said(await snapshotTool({ ...agent, name: "proxied" }));
  check("...an answer over several lines reads as one",
    proxied === "snapshot: no picture was taken; the world server answered 502 (<html> <h1>502 Bad Gateway</h1> </html>), so try again in a while", proxied);
  const blank = said(await snapshotTool({ ...agent, name: "blank" }));
  check("...and an answer of nothing but whitespace gives the status alone",
    blank === "snapshot: no picture was taken; the world server answered 502, so try again in a while", blank);
  const worldsDown = said(await call("worlds"));
  check("worlds names the server's status", /^worlds: the world server answered 500, so the list isn't known/.test(worldsDown), worldsDown);
  const notGeometry = said(await call("measure", { id: "x" }));
  check("measure says the server's answer wasn't geometry, with its status",
    notGeometry === "measure: the world server answered 200 with something that isn't geometry, so nothing was measured", notGeometry);
  const geomError = said(await call("measure", { id: "err" }));
  check("measure gives the server's status and its error, with no quotes nested in ours",
    geomError === `measure: the world server answered 404 (no entity "err" in w), so nothing was measured`, geomError);
  agent.httpBase = goneBase;
  check("a snapshot from a server that's gone says no picture arrived",
    /^snapshot failed: no picture arrived from the world server \(.+\); try again/.test(said(await snapshotTool(agent))));
  check("worlds from a server that's gone says it didn't answer",
    /^worlds: the world server didn't answer \(.+\), so the list isn't known/.test(said(await call("worlds"))));
  const geomGone = said(await call("measure", { id: "x" }));
  check("measure from a server that's gone says it didn't answer",
    /^measure: the world server didn't answer \(.+\), so nothing was measured; try again in a moment$/.test(geomGone), geomGone);

  console.log("\nWORLD_VERB");
  const yaw = await call("world_verb", { verb: "place", args: { id: "t", yaw: "1.5" } });
  check("a raw place's yaw shows the value sent", yaw.isError === true && said(yaw) === 'refused place: raw place yaw must be a finite number — got "1.5"', said(yaw));
  check("a raw spawn's pos shows the value sent",
    said(await call("world_verb", { verb: "spawn", args: { pos: { x: 1 } } })) === 'refused spawn: raw spawn pos must be a finite [x,y,z] — got {"x":1}');
  check("a raw place's scale shows the value sent",
    rawShapeError("place", { id: "t", scale: "2" }) === 'raw place scale must be a finite number — got "2"');
  check("a raw dismount's pos shows the value sent",
    rawShapeError("dismount", { pos: [1, 2] }) === "raw dismount pos must be a finite [x,y,z] — got [1,2]");
  check("a raw light's pos shows the value sent",
    rawShapeError("light", { id: "lamp", pos: "up" }) === 'raw light pos must be a finite [x,y,z] — got "up"');
  check("a raw place in the typed tool's shape names both",
    rawShapeError("place", { id: "t", x: 1, y: 0, z: 2 }) === "raw place takes pos:[x,y,z], not separate x, y and z; the typed place tool takes those");
  const forwarded = await call("world_verb", { verb: "fly_away", args: {} });
  check("world_verb passes a verb it doesn't know on to the world",
    said(forwarded) === "sent fly_away" && JSON.stringify(agent.verbs.at(-1)) === JSON.stringify(["fly_away", {}]), said(forwarded));
  const desc = TOOLS.find((t: any) => t.name === "world_verb")!.description;
  const verbList = desc.slice(desc.indexOf("CLOSED by design —"), desc.indexOf("and the world refuses others"));
  check("world_verb's description lists every verb the world takes, in its verb list",
    verbList.length > 0 && Object.keys(VERB_NEEDS).every((v) => new RegExp(`\\b${v}\\b`).test(verbList)), Object.keys(VERB_NEEDS).filter((v) => !new RegExp(`\\b${v}\\b`).test(verbList)).join(", "));
  check("...and says the world, not the door, refuses the rest", desc.includes("the world refuses others") && !desc.includes("the door refuses"));

  console.log("\nSHOWN");
  check("a value left out reads nothing", shown(undefined) === "nothing");
  check("a string keeps its quotes, so it reads as a string", shown("5") === '"5"');
  check("numbers read as written, NaN included", shown(NaN) === "NaN" && shown(-1) === "-1");
  check("a BigInt and a cycle don't throw", shown(10n) === "10" && shown((() => { const o: any = {}; o.o = o; return o; })()) === "[object Object]");
  check("a long value is cut to 60 characters", shown("x".repeat(100)).length === 60 && shown("x".repeat(100)).endsWith("…"));
  const emoji = shown("😀".repeat(70));
  check("a cut never splits a character outside the BMP",
    Array.from(emoji).length === 60 && emoji.endsWith("😀…") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), emoji);

  console.log("\nWHISPER");
  const off = Bun.spawnSync(["bun", "-e",
    `const { handleTool } = await import(${JSON.stringify(new URL("../mcpl/tools.ts", import.meta.url).pathname)});
     const r = await handleTool({ agent: {} }, "whisper", { to: "x", text: "y" });
     console.log(r.content[0].text);`], { env: { ...process.env, EIDO_WHISPERS_ENABLED: "0" } });
  check("whispers turned off say so, and that calling again won't help",
    off.stdout.toString().trim() === "whispers are turned off on this door, so nothing was sent, and calling again won't change that", off.stdout.toString() + off.stderr.toString());

  console.log("\nBODY_STATE");
  const reader = new BodyStateReader(worldBase);
  const standing = (extra: Record<string, unknown> = {}) => ({ p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle", ...extra });
  const seen = (who: string, avatar: string, pose: unknown, extra: Record<string, unknown> = {}): any =>
    ({ who, avatar, generation: 1, self: false, connected: true, receivedAt: Date.now(), source: "unknown", pose, ...extra });
  const scene = (...bodies: any[]) => (id: string) => bodies.find((b) => b.who === id) ?? null;
  const ask = async (who: string, detail: unknown, observe: (id: string) => any, points?: unknown, windowMs: unknown = 0, r = reader): Promise<any> =>
    r.readWindow(who, detail as string, points, windowMs, observe);
  // a fresh observation each time it's read, so a slow run can't age it past BODY_STALE_MS
  const probe = (id: string) => id === "probe" ? seen("probe", "body.vrm", standing()) : null;
  check("window_ms out of range shows what was sent",
    (await ask("probe", "summary", probe, undefined, "1000")).error === `window_ms must be a whole number of milliseconds from 0 to 5000, so nothing was read; you sent "1000"`);
  const detailRefusal = `detail must be summary, bones, contacts or all, so nothing was read; you sent "everything"`;
  check("a detail it doesn't know shows what was sent, read once", (await ask("probe", "everything", probe)).error === detailRefusal);
  check("...and over a window", (await ask("probe", "everything", probe, undefined, 100)).error === detailRefusal);
  const pointsRefusal = "points must be a list of contact point names, as availablePoints has them, so nothing was read; ";
  const n = Object.keys(CONTACT_POINTS).length;
  check("points that aren't a list say what came", (await ask("probe", "contacts", probe, "hand_l")).error === pointsRefusal + 'you sent "hand_l"');
  const misnamed = await ask("probe", "contacts", probe, ["hand_l", "elbow_x"]);
  check("points names the entry that isn't a contact point, beside the names there are",
    misnamed.error === pointsRefusal + '"elbow_x" isn\'t one' && misnamed.availablePoints?.length === n, misnamed.error);
  check("...and a list longer than there are points says so",
    (await ask("probe", "contacts", probe, Array(n + 1).fill("hand_l"))).error === pointsRefusal + `it can name at most ${n}, and you sent ${n + 1}`);
  check("someone who isn't here is named, with where to look",
    (await ask("ghost", "summary", probe)).error === `nobody called "ghost" is here, so nothing was read; look lists who is present, and leaving who out reads your own body`);
  check("a body with no presence sample yet says calling again can work",
    (await ask("probe", "summary", scene(seen("probe", "body.vrm", null)))).error === "no presence sample has arrived for this body yet, so nothing of it was read; calling again in a moment can work");
  check("a position that isn't finite says it's their client's to mend",
    (await ask("probe", "summary", scene(seen("probe", "body.vrm", standing({ p: [NaN, 0, 0] }))))).error
      === "this body's published position or facing isn't a finite number, so nothing of it was read; it's in what its client publishes, so calling again changes nothing until that client publishes a usable one");
  check("...and so does a pose that isn't a map of bones, on someone else's body",
    (await ask("probe", "bones", scene(seen("probe", "body.vrm", standing({ pose: "kneel" }))))).error
      === "this body's published pose isn't a map of bones, so nothing of it was read; it's in what its client publishes, so calling again changes nothing until that client publishes a usable one");
  check("...but on your own body a position isn't sent anyone's way",
    (await ask("probe", "summary", scene(seen("probe", "body.vrm", standing({ p: [NaN, 0, 0] }), { self: true })))).error
      === "your published position or facing isn't a finite number, so nothing of your body was read");
  // the postures body_state's gate lets through, in the order the sentence gives them
  const evaluates = [...CLIP_SLOTS, "sitchair", ...SWIM_CLIPS].join(", ");
  const kneeling = await ask("probe", "contacts", scene(seen("probe", "body.vrm", standing({ clip: "kneel" }))));
  check("a posture it doesn't evaluate is named, beside the ones it does",
    kneeling.error === `probe's joints and contacts weren't read: the posture "kneel" isn't one body_state evaluates (it evaluates ${evaluates}, and ragdoll with published bones)`
      && kneeling.geometry?.reason === "posture_not_evaluated", kneeling.error);
  const ownKneeling = await ask("probe", "contacts", scene(seen("probe", "body.vrm", standing({ clip: "kneel" }), { self: true })));
  check("...and of your own body, as yours",
    ownKneeling.error === `your joints and contacts weren't read: the posture "kneel" isn't one body_state evaluates (it evaluates ${evaluates}, and ragdoll with published bones)`, ownKneeling.error);
  const downloadFailed = `the avatar's model couldn't be downloaded (the world server answered 404 for "missing.vrm")`;
  const missing = await ask("probe", "contacts", scene(seen("probe", "missing.vrm", standing())));
  check("a model that won't download says so, not that the posture isn't evaluated",
    missing.error === `probe's joints and contacts weren't read: ${downloadFailed}` && missing.detail === downloadFailed
      && missing.geometry?.reason === "posture_not_evaluated" && missing.posture === "idle", missing.error);
  const limpMissing = await ask("probe", "contacts", scene(seen("probe", "missing.vrm", standing({ clip: "ragdoll", pose: { hips: [0, 0, 0, 1] } }))));
  check("...and a limp body's says it too, as an error",
    limpMissing.error === `probe's joints and contacts weren't read: ${downloadFailed}` && limpMissing.geometry?.error === downloadFailed, JSON.stringify(limpMissing.error ?? null));
  const noHumanoid = await ask("probe", "contacts", scene(seen("probe", "flat.vrm", standing(), { self: true })));
  check("a model with no humanoid skeleton says calling again won't change that, of your own body",
    noHumanoid.error === "your joints and contacts weren't read: the avatar's model has no humanoid skeleton, so calling again won't change that", noHumanoid.error);
  check("a body whose avatar the world hasn't named says so",
    (await ask("probe", "contacts", scene(seen("probe", "", standing())))).error === "probe's joints and contacts weren't read: the world hasn't said which avatar this body wears");
  const loops = await ask("probe", "contacts", scene(seen("probe", "looped.vrm", standing())));
  check("a model whose bones loop says so, before anything is worked out from them",
    loops.error === "probe's joints and contacts weren't read: the avatar's model has a bone hierarchy that loops back on itself, so calling again won't change that", loops.error);
  const unanswered = await ask("probe", "contacts", probe, undefined, 0, new BodyStateReader(goneBase));
  check("a model the world server didn't answer for says it couldn't be downloaded, and why",
    /^probe's joints and contacts weren't read: the avatar's model couldn't be downloaded \(.+\)$/.test(unanswered.error ?? ""), unanswered.error);
  const fromSkeleton = ReachBody.fromSkeleton;
  (ReachBody as any).fromSkeleton = async () => null;   // as if this door's skeleton solver hadn't loaded
  const noSolver = await ask("probe", "contacts", probe, undefined, 0, new BodyStateReader(worldBase))
    .finally(() => { (ReachBody as any).fromSkeleton = fromSkeleton; });
  const unparsed = await ask("probe", "contacts", scene(seen("probe", "broken.vrm", standing())));
  check("a model file the parser can't read says so, with what the parser said",
    unparsed.error === "probe's joints and contacts weren't read: the avatar's model file couldn't be read as a model (not a GLB), so calling again won't change that", unparsed.error);
  const strolling = await ask("probe", "contacts", scene(seen("probe", "body.vrm", standing({ clip: "walk" }))));
  check("a posture whose clip can't be loaded says which, with the clip library's own words",
    strolling.error === "probe's joints and contacts weren't read: the walk animation couldn't be loaded (posture clip walk: HTTP 404)", strolling.error);
  let stroller = seen("stroller", "body.vrm", standing({ clip: "walk" }));
  // read() takes its first observation before its first await, so this posture changes while the skeleton loads
  const strolled = new BodyStateReader(worldBase).read("stroller", "contacts", undefined, (id: string) => id === "stroller" ? stroller : null);
  stroller = { ...stroller, pose: standing() };
  const restood = await strolled;
  check("...and one whose posture changed while that clip failed to load says so, as a load that succeeded does, and keeps the reading",
    restood.error === `stroller's joints and contacts weren't read: the posture changed from "walk" to "idle" while the skeleton loaded, so calling again can get them`
      && "reaches" in restood && "publishedRotations" in restood, JSON.stringify({ error: restood.error, keys: Object.keys(restood) }));
  // a swimmer is drawn over the idle clip, which this stand-in fetch refuses
  const swimFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => String(url).endsWith("/library/idle.vrma")
    ? new Response("no", { status: 404 }) : swimFetch(url, init)) as typeof fetch;
  const swimmer = await ask("probe", "contacts", scene(seen("probe", "body.vrm", standing({ clip: "swim" }))), undefined, 0, new BodyStateReader(worldBase))
    .finally(() => { globalThis.fetch = swimFetch; });
  check("a swimmer whose idle clip can't be loaded says it's the one a swimmer is drawn over",
    swimmer.error === "probe's joints and contacts weren't read: the idle animation a swimmer is drawn over couldn't be loaded (posture clip idle: HTTP 404)", swimmer.error);
  // a download that fails partway, after the server has answered
  const realFetch = globalThis.fetch;
  let sent = 0;   // the body's first bytes arrive, then the stream fails
  globalThis.fetch = (async (url: any, init?: any) => String(url).includes("/library/body.vrm")
    ? new Response(new ReadableStream({ pull(c) { if (sent++) c.error(new Error("the connection dropped")); else c.enqueue(new Uint8Array(16)); } }))
    : realFetch(url, init)) as typeof fetch;
  const cutShort = await ask("probe", "contacts", probe, undefined, 0, new BodyStateReader(worldBase)).finally(() => { globalThis.fetch = realFetch; });
  check("a model whose download fails partway says the download failed, and why",
    /^probe's joints and contacts weren't read: the avatar's model couldn't be downloaded \(.*the connection dropped.*\)$/.test(cutShort.error ?? ""), cutShort.error);
  const twoOnOne = await ask("probe", "bones", scene(seen("probe", "shared-neck.vrm", standing())));
  const near = (a: number[] | undefined, b: number[] | undefined) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  check("a model with two bones on one node keeps both, at one place",
    ["neck", "head"].every((n) => Object.hasOwn(twoOnOne.joints ?? {}, n)) && near(twoOnOne.joints?.neck?.position, twoOnOne.joints?.head?.position),
    JSON.stringify({ neck: twoOnOne.joints?.neck?.position, head: twoOnOne.joints?.head?.position }));
  const armless = await ask("probe", "contacts", scene(seen("probe", "one-armed.vrm", standing())));
  check("a contact point the rig can't place says why it can't",
    armless.contacts?.forearm_l?.reason === "this rig can't place it: it lacks the point's bone, or its bones don't form a body frame to place it in", JSON.stringify(armless.contacts?.forearm_l));
  check("a door whose skeleton solver didn't load says it can read no body, and who can help",
    noSolver.error === "probe's joints and contacts weren't read: this door couldn't load its skeleton solver, so it can evaluate no body, and calling again won't change that; if you need joints and contacts, ask whoever runs this door", noSolver.error);
  let turning = seen("turning", "body.vrm", standing());
  // read() takes its first observation before its first await, and its skeleton loads after this line runs
  const turned = new BodyStateReader(worldBase).read("turning", "contacts", undefined, (id: string) => id === "turning" ? turning : null);
  turning = { ...turning, pose: standing({ clip: "sit" }) };
  const turnedError = (await turned).error;
  check("a posture that changed while the skeleton loaded says calling again can get them",
    turnedError === `turning's joints and contacts weren't read: the posture changed from "idle" to "sit" while the skeleton loaded, so calling again can get them`, turnedError);
  let mine = seen("mine", "body.vrm", standing(), { self: true });
  const mineRead = new BodyStateReader(worldBase).read("mine", "contacts", undefined, (id: string) => id === "mine" ? mine : null);
  mine = { ...mine, pose: standing({ clip: "sit" }) };
  const mineError = (await mineRead).error;
  check("...and of your own body, as yours",
    mineError === `your joints and contacts weren't read: the posture changed from "idle" to "sit" while the skeleton loaded, so calling again can get them`, mineError);
  let kneeler = seen("kneeler", "body.vrm", standing());
  const knelt = new BodyStateReader(worldBase).read("kneeler", "contacts", undefined, (id: string) => id === "kneeler" ? kneeler : null);
  kneeler = { ...kneeler, pose: standing({ clip: "kneel" }) };
  const kneltError = (await knelt).error;
  check("a posture that became one it doesn't evaluate while the skeleton loaded is named, beside the ones it does",
    kneltError === `kneeler's joints and contacts weren't read: the posture "kneel" isn't one body_state evaluates (it evaluates ${evaluates}, and ragdoll with published bones)`, kneltError);
  const windowed: any = new BodyStateReader(worldBase);
  let pacer = seen("pacer", "body.vrm", standing());
  const oneRead = windowed.read.bind(windowed);
  let reads = 0;
  windowed.read = async (...args: any[]) => { const r = await oneRead(...args); if (++reads === 1) pacer = { ...pacer, generation: 2 }; return r; };
  const cut = await windowed.readWindow("pacer", "summary", undefined, 300, (id: string) => id === "pacer" ? pacer : null);
  check("a body that changed during the window says how far the measurement got",
    cut.error === "the body changed during the window (a new avatar or model, or a rejoin), so the measurement stopped after 1 sample; reading again measures it as it is now", cut.error);
  const twice: any = new BodyStateReader(worldBase);
  let strider = seen("strider", "body.vrm", standing());
  const readOnce = twice.read.bind(twice);
  let strides = 0;
  twice.read = async (...args: any[]) => { const r = await readOnce(...args); if (++strides === 2) strider = { ...strider, generation: 2 }; return r; };
  // the window stops at the third sample; its length only has to leave room for that
  const twoCut = await twice.readWindow("strider", "summary", undefined, 5000, (id: string) => id === "strider" ? strider : null);
  check("...after two samples, in the plural",
    twoCut.error === "the body changed during the window (a new avatar or model, or a rejoin), so the measurement stopped after 2 samples; reading again measures it as it is now", twoCut.error);
  const reacher = (who: string, reach: unknown, extra: Record<string, unknown> = {}) => seen(who, "body.vrm", standing({ reach }), extra);
  const facing = (who: string, avatar: string, extra: Record<string, unknown> = {}) => seen(who, avatar, standing({ p: [0, 0, 0.5], yaw: Math.PI, ...extra }));
  const towardAbsent = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } })));
  check("a reach toward a body that isn't here says later reads check it",
    towardAbsent.reachEvaluation?.rightHand?.why === "b's body can't be read here now (it isn't present), so this reach can't be checked; later reads check it again", JSON.stringify(towardAbsent.reachEvaluation));
  check("...and the reading points to reachEvaluation",
    towardAbsent.error === "some of a's held reaches couldn't be evaluated, so the joints and contacts here are incomplete; reachEvaluation says why for each limb", towardAbsent.error);
  const towardForearm = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "forearm_l" } } }), facing("b", "one-armed.vrm")));
  check("a point the target's rig lacks says this reach can't be solved, and where the points are",
    towardForearm.reachEvaluation?.rightHand?.why === `b's rig has no usable forearm_l, so this reach can't be solved; body_state {who: "b", detail: "contacts"} shows the points it has`, JSON.stringify(towardForearm.reachEvaluation));
  const towardFlat = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), facing("b", "flat.vrm")));
  check("a reach toward a body whose model can't be read gives the model's reason, and no wait",
    towardFlat.reachEvaluation?.rightHand?.why === "b's body can't be read here, so this reach can't be checked: the avatar's model has no humanoid skeleton, so calling again won't change that", JSON.stringify(towardFlat.reachEvaluation));
  const towardKneeling = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), facing("b", "body.vrm", { clip: "kneel" })));
  check("...and toward one in a posture body_state doesn't evaluate names the posture",
    towardKneeling.reachEvaluation?.rightHand?.why === `b's body can't be read here now (its posture "kneel" isn't one body_state evaluates), so this reach can't be checked until that changes`, JSON.stringify(towardKneeling.reachEvaluation));
  const towardLimp = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), facing("b", "body.vrm", { clip: "ragdoll" })));
  check("...and toward a limp one with no published bones says that's what it needs",
    towardLimp.reachEvaluation?.rightHand?.why === "b's body can't be read here now (it's limp with no published bones, and body_state reads a limp body from its bones), so this reach can't be checked until that changes", JSON.stringify(towardLimp.reachEvaluation));
  const towardStale = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }),
    { ...facing("b", "body.vrm"), receivedAt: Date.now() - 10_000 }));
  check("...toward one whose reading is stale says so",
    towardStale.reachEvaluation?.rightHand?.why === "b's body can't be read here now (its reading is stale), so this reach can't be checked; later reads check it again", JSON.stringify(towardStale.reachEvaluation));
  const towardUnreadable = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), facing("b", "body.vrm", { pose: "kneel" })));
  check("...toward one whose published pose can't be read gives that as the reason",
    towardUnreadable.reachEvaluation?.rightHand?.why === "b's body can't be read here, so this reach can't be checked: this body's published pose isn't a map of bones, so nothing of it was read; it's in what its client publishes, so calling again changes nothing until that client publishes a usable one", JSON.stringify(towardUnreadable.reachEvaluation));
  const towardNowhere = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), facing("b", "body.vrm", { p: [NaN, 0, 0.5] })));
  check("...toward one whose position isn't finite gives that",
    towardNowhere.reachEvaluation?.rightHand?.why === "b's body can't be read here, so this reach can't be checked: this body's published position or facing isn't a finite number, so nothing of it was read; it's in what its client publishes, so calling again changes nothing until that client publishes a usable one", JSON.stringify(towardNowhere.reachEvaluation));
  const seatless = "nothing of b's body was read, since their seat can't be placed: unknown id (not a thing, and not mounted)";
  const towardSeatless = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), { ...facing("b", "body.vrm"), error: seatless }));
  check("...toward one whose seat can't be placed gives that",
    towardSeatless.reachEvaluation?.rightHand?.why === `b's body can't be read here, so this reach can't be checked: ${seatless}`, JSON.stringify(towardSeatless.reachEvaluation));
  const towardSampleless = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } }), { ...facing("b", "body.vrm"), pose: null }));
  check("...toward one with no sample yet says so",
    towardSampleless.reachEvaluation?.rightHand?.why === "b's body can't be read here, so this reach can't be checked: no presence sample has arrived for this body yet, so nothing of it was read; calling again in a moment can work", JSON.stringify(towardSampleless.reachEvaluation));
  // read() takes every body's first observation before its first await, so this one's first sample arrives while the skeletons load
  const arriving = new Map<string, any>([["a", reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } } })], ["b", { ...facing("b", "body.vrm"), pose: null }]]);
  const arrival = new BodyStateReader(worldBase).read("a", "all", undefined, (id: string) => arriving.get(id) ?? null);
  arriving.set("b", facing("b", "body.vrm"));
  const arrived = await arrival;
  check("...but a target whose first sample arrives while the skeletons load is read with it",
    arrived.reachEvaluation?.rightHand?.ok === true, JSON.stringify(arrived.reachEvaluation));
  // ...as do a limp body's first bones, and a first sample in another posture than the idle one it loaded as
  const arrivals = new Map<string, any>([["a", reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } }, leftHand: { t: { who: "c", point: "shoulder_l" } } })],
    ["b", facing("b", "body.vrm", { clip: "ragdoll" })], ["c", { ...facing("c", "body.vrm"), pose: null }]]);
  const arriving2 = new BodyStateReader(worldBase).read("a", "all", undefined, (id: string) => arrivals.get(id) ?? null);
  arrivals.set("b", facing("b", "body.vrm", { clip: "ragdoll", pose: { hips: [0, 0, 0, 1] } }));
  arrivals.set("c", facing("c", "body.vrm", { clip: "walk" }));
  const arrived2 = await arriving2;
  check("...and a limp target whose bones arrive while the skeletons load is read with them",
    arrived2.reachEvaluation?.rightHand?.ok === true, JSON.stringify(arrived2.reachEvaluation));
  check("...but one whose first sample comes in another posture says it changed, for later reads",
    arrived2.reachEvaluation?.leftHand?.why === "c's body can't be read here now (it changed while its skeleton loaded), so this reach can't be checked; later reads check it again", JSON.stringify(arrived2.reachEvaluation));
  // read() takes every body's first observation before its first await, so these change while the skeletons load
  const moving = new Map<string, any>([["a", reacher("a", { rightHand: { t: { who: "b", point: "shoulder_l" } }, leftHand: { t: { who: "d", point: "shoulder_l" } },
      rightFoot: { t: { who: "i", point: "shoulder_l" } }, leftFoot: { t: { who: "n", point: "shoulder_l" } } })],
    ["b", facing("b", "body.vrm")], ["d", facing("d", "body.vrm")], ["i", facing("i", "flat.vrm")], ["n", facing("n", "body.vrm", { clip: "walk" })]]);
  const whileLoading = new BodyStateReader(worldBase).read("a", "all", undefined, (id: string) => moving.get(id) ?? null);
  moving.delete("b"); moving.set("d", { ...moving.get("d"), generation: 2 }); moving.delete("i");
  const changing = await whileLoading;
  check("...toward one that left while the skeletons loaded says so",
    changing.reachEvaluation?.rightHand?.why === "b's body can't be read here now (it left), so this reach can't be checked; later reads check it again", JSON.stringify(changing.reachEvaluation));
  check("...and toward one that changed while they loaded says that",
    changing.reachEvaluation?.leftHand?.why === "d's body can't be read here now (it changed while its skeleton loaded), so this reach can't be checked; later reads check it again", JSON.stringify(changing.reachEvaluation));
  check("...and toward one whose load failed, and that left, says it left rather than what its model's load said",
    changing.reachEvaluation?.rightFoot?.why === "i's body can't be read here now (it left), so this reach can't be checked; later reads check it again", JSON.stringify(changing.reachEvaluation?.rightFoot));
  check("...while one whose clip couldn't be loaded, and that stayed as it was, gives the clip's reason",
    changing.reachEvaluation?.leftFoot?.why === "n's body can't be read here, so this reach can't be checked: the walk animation couldn't be loaded (posture clip walk: HTTP 404)", JSON.stringify(changing.reachEvaluation?.leftFoot));
  // ...and the rest of what can change then: the model, the clip, a posture body_state doesn't evaluate, and a body whose load failed
  const shifting = new Map<string, any>([["a", reacher("a", { rightHand: { t: { who: "e", point: "shoulder_l" } }, leftHand: { t: { who: "f", point: "shoulder_l" } },
      rightFoot: { t: { who: "g", point: "shoulder_l" } }, leftFoot: { t: { who: "h", point: "shoulder_l" } } })],
    ["e", facing("e", "body.vrm")], ["f", facing("f", "body.vrm")], ["g", facing("g", "body.vrm")], ["h", facing("h", "flat.vrm")]]);
  const whileShifting = new BodyStateReader(worldBase).read("a", "all", undefined, (id: string) => shifting.get(id) ?? null);
  shifting.set("e", facing("e", "one-armed.vrm")); shifting.set("f", facing("f", "body.vrm", { clip: "walk" }));
  shifting.set("g", facing("g", "body.vrm", { clip: "kneel" })); shifting.set("h", { ...facing("h", "body.vrm"), generation: 2 });
  const shifted = await whileShifting;
  const changedWhy = (who: string) => `${who}'s body can't be read here now (it changed while its skeleton loaded), so this reach can't be checked; later reads check it again`;
  check("...toward one whose model changed then says it changed", shifted.reachEvaluation?.rightHand?.why === changedWhy("e"), JSON.stringify(shifted.reachEvaluation?.rightHand));
  check("...and one whose posture did", shifted.reachEvaluation?.leftHand?.why === changedWhy("f"), JSON.stringify(shifted.reachEvaluation?.leftHand));
  check("...but one now in a posture body_state doesn't evaluate names that posture",
    shifted.reachEvaluation?.rightFoot?.why === `g's body can't be read here now (its posture "kneel" isn't one body_state evaluates), so this reach can't be checked until that changes`, JSON.stringify(shifted.reachEvaluation?.rightFoot));
  check("...and one whose load failed, and that changed, says it changed rather than what its old model said",
    shifted.reachEvaluation?.leftFoot?.why === changedWhy("h"), JSON.stringify(shifted.reachEvaluation?.leftFoot));
  // a failed load's cause gives way to a change in the model alone, the generation alone, or the clip alone
  const refailing = new Map<string, any>([["a", reacher("a", { rightHand: { t: { who: "j", point: "shoulder_l" } }, leftHand: { t: { who: "k", point: "shoulder_l" } },
      rightFoot: { t: { who: "l", point: "shoulder_l" } }, leftFoot: { t: { who: "m", point: "shoulder_l" } } })],
    ["j", facing("j", "flat.vrm")], ["k", facing("k", "flat.vrm")], ["l", facing("l", "body.vrm", { clip: "walk" })], ["m", facing("m", "body.vrm", { clip: "walk" })]]);
  const whileRefailing = new BodyStateReader(worldBase).read("a", "all", undefined, (id: string) => refailing.get(id) ?? null);
  refailing.set("j", facing("j", "body.vrm")); refailing.set("k", { ...facing("k", "flat.vrm"), generation: 2 }); refailing.set("l", facing("l", "body.vrm"));
  refailing.set("m", facing("m", "body.vrm", { clip: "kneel" }));
  const refailed = await whileRefailing;
  check("...as one whose model changed after its load failed", refailed.reachEvaluation?.rightHand?.why === changedWhy("j"), JSON.stringify(refailed.reachEvaluation?.rightHand));
  check("...or whose generation did", refailed.reachEvaluation?.leftHand?.why === changedWhy("k"), JSON.stringify(refailed.reachEvaluation?.leftHand));
  check("...or whose clip did, after its clip couldn't be loaded", refailed.reachEvaluation?.rightFoot?.why === changedWhy("l"), JSON.stringify(refailed.reachEvaluation?.rightFoot));
  check("...but one that moved to a posture body_state doesn't evaluate names that posture",
    refailed.reachEvaluation?.leftFoot?.why === `m's body can't be read here now (its posture "kneel" isn't one body_state evaluates), so this reach can't be checked until that changes`, JSON.stringify(refailed.reachEvaluation?.leftFoot));
  const longId = "p".repeat(64);
  const towardLong = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: longId, point: "forearm_l" } } }), facing(longId, "one-armed.vrm")));
  check("a copyable body_state call keeps a long participant id whole",
    towardLong.reachEvaluation?.rightHand?.why?.includes(`body_state {who: "${longId}", detail: "contacts"}`), JSON.stringify(towardLong.reachEvaluation));
  const inFrame = await ask("a", "all", scene(reacher("a", { rightHand: { t: { p: [0, 1, 0.3], space: "b" } } }, { self: true }),
    seen("b", "body.vrm", standing(), { receivedAt: Date.now() - 10_000 })));
  check("a point in a stale body's frame says later reads place it",
    inFrame.reachEvaluation?.rightHand?.why === "b's body has no current reading on this door, so a point in their frame can't be placed now; later reads place it again", JSON.stringify(inFrame.reachEvaluation));
  const inUnreadFrame = await ask("a", "all", scene(reacher("a", { rightHand: { t: { p: [0, 1, 0.3], space: "b" } } }, { self: true }),
    seen("b", "body.vrm", standing({ pose: "kneel" }))));
  check("...but a point in the frame of one whose reading can't be read gives that reason, with no wait",
    inUnreadFrame.reachEvaluation?.rightHand?.why === "b's body can't be read here, so a point in their frame can't be placed: this body's published pose isn't a map of bones, so nothing of it was read; it's in what its client publishes, so calling again changes nothing until that client publishes a usable one", JSON.stringify(inUnreadFrame.reachEvaluation));
  check("...and reading your own body says clear_reach releases one",
    inFrame.error === "some of your held reaches couldn't be evaluated, so the joints and contacts here are incomplete; reachEvaluation says why for each limb, and clear_reach releases one", inFrame.error);
  const chainless = await ask("c", "all", scene(seen("c", "one-armed.vrm", standing({ reach: { leftHand: { t: { p: [0.3, 1.2, 0.3] } } } }))));
  check("a limb the rig can't move says another limb may",
    /^this body's rig has no measurable leftHand chain \(.+\), so the solver can't move this limb; another limb may have one$/.test(chainless.reachEvaluation?.leftHand?.why ?? ""), JSON.stringify(chainless.reachEvaluation));
  const loop = await ask("a", "all", scene(reacher("a", { rightHand: { t: { who: "b", point: "hand_l" } } }),
    facing("b", "body.vrm", { reach: { leftHand: { t: { who: "a", point: "hand_r" } } } })));
  check("a loop of reaches keeps its code in body_state", loop.reachEvaluation?.rightHand?.why === "cyclic-reach", JSON.stringify(loop.reachEvaluation));
  // a chain of reaches, each body reaching for the next, 66 bodies long
  const chain = Array.from({ length: 66 }, (_, i) => reacher(`l${i}`, i < 65 ? { rightHand: { t: { who: `l${i + 1}`, point: "shoulder_l" } } } : undefined));
  const linked = await ask("l0", "contacts", scene(...chain));
  check("reaches that link more than 64 bodies say one reading follows at most 64",
    linked.error === "l0's joints and contacts weren't read: the reaches around this body link more than 64 bodies, and one reading follows at most 64", linked.error);
  const rider: any = new WorldAgent({ name: "rider", world: "w" });
  rider.selfObservedAt = Date.now();
  rider.mounts.set("rider", { to: "nowhere", slot: "seat" });
  const unseated = await rider.bodyState("rider");
  check("your seat that can't be placed says standing gets you off it, once this body has rejoined",
    unseated.error === `nothing of your body was read, since your seat can't be placed: unknown id (not a thing, and not mounted); posture {kind: "stand"} gets you off it once this body has rejoined the world`, unseated.error);
  rider.joined = true;
  const seatedJoined = await rider.bodyState("rider");
  rider.joined = false;
  check("...and while it's joined, that standing gets you off it",
    seatedJoined.error === `nothing of your body was read, since your seat can't be placed: unknown id (not a thing, and not mounted); posture {kind: "stand"} gets you off it`, seatedJoined.error);
  rider.people.set("perch", { id: "perch", avatar: "body.vrm", pose: standing(), agent: false, observedAt: Date.now(), bodyGeneration: 1 });
  rider.mounts.set("perch", { to: "nowhere", slot: "seat" });
  const perched = await rider.bodyState("perch");
  check("...and someone else's says only that nothing was read",
    perched.error === "nothing of perch's body was read, since their seat can't be placed: unknown id (not a thing, and not mounted)", perched.error);
  rider.close();

  console.log("\nREACH");
  check("reach with no target shows the forms",
    said(await call("reach", {})) === "reach needs a target, so nothing was reached: point for a contact point on your own body, who and point for one on someone else's, or x, y and z as numbers for a point (space 'world' by default, 'self' for your own frame, or a participant id for theirs)");
  const halfPoint = said(await call("reach", { x: "1", y: 2 }));
  check("...and a point it couldn't use shows what came", /, or x, y and z as numbers for a point .*; you sent x "1", y 2, z nothing$/.test(halfPoint), halfPoint);
  const pointless = said(await call("reach", { who: "bo" }));
  check("reaching for someone without a point shows the call",
    /^reaching for someone needs point too, the contact point on them, so nothing was reached: reach \{who: "bo", point: "shoulder_l"\}; the points are hand_l, /.test(pointless), pointless);
  const longWho = said(await call("reach", { who: "q".repeat(64) }));
  check("...with a long participant id kept whole in it",
    longWho.includes(`reach {who: "${"q".repeat(64)}", point: "shoulder_l"}`), longWho);
  const elbow = said(await call("reach", { point: "elbow_x" }));
  check("a contact point that isn't one is named, with the ones there are",
    /^there's no contact point called "elbow_x", so nothing was reached; the points are hand_l, /.test(elbow), elbow);
  const hand: any = new WorldAgent({ name: "hand", world: "w" });
  hand.reachBodies.set(hand.avatar, null);   // its own model didn't load
  check("an unknown limb is named, with the ones there are",
    (await hand.reach("tentacle", { p: [0, 1, 0] })).text === `there's no limb called "tentacle", so nothing was reached; limb takes leftHand, rightHand, leftFoot or rightFoot`);
  check("...and clear_reach says nothing was released",
    hand.releaseReach("tentacle").text === `there's no limb called "tentacle", so nothing was released; limb takes leftHand, rightHand, leftFoot or rightFoot`);
  const unusable = (await hand.reach("rightHand", { who: "", point: "x" })).text;
  check("a target reach can't use says nothing was reached, and shows both forms",
    /^reach couldn't use that target, so nothing was reached: pass \{who, point\}/.test(unusable), unusable);
  const own = (await hand.reach("rightHand", { who: "hand", point: "head_top" })).text;
  check("a reach this door can't check says whose body couldn't be set up: your own",
    own === "right hand reaching toward your head_top — streamed, but unverified: your body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach", own);
  const towardPoint = (await hand.reach("leftHand", { p: [0, 1, 0.3] })).text;
  check("...as the reacher, toward a point",
    /— streamed, but unverified: your body couldn't be set up on this door \(its model, or the door's skeleton solver, didn't load\), so it can't check this reach$/.test(towardPoint), towardPoint);
  hand.people.set("bo", { id: "bo", avatar: "bo.vrm", pose: standing({ p: [0, 0, 0.5] }) });
  hand.reachBodies.set("bo.vrm", null);
  const theirs = (await hand.reach("leftHand", { who: "bo", point: "shoulder_l" })).text;
  check("...or someone else's",
    theirs === "left hand reaching toward bo's shoulder_l — streamed, but unverified: bo's body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach", theirs);
  const looped = { t: { who: "bo", point: "hand_l" } };
  hand.joined = true;
  hand.reachReading = { reaches: { rightHand: looped }, reachEvaluation: { rightHand: { ok: false, why: "cyclic-reach", reached: false } } };
  const verdict = hand.solveReachEntry("rightHand", looped);
  check("a loop of reaches is said in words in reach's reply",
    verdict.err === "it depends on a loop of reaches (limbs reaching for limbs that reach back), so it can't be solved until a limb in the loop lets go", JSON.stringify(verdict));
  const elsewhere = { t: { who: "bo", point: "shoulder_l" } };
  const notHere = "bo's body can't be read here now (it isn't present), so this reach can't be checked; later reads check it again";
  hand.reachReading = { reaches: { leftHand: elsewhere }, reachEvaluation: { leftHand: { ok: false, why: notHere, reached: false } } };
  const passed = hand.solveReachEntry("leftHand", elsewhere);
  check("...and any other reason body_state gives comes through as it is", passed.err === notHere, JSON.stringify(passed));
  hand.joined = false;
  hand.close();

  console.log("\nTHE BODY");
  const bodies: any[] = [];
  const ag: any = new WorldAgent({ name: "nj", world: "w" });
  bodies.push(ag);
  const thrown = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };
  const between = thrown(() => ag.verb("say", { text: "hi" }));
  check("a verb sent between connections says the body rejoins once the world answers",
    between === "this body is reconnecting to the world, so nothing was sent; it rejoins on its own once the world answers, so try again shortly", between);
  ag.close();
  const ended = thrown(() => ag.verb("say", { text: "hi" }));
  check("a verb sent after the body is closed says calling again won't help",
    /has ended for good .* so nothing was sent, and calling again won't change that$/.test(ended), ended);
  const endedMod = thrown(() => ag.sendMod("world-bans"));
  check("...and so does a moderation message", /has ended for good/.test(endedMod), endedMod);

  const pilot: any = new WorldAgent({ name: "pilot", world: "w" });
  bodies.push(pilot);
  const wingBones = ["Hip", "Spine02", "Head", "L_Wing_Upper", "L_Wing_Upper_1", "R_Wing_Upper", "R_Wing_Upper_1", "L_Wing_Lower", "R_Wing_Lower"];
  const winged = (a: any) => { a.bodyBoneNames = wingBones; a.loadBodyBones = async () => wingBones; a.myRights = { role: "builder", fly: true }; return a; };
  winged(pilot);
  pilot.wingsFolded = true;
  // The acts answer { ok, text }; these checks read the words.
  const folded = await pilot.takeOff();
  check("take-off with folded wings says how to open them",
    !folded.ok && folded.text === "still standing — wings folded; unfold_wings opens them", JSON.stringify(folded));
  pilot.wingsFolded = false;
  const up = (await pilot.takeOff()).text;
  const stay = (await pilot.foldWings(true)).text;
  check("a refused fold doesn't repeat the wings' state before the reason",
    /^took off/.test(up) && /^wings stay as they are — \S/.test(stay) && !/wings stay (open|limp|folded) —/.test(stay), `${up} / ${stay}`);
  const status = pilot.flightStatus();
  check("flight_status gives the wings' state the fold's sentence leaves out", /\bwings OPEN\b/.test(status), status);
  pilot.applyEntry({ verb: "grant", args: { id: "pilot", fly: false }, actor: "owner", ts: Date.now() }, true);
  const notice = pilot.inbox.at(-1);
  check("a withdrawal reads as the granter's act, with what follows and who can undo it",
    `* ${notice?.who} ${notice?.text}` === "* owner withdrew your flight, so your next flight action will be refused until the world's owner grants it again",
    JSON.stringify(notice));
  pilot.flight = { ...pilot.flight, phase: "GROUND", wings: "LIMP" };
  const limp = (await pilot.foldWings(true)).text;
  check("a fold refused for limp wings doesn't name the state twice",
    /^wings stay as they are — /.test(limp) && !/^wings stay limp/.test(limp), limp);
  const aloft: any = winged(new WorldAgent({ name: "aloft", world: "w" }));
  bodies.push(aloft);
  await aloft.takeOff();
  aloft.acceptEffectiveRights({ role: "builder", fly: false }, "world");
  const fall = aloft.inbox.at(-1);
  check("a withdrawal while aloft says the body is coming down, and how to fly again",
    `* ${fall?.who} ${fall?.text}` === "* world withdrew your flight while you were aloft, so you're coming down under the falling-leaf reflex; you can fly again once the world's owner grants it",
    JSON.stringify(fall));

  console.log("\nTHE CONNECTION");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await sleep(100); return ok(); };

  // A stand-in world on a WebSocket: each body's name picks how the join is answered.
  const snapshot = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "snapshot", state: null, entries: [], present: [], ...extra });
  const joins = new Map<string, number>();
  const answers: Record<string, (ws: any, n: number) => void> = {
    kicked: (ws) => { ws.send(snapshot()); setTimeout(() => ws.close(4006, "kicked"), 200); },
    denied: (ws) => ws.close(4005, "refused"),
    "refused-silently": (ws) => ws.send(JSON.stringify({ type: "error" })),
    "refused-blank": (ws) => ws.send(JSON.stringify({ type: "error", error: "" })),
    "refused-in-words": (ws) => ws.send(JSON.stringify({ type: "error", error: "you are banned from this world." })),
    late: (ws) => setTimeout(() => ws.send(snapshot()), 9000),
    dropped: (ws, n) => {
      if (n > 1) { setTimeout(() => ws.send(snapshot()), 9000); return; }
      ws.send(snapshot()); setTimeout(() => ws.close(1001, "restarting"), 300);
    },
    grounded: (ws) => ws.send(snapshot({ yourRights: { role: "builder", fly: false } })),
  };
  const wsWorld = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.type !== "join") return;
        const n = (joins.get(m.id) ?? 0) + 1;
        joins.set(m.id, n);
        answers[m.id]?.(ws, n);
      },
    },
  });
  const wsUrl = `ws://127.0.0.1:${wsWorld.port}/ws`;
  const body = (name: string) => { const a: any = new WorldAgent({ name, world: "w", url: wsUrl }); bodies.push(a); return a; };
  const outcome = (p: Promise<unknown>) => p.then(() => "joined", (e: Error) => e.message);
  // The two slow ones start first and are checked last.
  const late = body("late"), dropped = body("dropped");
  const lateJoin = outcome(late.connect());
  const droppedJoin = outcome(dropped.connect());
  for (const [name, want] of [
    ["refused-silently", "the world refused the join without giving a reason"],
    ["refused-blank", "the world refused the join without giving a reason"],
    ["refused-in-words", "the world refused the join: you are banned from this world"],
  ]) {
    const a = body(name);
    const got = await outcome(a.connect());
    check(`a join the world refuses says so, in its words if it gave any (${name})`, got === want && a.closed === true, got);
  }
  const kicked = body("kicked");
  const kickedJoin = await outcome(kicked.connect());
  await until(() => kicked.closed, 3000);
  const afterKick = thrown(() => kicked.verb("say", { text: "hi" }));
  check("a body the world removes (4006) has ended for good, and calling again won't help",
    kickedJoin === "joined" && kicked.closed === true && /has ended for good .* calling again won't change that$/.test(afterKick), `${kickedJoin} / ${afterKick}`);
  const denied = body("denied");
  denied.connect().catch(() => {});
  await until(() => denied.closed, 3000);
  const afterDenial = thrown(() => denied.verb("say", { text: "hi" }));
  check("a body whose join the world refuses (4005) has ended for good too",
    denied.closed === true && /has ended for good .* calling again won't change that$/.test(afterDenial), afterDenial);
  const grounded = winged(body("grounded"));
  await grounded.takeOff();
  const groundedJoin = await outcome(grounded.connect());
  const groundedNotice = grounded.inbox.at(-1);
  check("rights withdrawn in a snapshot read as the world's act",
    groundedJoin === "joined" && `* ${groundedNotice?.who} ${groundedNotice?.text}`.startsWith("* world withdrew your flight while you were aloft"), `${groundedJoin} / ${JSON.stringify(groundedNotice)}`);
  check("a join the world answers is a join", await droppedJoin === "joined");
  await until(() => !dropped.joined, 3000);
  const reconnecting = thrown(() => dropped.verb("say", { text: "hi" }));
  check("a body whose connection dropped says it's reconnecting",
    /^this body is reconnecting to the world, so nothing was sent; it rejoins on its own once the world answers/.test(reconnecting), reconnecting);
  const lateOutcome = await lateJoin;
  check("a join the world doesn't answer within 8 seconds says so", lateOutcome === "the world didn't answer the join within 8 seconds", lateOutcome);
  check("...and the world's late answer still joins the body", await until(() => late.joined, 4000));
  check("a reconnecting body rejoins on its own once the world answers, though its own join timed out first",
    await until(() => dropped.joined, 6000) && joins.get("dropped") === 2 && thrown(() => dropped.verb("say", { text: "back" })) === "",
    `joined ${dropped.joined}, joins ${joins.get("dropped")}`);
  for (const a of bodies) a.close();
  wsWorld.stop(true);
} finally {
  world.stop(true);
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
