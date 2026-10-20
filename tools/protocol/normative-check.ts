// normative-check — spec/NORMATIVE.md is the closed set, and its tables say what the reference does.
//   N1 every file the normative set lists exists; nothing outside spec/ is listed as normative
//   N2 the consent preset table equals shared/protocol/consent.js PRESETS, cell for cell (both tiers)
//   N3 the consent numbers in the prose (20 s ask, 10 min, 30 days, the intimate points) equal the code's
//   N4 the roles ladder, permission list and built-in roles equal shared/protocol/roles.js
//   N5 PROTOCOL.md never calls a code file normative (code is informative: NORMATIVE.md says so)
// A failing row means one of the two moved: change the other in the same commit, or mark the row's status.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/normative-check.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as C from "../../shared/protocol/consent.js";
import * as R from "../../shared/protocol/roles.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

// N2
const presetRows = rows(doc.slice(doc.indexOf("**Presets**"))).filter((r) => C.CLASSES.includes(r[0]) || r[0] === "class");
const head = presetRows.find((r) => r[0] === "class") ?? [];
const names = head.slice(1, -1), diffs: string[] = [];
if (names.join() !== Object.keys(C.PRESETS).join()) diffs.push(`columns ${names.join()} vs presets ${Object.keys(C.PRESETS).join()}`);
for (const cls of C.CLASSES) {
  const r = presetRows.find((x) => x[0] === cls); if (!r) { diffs.push(`no row ${cls}`); continue; }
  names.forEach((p, i) => { if (C.PRESETS[p]?.everyone[cls] !== r[i + 1]) diffs.push(`${p}.everyone.${cls}: doc ${r[i + 1]}, code ${C.PRESETS[p]?.everyone[cls]}`); });
  for (const p of Object.keys(C.PRESETS)) if (C.PRESETS[p].friends[cls] !== r.at(-1)) diffs.push(`${p}.friends.${cls}: doc ${r.at(-1)}, code ${C.PRESETS[p].friends[cls]}`);
}
check("N2", "the preset table equals consent.js PRESETS, every cell of both tiers", !diffs.length, diffs.join("; "));

// N3
const consent = section("### Body consent");
const n3 = [
  ["classes", C.CLASSES.every((c) => consent.includes("`" + c + "`")) && (consent.match(/^\| Classes \|(.*)\|/m)?.[1].match(/`[a-z-]+`/g) ?? []).length === C.CLASSES.length],
  ["enforced", (consent.match(/^\| Enforced today \|([^|]*)/m)?.[1].split(".")[0].match(/`[a-z]+`/g) ?? []).map((x) => x.slice(1, -1)).join() === C.ENFORCED.join()],
  ["default preset", C.DEFAULT_PRESET === "normal" && /the `normal` preset, for every body/.test(consent)],
  ["ask timeout", C.ASK_MS === 20_000 && /\*\*20 s\*\*/.test(consent)],
  ["cool-down after a no", C.COOL_MS === 600_000 && /\*\*10 min\*\*, doubling/.test(consent)],
  ["a yes held", C.REACH_GRANT_MS === 600_000 && /held at most \*\*10 min\*\*/.test(consent)],
  ["longest allow", C.MAX_ALLOW_MS === 30 * 24 * 3_600_000 && /at most \*\*30 days\*\*/.test(consent)],
  ["intimate points", [...C.INTIMATE_POINTS].every((p) => (consent.match(/^\| Intimate points \|([^|]*)/m)?.[1] ?? "").includes("`" + p + "`")) && (consent.match(/^\| Intimate points \|([^|;]*)/m)?.[1].match(/`[a-z_]+`/g) ?? []).length === C.INTIMATE_POINTS.size],
  ["refusal words", C.refusalWords("<name>", "<class>") === "<name> isn't taking <class> right now" && consent.includes("`\"<name> isn't taking <class> right now\"`")],
] as const;
const bad3 = n3.filter(([, ok]) => !ok).map(([k]) => k);
check("N3", "the consent prose's values equal consent.js (classes, enforced, default, 20 s, 10 min ×2, 10 min yes, 30 days, intimate points, the refusal)", !bad3.length, bad3.join(", "));

// N4
const roles = section("### World roles");
const ladder = roles.match(/^\| The ladder \|([^|]*)/m)?.[1] ?? "";
const want = ["visitor", "builder", "moderator", "owner"].map((k) => `\`${k}\` ${R.RANK[k]}`);
const perms = (roles.match(/^\| Permissions \|([^|]*)/m)?.[1].match(/`[A-Za-z]+`/g) ?? []).map((x) => x.slice(1, -1));
const built = roles.match(/^\| Built-in roles \|([^|]*)/m)?.[1] ?? "";
const can = (k: string) => Object.keys(R.BUILTIN[k].can).filter((x) => R.BUILTIN[k].can[x]);
const builtOk = can("visitor").length === 0 && /visitor: none/.test(built) && /builder: build, editOthers, scripts/.test(built) && can("builder").join() === "build,editOthers,scripts"
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

console.log(`[normative-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
