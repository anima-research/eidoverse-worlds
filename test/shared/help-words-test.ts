// The words people and agents read from the door and its help tables say what the code does: a help list is the list
// the code holds, a role is named by its name today, and no internal review tag ("(R 10-07)") leaks into a refusal.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/help-words-test.ts
// @ts-nocheck
import { scratchWorld } from "../harness/scratchworld.ts";
import { suite } from "../gate/suite.ts";
import { VERBSPEC, REMOVED_VERBS, RESERVED_VERBS } from "../../shared/protocol/verbspec.js";
import { COMPONENTS } from "../../shared/protocol/componentspec.js";
import { PERMISSION_NAMES, RENAMED_ROLES } from "../../shared/protocol/roles.js";
import { RECORDS } from "../../shared/components.js";
import { GATE_WORDS } from "../../client/lib/player/consent.js";

const { check, done } = suite("help-words");
const TAG = /\bR \d{1,2}-\d{2}\b/;

const W = scratchWorld("help-words").seed({ cup: { model: "cup.glb", pos: [0, 0, 0] } });

// HW2 role-defs help lists the permissions roles.js holds, all of them
{ const help = COMPONENTS["role-defs"].help; const list = help.match(/Permissions: (.*)$/)?.[1] ?? "";
  check("HW2 role-defs help names exactly the permission list (PERMISSION_NAMES)", list.split(/,\s*/).join() === PERMISSION_NAMES.join(), { list, want: PERMISSION_NAMES }); }

// HW3 undo's doc names roles by today's names, never a renamed one (visitor is member now)
{ const doc = VERBSPEC.undo.doc; const old = Object.keys(RENAMED_ROLES).filter((k) => new RegExp(`\\b${k}'s\\b`).test(doc));
  check("HW3 undo's doc names no renamed role, and names member", !old.length && /\bmember's\b/.test(doc), doc); }

// HW4 the door component's refusal teaches openable with no review tag
{ const r = W.call("set", { id: "cup", component: "door", value: { open: false } }); const said = `${r.refused?.reason ?? ""}`;
  check("HW4 set door is refused pointing at openable, with no review tag in the words", r.refused?.code === "schema" && /openable/.test(said) && !TAG.test(said), said); }

// HW5 the Light record's note names the light component's real wire keys (componentspec light.fields)
{ const note = RECORDS.Light?.note ?? ""; const keys = (note.match(/comp\.light \{([^}]*)\}/)?.[1] ?? "").split(/,\s*/).filter(Boolean);
  const fields = Object.keys(COMPONENTS.light.fields), stray = keys.filter((k) => !fields.includes(k));
  check("HW5 the Light note's wire keys are light component fields, and include decay and daytime", keys.length > 0 && !stray.length && keys.includes("decay") && keys.includes("daytime"), { keys, stray }); }

// HW6 no help string an agent reads (every verb's, removed or reserved verb's and component's doc, help, why, dropped note) carries a review tag
{ const hits = []; const walk = (v, at) => { if (typeof v === "string") { if (TAG.test(v)) hits.push(`${at}: ${v.slice(0, 80)}`); }
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`); };
  walk(VERBSPEC, "VERBSPEC"); walk(REMOVED_VERBS, "REMOVED_VERBS"); walk(RESERVED_VERBS, "RESERVED_VERBS"); walk(COMPONENTS, "COMPONENTS");
  check("HW6 no VERBSPEC, REMOVED_VERBS, RESERVED_VERBS or COMPONENTS string carries a review tag", !hits.length, hits); }

// HW7 consent's refusal of a retired argument carries no review tag
{ const r = W.call("consent", { switch: "accept" }); const said = `${r.refused?.reason ?? ""}`;
  check("HW7 consent {switch} is refused shape, with no review tag in the words", r.refused?.code === "shape" && /switch/.test(said) && !TAG.test(said), said); }

// HW9 the scripts verb's test event names every event a script can be woken by (componentspec script on: + tick and wake)
{ const doc = VERBSPEC.scripts.args.test.doc; const want = [...COMPONENTS.script.itemEnums.on.map((e) => e === "changed:*" ? "changed:<comp>" : e), "tick", "wake"];
  const missing = want.filter((e) => !doc.includes(`'${e}'`));
  const r = W.call("scripts", { id: "cup", script: "x", test: {} }); const said = `${r.refused?.reason ?? ""}`; const missingR = want.filter((e) => !said.includes(`'${e}'`));
  check("HW9 scripts test doc and its refusal name every script event (grab and release too)", !missing.length && !missingR.length && r.refused?.code === "shape", { missing, missingR, said }); }

// HW10 access help says who skips what (server/access.ts bypassOf): listed owners and moderators skip join, age and capacity, never a ban
{ const help = COMPONENTS.access.help;
  check("HW10 access help no longer says moderators and owners always get in, and says a ban still holds", !/always get in/.test(help) && /ban/.test(help), help); }

// HW11 Settings ▸ body's gate tips say the world's own default comes first (shared/protocol/consent.js decide reads @world.body-default)
{ const tips = Object.values(GATE_WORDS).map((w) => w.tip);
  check("HW11 each gate tip says this world may set its own default", tips.length === 2 && tips.every((t) => /unless this world sets its own default/.test(t) && !/ by default\.$/.test(t)), tips); }

done();
