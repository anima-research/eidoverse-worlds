// test/protocol/verbclasses-check.ts — the verb classes have ONE home (shared/protocol/verbclasses.js): the authority's
// READ_ONLY and the wire's WIRE_READS/PERSON_ACTS, once literals in two files that drifted. This pins each class, holds
// that the wire's reads are the authority's plus the wire's own answers (`wait`/`whois`, which write nothing to the
// log), that a spectator may read every read (none is gated), and that neither consumer spells a second copy.
//   bun test/protocol/verbclasses-check.ts
import { readFileSync } from "node:fs";
import { ENGINE } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";

const { ok, done } = suite("verbclasses-check", { quiet: true });
const show = (s: Iterable<string>) => "{" + [...s].sort().join(", ") + "}";
const diff = (a: Set<string>, b: Set<string>) => new Set([...a].filter((v) => !b.has(v)));
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));
const sub = (a: Set<string>, b: Set<string>) => [...a].every((v) => b.has(v));

// the pinned classes (a change here is a decision, with R)
const READ_ONLY_PIN = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "modlog", "bans", "effect"]);
// LOOK_ONLY (what a role-less `none` might still do) left with none (R 10-21): no rung sits below member
const WIRE_READS_PIN = new Set(["look", "inspect", "measure", "find", "lint", "history", "schema", "help", "wait", "whois", "modlog", "bans", "scripts", "effect"]);
const PERSON_ACTS_PIN = new Set(["warn", "mute", "unmute", "kick", "ban", "unban"]);

// one source: the shared table
let V: any = null;
try { V = await import(ENGINE + "shared/protocol/verbclasses.js"); } catch (x: any) { ok(false, `shared/protocol/verbclasses.js imports: ${x.message}`); }
if (V) {
  for (const [k, pin] of [["READ_ONLY", READ_ONLY_PIN], ["WIRE_READS", WIRE_READS_PIN], ["PERSON_ACTS", PERSON_ACTS_PIN]] as const)
    ok(V[k] instanceof Set && same(V[k], pin), `${k} is the pinned class: ${V[k] instanceof Set ? show(V[k]) : typeof V[k]} vs ${show(pin)}`);
  if (V.WIRE_READS instanceof Set && V.READ_ONLY instanceof Set) {
    ok(sub(V.WIRE_READS, new Set([...V.READ_ONLY, "wait", "whois", "inbox"])), `WIRE_READS ⊆ READ_ONLY ∪ {wait, whois, inbox}: extra ${show(diff(V.WIRE_READS, new Set([...V.READ_ONLY, "wait", "whois", "inbox"])))}`);
    ok(diff(V.READ_ONLY, V.WIRE_READS).size === 0 && !("SPECTATOR_GATED" in V), `a spectator reads every read: READ_ONLY − WIRE_READS is empty and no gated class remains (today: ${show(diff(V.READ_ONLY, V.WIRE_READS))})`);
    ok(!("LOOK_ONLY" in V), "LOOK_ONLY is gone (it only served the none role)");
  }
}

// no second copy: the two consumers import the table, they don't spell it
const auth = readFileSync(ENGINE + "shared/protocol/authority.js", "utf8");
const wire = readFileSync(ENGINE + "server/requestwire.ts", "utf8");
const literal = (src: string, name: string) => { const m = src.match(new RegExp(`const ${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]`)); return m ? new Set(m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)) : null; };
const aRO = literal(auth, "READ_ONLY"), wR = literal(wire, "READS"), wP = literal(wire, "PERSON_ACTS");
ok(!aRO && /from "\.\/verbclasses\.js"/.test(auth), `authority.js imports READ_ONLY from verbclasses.js (literal READ_ONLY: ${aRO ? show(aRO) : "none"})`);
ok(!wR && !wP && /from "\.\.\/shared\/protocol\/verbclasses\.js"/.test(wire), `requestwire.ts imports its READS/PERSON_ACTS from verbclasses.js (literal READS: ${wR ? show(wR) : "none"})`);
if (aRO && wR) console.log(`  today's drift: READ_ONLY − READS = ${show(diff(aRO, wR))}; READS − READ_ONLY = ${show(diff(wR, aRO))}`);

done();
