// The door's refusals say what didn't happen, why, and what to do instead,
// with the agent's own value where that was the problem.
// Run: bun tools/door-wording-test.ts
import { mkCheck } from "./harness.ts";
import { handleTool, snapshotTool, TOOLS } from "../mcpl/tools.ts";
import { rawShapeError } from "../mcpl/shape.ts";
import { shown } from "../shared/shown.js";
import { VERB_NEEDS } from "../server/rights.ts";
import { WorldAgent } from "../mcpl/agent.ts";

const { check, tally } = mkCheck();
const said = (r: any) => String(r?.content?.[0]?.text ?? "");

// A stand-in world server: just the routes these tools read.
let roster: { name: string; path: string }[] = [{ name: "aria", path: "avatars/aria.vrm" }, { name: "bo", path: "avatars/bo.vrm" }];
const world = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/avatars") return Response.json(roster);
  if (u.pathname === "/library-models") return Response.json([]);
  if (u.pathname === "/snap") return new Response('no renderer is currently serving world "w"', { status: 503 });
  if (u.pathname === "/worlds") return new Response("broken", { status: 500 });
  if (u.pathname === "/geom") return u.searchParams.get("id") === "err"
    ? Response.json({ error: "no geometry for that id" }, { status: 404 })
    : new Response("not json");
  return new Response("no", { status: 404 });
} });
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
  const emptyLib = said(await call("spawn", { lib: "", query: "zzz" }));
  check("an empty lib, which skips the search, says the lib named no model",
    emptyLib === `spawn's lib was "", which names no model, so nothing was spawned; pass a model's path, or leave lib out and pass query to search the library`, emptyLib);
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
  check("a snapshot the server refused quotes its answer and status",
    snap === `snapshot: no picture was taken; the world server answered "no renderer is currently serving world "w"" (503), so try again in a while`, snap);
  const worldsDown = said(await call("worlds"));
  check("worlds names the server's status", /^worlds: the world server answered 500, so the list isn't known/.test(worldsDown), worldsDown);
  const notGeometry = said(await call("measure", { id: "x" }));
  check("measure says the server's answer wasn't geometry, with its status",
    notGeometry === "measure: the world server answered 200 with something that isn't geometry, so nothing was measured", notGeometry);
  const geomError = said(await call("measure", { id: "err" }));
  check("measure quotes the server's error and status",
    geomError === `measure: the world server answered "no geometry for that id" (404), so nothing was measured`, geomError);
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
  check("take-off with folded wings says how to open them",
    await pilot.takeOff() === "still standing — wings folded; unfold_wings opens them");
  pilot.wingsFolded = false;
  const up = await pilot.takeOff();
  const stay = await pilot.foldWings(true);
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
  const limp = await pilot.foldWings(true);
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
