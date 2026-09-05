// The `residency` component's meaning, projection and evidence — serverless
// for three legs, and against a real sequencer for the fourth.
//
//   bun tools/residency-test.ts
//
// Four legs, matching what a residency has to be worth:
//
//   1. DECLARATION — what a record may say, what it may not, and what fails
//      LEGIBLY (an unknown role still reads; a marker path that isn't a
//      library path falls back with a note; a record with nobody home is
//      refused outright).
//   2. PROJECTION  — descriptor → the verbs that plant it, deterministic and
//      re-plantable, under the component-bag cap.
//   3. EVIDENCE    — the claim/trace split: a roster is what a system SAYS,
//      the log is what its bodies DID, and a declared-but-absent agent stays
//      visible as exactly that.
//   4. IN THE WORLD — a real sequencer: look()-shaped perception through the
//      mcpl agent, the advisory lint in the flight recorder, and the
//      /residency projection another instance polls.
//
// Every check here fails against the old behavior by construction: none of
// this existed.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  RESIDENT_ROLES, RESIDENCY_MAX_AGENTS, RESIDENCY_MARKER_FALLBACK,
  normalizeResidency, describeResidency, residencyEntries, residencyTransition,
  residencyLine, traceResidents, describeTraces, wornName, roleReads,
} from "../shared/residency.js";

let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HARBOR = {
  instance: "example:harbor", system: "ExampleHost", since: "2026-09-04",
  mind: { name: "Harbor", id: "agent:harbor@example", role: "coordinator" },
  agents: [
    { id: "agent:harbor.wright@example", role: "builder" },
    { id: "agent:harbor.scribe@example", role: "scribe" },
  ],
  lore: "one instance, one mind, its standing agents — none of them a person",
  marker: { lib: "eidoverse/assets/models/crate_large_red.glb" },
};

// ---- 1. declaration --------------------------------------------------------
console.log("\ndeclaration — what a record may say, and what fails legibly\n");
{
  const r = normalizeResidency(HARBOR, { entityId: "marker1" });
  check("a well-formed record normalizes clean", r.ok === true && r.notes.length === 0, r.ok ? "" : r.why);
  const rec = (r as { residency: any }).residency;
  check("the mind's worn name is derived from its durable id", rec.mind.wears === "harbor");
  check("...and so is each agent's", rec.agents[0].wears === "harbor.wright");
  check("an ISO `since` becomes epoch ms", typeof rec.since === "number" && new Date(rec.since).toISOString().startsWith("2026-09-04"));
  check("the record carries a key stable across worlds", rec.key === "example:harbor:harbor");

  check("a record with no instance is refused", normalizeResidency({ mind: { name: "X" } }).ok === false);
  check("a record with nobody home is refused", normalizeResidency({ instance: "example:x" }).ok === false);
  check("a non-object bag fails legibly", normalizeResidency(42).ok === false);

  const odd = normalizeResidency({ ...HARBOR, mind: { name: "Harbor", role: "hierophant" } });
  check("an unknown role is kept, with a note", (odd as any).residency.mind.role === "hierophant"
    && (odd as any).notes.some((n: string) => n.includes("hierophant")));
  check("...and still reads in prose", roleReads("hierophant") === '"hierophant"');
  check("known roles read as phrases", roleReads("coordinator") === RESIDENT_ROLES["coordinator"]);

  const escaped = normalizeResidency({ ...HARBOR, marker: { lib: "../../etc/passwd" } });
  check("a marker path that isn't a library path falls back, with a note",
    (escaped as any).residency.marker.lib === RESIDENCY_MARKER_FALLBACK
    && (escaped as any).notes.some((n: string) => n.includes("marker.lib")));

  const dup = normalizeResidency({ ...HARBOR, agents: [{ id: "agent:a@x" }, { id: "agent:a@y" }] });
  check("two agents wearing one name is a note, not two rows",
    (dup as any).residency.agents.length === 1 && (dup as any).notes.some((n: string) => n.includes("wear")));

  const many = normalizeResidency({ ...HARBOR, agents: Array.from({ length: 40 }, (_, i) => ({ id: `agent:w${i}@x` })) });
  check(`a roster is capped at ${RESIDENCY_MAX_AGENTS}, with a note`,
    (many as any).residency.agents.length === RESIDENCY_MAX_AGENTS && (many as any).notes.some((n: string) => n.includes("truncated")));

  const long = normalizeResidency({ ...HARBOR, lore: "x".repeat(4000) });
  check("lore is clamped rather than allowed to eat the bag", (long as any).residency.lore.length === 400);

  // The privacy rule the model exists to make structural: there is nowhere to
  // put an address, so an authored one simply is not in the record.
  const sneaky = normalizeResidency({ ...HARBOR, host: "some-host.example", url: "http://10.0.0.4:5555", token: "sekrit" });
  const flat = JSON.stringify((sneaky as any).residency);
  check("a record has nowhere to carry a host, a URL or a token",
    !flat.includes("some-host") && !flat.includes("10.0.0.4") && !flat.includes("sekrit"));

  check("wornName strips the scheme and the home node", wornName("agent:harbor.wright@example") === "harbor.wright");
}

