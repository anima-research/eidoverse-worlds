// scripting/run.ts — run a world script locally, in the real sandbox, before uploading it (docs/SCRIPTS.md "Developer kit").
//   bun scripting/run.ts scripting/examples/bellkeeper.js --self bell1 --knobs '{"period":2}' \
//     --use '{"action":"ring","by":"you"}' --say '{"text":"hi","by":"you"}' --enter you --tick 2 --people '[{"id":"you","d":1.5}]'
// Events run in the order given; each one's writes land before the next (state carries, as in a world). Prints writes,
// says, uses, body effects and the console. Scope, rights, consent and budgets are the authority's: not checked here.
import { SANDBOX } from "../shared/protocol/sandbox.js";
import { cowState, applyCow } from "../shared/protocol/fold.js";
import { seedOf } from "../shared/protocol/scriptrules.js";

type Ev = { on: string; [k: string]: unknown };
type Person = { id: string; d: number };
export type Opts = { self?: string; knobs?: Record<string, unknown>; events: Ev[]; people?: Person[]; now?: number; print?: (line: string) => void };

/** Run `text` for each event in turn; returns what it wrote, said and used, its console, its failures and the end state. */
export function runEvents(text: string, o: Opts) {
  const self = o.self ?? "thing", key = "script:local", print = o.print ?? (() => {});
  let st: any = { entities: { [self]: { born: 0, c: {} }, "@world": { born: 0, c: {} } }, diagnostics: [] };
  const people = o.people ?? [{ id: "you", d: 1 }];
  const out = { writes: [] as any[], says: [] as string[], uses: [] as any[], bodies: [] as any[], console: [] as string[], failed: [] as any[], state: {} as any };
  let now = o.now ?? Date.UTC(2026, 0, 1);
  o.events.forEach((ev, i) => {
    now += ev.on === "tick" ? 60000 : 1000;
    print(`→ ${JSON.stringify(ev)}`);
    const r = SANDBOX.run({ text, self, key, event: ev, knobs: o.knobs ?? {}, now, seed: seedOf("local", i, `${self}/${key}`), st,
      near: (rr: number) => people.filter((p) => p.d <= rr), count: () => people.length, name: (id: string) => id });
    for (const l of r.logs ?? []) { out.console.push(l); print(`  console ${l}`); }
    if (!r.ok) { out.failed.push({ on: ev.on, code: r.code, why: r.why }); print(`  failed ${r.code}: ${r.why}`); return; }
    for (const op of r.ops) { out.writes.push(op); print(`  ${op.verb} ${op.id}${op.comp ? ` ${op.comp}` : ""}${"value" in op ? ` ${JSON.stringify(op.value)}` : ""}`); }
    for (const t of r.says) { out.says.push(t); print(`  say ${JSON.stringify(t)}`); }
    for (const u of r.uses) { out.uses.push(u); print(`  use ${u.id} ${u.action}${u.args !== undefined ? ` ${JSON.stringify(u.args)}` : ""}`); }
    for (const b of r.bodies) { out.bodies.push(b); print(`  ${b.kind} ${b.to}`); }
    if (!r.ops.length && !r.says.length && !r.uses.length && !r.bodies.length) print("  (nothing)");
    st = applyCow(cowState(st), r.ops);
  });
  for (const [id, e] of Object.entries(st.entities) as any) if (Object.keys(e.c).length) out.state[id] = { ...e.c };
  return out;
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.log("usage: bun scripting/run.ts <script.js> [--self id] [--knobs json] [--people json] [--use json] [--say json] [--enter id] [--leave id] [--tick n]"); process.exit(2); }
  let self = "thing", knobs = {}, people: Person[] | undefined; const events: Ev[] = [];
  for (let i = 0; i < rest.length; i += 2) { const k = rest[i], v = rest[i + 1] ?? "";
    if (k === "--self") self = v; else if (k === "--knobs") knobs = JSON.parse(v); else if (k === "--people") people = JSON.parse(v);
    else if (k === "--use") events.push({ on: "use", by: "you", action: "use", ...JSON.parse(v) });
    else if (k === "--say") events.push({ on: "say", by: "you", seq: 1, ...JSON.parse(v) });
    else if (k === "--enter" || k === "--leave") events.push({ on: k.slice(2), by: v });
    else if (k === "--tick") for (let n = 0; n < Number(v); n++) events.push({ on: "tick" });
    else { console.log(`unknown flag ${k}`); process.exit(2); } }
  const r = runEvents(await Bun.file(file).text(), { self, knobs, people, events, print: (l) => console.log(l) });
  console.log(`state ${JSON.stringify(r.state)}`);
  process.exit(r.failed.length ? 1 : 0);
}
