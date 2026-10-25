// tools/protocol/video-check.ts — the `video` component, rung one of the screen (projector design revision 2, approved by
// Mica 2026-10-20 into the trial ladder): what it means (shared/video.js), the door (the source-id grammar, admission,
// a fork's carry), what look says (the appliance's source state, never a viewer's playback), and the sequencer's half
// (server/videosources.ts: the operator registry, the appliance poll, the WHEP sessions it brokers), against a FAKE
// appliance that records every request, so what reaches the appliance and what reaches a viewer is checked exactly.
//   bun tools/protocol/video-check.ts                 every case
//   bun tools/protocol/video-check.ts --only M2,B3    just those
//   bun tools/protocol/video-check.ts --tree <dir>    against another checkout's shared/ + server/ (a mutant, the base)
//   bun tools/protocol/video-check.ts --control       #260's head (video reserved): every M/B case must be red, K green
//   bun tools/protocol/video-check.ts --mutants       remove each gate in a copy of the tree: its cases go red
// Cases:
//   M  the component: its meaning, the door, look
//   B  the broker: registry, source state, sessions
//   K  kept (green at base and now)
// The real appliance (mediamtx + a synthetic OBS feed, two browsers) is tools/video-probe.ts: this file is what can be
// checked without a browser, exactly.
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree, archiveTo } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "9d60447f";   // #260's head video is stacked on (restacked 10-25 from b731a8ec, at Mica's approved head)