// ---- 2. projection ---------------------------------------------------------
console.log("\nprojection — descriptor to verbs\n");
{
  const plan = residencyEntries(HARBOR, { pos: [4, 0, -6] });
  check("a plan is a spawn, a record and a lock", plan.ok === true
    && (plan as any).entries.map((e: any) => e.verb).join(",") === "spawn,comp,comp");
  const p = plan as any;
  check("the marker id is derived from the instance, so re-planting re-authors one entity",
    p.id === "residency-example-harbor" && residencyEntries(HARBOR).id === p.id);
  check("the record rides a `residency` comp on that entity",
    p.entries[1].args.type === "residency" && p.entries[1].args.id === p.id);
  check("the marker is nailed down by default", p.entries[2].args.type === "lock" && p.entries[2].args.data === true);
  check("--no-lock leaves it loose", residencyEntries(HARBOR, { lock: false }).entries.length === 2);
  check("the record fits the component bag with room to spare",
    JSON.stringify(p.entries[1].args).length < 8192);
  check("the planted record carries no marker asset — that rode the spawn",
    p.entries[1].args.data.marker === undefined);
  // the lock refuses a same-id spawn, so re-planting must be comps only
  const again = residencyEntries(HARBOR, { skipSpawn: true });
  check("re-planting a standing marker emits no spawn for its lock to refuse",
    (again as any).entries.every((e: any) => e.verb !== "spawn"));
  check("a record that won't normalize projects nothing", residencyEntries({ instance: "x" }).ok === false);
}

// ---- 3. evidence -----------------------------------------------------------
console.log("\nevidence — the claim and the log, kept apart\n");
{
  const log = [
    { seq: 10, ts: 1_000, actor: "harbor", verb: "say" },
    { seq: 11, ts: 2_000, actor: "harbor.wright", verb: "spawn" },
    { seq: 12, ts: 3_000, actor: "harbor.wright", verb: "comp" },
    { seq: 13, ts: 4_000, actor: "harbor.wright", verb: "spawn" },
    { seq: 14, ts: 5_000, actor: "somebody-else", verb: "spawn" },
  ];
  const traces = traceResidents(log, HARBOR);
  const byName = Object.fromEntries(traces.map((t) => [t.wears, t]));
  check("the mind's acts are counted", byName.harbor.acts === 1 && byName.harbor.verbs.say === 1);
  check("an agent's acts are counted per verb", byName["harbor.wright"].acts === 3 && byName["harbor.wright"].verbs.spawn === 2);
  check("first and last are the entries' own timestamps",
    byName["harbor.wright"].first === 2_000 && byName["harbor.wright"].last === 4_000 && byName["harbor.wright"].lastSeq === 13);
  check("a declared agent that never acted is reported, not dropped",
    byName["harbor.scribe"].acts === 0 && traces.length === 3);
  check("a stranger's acts attach to nobody", !traces.some((t) => t.wears === "somebody-else"));

  const prose = describeTraces(traces, { now: 6_000 });
  check("the mind leads the prose", prose[0].startsWith("harbor "), prose[0]);
  check("an unseen agent says so in words", prose.some((l) => l.includes("declared, but has done nothing")));
  check("relative ages need a clock the caller passes", prose[0].includes("ago")
    && describeTraces(traces)[0].includes("last 1970"));

  // an `as` on the roster is how a body that joins under some other name is
  // still recognizable as this instance's
  const aliased = traceResidents([{ seq: 1, ts: 1, actor: "vw-7", verb: "say" }],
    { ...HARBOR, agents: [{ id: "agent:harbor.wright@example", as: "vw-7" }] });
  check("an explicit `as` binds a body joining under another name",
    aliased.find((t) => t.wears === "vw-7")!.acts === 1);
  check("a record that won't normalize traces nothing", traceResidents([], { instance: "x" }).length === 0);
}

