// normative-check — spec/NORMATIVE.md is the closed set, and its tables say what the reference does.
//   N1 every file the normative set lists exists; nothing outside spec/ is listed as normative
//   N2 the consent switch row equals consent.js SWITCHES (recut A2: one switch replaced the preset table)
//   N3 the default and the ask window in the prose equal the code's; N3b the old table is kept in docs/
//   N4 the roles ladder, permission list and built-in roles equal shared/protocol/roles.js
//   N5 PROTOCOL.md never calls a code file normative (code is informative: NORMATIVE.md says so)
//   N6–N9 (recut C12) the refusal codes and the readback table are PINNED in spec/ (refusal-codes.json, readback.json): the
//   pins equal the code, a removal or a changed meaning re-pins only with --ack (a REGISTRY-CHANGELOG line), an addition freely
//   bun tools/protocol/normative-check.ts --pin [--ack "<why>"]   re-pin both from the code
// A failing row means one of the two moved: change the other in the same commit, or mark the row's status.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/normative-check.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as C from "../../shared/protocol/consent.js";
import * as R from "../../shared/protocol/roles.js";
import * as RC from "../../shared/protocol/refusalcodes.js";
import * as VC from "../../shared/protocol/verbclasses.js";
import { writeFileSync, appendFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// ---- C12: the two pins, and the one rule for moving them ----
const RC_PIN = "spec/refusal-codes.json", RB_PIN = "spec/readback.json";
/** What the code says, in the pins' shape. readback's `where` is a pointer into the reference code, never pinned. */
const refusalNow = () => ({ codes: Object.fromEntries(Object.entries(RC.REFUSAL_CODES).map(([k, v]: [string, any]) => [k, { meaning: v.meaning, when: v.when, ...(v.reserved ? { reserved: true } : {}) }])), renamed: { ...RC.RENAMED_CODES } });
const readbackNow = () => Object.fromEntries(Object.entries(VC.READBACK).map(([k, v]: [string, any]) => [k, { fields: [...v.fields], unknown: v.unknown }]));
/** Breaks between a pinned table and now: a row gone or a row changed (an addition is not a break). */
const tableBreaks = (pin: Record<string, any>, now: Record<string, any>, label: string) => Object.entries(pin ?? {}).flatMap(([k, v]) =>
  !Object.hasOwn(now, k) ? [`${label} ${k}: gone (old logs may hold it)`] : JSON.stringify(v) !== JSON.stringify(now[k]) ? [`${label} ${k}: ${JSON.stringify(v)} → ${JSON.stringify(now[k])}`] : []);
const pinBreaksC12 = (rc: any, rb: any, nowRc = refusalNow(), nowRb = readbackNow()) => [...tableBreaks(rc?.codes, nowRc.codes, "refusal"), ...tableBreaks(rc?.renamed, nowRc.renamed, "renamed code"), ...tableBreaks(rb, nowRb, "readback")];
/** May the code be pinned over the pins? {ok, breaks, changelog?, why?}: breaks need an ack, additions don't. */
const pinVerdictC12 = (rc: any, rb: any, ack: string | null, date: string, nowRc = refusalNow(), nowRb = readbackNow()) => {
  const breaks = pinBreaksC12(rc, rb, nowRc, nowRb); const why = (ack ?? "").trim();
  if (breaks.length && !why) return { ok: false, breaks, why: `these change a pinned refusal code or readback rule (old logs and clients depend on them): re-pin with --ack "<why>":\n  ${breaks.join("\n  ")}` };
  return { ok: true, breaks, ...(breaks.length ? { changelog: `- ${date}: normative: ${why}\n${breaks.map((b) => `  - ${b}`).join("\n")}\n` } : {}) };
};
const readJson = (f: string) => (existsSync(ROOT + f) ? JSON.parse(readFileSync(ROOT + f, "utf8")) : null);
if (process.argv.includes("--pin")) {
  const i = process.argv.indexOf("--ack"); const ack = i >= 0 ? process.argv[i + 1] : null;
  const v = pinVerdictC12(readJson(RC_PIN), readJson(RB_PIN), ack, new Date().toISOString().slice(0, 10));
  if (!v.ok) { console.log("refusing to re-pin: " + v.why); process.exit(1); }
  if (v.changelog) appendFileSync(ROOT + "spec/REGISTRY-CHANGELOG.md", v.changelog);
  writeFileSync(ROOT + RC_PIN, JSON.stringify(refusalNow(), null, 1) + "\n"); writeFileSync(ROOT + RB_PIN, JSON.stringify(readbackNow(), null, 1) + "\n");
  console.log(`${RC_PIN} and ${RB_PIN} written${v.breaks.length ? ` over ${v.breaks.length} acknowledged break(s)` : ""}`); process.exit(0);
}
const doc = readFileSync(ROOT + "spec/NORMATIVE.md", "utf8");
const proto = readFileSync(ROOT + "spec/PROTOCOL.md", "utf8");
let pass = 0, fail = 0;
const check = (id: string, what: string, ok: boolean, detail: unknown = "") => {
  if (ok) { pass++; console.log(`  ✓ ${id} ${what}`); } else { fail++; console.log(`  ✗ ${id} ${what} — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); }
};
const section = (title: string) => { const i = doc.indexOf(title); return i < 0 ? "" : doc.slice(i, doc.indexOf("\n## ", i + 1) < 0 ? undefined : doc.indexOf("\n## ", i + 1)); };
const rows = (text: string) => text.split("\n").filter((l) => /^\|/.test(l) && !/^\|[-| ]+\|$/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

// N1
const listed = rows(section("## The normative set")).slice(1).map((r) => r[0].replace(/`/g, ""));
const missing = listed.filter((f) => !existsSync(ROOT + f));
check("N1", `the normative set's ${listed.length} files exist, all under spec/`, listed.length >= 8 && !missing.length && listed.every((f) => f.startsWith("spec/")), { missing, outside: listed.filter((f) => !f.startsWith("spec/")) });

// N2 (recut A2): the switch row names exactly consent.js SWITCHES, and the default row names DEFAULT_SWITCH
{ const row = (k: string) => (doc.split("\n").find((l) => l.startsWith(`| ${k} |`)) ?? "");
  const sw = [...row("The answer").matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
  check("N2", "the switch row lists consent.js SWITCHES, in order", JSON.stringify(sw) === JSON.stringify(C.SWITCHES), { sw, code: C.SWITCHES });
// N3: the default and the ask window equal the code
  const def = row("Default").match(/`([a-z]+)`/)?.[1];
  check("N3", "the default row equals DEFAULT_SWITCH and the ask row says 20 s (ASK_MS)", def === C.DEFAULT_SWITCH && C.ASK_MS === 20000 && /20 s/.test(row("Ask")), { def, code: C.DEFAULT_SWITCH, ask: row("Ask") });
  check("N3b", "the retired table is kept as a record in docs/", existsSync(ROOT + "docs/CONSENT-TABLE-RECORD.md")); }

// N4
const roles = section("### World roles");
const ladder = roles.match(/^\| The ladder \|([^|]*)/m)?.[1] ?? "";
const want = ["player", "builder", "moderator", "owner"].map((k) => `\`${k}\` ${R.RANK[k]}`);
const perms = (roles.match(/^\| Permissions \|([^|]*)/m)?.[1].match(/`[A-Za-z]+`/g) ?? []).map((x) => x.slice(1, -1));
const built = roles.match(/^\| Built-in roles \|([^|]*)/m)?.[1] ?? "";
const can = (k: string) => Object.keys(R.BUILTIN[k].can).filter((x) => R.BUILTIN[k].can[x]);
const builtOk = can("player").length === 0 && /player: none/.test(built) && /builder: build, editOthers, scripts/.test(built) && can("builder").join() === "build,editOthers,scripts"
  && can("moderator").join() === "build,editOthers,scripts,pauseScripts,mute,kick,ban,grantRoles" && /moderator: those \+ pauseScripts, mute, kick, ban, grantRoles/.test(built)
  && can("owner").length === R.PERMISSION_NAMES.length && /owner: all/.test(built);
const caps = R.MUTE_MAX_MIN === 7 * 1440 && R.KICK_DEFAULT_MIN === 10 && R.KICK_MAX_MIN === 60 && R.REASON_MAX === 500 && /mute ≤ 7 days · kick 10 min default, ≤ 60 min · reason ≤ 500/.test(roles);
const qs = [["Q1", R.CAPTION_ON_SCREENS], ["Q2", R.OWNERS_FLY], ["Q3", R.GUESTS_AT_MOST_DEFAULT], ["Q4", R.EDIT_WORLD_PERMISSION]].every(([q, v]) => v === true && new RegExp(`^\\| ${q}[^\\n]*\\*\\*open\\*\\*`, "m").test(roles))
  && R.MOD_BAN_MAX_DAYS === 30 && /^\| Q5[^\n]*at most 30 days[^\n]*\*\*open\*\*/m.test(roles);
check("N4", "the roles ladder, permissions, built-in roles, caps and the five open defaults equal roles.js",
  want.every((w) => ladder.includes(w)) && perms.join() === R.PERMISSION_NAMES.join() && builtOk && caps && qs,
  { ladder: want.every((w) => ladder.includes(w)), perms: perms.join() === R.PERMISSION_NAMES.join() || `${perms} vs ${R.PERMISSION_NAMES}`, builtOk, caps, qs });

// N5
const codeNormative = proto.split("\n").filter((l) => /normative/i.test(l) && /`(shared|server|client|mcpl|tools)\/[^`]+\.(js|ts)`/.test(l));
check("N5", "PROTOCOL.md never calls a code file normative", !codeNormative.length, codeNormative.join(" / "));

// N6–N9 (recut C12)
{ const rc = readJson(RC_PIN), rb = readJson(RB_PIN); const nowRc = refusalNow(), nowRb = readbackNow();
  const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  check("N6", `the refusal codes are pinned in ${RC_PIN} and the pin equals refusalcodes.js (every code, its meaning and when; the renamed words)`, !!rc && same(rc, nowRc),
    rc ? [...pinBreaksC12(rc, null, nowRc, {}), ...Object.keys(nowRc.codes).filter((k) => !Object.hasOwn(rc.codes ?? {}, k)).map((k) => `unpinned ${k}`)].slice(0, 8) : "no pin: --pin");
  check("N7", `the readback table is pinned in ${RB_PIN} (fields and the unknown rule; never the code pointer) and equals verbclasses.js READBACK`, !!rb && same(rb, nowRb) && Object.values(rb ?? {}).every((r: any) => !("where" in r)),
    rb ? Object.keys({ ...rb, ...nowRb }).filter((k) => !same(rb[k], nowRb[k])) : "no pin: --pin");
  // the rule itself, on mutated tables
  const codes = JSON.parse(JSON.stringify(nowRc)); const one = Object.keys(codes.codes)[0];
  const gone = { ...codes, codes: Object.fromEntries(Object.entries(codes.codes).filter(([k]) => k !== one)) };
  const reworded = JSON.parse(JSON.stringify(codes)); reworded.codes[one].meaning += " (changed)";
  const added = JSON.parse(JSON.stringify(codes)); added.codes["zz-new"] = { meaning: "m", when: "w" };
  const rbOne = Object.keys(nowRb)[0]; const rbChanged = JSON.parse(JSON.stringify(nowRb)); rbChanged[rbOne].unknown = "something else";
  const vGone = pinVerdictC12(codes, nowRb, null, "2026-10-21", gone, nowRb), vGoneAck = pinVerdictC12(codes, nowRb, "test", "2026-10-21", gone, nowRb);
  const vWord = pinVerdictC12(codes, nowRb, null, "2026-10-21", reworded, nowRb), vAdd = pinVerdictC12(codes, nowRb, null, "2026-10-21", added, nowRb);
  const vRb = pinVerdictC12(codes, nowRb, null, "2026-10-21", codes, rbChanged);
  check("N8", "a refusal code gone, a code's meaning reworded, or a readback rule changed re-pins only with --ack (the changelog line names it); a new code re-pins freely",
    !vGone.ok && vGoneAck.ok && /^- 2026-10-21: normative: test\n  - refusal [a-z-]+: gone/.test(vGoneAck.changelog ?? "") && !vWord.ok && vAdd.ok && !vAdd.breaks.length && !vRb.ok && /readback/.test(vRb.why ?? ""), { vGone: vGone.ok, vWord: vWord.ok, vAdd: vAdd.ok, vRb: vRb.ok });
  const setFiles = rows(section("## The normative set")).slice(1).map((r) => r[0].replace(/`/g, ""));
  check("N9", "NORMATIVE.md lists both pins in the set, and PROTOCOL.md cites the pins (not the code) for the refusal codes and the readback table",
    setFiles.includes(RC_PIN) && setFiles.includes(RB_PIN) && proto.includes(RC_PIN) && proto.includes(RB_PIN), { set: [setFiles.includes(RC_PIN), setFiles.includes(RB_PIN)], proto: [proto.includes(RC_PIN), proto.includes(RB_PIN)] }); }

console.log(`[normative-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