// [name, file, find, replace, cases that must turn red]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the door refuses a source this server hasn't admitted", "shared/protocol/authority/checks.js", "if (!carry && !isAdmittedSource(v.source))", "if (false)", ["M2", "M3"]],
  ["a fork's copy carries an unadmitted source (no silent loss)", "shared/protocol/authority/checks.js", "if (!carry && !isAdmittedSource(v.source))", "if (!isAdmittedSource(v.source))", ["M4"]],
  ["nothing is admitted until the server says (fail closed)", "shared/video.js", "export const isAdmittedSource = (id) => typeof id === 'string' && ADMITTED.has(id);", "export const isAdmittedSource = (id) => typeof id === 'string' && (ADMITTED.size === 0 || ADMITTED.has(id));", ["M3"]],
  ["a source is an id, never a URL", "shared/video.js", "if (/^[a-z][a-z0-9+.-]*:/i.test(id) || id.includes('/') || id.includes('.')) return", "if (false) return", ["M1"]],
  ["the id grammar", "shared/video.js", "export const VIDEO_SOURCE_ID = /^[a-z][a-z0-9-]{0,39}$/;", "export const VIDEO_SOURCE_ID = /^.+$/;", ["M1", "B1"]],
  ["a stale observation reads as unknown", "shared/video.js", "if (age > SOURCE_STATE_FRESH_MS) return { state: 'unknown', ageS };", "", ["M5"]],
  ["look judges freshness on the clock the observation was stamped on", "shared/says.js", "describeVideo(c.video, sourceStateOf(c.video.source), Date.now())", "describeVideo(c.video, sourceStateOf(c.video.source), Number.isFinite(now) ? now : Date.now())", ["M5"]],
  ["the inspector draws the Video card", "shared/editschema.js", "groups.push({ group: 'video', label: 'video', types: ['video'], fields });", "", ["M8"]],
  ["Add Video takes a source by value", "shared/editschema.js", "return { ops: [OP.set(id, 'video', n.video)], errors: [] };", "return { ops: [], errors: ['no'] };", ["M8"]],
  ["near can't pass radius", "shared/protocol/authority/checks.js", "if ((comp === \"sound\" || comp === \"video\") && obj", "if ((comp === \"sound\") && obj", ["M6"]],
  ["a registry entry may not carry a credential in its URL", "server/videosources.ts", "&& !u.username && !u.password ? u.toString() : null", "? u.toString() : null", ["B1"]],
  ["the broker reads the sequencer's view (components on the record), not a fold record's c", "server/videosources.ts", "const videoOf = (world: any, entity: string): any => world?.state?.entities?.[entity]?.video;", "const videoOf = (world: any, entity: string): any => world?.state?.entities?.[entity]?.c?.video;", ["B3", "B4", "B5"]],
  ["the broker adds the operator's read credential", "server/videosources.ts", "headers: { \"content-type\": \"application/sdp\", ...(basic(src) ? { authorization: basic(src)! } : {}) }", "headers: { \"content-type\": \"application/sdp\" }", ["B3"]],
  ["one offer every OFFER_GAP_MS", "server/videosources.ts", "if (now - last < OFFER_GAP_MS) return", "if (false) return", ["B4"]],
  ["at most VIEWER_SESSION_CAP sessions a viewer", "server/videosources.ts", "if (screens.size >= VIEWER_SESSION_CAP) return", "if (false) return", ["B4", "B8"]],
  ["an offer at the appliance holds its slot", "server/videosources.ts", "  for (const e of inFlight.keys()) screens.add(e);\n", "", ["B8"]],
  ["an answer for a replaced offer is closed when it lands", "server/videosources.ts", "if (inFlight.get(msg.id) !== token) {", "if (false) {", ["B8"]],
  ["a new session for a screen replaces the viewer's older one there", "server/videosources.ts", "  for (const old of [...SESSIONS.values()]) if (old.client === c && old.entity === msg.id) await closeSession(old, \"replaced by a newer offer\");\n", "", ["B4", "B8"]],
  ["a session ends when its screen's video changes", "server/videosources.ts", "else if (boundOf(s.world, s.entity) !== s.bound) await closeSession(s, \"the screen's video changed\");", "", ["B5"]],
  ["a session ends when its viewer leaves", "server/videosources.ts", "if (!s.world?.clients?.has?.(s.client) || s.client.world !== s.world) await closeSession(s, \"the viewer left\");\n    else ", "", ["B5"]],
  ["a revoke closes the source's sessions", "server/videosources.ts", "for (const s of [...SESSIONS.values()]) if (s.source === id) void closeSession(s, \"the operator revoked this source\");", "", ["B6"]],
  ["closing a session deletes the appliance's resource", "server/videosources.ts", "if (s.resource) { try { await fetch(s.resource, { method: \"DELETE\"", "if (false) { try { await fetch(s.resource, { method: \"DELETE\"", ["B5", "B6"]],
  ["live needs bytes flowing, not just a ready path", "server/videosources.ts", "const flowing = j?.ready === true && Number.isFinite(bytes) && prev !== undefined && bytes > prev;", "const flowing = j?.ready === true;", ["B2"]],
  ["an unreachable appliance is never guessed", "server/videosources.ts", "} catch { /* unreachable: leave it to go stale (unknown), never guess */ }", "} catch { noteSourceState(s.id, { state: \"offline\", at: Date.now() }); }", ["B2"]],
  ["a viewer is told the state's age, never a timestamp", "server/videosources.ts", "ageMs: Math.max(0, now - o.at) }", "ageMs: o.at }", ["B7"]],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/video-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function tree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs", "client/lib"]) if (fs.existsSync(path.join(ENGINE, sub))) copyTree(path.join(ENGINE, sub), path.join(d, sub));
  for (const f of ["package.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0;
  for (const [name, file, find, repl, want] of MUTANTS) {
    const d = tree("vmut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, want);
    const red = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = r.code !== 0 && want.every((c) => red.includes(c));
    if (!good) { bad++; console.log(r.out.split("\n").slice(-10).join("\n")); }
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${red.join(",") || "(none)"} (want ${want.join(",")})`);
  }
  console.log(`[video-check --mutants] ${MUTANTS.length} mutations run, ${bad} wrong (each must turn its cases red)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  // The base's tree by archiveTo (its paths go to sh as arguments, never pasted into the script), then this suite's own copy
  // of video-check, and the engine's node_modules, as batch2-check's control does.
  const d = scratch("vctl"); const r0 = archiveTo(ENGINE, BASE, ["shared", "server", "tools", "client/lib", "defs"], d);
  if (r0.exitCode === 0) {
    fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
    fs.copyFileSync(path.join(ENGINE, "tools/protocol/video-check.ts"), path.join(d, "tools/protocol/video-check.ts"));
  }
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const kept = (l: string) => l.slice(5).trim().startsWith("K");
  const wrong = lines.filter((l) => (kept(l) ? l.startsWith("FAIL") : l.startsWith("ok ")));
  console.log(lines.map((l) => `${wrong.includes(l) ? "WRONG AT BASE: " : kept(l) ? "kept at base:  " : "red at base:   "}${l.slice(0, 140)}`).join("\n"));
  console.log(`[video-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (new cases red there, K green)`);
  process.exit(wrong.length || !lines.length ? 1 : 0);
}

// ---------------- the code, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const none = () => ({});
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);   // fixture-ids.ts switched on THIS checkout's authority; --tree loads another one
const F = await import(TREE + "shared/protocol/fold.js");
const SB = await import(TREE + "shared/protocol/sandbox.js");
const V = await import(TREE + "shared/video.js").catch(none);
const VS = await import(TREE + "server/videosources.ts").catch(none);
const ES = await import(TREE + "shared/editschema.js").catch(none);
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("vid");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: SB.SANDBOX,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
function cast(s: any) { s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } }); }
const sayLines = (s: any, id: string) => (s.call("olive", "look", {}).things ?? []).find((t: any) => t.id === id)?.says ?? null;
const admit = (ids: string[]) => V.admitVideoSources?.(ids);

