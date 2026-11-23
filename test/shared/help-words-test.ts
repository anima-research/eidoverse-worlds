// The words people and agents read from the door and its help tables say what the code does: a help list is the list
// the code holds, a role is named by its name today, and no internal review tag ("(R 10-07)") leaks into a refusal.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/help-words-test.ts
// @ts-nocheck
import { scratchWorld } from "../harness/scratchworld.ts";
import { suite } from "../gate/suite.ts";
import { VERBSPEC } from "../../shared/protocol/verbspec.js";
import { COMPONENTS } from "../../shared/protocol/componentspec.js";
import { PERMISSION_NAMES, RENAMED_ROLES } from "../../shared/protocol/roles.js";
import { RECORDS } from "../../shared/components.js";

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

// HW8 physics-volume's modes say only walk and swim change speed (shared/mover.js asks for those two; the authority's track reads all four), and say it is a list
{ const pv = COMPONENTS["physics-volume"]; const docs = pv.docs.modes, help = pv.help;
  const honest = (s) => /only walk and swim change a body's speed yet/.test(s) && /fly and climb are accepted/.test(s) && /nothing slows or boosts them/.test(s);
  check("HW8 physics-volume docs.modes and help say a list, and that fly and climb are accepted but change no one's speed yet", honest(docs) && honest(help) && /a list of/.test(docs), { docs, help }); }

// HW5 the Light record's note names the light component's real wire keys (componentspec light.fields)
{ const note = RECORDS.Light?.note ?? ""; const keys = (note.match(/comp\.light \{([^}]*)\}/)?.[1] ?? "").split(/,\s*/).filter(Boolean);
  const fields = Object.keys(COMPONENTS.light.fields), stray = keys.filter((k) => !fields.includes(k));
  check("HW5 the Light note's wire keys are light component fields, and include decay and daytime", keys.length > 0 && !stray.length && keys.includes("decay") && keys.includes("daytime"), { keys, stray }); }

done();
