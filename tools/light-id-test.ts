// Refuse incomplete light intent at both authoring doors, not during replay.
// Run: bun tools/light-id-test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scratchSequencer, mkCheck, sleep } from "./harness.ts";
import { emptyState, foldEntry } from "../shared/fold.js";
import { lightArgsError, LIGHT_ID_REASON } from "../server/verb-shapes.ts";
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
  check("every malformed id, and args that aren't a bag (none, a list, text, a number), is refused by the shared rule with its reason",
    invalid.every(args => lightArgsError(args) === LIGHT_ID_REASON));
  const exact = emptyState();
  for (const [seq, args] of [[1, { id: " lamp ", intensity: 3, color: 7 }], [2, { id: " lamp ", intensity: 5 }]] as const) {
    check("a valid id passes the rule as given: " + JSON.stringify(args), lightArgsError(args) === null);
    foldEntry(exact, { seq, ts: seq, actor: "a", verb: "light", args });
  }
  check("the fold stores the id exactly as given, and the sparse update merges into it",
    JSON.stringify(Object.keys(exact.entities)) === JSON.stringify([" lamp "]) && exact.entities[" lamp "].intensity === 5 && exact.entities[" lamp "].color === 7);
  const old = emptyState();
  foldEntry(old, { seq: 0, ts: 0, actor: "old", verb: "light", args: { intensity: 9 } });
  check("historical missing-id entries remain replay-tolerant", Object.keys(old.entities).length === 0);
  // A history light from before #216, with a numeric id, then the sparse
  // update #216 advises for it, authored as "5": one light, its own fields
  // kept beside the new one.
  foldEntry(old, { seq: 1, ts: 1, actor: "old", verb: "light", args: { id: 5, pos: [1, 2, 3], color: 0x123456, intensity: 4, range: 8, placer: { id: "builder" } } });
  const born = old.entities["5"]?.born;
  foldEntry(old, { seq: 2, ts: 2, actor: "new", verb: "light", args: { id: "5", intensity: 9, placer: { id: "new" } } });
  const five = old.entities["5"];
  check("a history light of {id: 5} takes an update authored as \"5\": one light, keeping pos, colour, placer and born",
    Object.keys(old.entities).length === 1 && five?.intensity === 9 && JSON.stringify(five?.pos) === "[1,2,3]" && five?.color === 0x123456
      && five?.range === 8 && five?.placer?.id === "builder" && born === 1 && five?.born === born);
  const author = await open("builder");
  const wireInvalid = [{ intensity: 3 }, { id: "", intensity: 3 }, { id: "  " }, { id: 42 }, { id: {} }, null, "lamp"];
  for (const args of wireInvalid) author.verb("light", args);
  await until(() => author.messages.filter(m => m.type === "error").length === wireInvalid.length);
  check("wire refusals give the rule's reason", author.messages.filter(m => m.type === "error").every(m => m.error === LIGHT_ID_REASON));
  check("wire failures have no light log echoes", !author.messages.some(m => m.type === "log" && m.entry.verb === "light"));
  const rejects = await ask(author, { type: "debug", kinds: ["rejected"], limit: 100 });
  check("flight recorder explains each wire rejection with the rule's reason", rejects.events.filter((e: any) => e.verb === "light" && e.why === LIGHT_ID_REASON).length === wireInvalid.length);
  // A verb that isn't a string is refused before the verb table is read:
  // property lookup would coerce ["light"] to the light row, past every
  // check that tests the verb's name, and append an id-less light.
  const errorsBefore = author.messages.filter(m => m.type === "error").length;
  author.ws.send(JSON.stringify({ type: "verb", verb: ["light"], args: { intensity: 3 } }));
  await until(() => author.messages.filter(m => m.type === "error").length === errorsBefore + 1);
  check("a verb that isn't a string is refused as such", author.messages.filter(m => m.type === "error").at(-1)?.error === 'a verb is a string, such as "light"');
  const listRejects = await ask(author, { type: "debug", kinds: ["rejected"], limit: 100 });
  check("the flight recorder keeps that refusal", listRejects.events.some((e: any) => e.verb === "light" && e.why === 'a verb is a string, such as "light"'));
  check("and nothing reached the log", !author.messages.some(m => m.type === "log" && String(m.entry.verb) === "light"));
  author.verb("light", { id: "lamp", pos: [1, 2, 3], color: 0xabcdef, intensity: 4, range: 8 });
  author.verb("light", { id: "lamp", intensity: 6 });
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.verb === "light").length === 2);
  const late = await open("late");
  const lamp = late.snapshot.state.entities.lamp;
  check("partial wire update retains the standing light's fields", lamp.intensity === 6 && lamp.range === 8 && lamp.color === 0xabcdef && JSON.stringify(lamp.pos) === "[1,2,3]");
  check("wire provenance still names the light's placer", lamp.placer?.id === "builder");
  // Another participant's sparse update is not re-authoring: the creator stays the placer.
  const other = await open("other");
  other.verb("light", { id: "lamp", day: false });
  await until(() => author.messages.some(m => m.type === "log" && m.entry.verb === "light" && m.entry.actor === "other"));
  const afterOther = (await open("after-other")).snapshot.state.entities.lamp;
  check("a sparse update from another participant keeps the creator as placer",
    afterOther.day === false && afterOther.actor === "other" && afterOther.placer?.id === "builder" && afterOther.intensity === 6 && afterOther.range === 8);

  await script(author, "caught", `
    try { world.emit('light', {intensity: 17}); world.log('UNEXPECTED SUCCESS'); }
    catch (e) { world.log('caught: ' + e.message); }
    world.emit('light', {id: 'script-lamp', pos: [4,5,6], color: 123, intensity: 2, range: 7});
    world.emit('light', {id: 'script-lamp', intensity: 3});
    world.emit('say', {text: 'caught: done'});
  `);
  // The say comes after every light the activation emitted, so once it has
  // landed the count of the script's lights is final.
  await until(() => author.messages.some(m => m.type === "log" && m.entry.actor === "bhv:caught" && m.entry.verb === "say"));
  const caught = await ask(author, { type: "debug", behavior: "caught" });
  check("script can catch the same missing-id refusal, with the rule's reason", caught.events.some((e: any) => e.line.includes("caught: " + LIGHT_ID_REASON)));
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
  check("uncaught malformed emission appears in world_debug", errors.events.some((e: any) => e.behavior === "uncaught" && e.error.includes(LIGHT_ID_REASON)));
  const history = await ask(author, { type: "history", verbs: ["light"], limit: 100 });
  check("only the five effective valid light verbs reach history", history.entries.length === 5 && history.entries.every((e: any) => typeof e.args.id === "string" && e.args.id.length));

  // The local harness refuses what the world refuses, by throwing (sdk/harness.ts).
  const harnessScript = join(assets, "harness-light.js");
  writeFileSync(harnessScript, `
    try { world.emit('light', {intensity: 1}); world.log('UNEXPECTED SUCCESS'); }
    catch (e) { world.log('caught: ' + e.message); }
    world.emit('light', {id: 'h-lamp', intensity: 2});
  `);
  const harness = Bun.spawnSync(["bun", new URL("../sdk/harness.ts", import.meta.url).pathname, harnessScript]);
  const harnessOut = harness.stdout.toString();
  check("the SDK harness refuses an id-less light with the rule's reason, and emits the valid one",
    harness.exitCode === 0 && harnessOut.includes("caught: " + LIGHT_ID_REASON) && !harnessOut.includes("UNEXPECTED") && harnessOut.includes("1 emit(s)"));

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
  // The agent's entity view as WorldAgent builds it from the fold: a light's
  // lib is "(light)", a model's its library path.
  const toolAgent: any = {
    entities: new Map<string, any>([
      ["lamp", { id: "lamp", lib: "(light)", pos: lamp.pos, yaw: 0, actor: "builder" }],
      ["statue", { id: "statue", lib: "eidoverse/assets/models/statue.glb", pos: [0, 0, 0], yaw: 0, actor: "builder" }],
    ]),
    pos: { x: 0, y: 0, z: 0 }, yaw: 0,
    heightAt: () => 0,
    verb(verb: string, args: any) { sent.push({ verb, args }); author.verb(verb, args); },
  };
  const ctx = { agent: toolAgent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  for (const id of ["", "   ", 42, [], {}]) {
    const reply = await handleTool(ctx, "light", { id, intensity: 9 });
    check("typed tool refuses invalid supplied id before sending or confirming: " + JSON.stringify(id),
      reply.isError === true && reply.content[0].text === LIGHT_ID_REASON && sent.length === 0);
  }
  const onModel = await handleTool(ctx, "light", { id: "statue", intensity: 3 });
  check("typed tool refuses to update an id that names a model, naming its kind, before sending",
    onModel.isError === true && onModel.content[0].text.startsWith('"statue" is a model') && sent.length === 0);
  // Each raw refusal on its own, with its reason; then a valid raw light goes through.
  for (const args of [{}, { id: "  " }, { id: 42 }]) {
    const before = sent.length;
    const reply = await handleTool(ctx, "world_verb", { verb: "light", args });
    check("raw MCPL light refuses " + JSON.stringify(args) + " with the rule's reason, sending nothing",
      reply.isError === true && reply.content[0].text === "refused light: " + LIGHT_ID_REASON && sent.length === before);
  }
  const raw = await handleTool(ctx, "world_verb", { verb: "light", args: { id: "raw-lamp", intensity: 2 } });
  check("raw MCPL light forwards a valid light", !raw.isError && sent.at(-1)?.verb === "light" && sent.at(-1)?.args.id === "raw-lamp");
  const update = await handleTool(ctx, "light", { id: "lamp", intensity: 11 });
  check("typed partial update retains the sparse argument bag",
    !update.isError && update.content[0].text.includes("updated light") && JSON.stringify(sent.at(-1)?.args) === JSON.stringify({ id: "lamp", intensity: 11 }));
  const generated = await handleTool(ctx, "light", { color: 456, intensity: 5 });
  const generatedId = sent.at(-1)?.args.id;
  check("omitting the typed id still generates and reports a usable id",
    !generated.isError && typeof generatedId === "string" && generatedId.trim().length > 0 && generated.content[0].text.includes(generatedId));
  // Hosts that fill every optional argument send null for one left out.
  const nulled = await handleTool(ctx, "light", { id: null, color: 789, intensity: 7 });
  const nulledId = sent.at(-1)?.args.id;
  check("a null typed id is taken as omitted, and one is generated",
    !nulled.isError && typeof nulledId === "string" && nulledId !== generatedId && nulledId.trim().length > 0 && nulled.content[0].text.includes(nulledId));
  const explicit = await handleTool(ctx, "light", { id: "typed-explicit", x: 7, y: 8, z: 9, intensity: 6 });
  check("typed explicit id still reports the accepted intent", !explicit.isError && explicit.content[0].text.includes("typed-explicit"));
  // The explicit light was sent last on this socket, so once it has landed every typed and raw send has.
  await until(() => author.messages.some(m => m.type === "log" && m.entry.verb === "light" && m.entry.args.id === "typed-explicit"));
  const typedView = await open("typed-view");
  check("typed sparse update reaches the server fold without resetting fields",
    typedView.snapshot.state.entities.lamp.intensity === 11 && typedView.snapshot.state.entities.lamp.range === 8 && typedView.snapshot.state.entities.lamp.color === 0xabcdef);
  check("generated, null-id, explicit and raw lights all reach the real world state",
    typedView.snapshot.state.entities[generatedId]?.intensity === 5 && typedView.snapshot.state.entities[nulledId]?.intensity === 7
      && typedView.snapshot.state.entities["typed-explicit"]?.intensity === 6 && typedView.snapshot.state.entities["raw-lamp"]?.intensity === 2);
  completed = true;
} finally {
  for (const ws of sockets) ws.close();
  await run.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(assets, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
