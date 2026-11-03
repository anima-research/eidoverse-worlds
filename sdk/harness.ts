// behavior harness — run a behavior script locally, before any upload.
//
//   bun run sdk/harness.ts sdk/examples/bellkeeper.js \
//     --self bell1 --knobs '{"period":2}' \
//     --use '{"action":"ring","by":"you"}' --say '{"text":"hi","by":"you"}' \
//     --enter you --tick 2
//
// Emits and logs print to stdout; kv persists across events within one run.
// This runs your script in PLAIN Bun (not the QuickJS sandbox), which is
// fine for logic: the API surface is identical (sdk/behavior.d.ts). What it
// does NOT check: the 25ms gas ceiling, the memory cap, or rights — the
// world checks those, and tells you via /debug when they bite. It does
// refuse a light the world would refuse (lightArgsError), by throwing, as
// world.emit does there.

import { lightArgsError } from "../server/verb-shapes.ts";

const [, , scriptPath, ...rest] = process.argv;
if (!scriptPath) {
  console.log("usage: bun run sdk/harness.ts <script.js> [--self id] [--knobs json]");
  console.log("       [--use json] [--say json] [--enter id] [--leave id] [--tick n]");
  process.exit(1);
}

const args = new Map<string, string[]>();
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, "");
  (args.get(k) ?? args.set(k, []).get(k)!).push(rest[i + 1] ?? "");
}

const handlers: Record<string, ((e: unknown) => void)[]> = {};
const timers: { sec: number; fn: () => void }[] = [];
const kv = new Map<string, unknown>();
let emits = 0;

const world = {
  self: args.get("self")?.[0] ?? null,
  knobs: JSON.parse(args.get("knobs")?.[0] ?? "{}"),
  on: (ev: string, fn: (e: unknown) => void) => { (handlers[ev] ??= []).push(fn); },
  every: (sec: number, fn: () => void) => { timers.push({ sec, fn }); },
  emit: (verb: string, a: Record<string, unknown> = {}) => {
    if (verb === "light") {
      const why = lightArgsError(a);
      if (why) throw new Error(why);
    }
    emits++;
    console.log(`  ⚡ emit ${verb} ${JSON.stringify(a)}`);
  },
  log: (...parts: unknown[]) =>
    console.log(`  · log ${parts.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`),
  entity: (id: string) => ({ id, pos: [0, 0, 0], yaw: 0, comp: {}, parent: null }),
  entities: () => [] as unknown[],
  people: () => JSON.parse(args.get("people")?.[0] ?? '[{"id":"you","pos":[0,0,0]}]'),
  kv: {
    get: (k: string) => kv.get(k),
    set: (k: string, v: unknown) => { if (v == null) kv.delete(k); else kv.set(k, v); },
  },
};

const src = await Bun.file(scriptPath).text();
console.log(`▶ load ${scriptPath} (self=${world.self}, knobs=${JSON.stringify(world.knobs)})`);
new Function("world", `"use strict";\n${src}`)(world);
console.log(`  handlers: ${Object.entries(handlers).map(([k, v]) => `${k}×${v.length}`).join(", ") || "none"}; timers: ${timers.length}`);

const fire = (ev: string, payload: unknown) => {
  console.log(`\n→ ${ev} ${JSON.stringify(payload)}`);
  for (const h of handlers[ev] ?? []) h(payload);
};
for (const j of args.get("use") ?? []) {
  const e = JSON.parse(j);
  fire("use", { entity: world.self ?? e.entity ?? "thing", action: "use", by: "you", seq: 1, ...e });
}
for (const j of args.get("say") ?? []) fire("say", { by: "you", seq: 2, ...JSON.parse(j) });
for (const id of args.get("enter") ?? []) fire("enter", { id });
for (const id of args.get("leave") ?? []) fire("leave", { id });
const ticks = Number(args.get("tick")?.[0] ?? 0);
for (let i = 0; i < ticks; i++) for (const t of timers) { console.log(`\n→ timer (${t.sec}s)`); t.fn(); }

console.log(`\n✓ done — ${emits} emit(s), kv = ${JSON.stringify(Object.fromEntries(kv))}`);
