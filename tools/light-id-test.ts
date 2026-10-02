// Refuse incomplete light intent at both authoring doors, not during replay.
// Run: bun tools/light-id-test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scratchSequencer, mkCheck, sleep } from "./harness.ts";
import { emptyState, foldEntry } from "../shared/fold.js";
import { lightArgsError } from "../server/verb-shapes.ts";
import { handleTool } from "../mcpl/tools.ts";

const { check, tally } = mkCheck();
const assets = mkdtempSync(join(tmpdir(), "light-id-assets-"));
const run = await scratchSequencer("light-id", { portFrom: 9700, serverEnv: {
  OPT_DIR: join(assets, "opt"), EIDOVERSE_DIR: join(assets, "library"), SKIP_OPT_SWEEP: "1", VERB_RATE: "100",
} });
const sockets: WebSocket[] = [];
async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await fn()) { if (Date.now() > end) throw new Error("light-id condition timed out"); await sleep(10); }
}
async function open(id: string) {
  const ws = new WebSocket(run.BASE.replace("http", "ws") + "/ws"); sockets.push(ws);
  const messages: any[] = [];
  ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
  await until(() => ws.readyState === WebSocket.OPEN);
  ws.send(JSON.stringify({ type: "join", id, world: "light-id", avatar: "" }));
  await until(() => messages.some(m => m.type === "snapshot"));
  return { ws, messages, snapshot: messages.find(m => m.type === "snapshot"),
    verb: (verb: string, args: any) => ws.send(JSON.stringify({ type: "verb", verb, args })) };
}
let reqId = 0;
async function ask(client: Awaited<ReturnType<typeof open>>, args: any) {
  const id = ++reqId; client.ws.send(JSON.stringify({ ...args, reqId: id }));
  await until(() => client.messages.some(m => m.reqId === id));
  return client.messages.find(m => m.reqId === id);
}
async function script(client: Awaited<ReturnType<typeof open>>, id: string, body: string, extra: any = {}) {
  const upload = await fetch(run.BASE + "/upload?as=script", { method: "POST", body });
  if (!upload.ok) throw new Error(await upload.text());
  const { path } = await upload.json() as any;
  client.verb("behavior", { id, src: path, ...extra });
}
let completed = false;
try {
  const invalid = [undefined, null, {}, [], "lamp", 7, { id: null }, { id: "" }, { id: "   " }, { id: 4 }, { id: [] }, { id: {} }];
  check("every malformed id is rejected by the shared rule", invalid.every(args => !!lightArgsError(args)));
  check("valid sparse updates preserve the exact id", lightArgsError({ id: "lamp", intensity: 3 }) === null && lightArgsError({ id: " lamp " }) === null);
  const old = emptyState();
  foldEntry(old, { seq: 0, ts: 0, actor: "old", verb: "light", args: { intensity: 9 } });
  check("historical missing-id entries remain replay-tolerant", Object.keys(old.entities).length === 0);
  const author = await open("builder");
  const wireInvalid = [{ intensity: 3 }, { id: "", intensity: 3 }, { id: "  " }, { id: 42 }, { id: {} }, null, "lamp"];
  for (const args of wireInvalid) author.verb("light", args);
  await until(() => author.messages.filter(m => m.type === "error").length === wireInvalid.length);
  check("wire refusals name the missing/invalid id", author.messages.filter(m => m.type === "error").every(m => m.error.includes("light needs a non-empty string id")));
  check("wire failures have no light log echoes", !author.messages.some(m => m.type === "log" && m.entry.verb === "light"));
  const rejects = await ask(author, { type: "debug", kinds: ["rejected"], limit: 100 });
  check("flight recorder explains each wire rejection", rejects.events.filter((e: any) => e.verb === "light" && e.why.includes("id")).length === wireInvalid.length);
  author.verb("light", { id: "lamp", pos: [1, 2, 3], color: 0xabcdef, intensity: 4, range: 8 });
  author.verb("light", { id: "lamp", intensity: 6 });
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.verb === "light").length === 2);
  const late = await open("late");
  const lamp = late.snapshot.state.entities.lamp;
  check("partial wire update retains the standing light's fields", lamp.intensity === 6 && lamp.range === 8 && lamp.color === 0xabcdef && JSON.stringify(lamp.pos) === "[1,2,3]");
  check("wire provenance still names the light's placer", lamp.placer?.id === "builder");

  await script(author, "caught", `
    try { world.emit('light', {intensity: 17}); world.log('UNEXPECTED SUCCESS'); }
    catch (e) { world.log('caught: ' + e.message); }
    world.emit('light', {id: 'script-lamp', pos: [4,5,6], color: 123, intensity: 2, range: 7});
    world.emit('light', {id: 'script-lamp', intensity: 3});
  `);
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.actor === "bhv:caught" && m.entry.verb === "light").length >= 2);
  const caught = await ask(author, { type: "debug", behavior: "caught" });
  check("script can catch the same missing-id refusal", caught.events.some((e: any) => e.line.includes("caught:") && e.line.includes("light needs a non-empty string id")));
  check("rejected script emit does not append false-success history", author.messages.filter(m => m.type === "log" && m.entry.actor === "bhv:caught" && m.entry.verb === "light").length === 2);
  const scriptView = await open("script-view");
  const scriptLamp = scriptView.snapshot.state.entities["script-lamp"];
  check("script partial update preserves standing light data", scriptLamp.intensity === 3 && scriptLamp.range === 7 && scriptLamp.color === 123 && JSON.stringify(scriptLamp.pos) === "[4,5,6]");
  check("script creation preserves author and placer provenance", scriptLamp.actor === "bhv:caught" && scriptLamp.placer?.id === "builder");

  await script(author, "uncaught", `world.emit('light', {intensity: 8});`);
  let errors: any;
  await until(async () => {
    errors = await ask(author, { type: "debug", kinds: ["script-error"], limit: 100 });
    return errors.events.some((e: any) => e.behavior === "uncaught");
  });
  check("uncaught malformed emission appears in world_debug", errors.events.some((e: any) => e.behavior === "uncaught" && e.error.includes("light needs a non-empty string id")));
  const history = await ask(author, { type: "history", verbs: ["light"], limit: 100 });
  check("only the four effective valid light verbs reach history", history.entries.length === 4 && history.entries.every((e: any) => typeof e.args.id === "string" && e.args.id.length));

  // Existing rights and selfOnly still decide which valid id may be changed.
  await script(author, "self-only", `
    try { world.emit('light', {id: 'script-lamp', intensity: 99}); }
    catch (e) { world.log('caught: ' + e.message); }
  `, { attach: "lamp" });
  let scoped: any;
  await until(async () => {
    scoped = await ask(author, { type: "debug", behavior: "self-only" });
    return scoped.events.some((e: any) => e.line.includes("selfOnly"));
  });
  check("valid ids still respect the behavior's selfOnly boundary", scoped.events.some((e: any) => e.line.includes("selfOnly")));
  // The dispatcher shared by both MCPL doors must refuse before optimistic
  // placement text. Use the real wire for accepted intents and record each send.
  const sent: { verb: string; args: any }[] = [];
  const toolAgent: any = {
    entities: new Map([["lamp", lamp]]), pos: { x: 0, y: 0, z: 0 }, yaw: 0,
    heightAt: () => 0,
    verb(verb: string, args: any) { sent.push({ verb, args }); author.verb(verb, args); },
  };
  const ctx = { agent: toolAgent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  for (const id of ["", "   ", null, 42, [], {}]) {
    const reply = await handleTool(ctx, "light", { id, intensity: 9 });
    check("typed tool refuses invalid supplied id before sending or confirming: " + JSON.stringify(id),
      reply.isError === true && reply.content[0].text.includes("light needs a non-empty string id") && sent.length === 0);
  }
  for (const args of [{}, { id: "  " }, { id: 42 }]) {
    const reply = await handleTool(ctx, "world_verb", { verb: "light", args });
    check("raw MCPL light applies the same id rule: " + JSON.stringify(args), reply.isError === true && sent.length === 0);
  }
  const update = await handleTool(ctx, "light", { id: "lamp", intensity: 11 });
  check("typed partial update retains the sparse argument bag",
    !update.isError && update.content[0].text.includes("updated light") && JSON.stringify(sent[0].args) === JSON.stringify({ id: "lamp", intensity: 11 }));
  const generated = await handleTool(ctx, "light", { color: 456, intensity: 5 });
  const generatedId = sent[1].args.id;
  check("omitting the typed id still generates and reports a usable id",
    !generated.isError && typeof generatedId === "string" && generatedId.trim().length > 0 && generated.content[0].text.includes(generatedId));
  const explicit = await handleTool(ctx, "light", { id: "typed-explicit", x: 7, y: 8, z: 9, intensity: 6 });
  check("typed explicit id still reports the accepted intent", !explicit.isError && explicit.content[0].text.includes("typed-explicit"));
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.verb === "light").length === 7);
  const typedView = await open("typed-view");
  check("typed sparse update reaches the server fold without resetting fields",
    typedView.snapshot.state.entities.lamp.intensity === 11 && typedView.snapshot.state.entities.lamp.range === 8 && typedView.snapshot.state.entities.lamp.color === 0xabcdef);
  check("generated and explicit typed lights both reach the real world state",
    typedView.snapshot.state.entities[generatedId]?.intensity === 5 && typedView.snapshot.state.entities["typed-explicit"]?.intensity === 6);
  completed = true;
} finally {
  for (const ws of sockets) ws.close();
  await run.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(assets, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
