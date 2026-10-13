// tools/lookat-forward-check.ts — LookAt.forward has one vocabulary (refactor plan 2, D7).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/lookat-forward-check.ts
//
// Binds: the door's `axis` type is the vocabulary (x, y, z, or a vector). Every forward or up the authority's words name
// (the registry's help, a refusal's text) is one the door takes, and every forward the Inspector offers is one the door
// takes; a value the door refuses is refused through the real authority. Narrowing the words, not widening the door: no
// logged value holds a negative letter, so nothing replays differently.

import { scratchWorld } from "./protocol/scratchworld.ts";
import { COMPONENTS } from "../shared/protocol/componentspec.js";
import { inspectSchema, fieldAt } from "../shared/editschema.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const D = scratchWorld("lookat-fwd").seed({ post: { pos: [0, 0, 0] }, lamp: { pos: [0, 0, 3] } });
const verdict = (field: string, v: any) => {
  const r = D.call("set", { id: "post", component: "look-at", value: { target: "lamp", [field]: v } });
  return { ok: !!r.ok, words: r.ok ? "" : `${r.refused?.reason ?? ""} ${r.refused?.fix ?? ""}` };
};
const show = (v: any) => JSON.stringify(v);

const TAKES = [["x"], ["y"], ["z"], [[0, 0, -1]], [[1, 0, 0]]].map((a) => a[0]);
const REFUSES = ["-x", "-y", "-z", "w", "", 5, [0, 0], ["x"]];
const said = new Set<string>();
for (const field of ["forward", "up"]) {
  for (const v of TAKES) check(`${field} ${show(v)}: the door takes it`, verdict(field, v).ok);
  for (const v of REFUSES) { const r = verdict(field, v); check(`${field} ${show(v)}: the door refuses it`, !r.ok); if (!r.ok) said.add(r.words); }
}

// the words: every axis letter (signed or not) the help or a refusal names must be one the door takes
const named = (text: string) => [...new Set((text.match(/(?<![\w-])-?[xyz](?=\s*\||\s*$|\s*,|\s*\)|\s+or\b)/g) ?? []).map((s) => s.trim()))];
const help = COMPONENTS["look-at"].help as string;
const fwd = /forward\?\s*\(([^)]*)\)/.exec(help)?.[1] ?? "";
for (const letter of named(fwd)) check(`the registry's help names forward '${letter}', and the door takes it`, verdict("forward", letter).ok, fwd);
const inRefusals = new Map<string, string>();
for (const w of said) for (const letter of named(w)) if (!inRefusals.has(letter)) inRefusals.set(letter, w.trim().slice(0, 120));
for (const [letter, w] of inRefusals) check(`a refusal names '${letter}', and the door takes it`, verdict("forward", letter).ok, w);

// the Inspector offers only what the door takes
const s = inspectSchema({ pos: [0, 0, 0], yaw: 0, comp: { "look-at": { target: "lamp" } } }, "post");
const offered = (fieldAt(s, "look-at.forward")?.options ?? []).map((o: any) => o.v);
check("the Inspector offers a forward row", offered.length > 0, JSON.stringify(offered));
for (const v of offered) check(`the Inspector offers forward '${v}', and the door takes it`, verdict("forward", v).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
