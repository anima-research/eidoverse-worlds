// Plant a residency marker — a hosting system saying, in-world, where it
// lives — and read back who a world says lives in it.
//
//   bun tools/residency-plant.ts residency/example.json --dry-run
//   WORLD_URL=ws://localhost:8940/ws JOIN_TOKEN=… \
//     bun tools/residency-plant.ts <descriptor>.json --world commons --pos 4,0,-6
//   WORLD_URL=… bun tools/residency-plant.ts --report --world commons
//
// The DESCRIPTOR is the host system's own instance data and lives wherever
// that host keeps it (`$RESIDENCY_DESCRIPTOR`, or a path — residency/README.md
// on why it does not belong in this repo). The VERBS it becomes are
// shared/residency.js's `residencyEntries`, so this tool decides nothing about
// what a residency IS — it carries entries to a door and reads the projection
// back. Ordinary builder rank: a spawn, a comp, and a lock.
//
// Re-running is the normal case (plant it from a schedule and the record stays
// current): if the marker already stands, the spawn is dropped and only the
// record is re-authored — which is also the only thing that WOULD work, since
// the lock refuses a same-id spawn for everyone including its author.

import { existsSync, readFileSync } from "node:fs";
import {
  normalizeResidency, residencyEntries, describeResidency, describeTraces,
} from "../shared/residency.js";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string | null = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const URL_ = process.env.WORLD_URL ?? "ws://localhost:8940/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "";
const WORLD = flag("world") ?? "commons";
const ME = flag("as") ?? process.env.RESIDENCY_ID ?? "residency-planter";
/** The projection rides the same host as the door: ws→http, minus /ws. */
const httpBase = URL_.replace(/^ws/, "http").replace(/\/ws$/, "");

/** The read side: what this world says about everyone who lives in it — the
 *  claim and the log's own evidence for it, in prose. */
async function report(): Promise<number> {
  const where = `${httpBase}/residency?world=${encodeURIComponent(WORLD)}`;
  // A readout that throws must not take the run down with it — this runs from
  // a socket callback, where an unhandled rejection is a dead process rather
  // than a failed read.
  const body = await fetch(where).then(async (res) => {
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json() as Promise<any>;
  }).catch((err) => { console.error(`✗ ${where} — ${err.message}`); return null; });
  if (!body) return 1;
  if (!body.residencies?.length) { console.log(`\nnobody has recorded a residency in "${WORLD}"\n`); return 0; }
  const now = Date.now();
  for (const r of body.residencies) {
    console.log(`\n[${r.entity}] ${r.record ? describeResidency(r.record) : `unreadable record — ${r.why}`}`);
    for (const line of describeTraces(r.traces ?? [], { now })) console.log(`    ${line}`);
  }
  console.log(`\n(evidence read from ${body.history?.entries ?? 0} log entries)\n`);
  return 0;
}

const file = argv.find((a) => !a.startsWith("--") && a.endsWith(".json")) ?? process.env.RESIDENCY_DESCRIPTOR;
// `--report` with no descriptor to plant is the read-only mode
if (has("report") && !file) process.exit(await report());
if (!file || !existsSync(file)) {
  console.error("usage: bun tools/residency-plant.ts <descriptor.json> [--world W] [--pos x,y,z] [--id E] [--no-lock] [--dry-run]");
  console.error("       bun tools/residency-plant.ts --report [--world W]        # read back who lives there");
  console.error("       the descriptor path may also come from $RESIDENCY_DESCRIPTOR");
  process.exit(2);
}

const descriptor = JSON.parse(readFileSync(file, "utf8"));
const check = normalizeResidency(descriptor);
if (!check.ok) {
  console.error(`✗ ${file}: ${check.why}`);
  process.exit(1);
}
for (const n of check.notes) console.warn(`  ! ${n}`);

const pos = (flag("pos") ?? "0,0,0").split(",").map(Number);
if (pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) {
  console.error("--pos wants x,y,z");
  process.exit(2);
}
const plan = residencyEntries(descriptor, {
  id: flag("id"), pos, lock: !has("no-lock"),
  ...(flag("yaw") != null ? { yaw: Number(flag("yaw")) } : {}),
});
if (!plan.ok) { console.error(`✗ ${plan.why}`); process.exit(1); }

const record = plan.entries.find((e) => e.verb === "comp" && (e.args as { type?: string }).type === "residency")!;
console.log(`\n${describeResidency((record.args as { data: unknown }).data)}\n`);

if (has("dry-run")) {
  for (const e of plan.entries) console.log(`  ${e.verb} ${JSON.stringify(e.args)}`);
  console.log(`\n${plan.entries.length} verbs, ${JSON.stringify(record.args).length} bytes of component (8192 cap) — nothing was sent\n`);
  process.exit(0);
}

const ws = new WebSocket(`${URL_}?token=${encodeURIComponent(TOKEN)}`);
const send = (o: unknown) => ws.send(JSON.stringify(o));
let refused = 0;

ws.onopen = () => send({ type: "join", world: WORLD, id: ME, token: TOKEN });
ws.onmessage = async (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "error") { refused++; console.error(`  refused: ${m.error}`); return; }
  if (m.type !== "snapshot") return;
  const standing = m.state?.entities?.[plan.id];
  const entries = standing ? plan.entries.filter((e) => e.verb !== "spawn") : plan.entries;
  if (standing) console.log(`  [${plan.id}] already stands — re-authoring its record only`);
  for (const e of entries) send({ type: "verb", verb: e.verb, args: e.args });
  console.log(`\n✓ planted [${plan.id}] in "${WORLD}" via ${URL_} (${entries.length} verbs as ${ME})`);
  // Give the sequencer a moment to answer with any refusal, then read the
  // world's own account of it back — a plant nobody can see is not a plant.
  setTimeout(async () => {
    ws.close();
    const reportStatus = has("report") ? await report() : 0;
    process.exit(refused ? 1 : reportStatus);
  }, 1200);
};
ws.onerror = () => { console.error(`✗ cannot reach ${URL_}`); process.exit(1); };