// ---- a fake appliance: WHEP (POST → 201 + Location; DELETE) and mediamtx's paths API, recording every request ----
const FAKE = { log: [] as any[], paths: {} as Record<string, any>, whepStatus: 201, apiDown: false, delays: [] as number[] };
const fake = Bun.serve({ port: 0, async fetch(req) {
  const u = new URL(req.url); const body = req.method === "POST" ? await req.text() : "";
  FAKE.log.push({ method: req.method, path: u.pathname, auth: req.headers.get("authorization"), body });
  if (req.method === "POST" && FAKE.delays.length) await new Promise((r) => setTimeout(r, FAKE.delays.shift()));   // a slow appliance, per offer
  if (u.pathname.startsWith("/v3/paths/get/")) { if (FAKE.apiDown) return new Response("down", { status: 503 }); const p = FAKE.paths[u.pathname.slice(14)]; return p ? Response.json(p) : new Response("not found", { status: 404 }); }
  if (req.method === "POST" && u.pathname.endsWith("/whep")) return FAKE.whepStatus === 201 ? new Response("v=0\r\nanswer-for:" + body.slice(0, 20), { status: 201, headers: { location: `${u.pathname.replace(/whep$/, "")}whep/session-${FAKE.log.length}` } }) : new Response("no", { status: FAKE.whepStatus });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  return new Response("?", { status: 400 });
} });
const APP = `http://127.0.0.1:${fake.port}`;
const SECRET = "reader:s3cret-read-key";
const REG = (extra = {}) => ({ sources: { solstice: { whep: `${APP}/screen/whep`, user: "reader", pass: "s3cret-read-key", api: APP, path: "screen" }, ...extra } });
const install = (doc: any) => VS.installSources?.(VS.parseRegistry(doc).sources);
// a viewer: a connection in a world whose state holds a thing with a video
function viewer(world: any, sent: any[] = []) { const c: any = { world, spectator: false, ws: { send: (s: string) => sent.push(JSON.parse(s)) } }; world.clients.add(c); return { c, sent }; }
// the sequencer's World.state is the VIEW (viewOf: components on the record, beside pos), so the fake is that shape exactly
function fakeWorld(video: any, more: string[] = []) { const entities: any = { screen: { pos: [0, 0, 0], yaw: 0, video } }; for (const id of more) entities[id] = { pos: [0, 0, 0], yaw: 0, video: { ...video } }; return { state: { entities }, clients: new Set() }; }
const tick = () => new Promise((r) => setTimeout(r, 5));

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- K: kept ----------------
  { id: "K1", what: "a store sound and a store picture keep working beside video", run(s) { cast(s);
      s.call("olive", "create", { id: "radio", model: "crate", place: { at: [0, 0] } });
      return { s: show(s.call("olive", "set", { id: "radio", component: "sound", value: { src: "store/audio/0123456789abcdef.ogg" } })), p: show(s.call("olive", "set", { id: "radio", component: "picture", value: { src: "store/images/0123456789abcdef.png" } })) }; },
    good: (o) => o.s === "ok" && o.p === "ok" },

  // ---------------- M: the component ----------------
  // first, before anything admits: a server that never said has admitted nothing
  { id: "M3", what: "fail closed: before the server admits anything, every source is refused, and the fix says the operator lists them", run(s) { cast(s);
      s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
      const r = s.call("olive", "set", { id: "screen", component: "video", value: { source: "solstice" } });
      return { code: code(r), fix: r.refused?.fix, admitted: V.admittedSources?.() }; },
    good: (o) => o.code === "not-found" && /admits no video sources yet/.test(o.fix ?? "") && Array.isArray(o.admitted) && o.admitted.length === 0 },
  { id: "M1", what: "a source is an id: a URL, a path, a dotted name, capitals and 41 characters are refused (shared and at the door); a plain id is accepted", run(s) {
      const bad = ["http://127.0.0.1:8889/screen/whep", "whep://appliance/screen", "screen/whep", "solstice.live", "Solstice", "a".repeat(41), "-x", ""];
      admit(["solstice"]); cast(s); s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
      return { shared: bad.map((x) => V.normalizeVideo?.({ source: x }).ok), door: bad.map((x) => code(s.call("olive", "set", { id: "screen", component: "video", value: { source: x } }))),
        good: V.normalizeVideo?.({ source: "solstice" }).ok, url: V.sourceIdProblem?.("https://x.example/whep") }; },
    good: (o) => o.shared.every((x: any) => x === false) && o.door.every((x: any) => x === "shape" || x === "schema") && o.good === true && /never a URL/.test(o.url ?? "") },
  { id: "M2", what: "the door: an admitted source is accepted with the defaults written; an unadmitted one refused not-found with what IS admitted and a did-you-mean; a revoke refuses new writes and keeps the stored value", run(s) {
      admit(["solstice", "movie-night"]); cast(s); s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
      const ok = show(s.call("bob", "set", { id: "screen", component: "video", value: { source: "solstice", alt: "the solstice stage" } }));
      const stored = comp(s, "screen", "video");
      const miss = s.call("bob", "set", { id: "screen", component: "video", value: { source: "solstise" } });
      admit(["movie-night"]);
      const after = s.call("bob", "set", { id: "screen", component: "video", value: { source: "solstice", volume: 0.5 } });
      return { ok, stored, miss: code(miss), fix: miss.refused?.fix, dym: miss.refused?.didYouMean, after: code(after), kept: comp(s, "screen", "video") }; },
    good: (o) => o.ok === "ok" && o.stored?.source === "solstice" && o.stored.volume === 0.8 && o.stored.width === 4 && o.stored.lit === "self" && o.stored.radius === 12 && !("playing" in o.stored) && !("t0" in o.stored)
      && o.miss === "not-found" && /movie-night/.test(o.fix ?? "") && o.dym?.[0] === "solstice" && o.after === "not-found" && o.kept?.source === "solstice" && o.kept.volume === 0.8 },
  { id: "M4", what: "a fork's copy carries a source this server doesn't admit (the bag is kept, not lost); an ordinary write of the same is refused", run(s) {
      admit([]); cast(s);
      const w = s.w(); let r; try { r = D.forkCopy(w, "olive", { ops: [{ verb: "create", args: { id: "old-screen", model: "crate", components: { video: { source: "elsewhere", alt: "a stage on another server" } } } }] }); } catch (e) { r = { crashed: String(e?.message) }; }
      const plain = s.call("olive", "create", { model: "crate", components: { video: { source: "elsewhere" } }, place: { at: [2, 0] } });
      return { fork: show(r), kept: comp(s, "old-screen", "video"), plain: code(plain) }; },
    good: (o) => o.fork === "ok" && o.kept?.source === "elsewhere" && o.plain === "not-found" },
  { id: "M5", what: "look says the appliance's state and its age: live (fresh), unknown when stale or never observed; never a URL or a viewer's playback", run(s) {
      admit(["solstice", "movie-night"]); cast(s);
      s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } }); s.call("olive", "create", { id: "screen2", model: "crate", place: { at: [3, 0] } });
      s.call("olive", "set", { id: "screen", component: "video", value: { source: "solstice", alt: "the solstice stage" } });
      s.call("olive", "set", { id: "screen2", component: "video", value: { source: "movie-night" } });
      V.forgetSourceState?.("movie-night");
      const now = Date.now();
      V.noteSourceState?.("solstice", { state: "live", at: now - 3000 }); const live = sayLines(s, "screen");
      V.noteSourceState?.("solstice", { state: "live", at: now - 120000 }); const stale = sayLines(s, "screen");
      return { live, stale, never: sayLines(s, "screen2") }; },
    good: (o) => /^a video screen: «the solstice stage»; its source is live \(as of [34] s ago\)$/.test(o.live?.find((l: string) => /video/.test(l)) ?? "")
      && /its source's state is unknown \(last observed 12\d s ago\)/.test(o.stale?.find((l: string) => /video/.test(l)) ?? "")
      && /source "movie-night"\); its source's state is unknown \(never observed\)/.test(o.never?.find((l: string) => /video/.test(l)) ?? "")
      && ![...(o.live ?? []), ...(o.stale ?? [])].some((l: string) => /https?:|whep|playing/.test(l)) },
  { id: "M6", what: "near past radius is refused, as sound's is; volume past 1 is refused by its range", run(s) {
      admit(["solstice"]); cast(s); s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
      return { near: code(s.call("olive", "set", { id: "screen", component: "video", value: { source: "solstice", near: 20, radius: 10 } })),
        vol: code(s.call("olive", "set", { id: "screen", component: "video", value: { source: "solstice", volume: 1.5 } })) }; },
    good: (o) => o.near === "bounds" && o.vol === "bounds" },
  { id: "M7", what: "what a viewer hears: authored volume × sound's distance law × their own gain (silent at radius)", run() {
      const v = { source: "solstice", volume: 0.5, near: 2, radius: 10 };
      return { at1: V.videoGain?.(v, 1), mine: V.videoGain?.(v, 1, 0.5), edge: V.videoGain?.(v, 10), mid: V.videoGain?.(v, 4), sound: (await_sound()).gainAt(4, 2, 10) }; },
    good: (o) => o.at1 === 0.5 && o.mine === 0.25 && o.edge === 0 && Math.abs(o.mid - 0.5 * o.sound) < 1e-12 },

  { id: "M8", what: "the inspector draws the Video card from the registry (volume 0..1, this viewer's own state, mute, take down); its edits keep the door's rules; Add Video takes a source by value", run() {
      const E = (c: any) => ({ transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, ...c });
      const flat = (ops: any[]) => ops.flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
      const sc = ES.inspectSchema?.(E({ video: { source: "solstice", volume: 0.8 } }), "t1", { mutedForMe: false, videoState: "stalled" });
      const g = sc?.groups?.find((x: any) => x.group === "video"); const vol = ES.fieldAt?.(sc, "video.volume");
      const set = (e: any) => { const r = ES.editOps(E({ video: { source: "solstice", volume: 0.8 } }), "t1", e); const op = flat(r.ops).find((o) => o.args?.component === "video"); return { errors: r.errors, verb: op?.verb, v: op?.args.value }; };
      return { keys: g?.fields?.map((f: any) => f.k ?? f.label), state: g?.fields?.find((f: any) => f.label === "on your screen")?.value, min: vol?.min, max: vol?.max,
        ok: set({ "video.volume": 0.5 }), loud: set({ "video.volume": 1.5 }), url: set({ "video.source": "http://x/whep" }), off: set({ "video.off": true }),
        add: ES.addOps?.(E({}), "t1", "Video", "solstice"), addUrl: ES.addOps?.(E({}), "t1", "Video", { source: "https://x/whep" }) }; },
    good: (o) => ["source", "alt", "volume", "near", "radius", "width", "mute", "off"].every((k) => o.keys?.includes(k)) && o.state === "stalled" && o.min === 0 && o.max === 1
      && o.ok.v?.volume === 0.5 && o.loud.errors.length && !o.loud.v && /never a URL/.test(o.url.errors.join()) && o.off.verb === "delete"
      && o.add?.ops?.[0]?.args?.value?.source === "solstice" && /never a URL/.test(o.addUrl?.errors?.join() ?? "") },

  // ---------------- B: the broker ----------------
  { id: "B1", what: "the registry: a credential inside a URL, a bad id, an api without a path, a non-http WHEP are dropped by id; a good entry is admitted", run() {
      const { sources, dropped } = VS.parseRegistry?.({ sources: { solstice: { whep: `${APP}/screen/whep`, api: APP, path: "screen" },
        "creds-in-url": { whep: "http://user:pw@host/screen/whep" }, "Bad.Id": { whep: `${APP}/x/whep` }, "no-path": { whep: `${APP}/x/whep`, api: APP }, "rtmp-src": { whep: "rtmp://host/screen" } } }) ?? {};
      return { ids: sources?.map((x: any) => x.id), dropped }; },
    good: (o) => JSON.stringify(o.ids) === '["solstice"]' && ["creds-in-url", "Bad.Id", "no-path", "rtmp-src"].every((x) => o.dropped?.includes(x)) },
  { id: "B2", what: "the source state: no path → offline; ready but bytes not flowing → offline; bytes flowing → live; first read waits for a baseline; an unreachable appliance writes nothing (it goes stale); ended is the operator's word", async run() {
      install(REG()); V.forgetSourceState?.("solstice"); const st = () => V.sourceStateOf?.("solstice")?.state ?? null; const obs = async () => { await VS.observeAll?.(); };
      FAKE.paths = {}; FAKE.apiDown = false; await obs(); const missing = st();
      FAKE.paths.screen = { ready: true, bytesReceived: 100 }; V.forgetSourceState?.("solstice"); await obs(); const first = st();
      await obs(); const stuck = st();
      FAKE.paths.screen = { ready: true, bytesReceived: 500 }; await obs(); const live = st();
      V.forgetSourceState?.("solstice"); install({ sources: { solstice: { whep: `${APP}/screen/whep`, api: "http://127.0.0.1:1", path: "screen" } } }); await obs(); const down = st();
      install(REG({ solstice: { whep: `${APP}/screen/whep`, api: APP, path: "screen", ended: true } })); await obs(); const ended = st();
      return { missing, first, stuck, live, down, ended }; },
    good: (o) => o.missing === "offline" && o.first === null && o.stuck === "offline" && o.live === "live" && o.down === null && o.ended === "ended" },
  { id: "B3", what: "an offer reaches the appliance with the operator's read credential and the viewer's SDP; the answer comes back; nothing the viewer receives names the endpoint or the credential", async run() {
      install(REG()); FAKE.log = []; FAKE.whepStatus = 201; const w = fakeWorld({ source: "solstice" }); const { c } = viewer(w);
      const r = await VS.offer?.(c, { id: "screen", sdp: "v=0 the-offer", req: "r1" }, 1e9);
      const post = FAKE.log.find((x) => x.method === "POST"); const said = JSON.stringify(r);
      return { type: r?.type, sdp: r?.sdp, auth: post?.auth, body: post?.body, leak: [APP, String(fake.port), "s3cret", "whep", "Basic"].filter((x) => said.includes(x)) }; },
    good: (o) => o.type === "video-answer" && /answer-for:v=0 the-offer/.test(o.sdp ?? "") && o.auth === "Basic " + Buffer.from(SECRET).toString("base64") && o.body === "v=0 the-offer" && o.leak.length === 0 },
  { id: "B4", what: "a viewer offers at most once every 2 s and holds at most 4 screens (a new offer for a screen it holds replaces that one); a spectator, an unadmitted source (before anything reaches an appliance) and a missing video are refused in words", async run() {
      install(REG()); FAKE.whepStatus = 201; FAKE.delays = []; const w = fakeWorld({ source: "solstice" }, ["s2", "s3", "s4", "s5"]); const { c } = viewer(w);
      const t = 2e9; const a = await VS.offer?.(c, { id: "screen", sdp: "o" }, t); const b = await VS.offer?.(c, { id: "s2", sdp: "o" }, t + 500);
      for (const [i, id] of ["s2", "s3", "s4"].entries()) await VS.offer?.(c, { id, sdp: "o" }, t + (i + 1) * 3000);
      const capped = await VS.offer?.(c, { id: "s5", sdp: "o" }, t + 20000);
      const again = await VS.offer?.(c, { id: "screen", sdp: "o" }, t + 25000);
      const spec = await VS.offer?.({ world: w, spectator: true }, { id: "screen", sdp: "o" }, t);
      const posts = FAKE.log.filter((x) => x.method === "POST").length;
      const w2 = fakeWorld({ source: "elsewhere" }); const { c: c2 } = viewer(w2); const unadm = await VS.offer?.(c2, { id: "screen", sdp: "o" }, t);
      const prefetch = FAKE.log.filter((x) => x.method === "POST").length - posts;
      const w3 = { state: { entities: { screen: { pos: [0, 0, 0], yaw: 0 } } }, clients: new Set() }; const { c: c3 } = viewer(w3); const novid = await VS.offer?.(c3, { id: "screen", sdp: "o" }, t);
      const held = VS.sessionCount?.(c);
      for (const s of [...w.clients]) w.clients.delete(s); await VS.sweep?.();
      return { a: a?.type, b: b?.why, capped: capped?.why, again: again?.type, spec: spec?.why, unadm: unadm?.why, novid: novid?.why, held, prefetch }; },
    good: (o) => o.prefetch === 0 && o.a === "video-answer" && /too soon/.test(o.b ?? "") && /at most 4/.test(o.capped ?? "") && o.again === "video-answer" && o.held === 4 && /only someone in this world/.test(o.spec ?? "") && /isn't admitted/.test(o.unadm ?? "") && /has no video/.test(o.novid ?? "") },
  { id: "B8", what: "offers at the appliance together: they hold slots (the cap can't be passed by overlapping them), and for one screen only the newest offer's session is kept, whichever answer lands first (I.M.'s two finds on #5)", async run() {
      install(REG()); FAKE.whepStatus = 201; const t = 3e9;
      const held = async (delays: number[], ids: string[], more: string[] = []) => {
        FAKE.log = []; FAKE.delays = [...delays]; const w = fakeWorld({ source: "solstice" }, more); const { c, sent } = viewer(w);
        const rs = await Promise.all(ids.map((id, i) => VS.offer?.(c, { id, sdp: "o", req: `r${i}` }, t + i * 3000))); await tick();
        const out = { rs: rs.map((r: any) => r?.type === "video-answer" ? "answer" : r?.why), held: VS.sessionCount?.(c), posts: FAKE.log.filter((x) => x.method === "POST").length,
          dels: FAKE.log.filter((x) => x.method === "DELETE").length, closed: sent.filter((m) => m.type === "video-closed").map((m) => m.why) };
        w.clients.delete(c); await VS.sweep?.(); return out; };
      return { overlap: await held([200, 200, 200, 200, 200, 200], ["screen", "s2", "s3", "s4", "s5", "s6"], ["s2", "s3", "s4", "s5", "s6"]),
        oldLate: await held([300, 0], ["screen", "screen"]), oldFirst: await held([100, 300], ["screen", "screen"]), settled: await held([], ["screen"]).then(async () => {
          FAKE.log = []; FAKE.delays = []; const w = fakeWorld({ source: "solstice" }); const { c, sent } = viewer(w);
          await VS.offer?.(c, { id: "screen", sdp: "o" }, t); const r = await VS.offer?.(c, { id: "screen", sdp: "o" }, t + 3000); await tick();
          const out = { r: r?.type, held: VS.sessionCount?.(c), dels: FAKE.log.filter((x) => x.method === "DELETE").length, closed: sent.filter((m) => m.type === "video-closed").map((m) => m.why) };
          w.clients.delete(c); await VS.sweep?.(); return out; }) }; },
    good: (o) => o.overlap.held === 4 && o.overlap.posts === 4 && o.overlap.rs.filter((x: string) => x === "answer").length === 4 && o.overlap.rs.filter((x: string) => /at most 4/.test(x ?? "")).length === 2
      && ["oldLate", "oldFirst"].every((k) => o[k].held === 1 && o[k].posts === 2 && o[k].dels === 1 && /replaced/.test(o[k].rs[0] ?? "") && o[k].rs[1] === "answer")
      && o.settled.r === "video-answer" && o.settled.held === 1 && o.settled.dels === 1 && /replaced/.test(o.settled.closed[0] ?? "") },
  { id: "B5", what: "a session ends, its appliance resource is DELETEd and the viewer told, when the screen's source changes, when the video comes down, and when the viewer leaves", async run() {
      install(REG({ "movie-night": { whep: `${APP}/movie/whep` } })); FAKE.whepStatus = 201;
      const run1 = async (mutate: (w: any, c: any) => void) => { FAKE.log = []; const w = fakeWorld({ source: "solstice" }); const { c, sent } = viewer(w);
        const r = await VS.offer?.(c, { id: "screen", sdp: "o" }, Date.now() + Math.random() * 1e9); mutate(w, c); await VS.sweep?.(); await tick();
        return { opened: r?.type === "video-answer", del: FAKE.log.filter((x) => x.method === "DELETE").length, closed: sent.find((m) => m.type === "video-closed")?.why, left: VS.sessionCount?.(c) }; };
      return { changed: await run1((w) => { w.state.entities.screen.video = { source: "movie-night" }; }),
        down: await run1((w) => { delete w.state.entities.screen.video; }),
        left: await run1((w, c) => { w.clients.delete(c); }),
        steady: await run1(() => {}) }; },
    good: (o) => ["changed", "down", "left"].every((k) => o[k].opened && o[k].del === 1 && o[k].closed && o[k].left === 0) && /changed/.test(o.changed.closed) && /left/.test(o.left.closed)
      && o.steady.opened && o.steady.del === 0 && o.steady.left === 1 },
  { id: "B6", what: "the operator revokes a source: its sessions are closed and DELETEd, its observation forgotten, and the door refuses it", async run(s) {
      install({ sources: {} }); await tick(); install(REG()); FAKE.log = []; FAKE.whepStatus = 201; const w = fakeWorld({ source: "solstice" }); const { c, sent } = viewer(w);
      await VS.offer?.(c, { id: "screen", sdp: "o" }, 5e9); V.noteSourceState?.("solstice", { state: "live", at: Date.now() });
      install({ sources: {} }); await tick(); await tick();
      cast(s); s.call("olive", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
      return { del: FAKE.log.filter((x) => x.method === "DELETE").length, closed: sent.find((m) => m.type === "video-closed")?.why, obs: V.sourceStateOf?.("solstice"), left: VS.sessionCount?.(c),
        door: code(s.call("olive", "set", { id: "screen", component: "video", value: { source: "solstice" } })) }; },
    good: (o) => o.del === 1 && /revoked/.test(o.closed ?? "") && o.obs === null && o.left === 0 && o.door === "not-found" },
  { id: "B7", what: "what a world is told: each admitted source's state with its AGE (ms), never a timestamp, never an endpoint", run() {
      install(REG()); const now = 7e12; V.noteSourceState?.("solstice", { state: "live", at: now - 2500 });
      const f = VS.stateFrame?.(now); return { f, s: JSON.stringify(f) }; },
    good: (o) => o.f?.type === "video-state" && o.f.states?.[0]?.source === "solstice" && o.f.states[0].state === "live" && o.f.states[0].ageMs === 2500 && !/at"|http|whep|s3cret/.test(o.s) },
];
function await_sound() { return SOUND; }
const SOUND = await import(TREE + "shared/sound.js");

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, ok = false;
  try { o = await c.run(session()); ok = !!c.good(o); } catch (e) { o = { threw: String(e?.message ?? e).slice(0, 200) }; }
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.id} ${c.what}${ok ? "" : `\n     ${JSON.stringify(o).slice(0, 600)}`}`);
}
fake.stop(true);
console.log(`[video-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
