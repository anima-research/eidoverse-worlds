// tools/protocol/verbclasses-check.ts — the verb classes have ONE home (shared/protocol/verbclasses.js). The authority's
// READ_ONLY/GHOST_OK and the wire's spectator READS/PERSON_ACTS used to be four literals in two files that had already
// drifted (DEBT-SURVEY 10-12 #10). This pin holds the classes as they stood on 2026-10-12 — the wire's set and the
// authority's are NOT equal today (a spectator is refused `scripts`/`effect`, which the authority calls reads; the wire
// admits `wait`/`whois`, which write nothing to the log but aren't the authority's reads) — and refuses two copies.
//   bun tools/protocol/verbclasses-check.ts
import { readFileSync } from "node:fs";
import { ENGINE } from "./common.ts";

let fails = 0;
const ok = (c: unknown, what: string) => { if (!c) { fails++; console.log("FAIL " + what); } };
const show = (s: Iterable<string>) => "{" + [...s].sort().join(", ") + "}";
const diff = (a: Set<string>, b: Set<string>) => new Set([...a].filter((v) => !b.has(v)));
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));
const sub = (a: Set<string>, b: Set<string>) => [...a].every((v) => b.has(v));

// the classes as of 2026-10-12 (behaviour pinned; a change here is a decision, with R)
const READ_ONLY_PIN = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "modlog", "bans", "effect"]);
const GHOST_OK_PIN = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "move", "leave", "wait", "ghost", "inbox", "effect"]);
const WIRE_READS_PIN = new Set(["look", "inspect", "measure", "find", "lint", "history", "schema", "help", "wait", "whois", "modlog", "bans"]);
const PERSON_ACTS_PIN = new Set(["warn", "mute", "unmute", "kick", "ban", "unban", "ghost", "unghost"]);

// one source: the shared table
let V: any = null;
try { V = await import(ENGINE + "shared/protocol/verbclasses.js"); } catch (x: any) { ok(false, `shared/protocol/verbclasses.js imports: ${x.message}`); }
if (V) {
  for (const [k, pin] of [["READ_ONLY", READ_ONLY_PIN], ["GHOST_OK", GHOST_OK_PIN], ["WIRE_READS", WIRE_READS_PIN], ["PERSON_ACTS", PERSON_ACTS_PIN]] as const)
    ok(V[k] instanceof Set && same(V[k], pin), `${k} is the pinned class: ${V[k] instanceof Set ? show(V[k]) : typeof V[k]} vs ${show(pin)}`);
  ok(V.SPECTATOR_GATED instanceof Set && same(V.SPECTATOR_GATED, diff(READ_ONLY_PIN, WIRE_READS_PIN)), `SPECTATOR_GATED = READ_ONLY − WIRE_READS = ${show(diff(READ_ONLY_PIN, WIRE_READS_PIN))}`);
  if (V.WIRE_READS instanceof Set && V.READ_ONLY instanceof Set && V.GHOST_OK instanceof Set) {
    ok(sub(V.WIRE_READS, new Set([...V.READ_ONLY, "wait", "whois", "inbox"])), `WIRE_READS ⊆ READ_ONLY ∪ {wait, whois, inbox}: extra ${show(diff(V.WIRE_READS, new Set([...V.READ_ONLY, "wait", "whois", "inbox"])))}`);
    ok(same(diff(V.READ_ONLY, V.WIRE_READS), V.SPECTATOR_GATED), `READ_ONLY − WIRE_READS is exactly SPECTATOR_GATED (today: ${show(diff(V.READ_ONLY, V.WIRE_READS))})`);
    // the authority's reads a ghost may NOT do: the moderation reads (modlog, bans) — recorded, not changed (question for R)
    ok(same(diff(V.READ_ONLY, V.GHOST_OK), new Set(["modlog", "bans"])), `READ_ONLY − GHOST_OK = {bans, modlog} (today: ${show(diff(V.READ_ONLY, V.GHOST_OK))})`);
  }
}

// no second copy: the two consumers import the table, they don't spell it
const auth = readFileSync(ENGINE + "shared/protocol/authority.js", "utf8");
const wire = readFileSync(ENGINE + "server/requestwire.ts", "utf8");
const literal = (src: string, name: string) => { const m = src.match(new RegExp(`const ${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]`)); return m ? new Set(m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)) : null; };
const aRO = literal(auth, "READ_ONLY"), aGO = literal(auth, "GHOST_OK"), wR = literal(wire, "READS"), wP = literal(wire, "PERSON_ACTS");
ok(!aRO && !aGO && /from "\.\/verbclasses\.js"/.test(auth), `authority.js imports READ_ONLY/GHOST_OK from verbclasses.js (literal READ_ONLY: ${aRO ? show(aRO) : "none"})`);
ok(!wR && !wP && /from "\.\.\/shared\/protocol\/verbclasses\.js"/.test(wire), `requestwire.ts imports its READS/PERSON_ACTS from verbclasses.js (literal READS: ${wR ? show(wR) : "none"})`);
if (aRO && wR) console.log(`  today's drift: READ_ONLY − READS = ${show(diff(aRO, wR))}; READS − READ_ONLY = ${show(diff(wR, aRO))}`);
if (aRO && aGO) console.log(`  today: READ_ONLY − GHOST_OK = ${show(diff(aRO, aGO))}`);

console.log(fails ? `verbclasses: ${fails} FAILED` : "verbclasses: ok");
process.exit(fails ? 1 : 0);