// ---- 3b. perception, serverless -------------------------------------------
console.log("\nperception — what a reader is told, and what is never claimed\n");
{
  const line = describeResidency(normalizeResidency(HARBOR).residency);
  check("the line names the instance, the mind and the roster size",
    line.includes("example:harbor") && line.includes("Harbor") && line.includes("2 agents"), line);
  check("...and the residency date, not an age that would silently drift", line.includes("resident since 2026-09-04"));
  check("...and says it is a declaration rather than a presence", line.includes("not a presence"));
  check("...and claims nothing about anyone being here",
    !/\b(present|online|connected|running|here now)\b/i.test(line), line);
  check("a malformed record still reads as somebody's marker",
    describeResidency({ instance: "example:x" }).includes("nobody named"));
  check("a non-object bag reads as malformed", describeResidency(7).includes("malformed"));

  const begin = residencyLine("antra", "m1", residencyTransition(null, HARBOR));
  check("a record beginning narrates once, naming the mind", begin!.includes("records Harbor's residency"));
  const end = residencyLine("antra", "m1", residencyTransition(HARBOR, null));
  check("a withdrawal narrates as a withdrawal", end!.includes("withdraws"));
  const swap = residencyLine("antra", "m1", residencyTransition(HARBOR, { ...HARBOR, mind: { name: "Hesper" } }));
  check("a rededication names both minds", swap!.includes("Harbor") && swap!.includes("Hesper"));
  const tweak = residencyLine("antra", "m1", residencyTransition(HARBOR, { ...HARBOR, lore: "changed" }));
  check("an ordinary revision narrates as a revision", tweak!.includes("revises"));
  check("an identical re-author narrates nothing", residencyTransition(HARBOR, { ...HARBOR }) === null);
}

// Normalized records are inputs to planting and projection too: aliases
// must survive that second normalization and remain bound to actor evidence.
{
  const raw = { ...HARBOR, mind: {...HARBOR.mind, as: "Captain"}, agents: [{id:"agent:worker@example", as:"Dockhand"}] };
  const once = normalizeResidency(raw).residency;
  const twice = normalizeResidency(once).residency;
  check("normalized aliases survive another normalization", twice.mind.wears === "captain" && twice.agents[0].wears === "dockhand");
  const plan = residencyEntries(raw);
  const planted = plan.entries.find(e => e.verb === "comp" && e.args.type === "residency").args.data;
  check("planting preserves aliases in actor traces", traceResidents([{actor:"dockhand",verb:"use",ts:1,seq:1}], planted)[1].acts === 1);
  for (const since of [1e100, -1e100, Infinity, NaN]) {
    const r = normalizeResidency({...raw, since});
    check("out-of-range residency dates are dropped with a note", r.ok && r.residency.since == null && r.notes.some(n=>n.includes("since")));
    check("invalid authored dates remain perceivable", typeof describeResidency({...raw,since}) === "string");
  }
}

// ---- 4. in the world -------------------------------------------------------
console.log("\nin the world — a real sequencer, its lint, and the projection\n");

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }               // nothing answered: free
  }
  throw new Error("no free port found in 20 tries");
}
const PORT = await freePort();
const WORLD = `residency-${Date.now().toString(36)}`;
// process.execPath, not "bun": on Windows the PATH "bun" is an npm shim whose
// pid dies the moment it has launched the real binary, orphaning the server.
const server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-residency-")), JOIN_TOKEN: "" },
  stdio: "ignore",
});
process.on("exit", () => { try { server.kill(); } catch { /* already gone */ } });

