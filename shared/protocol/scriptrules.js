// shared/protocol/scriptrules.js — the parts of v4 scripts (research 41) that the AUTHORITY, the SANDBOX and an AUDITOR must agree on
// byte for byte. Pure: no node: imports, no sandbox (the authority is imported by browsers; the sandbox is injected).
//   LIMITS   the budgets an activation runs under (41 §3.10), named once.
//   SOURCE   what a script's source blob is: {lang: "js", api: 1, text}, stored by its sha256 name (§2.2).
//   hygiene  refusals at install that teach (41 §3.12): Trojan Source, code hidden past column 1000, a BOM.
//   seedOf   the activation's seed = H(world ‖ act seq ‖ entity/script key) (41 §3.7): what Math.random runs from.
//   elide    PROTOCOL-v4 §3d: dropping no-op writes in a SCRIPT batch is a stated rule, not free authority practice,
//            because an audit re-run must drop exactly the same writes. In order, against the batch so far, by JCS.
//   paramKey a component's `param.<name>` field: a number a script writes for something else to read (seat poses
//            that blend by signals read `param.<name>`; RESEARCH-socket-body 2026-10-06).
import { cowState, applyCow, jcs } from "./fold.js";
import { sha256 } from "./hash.js";

export const LANG = "js";
export const API = 1;
export const LIMITS = Object.freeze({
  source: 65536,        // characters of source
  fuel: 60,             // QuickJS interrupt-handler calls per activation: deterministic for one QuickJS build (41 §3.7). Measured
                        // (2026-10-06, this host): 1e6 loop iterations of `x += i` = 201 calls ≈ 60 ms idle, about twice that
                        // under load, so 60 ≈ 18–40 ms of dense work. Fuel, not the wall clock, must be what stops runaway code
                        // (a reviewer saw 100 lose to the backstop under load): fuel is the same on every re-run
  wallMs: 300,          // the wall-clock backstop per activation, host calls included (non-deterministic: a run that hits it
                        // writes nothing). The authority kills the activation's sandbox process at wallMs + GRACE (sandbox.js): a
                        // native builtin can't outlast that. Generous on purpose: a loaded host can stall an innocent run
                        // (measured: 1 in ~4,300 trivial runs passed 300 ms at load average ~35)
  memory: 24 << 20,     // bytes per activation's runtime
  stack: 256 << 10,     // bytes of native stack
  calls: 64,            // host calls (reads) per activation (Decentraland's 40 in flight; 41 §3.10)
  ops: 32,              // writes in one activation's batch
  says: 4,              // say entries per activation
  bodies: 4,            // body effects per activation
  ids: 1000,            // ids one read returns at most
  logLines: 20,         // world.log lines kept per activation in the console ring
  cpu: 2000,            // authority practice: ms of sandbox time per sponsor per minute (runs that write nothing cost the authority too)
  runs: 60,             // authority practice: activations per script per minute, whatever they write
  uploads: 20,          // uploads per person per minute (a blob costs storage and a parse, and logs nothing)
});
// what QuickJS build ran an activation (the act names it, as `sim` names its engine): an auditor re-runs with the same
export const ENGINE = "quickjs-emscripten@0.32.0/release-sync";

// Trojan Source (CVE-2021-42574) and its cousins: bidi controls, zero-width characters, a BOM, lines off the screen
const BIDI = /[‪-‮⁦-⁩‎‏؜]/, ZW = /[​-‍⁠﻿­]/;
export function hygiene(text) {
  if (typeof text !== "string") return { code: "source", reason: "a script's source is UTF-8 text" };
  if (text.length > LIMITS.source) return { code: "too-big", reason: `the source is ${text.length} characters; at most ${LIMITS.source}` };
  if (text.charCodeAt(0) === 0xfeff) return { code: "source-bom", reason: "the source starts with a byte-order mark" };
  if (/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) return { code: "source", reason: "the source has a lone surrogate (it isn't valid UTF-8)" };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].search(BIDI); if (b >= 0) return { code: "trojan-source", reason: `line ${i + 1}, column ${b + 1}: a Unicode bidi control (U+${lines[i].charCodeAt(b).toString(16).toUpperCase().padStart(4, "0")}) can make code read differently from how it runs` };
    const z = lines[i].search(ZW); if (z >= 0) return { code: "trojan-source", reason: `line ${i + 1}, column ${z + 1}: an invisible character (U+${lines[i].charCodeAt(z).toString(16).toUpperCase().padStart(4, "0")})` };
    if (lines[i].length > 1000) return { code: "long-line", reason: `line ${i + 1} is ${lines[i].length} columns; code past column 1000 is off every reviewer's screen` };
  }
  return null;
}
/** Minified-looking source isn't refused, but the status view says so (41 §3.12). */
export const looksMinified = (text) => { const ls = text.split("\n").filter((l) => l.trim()); return ls.length > 0 && ls.some((l) => l.length > 400) && text.length / ls.length > 200; };

export const seedOf = (worldId, actSeq, key) => sha256(`${worldId}|${actSeq}|${key}`);

// drop a set equal to the value it would replace, or a delete of what isn't there, judged in order against the batch so far
export function elide(st, ops) {
  const s = cowState(st); const out = [];
  for (const o of ops) { const e = s.entities[o.id];
    if (o.verb === "set" && e && o.comp in e.c && jcs(e.c[o.comp]) === jcs(o.value)) continue;
    if (o.verb === "delete" && (!e || (o.comp !== undefined && !(o.comp in e.c)))) continue;
    out.push(o); try { applyCow(s, [o]); } catch { /* the gate names the shape problem */ } }
  return out;
}

export const PARAM = /^param\.[a-z][a-zA-Z0-9_-]{0,31}$/;
export const isParamKey = (k) => typeof k === "string" && PARAM.test(k);