let up = false;
for (let i = 0; i < 40; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/avatars`); up = true; break; }
  catch { await sleep(250); }
}
check("child sequencer came up on a verified-free port", up, `:${PORT}`);
if (!up) { console.log("\n  refusing to test a server that never started\n"); process.exit(1); }

// One body, wearing the roster name a wright wears, doing the planting — so
// the traces this world reports are the acts this test actually performed.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const inbox: any[] = [];
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("join timeout")), 8000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: WORLD, id: "harbor.wright" }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    inbox.push(m);
    if (m.type === "snapshot") { clearTimeout(t); resolve(); }
  };
  ws.onerror = () => { clearTimeout(t); reject(new Error("socket error")); };
});
const plan = residencyEntries(HARBOR, { pos: [2, 0, 3] }) as any;
for (const e of plan.entries) ws.send(JSON.stringify({ type: "verb", verb: e.verb, args: e.args }));
// a record nobody can read, to prove the recorder says so
ws.send(JSON.stringify({ type: "verb", verb: "spawn", args: { id: "broken-marker", lib: RESIDENCY_MARKER_FALLBACK, pos: [9, 0, 9] } }));
ws.send(JSON.stringify({ type: "verb", verb: "comp", args: { id: "broken-marker", type: "residency", data: { instance: "example:nobody" } } }));
await sleep(600);

const res = await fetch(`http://127.0.0.1:${PORT}/residency?world=${WORLD}`);
const body = await res.json() as any;
check("GET /residency answers for a live world", res.ok && body.world === WORLD);
const planted = body.residencies.find((r: any) => r.entity === plan.id);
check("...naming the instance that planted the marker", planted?.record?.instance === "example:harbor");
check("...with the roster it declared", planted?.record?.agents?.length === 2);
check("...and where the marker stands", Array.isArray(planted?.pos) && planted.pos[0] === 2);
const wright = planted?.traces?.find((t: any) => t.wears === "harbor.wright");
check("the log's evidence rides alongside the claim", wright?.acts >= 3, JSON.stringify(wright?.verbs ?? {}));
check("...and a declared agent that never acted is still listed",
  planted?.traces?.find((t: any) => t.wears === "harbor.scribe")?.acts === 0);
const broken = body.residencies.find((r: any) => r.entity === "broken-marker");
check("an unreadable record is reported as unreadable, not omitted",
  broken && broken.record === null && typeof broken.why === "string");
check("an unknown world is a 404, and never created",
  (await fetch(`http://127.0.0.1:${PORT}/residency?world=no-such-world`)).status === 404);

// the advisory lint: the author of the broken record has no other way to learn
const dbg = await new Promise<any>((resolve) => {
  const onMsg = (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "debug" && m.reqId === "res-dbg") { ws.removeEventListener("message", onMsg); resolve(m); }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ type: "debug", reqId: "res-dbg", kinds: ["residency-lint"], limit: 50 }));
  setTimeout(() => resolve({ events: [] }), 3000);
});
check("the flight recorder says why a record won't read",
  (dbg.events ?? []).some((e: any) => e.kind === "residency-lint" && String(e.why ?? e.detail?.why ?? "").includes("mind.name")),
  JSON.stringify(dbg.events ?? []).slice(0, 160));

// perception, through the same agent a resident reads with
const { WorldAgent } = await import("../mcpl/agent.ts");
{
  const ag: any = new WorldAgent({ name: "reader" });
  ag.applyEntry({ verb: "spawn", args: { id: plan.id, lib: HARBOR.marker.lib, pos: [2, 0, 3] }, ts: 1, seq: 1, actor: "harbor.wright" }, false);
  ag.applyEntry({ verb: "comp", args: { id: plan.id, type: "residency", data: plan.entries[1].args.data }, ts: 2, seq: 2, actor: "harbor.wright" }, false);
  const out = ag.look();
  check("look() names the residency on the entity that carries it",
    new RegExp(`\\[${plan.id}\\][^\\n]*residency: instance example:harbor`).test(out),
    out.split("\n").find((l: string) => l.includes(plan.id)));
  check("...and does not fall back to `components: residency`", !/components:[^\n]*residency/.test(out));

  const events: any[] = [];
  ag.onEvent = (ev: any) => { if (ev.kind === "world-change") events.push(ev); };
  ag.applyEntry({ verb: "comp", args: { id: plan.id, type: "residency", data: { ...plan.entries[1].args.data, lore: "revised" } }, ts: 3, seq: 3, actor: "antra" }, true);
  check("a live revision arrives as one ambient world-change line",
    events.length === 1 && events[0].text.includes("revises Harbor's residency"), JSON.stringify(events));
  ag.applyEntry({ verb: "comp", args: { id: plan.id, type: "residency", data: { ...plan.entries[1].args.data, lore: "again" } }, ts: 4, seq: 4, actor: "reader" }, true);
  check("...and your own authoring is never echoed back at you", events.length === 1);
}

ws.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
