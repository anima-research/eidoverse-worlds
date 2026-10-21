// shared/protocol/authority/checks.js — what the gate checks a value against: sanity and shape of what the authority's
// own engine reads (valueCheck), media sources, the typed fields and the terrain's shape, unknown and dropped keys, the
// registry's schema (schemaCheck, schemaRefusal), particle effects, handlers, and a rest's claim against the engine
// (restCheck) (refactor split, 2026-10-17; moved from authority.js's gate section unchanged). guess is above it, through UP.
import { ONE_PLACE } from "../../components.js";
import { checkSockets, checkSocket, checkStation } from "../../sockbody.js";
import { checkGrabbable } from "../../grab.js";
import { isEntityId, isComponent, isIdentity, PURGED } from "../fold.js";
import { COMPONENTS, defOf, registered, baseOf, isNamespaced, outOfRange, rangeWords } from "../componentspec.js";
import { partSlot } from "../names.js";
import * as TR from "../sculpt.js";
import * as R from "../roles.js";
import { graphemes, cleanText } from "../../text.js";
import { mediaTier } from "../../mediasrc.js";
import { instanceProblem, ESSENTIAL_NAMES, LEGACY_FIELDS } from "../../particle_effects.js";
import { worldPose } from "../simlayer.js";
import { trustRefusal } from "../../drafts.js";
import { shapeError } from "../shapes.js";
import { CTX, UP } from "./ctx.js";
import { Refusal, refuse } from "./refuse.js";
import { modelOf } from "./catalogue.js";
import { LOCK_LEVELS } from "./storage.js";
import { ancestors } from "./math.js";
import { toggleOf } from "./use.js";
import { scriptCeiling } from "./scripts.js";
import { CAPACITY_CEILING } from "./capacity.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const guess = (...a) => UP.guess(...a);

// Sanity and shape of the values the authority's own engine reads (what the change IS, not which word carried it).
function valueCheck(s, { id, comp, value: v }, { carry = false, now = null } = {}) {
  const at = `${id}.${comp}`; const obj = v && typeof v === "object" && !Array.isArray(v);
  // where a component goes (catalogue `on`): world settings on a chair, or a transform on @world, were taken and then
  // meant different things to the authority and the renderer (component review T1a/T1b)
  const on = defOf(comp)?.on;
  if (on === "world" && id !== "@world") refuse("world-only", `${comp.split(":")[0]} is a world setting: it goes on @world, not on ${id}`, `set {id: '@world', component: '${comp}', value: …}`);
  if (on === "thing" && id === "@world") refuse("thing-only", `${comp} belongs to a thing; @world is the world itself`, "make a thing (create) and put it there");
  if (comp === "parent" && v?.to === "@world") refuse("thing-only", `@world isn't a thing to be inside: a thing with no parent already sits in the world`, `delete {id: '${id}', component: 'parent'}`);
  // one place per thing (R 10-11 00:37; the answer: anything that needs its own place goes on a child): a light and a model
  // never share an entity, so a light's pose is its own and the editor's gizmo moves one thing. Existing logs keep folding
  // (the fold never refuses); the importer splits them; a carried value (an import) passes.
  // a mesh is a body of its own, as a model is: never beside a model or a light on one thing. The words are shared with the
  // Inspector (components.js ONE_PLACE), so a refusal reads the same from either
  if (!carry && (comp === "light" || comp === "model" || comp === "mesh")) { const c = s.entities[id]?.c ?? {};
    for (const has of ["model", "light", "mesh"]) if (has !== comp && c[has] !== undefined) refuse("one-place", ONE_PLACE.reason(id, has, comp), ONE_PLACE.fix(id, has, comp)); }
  if (id === "@world" && comp.startsWith("roles:") && (!isIdentity(comp.slice(6)) || !CTX.knownId(comp.slice(6))))
    refuse("shape", !isIdentity(comp.slice(6)) ? `roles:${comp.slice(6)} names no one: a role is given to an identity (u-…), not a typed name` : `roles:${comp.slice(6)} is an identity this server doesn't know`, "whois {name} finds a person's identity; then set roles:<identity>", { didYouMean: guess(comp.slice(6), Object.keys(s.entities["@world"]?.c ?? {}).filter((k) => k.startsWith("roles:")).map((k) => k.slice(6))) });
  const nums = (a, n, lim = 1e5) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Math.abs(x) <= lim);
  // H5: everyone-is-owner would let any stranger remove the real owners: the default role is any role but owner (R 10-06;
  // research §4); `none` (legacy: below visitor) is still read and written, as existing worlds carry it
  const wcS = s.entities["@world"]?.c ?? {}; const roleIds = () => R.rolesOf(wcS).map((r) => r.id);
  if (id === "@world" && comp === "default-role" && (R.isOwner(v) || (!R.isNone(v) && !R.roleDef(wcS, v?.role))))
    refuse("shape", `${at}.role must be a role here other than owner (${roleIds().filter((x) => x !== "owner").join(", ")}; got ${JSON.stringify(v?.role)})`, "an owner is named by identity: set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}");
  if (id === "@world" && comp === "default-role" && v?.guests !== undefined && (v.guests === "owner" || !R.roleDef(wcS, v.guests) || (R.GUESTS_AT_MOST_DEFAULT && R.rankOfRole(wcS, v.guests) > R.rankOfRole(wcS, v.role))))
    refuse("shape", `${at}.guests must be a role here at or below role (guests never get more than everyone else; got ${JSON.stringify(v.guests)} with role ${JSON.stringify(v.role)})`, "to let people without an account build here: {role: 'builder', guests: 'builder'}");
  if (id === "@world" && comp.startsWith("roles:") && (!obj || (!R.isNone(v) && !R.roleDef(wcS, v.role))))
    refuse("shape", `${at}.role must be a role here (${roleIds().join(", ")}; got ${JSON.stringify(v?.role)})`, "role-defs (the owner) defines custom roles", { didYouMean: guess(String(v?.role), roleIds()) });
  if (id === "@world" && comp.startsWith("roles:") && obj) {
    for (const k of Object.keys(v)) if (!["role", "can", "note", "until"].includes(k)) refuse("schema", `${at}: unknown key '${k}'`, "roles:<id> is {role, can?, note?, until?}", { didYouMean: guessKey(k, ["role", "can", "note", "until"]) });
    // a timed grant (upstream #258): `until` is when it ends (epoch ms, the authority's clock); the authority writes its end
    // (expire-roles) and warns the holder five minutes before. Ownership never ends by itself (an ownerless world would
    // open), and a new end is in the future, at most a year out
    if (v.until !== undefined) {
      if (R.isOwner(v)) refuse("shape", `${at}: ownership never expires`, "give a timed grant a role below owner, or leave until out");
      if (!Number.isSafeInteger(v.until)) refuse("shape", `${at}.until is a time in epoch milliseconds`, now != null ? `until: ${now + 7200000} ends it two hours from now (it is ${now} here now)` : "until is the time it ends, in epoch milliseconds");
      if (!carry && now != null && (v.until <= now || v.until > now + 366 * 86400000)) refuse("bounds", `${at}.until must be in the future and at most a year away (it is ${v.until <= now ? "already past" : "more than a year out"})`, `it is ${now} here now: until is that plus the grant's length in ms; to end a grant now, delete roles:<id>`);
    }
    if (v.note !== undefined && !(typeof v.note === "string" && v.note.length <= 80)) refuse("shape", `${at}.note is up to 80 characters`, "");
    if (v.can !== undefined) { const bad = R.checkCan(v.can, at); if (bad) refuse(bad.code, bad.reason, bad.fix, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined);
      // dependencies are checked on the EFFECTIVE set at write (research §3): editOthers on without build is refused
      if (!R.isOwner(v) && !R.isNone(v)) { const br = R.brokenNeed({ ...R.roleDef(wcS, v.role).can, ...v.can });
        if (br) refuse("needs", `${at}: ${br[0]} needs ${br[1]}, which would be off`, `give ${br[1]} too (can: {${br[1]}: true}), or leave ${br[0]} off`); } } }
  // default-role.can: permissions on top of the default role for everyone who holds it that way (what an imported world's
  // grant to everyone, roles['*'].gen in its old log, becomes: can.generate). The same closed list and dependencies as roles:<id>.can
  if (id === "@world" && comp === "default-role" && obj && v.can !== undefined) { const bad = R.checkCan(v.can, at); if (bad) refuse(bad.code, bad.reason, bad.fix, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined);
    if (R.roleDef(wcS, v.role)) { const br = R.brokenNeed({ ...R.roleDef(wcS, v.role).can, ...v.can }); if (br) refuse("needs", `${at}: ${br[0]} needs ${br[1]}, which would be off`, `give ${br[1]} too (can: {${br[1]}: true}), or leave ${br[0]} off`); } }
  if (id === "@world" && comp === "trusted-components") { const bad = trustRefusal(v); if (bad) refuse("shape", `${at}: ${bad}`, "set {id: '@world', component: 'trusted-components', value: {components: ['<handle>/<name>', …]}} (the drafts this world trusts; delete the component to trust none)"); }
  // policy numbers (PROTOCOL §9.2): an owner sets each at or below this server's ceiling, which is policy, not a registry range
  if (id === "@world" && obj && !carry && (comp === "capacity" || comp === "script-settings")) { const top = comp === "capacity" ? CAPACITY_CEILING : scriptCeiling();
    for (const [k, n] of Object.entries(top)) if (Number.isFinite(v[k]) && v[k] > n) refuse("bounds", `${at}.${k} is ${v[k]}; this server allows at most ${n}`, `set it at ${n} or below (schema reports this server's defaults and ceilings)`, { ceiling: n }); }
  if (id === "@world" && comp === "access" && obj && v.soft !== undefined && v.max !== undefined && v.soft > v.max) refuse("bounds", `${at}.soft (${v.soft}) can't be above max (${v.max})`, "soft is the recommended capacity; max is the hard one");
  // a who names a role this world has (a custom role too); a typo would open or close it to the wrong people
  // a carried value (a fork's copy, the load's lift) keeps the who it was written with, even a role deleted since: the lift
  // re-spells what the log holds and judges nothing new (review 10-12 S2-3); an unknown who reads as the strictest
  const whoOk = (x, where) => { if (!carry && x !== undefined && (x === "none" || !R.roleDef(wcS, x))) refuse("shape", `${where}.who must be a role here (${roleIds().join(", ")}; got ${JSON.stringify(x)})`, "who may: a role name; anyone ranked at or above it may", { didYouMean: guess(String(x), roleIds()) }); };
  if (comp === "physics" && obj) whoOk(v.who, at);
  if (comp === "grabbable" && obj) whoOk(v.who, at);
  if (comp === "reactions" && obj) for (const [act, h] of Object.entries(v)) if (h && typeof h === "object") whoOk(h.who, `${at}.${act}`);
  if (comp === "sockets" && obj) for (const [slot, sk] of Object.entries(v)) if (sk?.body && typeof sk.body === "object") whoOk(sk.body.who, `${at}.${slot}.body`);
  if (comp === "station" && obj) whoOk(v.who, at);
  if (comp === "transform") { if (!obj || !nums(v.pos, 3) || !nums(v.q, 4, 1.0001) || !nums(v.scale, 3, 1e3) || Object.keys(v).some((k) => !["pos", "q", "scale"].includes(k)))
    refuse("shape", `${at} must be {pos: [x,y,z], q: [x,y,z,w], scale: [x,y,z]}, finite and within bounds`, "pos within ±100 km, q a rotation, scale within ±1000");
    // a rotation is a unit quaternion (the renderer normalizes; the authority's own maths uses q as written), and a scale of
    // 0 makes every child's transform divide by zero (review T0e)
    if (Math.hypot(...v.q) < 1e-6) refuse("shape", `${at}.q is all zeros, which isn't a rotation`, "no rotation is [0, 0, 0, 1]");
    if (v.scale.some((x) => Math.abs(x) < 1e-4)) refuse("shape", `${at}.scale has a 0 in it; a thing can't be flat to nothing`, "to hide something, delete it or give it a tiny scale like 0.01"); }
  if (comp === "bounds") { if (!obj || !nums(v.min, 3) || !nums(v.max, 3) || Object.keys(v).some((k) => !["min", "max"].includes(k)) || v.min.some((x, i) => x >= v.max[i]))
    refuse("shape", `${at} must be {min: [x,y,z], max: [x,y,z]} with min < max on every axis (a box with room inside)`, "e.g. {min: [-20, 0, -20], max: [20, 12, 20]}"); }
  if (comp === "parent") { if (!obj || typeof v.to !== "string") refuse("shape", `${at} must be {to: <id>}`, "");
    if (v.socket !== undefined) refuse("legacy", `${at}.socket is the old spelling: a socket is a child entity now`, `parent {to: <the socket's id>} (inspect {id: '${v.to}'} lists its sockets)`);
    if (!s.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(s.entities)) });
    if (v.to === id || ancestors(s, v.to).includes(id)) refuse("loop", `${id} can't be inside ${v.to}: that makes a loop`, "");
    // A chain 32 deep is a LIMIT, not a loop, and saying "loop" sent people hunting a cycle that isn't there
    // (the walk in `ancestors` stops at 32, so this is where the engine stops following a parent chain).
    if (ancestors(s, id).length >= 32) refuse("deep", `${id} is already 32 deep; a parent chain stops there`, "attach it higher up, or flatten part of the chain", { depth: ancestors(s, id).length }); }
  if (comp === "model" && !modelOf(v)) refuse("shape", `no model called '${v}'`, "find {kind: 'model', query} lists models", { didYouMean: guess(String(v), CTX.cat.list(String(v).split("/").pop().replace(/\.[a-z0-9]+$/i, "").slice(0, 12)).map(([k]) => k).slice(0, 200)) });
  if (comp === "pivot" && (!obj || !nums(v.pos, 3, 1e4) || Object.keys(v).some((k) => k !== "pos"))) refuse("shape", `${at} must be {pos: [x,y,z]} in its own frame (metres, before scale)`, "e.g. {pos: [0, 0.5, 0]}; delete it to turn about the origin again");
  if (comp === "lock" && v !== true && !(obj && Object.keys(v).length === 1 && LOCK_LEVELS.includes(v.rank)))
    refuse("shape", `${at} is true (a builder-level lock) or {rank: 'builder' | 'moderator' | 'owner'}; to unlock, delete it`, `delete {id: '${id}', component: 'lock'}`);
  if (comp === "openable" && obj) {
    if (v.angle !== undefined && v.slide !== undefined) refuse("shape", `${at} turns (angle) or slides (slide), not both`, "give one: angle (rad) to swing about its pivot, or slide [x, y, z] (m) to slide");
    if (v.slide !== undefined && !nums(v.slide, 3, 10)) refuse("bounds", `${at}.slide is [x, y, z] in metres, each within 10`, "e.g. [0.9, 0, 0]: a sliding door moves its own width sideways"); }
  if ((comp === "motion" || comp.startsWith("motion:")) && obj) {
    if ("rpm" in v) refuse("schema", `${at}.rpm: a spin's rate is degPerSec here (degrees a second; rpm × 6)`, `e.g. {type: 'spin', degPerSec: ${Number.isFinite(v.rpm) ? +(v.rpm * 6).toFixed(4) : 36}}, or period (seconds a turn)`, { didYouMean: ["degPerSec"] });
    if ((v.type === "spin" || v.type === "orbit") && v.degPerSec !== undefined && v.period !== undefined) refuse("shape", `${at} gives its speed twice (degPerSec and period)`, "give one: degPerSec (degrees a second) or period (seconds a turn)");
    if (v.type === "path" && v.speed !== undefined && v.duration !== undefined) refuse("shape", `${at} gives its speed twice (speed and duration)`, "give one: speed (m/s) or duration (s from the first point to the last)");
    if (v.type === "path" && !(Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= 64 && v.points.every((p) => nums(p, 3, 1e4))))
      refuse("shape", `${at}.points must be 2 to 64 points [x, y, z] (metres, in its parent's frame)`, "e.g. {type: 'path', points: [[0, 0, 0], [0, 0, 4]], speed: 1}"); }
  // one hinge per thing (shape audit 10-16): a whole thing turns about its pivot component; motion:<part>.pivot is a part's
  // a node of its model moves as motion:<slot> {node: <the file's name>} (review r7, R 10-16: a part's name is data, never
  // part of a key); a whole thing's motion moves the whole thing
  if (comp === "motion" && obj && "node" in v && !carry) refuse("shape", `${at}.node: a whole thing's motion moves the whole thing; a node of its model moves as its own component`, `set {id: '${id}', component: 'motion:${partSlot(typeof v.node === "string" && v.node ? v.node : "part")}', value: {node: ${JSON.stringify(typeof v.node === "string" ? v.node : "<node>")}, type, …}}`);
  if (comp.startsWith("motion:") && obj && "node" in v && !(typeof v.node === "string" && v.node.length >= 1 && v.node.length <= 256)) refuse("shape", `${at}.node is the name of a node in its model, as the file spells it (1–256 characters)`, "measure {id} lists its model's parts");
  if (comp === "motion" && obj && "pivot" in v && !carry) refuse("derived", `${at}.pivot: a whole thing's motion turns about its pivot component, not a field of the motion`, `set {id: '${id}', component: 'pivot', value: {pos: [x, y, z]}} (its own frame); a part's motion (motion:<part>) takes pivot`);
  if (comp === "home") { const okQ = (q) => nums(q, 4, 2) && Math.abs(Math.hypot(...q) - 1) < 1e-3;
    // one spelling (shape audit 10-16): scale is [x, y, z] (a number is taken at write and stored as one; an older stored
    // number is carried by a fork or a lift), parent is {to}
    const okScale = (sc) => (nums(sc, 3) && sc.every((x) => x > 0)) || (carry && typeof sc === "number" && sc > 0);
    if (!obj || !nums(v.pos, 3) || (v.q !== undefined && !okQ(v.q)) || (v.scale !== undefined && !okScale(v.scale)) || Object.keys(v).some((k) => !["pos", "q", "scale", "parent"].includes(k)) || (v.parent !== undefined && !(v.parent && typeof v.parent === "object" && typeof v.parent.to === "string" && Object.keys(v.parent).every((k) => k === "to"))))
      refuse("shape", `${at} is {pos: [x, y, z], q?: [x, y, z, w], scale?: [x, y, z], parent?: {to}}`, "e.g. {pos: [0, 0, 2]}"); }
  if (comp === "reactions") { if (!obj) refuse("shape", `${at} must be {<action>: handler}`, "");
    const kinds = Object.keys(COMPONENTS.reactions.handlers), held = COMPONENTS.reactions.reservedKinds;
    for (const [act, h] of Object.entries(v)) { if (!carry && Object.hasOwn(held, h?.kind)) refuse("reserved", `reactions.${act}: the handler kind '${h.kind}' is reserved: ${held[h.kind]}`, `handler kinds: ${kinds.join(", ")}; a script handler computes anything else`, { status: "reserved" });
      if (!kinds.includes(h?.kind) && !(carry && Object.hasOwn(held, h?.kind))) refuse("shape", `reactions.${act}: no handler kind '${h?.kind}'`, `handler kinds: ${kinds.join(", ")}`, { didYouMean: guess(String(h?.kind), kinds) });
      if (h.component !== undefined && !isComponent(h.component)) refuse("shape", `reactions.${act}.component '${h.component}' isn't a component name`, "§3.1");
      if (h.kind === "set" && !isComponent(h.component)) refuse("shape", `reactions.${act} (set) needs a component`, "e.g. {kind: 'set', component: 'openable', field: 'locked', value: true}");
      for (const f of ["field", "unless"]) if (h[f] !== undefined && typeof h[f] !== "string") refuse("shape", `reactions.${act}.${f} is a field name (a string)`, "");
      if (h.kind === "reset" && !(Array.isArray(h.targets) && h.targets.length >= 1 && h.targets.length <= 64 && h.targets.every((t) => typeof t === "string")))
        refuse("shape", `reactions.${act} (reset) names what it sends home: targets [1 to 64 ids]`, "e.g. {reset: {kind: 'reset', targets: ['ball-0', 'ball-1']}}");
      if (h.kind === "reset") { const gone = h.targets.filter((t) => !s.entities[t]); if (gone.length) refuse("not-found", `reactions.${act} (reset) names ${gone.join(", ")}, which ${gone.length > 1 ? "aren't" : "isn't"} here`, "", { didYouMean: guess(gone[0], Object.keys(s.entities)) }); }
      if (h.kind === "script" && !(typeof h.script === "string" && isComponent(`script:${h.script}`))) refuse("shape", `reactions.${act} (script) names the script: {kind: 'script', script: '<name>'} for the script:<name> on this thing`, "e.g. {ring: {kind: 'script', script: 'bell'}}");
      handlerCheck(at, act, h); effectCheck(s, id, act, h); } }
  mediaCheck(s, id, comp, v, at, obj);
  // a held kind (componentspec reservedKinds: terrain's raster, shape audit 10-16) is refused as reserved, in its own words
  if (comp === "terrain" && obj && !carry && Object.hasOwn(COMPONENTS.terrain.reservedKinds, v.kind)) refuse("reserved", `${at}.kind '${v.kind}' is reserved: ${COMPONENTS.terrain.reservedKinds[v.kind]}`, "terrain {kind: 'noise', seed, size, amplitude, …}; an image as the base is heightmap {grid, min, max}", { status: "reserved" });
  // the first protocol's particles bag (preset, origin, count…): its fields left the registry (shape audit 10-16), so say today's
  // spelling in particlesCheck's own words before the schema calls them unknown keys
  if (baseOf(comp) === "particles" && obj && !carry && LEGACY_FIELDS.some((k) => k in v)) refuse("shape", `${at}: ${instanceProblem(v, null)}`, `PROTOCOL §4 (effects are documents): {effect: '${ESSENTIAL_NAMES[0]}'} or an uploaded effect's address; schema {component: 'particles'} lists the Essentials and their params`);
  if (comp === "water" && obj && v.flow !== undefined && !(Array.isArray(v.flow) && v.flow.length === 2 && v.flow.every(isNum) && v.flow.every((x) => Math.abs(x) <= 100))) refuse("shape", `${at}.flow is a current [x, z] in metres a second, each within ±100`, COMPONENTS.water.help);
  for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(":")[0]]?.enums ?? {})) if (obj && v[f] !== undefined && !allowed.includes(v[f])) refuse("shape", `${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`, `schema {component: '${comp}'}`);
  schemaCheck(at, comp, v, { carry });
  // physics.material (a surface's name) is renamed physics.surface and reserved with surfaces (shape audit 10-16): the
  // check that it names one of this world's surfaces returns when the field opens
  if (comp === "terrain-grid") { const ok = v.spacing > 0 && Number.isInteger(v.tile) && v.tile >= 1 && v.tile <= 64 && Array.isArray(v.extent) && v.extent.length === 2 && v.extent.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)
      && Array.isArray(v.origin) && v.origin.length === 2 && v.origin.every(isNum) && (v.limits === undefined || (Number.isInteger(v.limits.raise) && Number.isInteger(v.limits.lower) && v.limits.raise >= 0 && v.limits.lower >= 0));
    if (!ok) refuse("shape", `${at} must be {spacing > 0, tile 1–64, origin [x, z], extent [nx, nz], limits? {raise, lower} (mm)}`, COMPONENTS["terrain-grid"].help); }
  if (comp.startsWith("terrain-tile:")) { const g = s.entities[id]?.c["terrain-grid"]; const ij = TR.parseKey(comp);
    if (!g) refuse("no-grid", `${id} has no terrain-grid`, "set terrain-grid on the ground first");
    if (!ij || ij[0] >= g.extent[0] || ij[1] >= g.extent[1]) refuse("shape", `${comp} isn't a tile of ${id}'s ${g.extent.join("×")} grid`, "keys are <i>-<j>, counted from the grid origin");
    if (!Array.isArray(v.mm) || v.mm.length !== g.tile ** 2 || !v.mm.every(Number.isInteger)) refuse("shape", `${at}.mm must be ${g.tile ** 2} integers (millimetres)`, "");
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity;
    if (v.mm.some((n) => n < lo || n > hi)) refuse("bounds", `${at} goes outside the grid's limits (−${g.limits.lower} … +${g.limits.raise} mm)`, "terrain-grid.limits (SL's raise/lower)"); }
  // well-shaped and still here: the translator didn't see it (the door stores no old spelling)
  if (comp === "sockets") refuse("legacy", `${at} is the old spelling: each socket is a child entity now`, "create {components: {parent: {to: <host>}, transform: {pos}, socket: {name, …}}}");
}
// batch 2 (10-07): pictures, sounds, stories, signs and look-at, beyond their catalogue shape
const LOOK_WORDS = ["@viewer", "@nearest"];
const ROTATING = new Set(["pendulum", "spin"]);
const isLookAt = (k) => k === "look-at" || k.startsWith("look-at:");
const nodeOf = (k, v) => (k.includes(":") ? k.slice(k.indexOf(":") + 1) : k === "motion" && typeof v?.part === "string" ? v.part : null);   // null = the whole thing
function mediaCheck(s, id, comp, v, at, obj) {
  // where a picture's or a sound's bytes may come from (shared/mediasrc.js): this server's store, or an https link to a
  // public host. Who may FETCH a link is each viewer's browser's question (clientMayFetch); the authority refuses what nobody may
  if ((comp === "picture" || comp === "sound") && obj && v.src !== undefined) { const t = mediaTier(v.src, comp === "picture" ? "image" : "audio");
    if (t.tier === "bad") refuse("shape", `${at}.src: ${t.why}`, t.fix); }
  if (comp === "sound" && obj && isNum(v.near) && isNum(v.radius) && v.near > v.radius) refuse("bounds", `${at}.near (${v.near}) is past radius (${v.radius})`, "near is where it's at full volume; radius is where it goes silent");
  if (comp === "story" && obj && Array.isArray(v.marks)) { const seen = new Set();
    for (const m of v.marks) { if (typeof m !== "string") refuse("shape", `${at}.marks holds thing ids (strings)`, "");
      if (m === id) refuse("loop", `${id}'s story can't mark ${id} itself`, "marks names other things: what this one commemorates");
      if (seen.has(m)) refuse("shape", `${at}.marks names ${m} twice`, ""); seen.add(m);
      if (!s.entities[m] || m === "@world") refuse("not-found", `${at}.marks: no thing called '${m}'`, "look lists what's here", { didYouMean: guess(m, Object.keys(s.entities).filter((k) => k !== "@world")) }); } }
  if (comp === "text" && obj && typeof v.text === "string" && v.text.split("\n").length > 16) refuse("bounds", `${at}.text is ${v.text.split("\n").length} lines; a sign holds at most 16`, "a longer text is a story (Inspect reads it), or several signs");
  if (isLookAt(comp) && obj) {
    const T = v.target;
    if (typeof T === "string" && T.startsWith("@") && !LOOK_WORDS.includes(T)) refuse("shape", `${at}.target '${T}' isn't one of ${LOOK_WORDS.join(", ")}`, "@viewer: each viewer's own eyes; @nearest: whoever is nearest; or a thing's id, or a person's identity (u-…)", { didYouMean: guess(T, LOOK_WORDS) });
    else if (typeof T === "string" && T.startsWith("@")) { /* @viewer, @nearest */ }
    else if (typeof T === "string" && /^u-/.test(T)) { if (!isIdentity(T)) refuse("shape", `${at}.target '${T}' isn't an identity`, "whois {name} finds a person's identity"); }
    else if (typeof T === "string") { if (!s.entities[T] || T === "@world") refuse("not-found", `${at}.target: no thing called '${T}'`, "look lists what's here", { didYouMean: guess(T, Object.keys(s.entities).filter((k) => k !== "@world")) });
      if (T === id || ancestors(s, T).includes(id)) refuse("loop", `${id} can't turn to face ${T === id ? "itself" : `${T}, which rides it`}`, "pick a thing outside it"); }
    // radians (shape audit 10-16; PROTOCOL §9.2): the limits are [min, max] from rest
    for (const f of ["yaw", "pitch"]) if (v[f] !== undefined) { const lim = f === "yaw" ? Math.PI : Math.PI / 2;
      if (!(Array.isArray(v[f]) && v[f].length === 2 && v[f].every((x) => isNum(x) && Math.abs(x) <= lim + 1e-12) && v[f][0] <= v[f][1])) refuse("bounds", `${at}.${f} is [min, max] radians from rest, each within ±${f === "yaw" ? "π" : "π/2"}, min ≤ max`, `e.g. ${f}: [-0.785, 0.785] (±45°)`); }
    for (const f of ["forward", "up"]) if (typeof v[f] === "string" && !["x", "y", "z"].includes(v[f])) refuse("shape", `${at}.${f} is an axis: x|y|z or [x, y, z] (a negative one is a vector: [0, 0, -1])`, ""); }
  // one driver per node (a socket's "one drive per thing", catalogue sockets): a node turned by a rotating motion can't
  // also turn to face something, and a dynamic thing's rotation is the sim's
  if ((isLookAt(comp) || comp === "motion" || comp.startsWith("motion:")) && obj) {
    const e = s.entities[id]; const node = nodeOf(comp, v);
    if (isLookAt(comp) && e?.c.physics?.kind === "dynamic") refuse("conflict", `${id} is dynamic: physics turns it, so it can't also turn to face something`, "make it static or kinematic (physics {kind: 'static'} or {kind: 'kinematic'}): only a dynamic body is turned by physics");
    const mine = isLookAt(comp) ? (k, x) => (k === "motion" || k.startsWith("motion:")) && ROTATING.has(x?.type) : (k) => isLookAt(k);
    if (!isLookAt(comp) && !ROTATING.has(v.type)) return;
    for (const [k, x] of Object.entries(e?.c ?? {})) if (k !== comp && mine(k, x) && nodeOf(k, x) === node)
      refuse("conflict", `${node ? `${id}'s ${node}` : id} already turns by ${isLookAt(k) ? k : `${x.type} (${k})`}; one thing turns a node at a time`, `remove ${k} first, or put ${comp.split(":")[0]} on another part`); }
}
// L7 (21:45, research 40 T10): values are checked against their schema at admit. A KNOWN name with an unknown key is
// refused with a "did you mean": Under the Eves sent terrain {amp: 0}, the engine reads `amplitude`, and the flat world
// got 3 m hills. Unknown NAMES are still kept (L5): this binds only names the catalogue defines.
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const TYPES = { number: isNum, int: Number.isInteger, string: (x) => typeof x === "string", bool: (x) => typeof x === "boolean", any: () => true,
  sha256: (x) => typeof x === "string" && /^sha256:[0-9a-f]{64}$/.test(x),   // a content hash (model-hash; the one spelling, as copy-of.from's)
  vec3: (x) => Array.isArray(x) && x.length === 3 && x.every(isNum),
  axis: (x) => (Array.isArray(x) && x.length === 3 && x.every(isNum)) || x === "x" || x === "y" || x === "z", // the text-tier shorthand the renderer reads (motioneval.js)
  array: Array.isArray, object: (x) => x && typeof x === "object" && !Array.isArray(x),
  // references (componentspec REF_TYPES): ids of things, identities of people, or @words where a field takes them
  ref: (x) => isEntityId(x), refs: (x) => Array.isArray(x) && x.every((y) => isEntityId(y)), person: (x) => isIdentity(x), people: (x) => Array.isArray(x) && x.every((y) => isIdentity(y)),
  target: (x) => typeof x === "string" && (isEntityId(x) || /^@[a-z]+$/.test(x)), scope: (x) => x === "self" || x === "subtree" || (Array.isArray(x) && x.every((y) => y === "self" || isEntityId(y))) };
// "did you mean" for a field name: a prefix either way (amp → amplitude) beats a short edit distance (amp → w)
function guessKey(k, allowed) {
  const lev = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return m[a.length][b.length]; };
  const x = k.toLowerCase();
  return allowed.map((a) => { const y = a.toLowerCase(); const pre = Math.min(x.length, y.length) >= 2 && (y.startsWith(x) || x.startsWith(y));
    return [a, pre ? Math.abs(y.length - x.length) / 100 : lev(x, y)]; })
    .filter(([a, d]) => d < 1 || d <= Math.max(1, Math.floor(Math.max(k.length, a.length) / 3))).sort((p, q) => p[1] - q[1]).slice(0, 3).map(([a]) => a);
}
// upstream #237/#242's shaped terrain and water, bounded at the door (review 10-15 #5): the readers (shared/terrainshape.js)
// clamp features and water but pass a heightmap's min/max through raw, so one write of ±1e308 made every client's,
// agent's and the sim's ground NaN. A world's ground is everyone's: the same ±500 m as amplitude, min below max.
const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/, FEATURE_TYPES = ["hill", "ridge", "flatten"], HEX = /^#[0-9a-f]{6}$/i;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
function terrainShapeCheck(at, v, def) {
  if (Array.isArray(v.features)) v.features.forEach((f, i) => {
    const here = `${at}.features[${i}]`;
    if (!f || typeof f !== "object" || !FEATURE_TYPES.includes(f.type)) refuse("shape", `${here} must be {type: hill | ridge | flatten, …}`, def.help);
    const pts = f.type === "ridge" ? ["x1", "z1", "x2", "z2"] : ["x", "z"];
    for (const k of [...pts, "radius", "height", ...(f.edge !== undefined ? ["edge"] : [])]) if (!fin(f[k])) refuse("shape", `${here}.${k} must be a finite number`, def.help);
    if (!(f.radius > 0.05 && f.radius <= 2000)) refuse("bounds", `${here}.radius is ${f.radius}; it must be 0.05 < radius ≤ 2000 (m)`, def.help);
    if (Math.abs(f.height) > 500) refuse("bounds", `${here}.height is ${f.height}; it must be within ±500 (m)`, def.help);
    for (const k of pts) if (Math.abs(f[k]) > 100000) refuse("bounds", `${here}.${k} is ${f[k]}; it must be within ±100000 (m)`, def.help); });
  const h = v.heightmap;
  if (h != null) {
    if (typeof h !== "object" || Array.isArray(h)) refuse("shape", `${at}.heightmap must be {grid, min, max} or null`, def.help);
    if (typeof h.grid !== "string" || !GRID_REF.test(h.grid)) refuse("shape", `${at}.heightmap.grid must be store/heightmaps/<16 hex>.json (POST /upload?as=heightmap)`, def.help);
    for (const k of ["min", "max"]) if (h[k] !== undefined && !fin(h[k])) refuse("shape", `${at}.heightmap.${k} must be a finite number`, def.help);
    const min = h.min ?? 0, max = h.max ?? 10;
    if (Math.abs(min) > 500 || Math.abs(max) > 500) refuse("bounds", `${at}.heightmap min/max are ${min}/${max}; each must be within ±500 (m), the ground every client builds`, def.help);
    if (!(min < max)) refuse("bounds", `${at}.heightmap.min (${min}) must be below max (${max})`, def.help);
  }
  // its colour layers (shape audit 10-16): [{color: 0xRRGGBB, repeat > 0}], at most 8 (the registry's maxItems). Water is its
  // own component now (componentspec water: its level, opacity and kind are the registry's ranges and enum)
  if (Array.isArray(v.layers)) v.layers.forEach((l, i) => { const here = `${at}.layers[${i}]`;
    if (!l || typeof l !== "object" || Array.isArray(l) || Object.keys(l).some((k) => k !== "color" && k !== "repeat")) refuse("shape", `${here} must be {color?: 0xRRGGBB, repeat?: tiles across its size}`, def.help);
    if (l.color !== undefined && !(Number.isInteger(l.color) && l.color >= 0 && l.color <= 0xffffff)) refuse("shape", `${here}.color is an int 0xRRGGBB (sRGB)`, def.help);
    if (l.repeat !== undefined && !(fin(l.repeat) && l.repeat > 0 && l.repeat <= 4096)) refuse("bounds", `${here}.repeat is how many times it tiles across the ground, 0 < repeat ≤ 4096`, def.help); });
}
// where a cut field went (componentspec `dropped`), for the refusal's fix
const DROPPED_FIX = {
  "motion.amplitude": "amp is the one spelling: {type: 'pendulum', amp: 0.3}",
  "motion.part": "a node of its model moves as its own component: set {id, component: 'motion:<slot>', value: {node: <the node's name, as its file spells it>, type, …}} (<slot>: any short tag [a-z0-9-]; the editors use the node's name, or a sanitized form of it)",
  "physics.material": "physics.surface names a surface:<name> (reserved until an engine reads surfaces)",
  "physics.layers": "collision filters come back as named groups; leave it out",
  "physics.mask": "collision filters come back as named groups; leave it out",
  "physics.ccd": "eidosim sweeps every body; leave it out",
  "parent.order": "leave it out: siblings have no stored order",
  "light.shadows": "leave it out: no light here casts its own shadows yet (important claims a light slot)",
  "picture.part": "a picture is a quad of its own; texturing a node of a model is the material component's (reserved: not written yet)",
  "picture.flip": "a part's upside-down UVs are the material component's (reserved), with part",
  "terrain.water": "set {id: '@world', component: 'water', value: {level, color?, opacity?, kind?, flow?}}",
  "sky.clock": "a tz present is the wall clock: {tz: 'Europe/Paris'} (the sky act still takes clock: 'real')",
  "sky.weatherSeconds": "transition (seconds) is the one spelling",
};
const DROPPED_DYM = { "motion.amplitude": ["amp"], "physics.material": ["surface"], "light.day": ["daytime"], "sky.weatherSeconds": ["transition"], "sky.clock": ["tz"], "terrain.water": ["water"] };
function unknownKeys(at, v, allowed, what) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) { const dym = guessKey(k, allowed);
    refuse("schema", `${at}: unknown key '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ""}`, `${what} takes: ${allowed.join(", ")}`, { didYouMean: dym }); }
}
// edit distance (a near-miss of a registered component name is a typo, R8)
function lev(a, b) { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return d[b.length]; }
// the registered names one letter-slip from an unregistered bare one (round-2 R8): a typo, refused at admit
const nearMiss = (name) => Object.keys(COMPONENTS).filter((k) => k !== name && Math.abs(k.length - name.length) <= 2 && lev(k, name) <= (k.length > 4 ? 2 : 1));
/** Why the catalogue would refuse this value (its shape only: no state, no rights), or null. For tools that ask
 *  whether a translated world is one the authority takes as it is (sweep). */
export function schemaRefusal(comp, v) { try { schemaCheck(comp, comp, v);
    // the enums too (valueCheck's): a translated motion {type: 'path'} passed this and was refused at the first edit
    const ob = v && typeof v === "object" && !Array.isArray(v);
    for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(":")[0]]?.enums ?? {})) if (ob && v[f] !== undefined && !allowed.includes(v[f])) return `shape: ${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`;
    return null; } catch (e) { if (e instanceof Refusal) return `${e.code}: ${e.reason}`; throw e; } }
function schemaCheck(at, comp, v, { carry = false } = {}) {
  const base = baseOf(comp), name = registered(base) ?? base, def = COMPONENTS[name];
  // PROTOCOL §4 (review 10-07 H1, R's ruling): a bare name is the registry's. An unregistered one is refused: a typo of
  // a registered name says "did you mean"; a versioned one (light@2) says a new meaning is registered first; anything
  // else is someone's own component, which carries a namespace (example.org/heart). Before this they were admitted, and
  // the registry later promoting the same word (story) would have reread every old value in the new meaning.
  // `carry`: a fork's copy of what its parent already holds (an old world's bare invention travels as it was).
  if (name === "door") refuse("schema", `${at}: the opening behaviour is called 'openable' (R 10-07: chests, gates, lids and hatches open too)`, "openable {open: false, locked?, angle?, slide?, time?}; schema {component: 'openable'} says the rest", { didYouMean: ["openable"] });
  if (name === "placer") refuse("derived", `${at}: who made a thing is a view over the log (§0 rule 2), never stored`, "inspect {id} → derived.madeBy");
  if (!def) { if (isNamespaced(base) || carry) return;   // someone's own: kept, replayed, shown honestly (must-ignore)
    const ver = /^(.*)@[1-9][0-9]*$/.exec(name);
    if (ver && COMPONENTS[ver[1]]) refuse("schema", `${at}: '${name}' isn't registered yet: a changed meaning of '${ver[1]}' is a new name, registered (saying what it supersedes) before anyone writes it`, `use '${ver[1]}' as it is defined (schema {component: '${ver[1]}'}), or propose ${name} for the registry (shared/protocol/componentspec.js); a meaning of your own goes under your namespace: 'example.org/${name}'`, { didYouMean: [ver[1]] });
    const near = nearMiss(name);
    if (near.length) refuse("schema", `${at}: '${name}' isn't a component; did you mean '${near[0]}'?`, `${near[0]}: ${COMPONENTS[near[0]].help ?? ""}. A component of your own carries a namespace (e.g. 'example.org/${name}')`, { didYouMean: near });
    refuse("schema", `${at}: '${name}' isn't a registered component; bare names belong to the registry (PROTOCOL §4)`, `a component of your own carries a namespace: '<your domain or handle>/${name}', e.g. 'example.org/${name}'. It's kept and shown as it is; schema lists the registered ones`, { didYouMean: [`example.org/${name}`] });
  }
  // a keyed name written bare, or an unkeyed one written keyed (terrain:base {amp}, light:main {...}), dodged every check
  if (def.keyed !== "optional" && !!def.keyed !== comp.includes(":")) refuse("shape", def.keyed ? `${at}: ${name} is keyed (${name}:<key>)` : `${at}: ${name} isn't keyed; write '${name}', not '${comp}'`, def.help ?? "");
  if (def.type && !TYPES[def.type](v)) refuse("shape", `${at} must be a ${def.type}, got ${JSON.stringify(v).slice(0, 40)}`, def.help ?? "");
  // a whole-value string (description): its length in graphemes and the words-everyone-reads check, as a field's
  if (def.type === "string" && typeof v === "string") {
    if (def.maxLen !== undefined && graphemes(v) > def.maxLen) refuse("bounds", `${at} is ${graphemes(v).toLocaleString("en")} characters; it must be ≤ ${def.maxLen}`, def.help ?? "");
    if (def.cleanAs) { const bad = cleanText(v, { lines: def.cleanAs === "lines" }); if (bad) refuse("shape", `${at} ${bad.why}`, bad.fix); } }
  // a socket's whole shape (shared/sockbody.js: closed keys, ranges, enums, one driver per thing), in its own words
  if (name === "sockets") { const bad = checkSockets(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.sockets.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (name === "socket") { const bad = checkSocket(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.socket.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  // what a body does at a socket (shape audit 10-16): the core, closed; the reserved keys refused as reserved
  if (name === "station") { const bad = checkStation(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.station.help, { ...(bad.didYouMean ? { didYouMean: bad.didYouMean } : {}), ...(bad.code === "reserved" ? { status: "reserved" } : {}) }); }
  // a place entry is closed (shape audit 10-16): {at} | {min, max}, + label; null hides a model's own
  if (name === "places" && !carry && v && typeof v === "object" && !Array.isArray(v)) for (const [k, p] of Object.entries(v)) { if (p === null) continue; const pat = `${at}.${k}`;
    if (!(p && typeof p === "object" && !Array.isArray(p))) refuse("shape", `${pat} must be {at: [x, y, z]} or {min: [x, y, z], max: [x, y, z]} (+ label), or null`, def.help);
    unknownKeys(pat, p, ["at", "min", "max", "label"], "a place");
    const v3 = (x) => Array.isArray(x) && x.length === 3 && x.every((n) => isNum(n) && Math.abs(n) <= 1e5);
    if (p.at !== undefined ? (!v3(p.at) || p.min !== undefined || p.max !== undefined) : !(v3(p.min) && v3(p.max))) refuse("shape", `${pat} is a spot {at: [x, y, z]} or a room {min: [x, y, z], max: [x, y, z]}, in the thing's own frame (metres)`, def.help);
    if (p.label !== undefined && !(typeof p.label === "string" && graphemes(p.label) <= 80)) refuse("bounds", `${pat}.label is a string of at most 80 characters`, def.help);
    if (typeof p.label === "string") { const bad = cleanText(p.label, { lines: false }); if (bad) refuse("shape", `${pat}.label ${bad.why}`, bad.fix); } }
  // what a hand may do with it (shared/grab.js: closed keys, ranges, enums, grips), in its own words
  if (name === "grabbable") { const bad = checkGrabbable(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.grabbable.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (def.map) { if (!(v && typeof v === "object" && !Array.isArray(v)) || Object.values(v).some((x) => !TYPES[def.map](x))) refuse("shape", `${at} must be {<name>: ${def.map}}`, def.help ?? "");
    // a keyed map's grammar and size (params: shape audit 10-16): its keys are names, and there are at most maxKeys of them
    if (def.keyPattern) { const re = new RegExp(def.keyPattern); const bad = Object.keys(v).find((k) => !re.test(k)); if (bad !== undefined) refuse("shape", `${at}: '${bad}' isn't a name here (${def.keyPattern})`, def.help ?? ""); }
    if (def.maxKeys !== undefined && Object.keys(v).length > def.maxKeys) refuse("bounds", `${at} has ${Object.keys(v).length} entries; at most ${def.maxKeys}`, def.help ?? ""); }
  if (!def.fields) return;
  if (name === "lock" && v === true) return;   // a plain lock is true (builder level); its {rank} form is checked as an object below
  const fields = Object.keys(def.fields);
  if (!(v && typeof v === "object" && !Array.isArray(v))) refuse("shape", `${at} must be an object {${fields.join(", ")}}`, def.help);
  // shape audit 10-16: a reserved field (physics' unread properties) is refused in its own words, and a field the alpha cut
  // (motion.amplitude, motion.part, physics.layers…) says where it went. A carried value (a fork's copy, the load's lift)
  // keeps what it was written with
  if (!carry) { const held = def.reservedFields?.find((k) => k in v);
    if (held !== undefined && name !== "grabbable" && name !== "station") refuse("reserved", def.reservedWhy?.[held] ? `${at}.${held} is reserved: not built yet (${def.reservedWhy[held]}); nothing may write it` : `${at}.${held} is a reserved field: no engine here reads it yet, so nothing may write it (the name and its meaning are held: schema {component: '${name}'})`, def.help, { status: "reserved" });
    const gone = Object.keys(def.dropped ?? {}).find((k) => k in v);
    if (gone !== undefined) refuse("schema", `${at}.${gone} is gone: ${def.dropped[gone]}`, DROPPED_FIX[`${name}.${gone}`] ?? def.help, DROPPED_DYM[`${name}.${gone}`] ? { didYouMean: DROPPED_DYM[`${name}.${gone}`] } : undefined); }
  unknownKeys(at, v, carry ? [...fields, ...(def.reservedFields ?? []), ...Object.keys(def.dropped ?? {})] : fields, name);
  const kind = v.kind ?? def.defaultKind; // an imported world's terrain never named its kind: it is noise
  if (def.byKind) { if (!def.byKind[kind]) refuse("schema", `${at}.kind must be one of ${Object.keys(def.byKind).join(" | ")}, got ${JSON.stringify(v.kind)}`, def.help, { didYouMean: guess(String(v.kind), Object.keys(def.byKind)) });
    unknownKeys(at, v, def.byKind[kind], `${name} {kind: '${kind}'}`); }
  for (const [k, t] of Object.entries(def.fields)) if (v[k] !== undefined && !(v[k] === null && def.nullable?.includes(k)) && !TYPES[t](v[k])) refuse("shape", `${at}.${k} must be ${t}, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
  for (const k of def.required ?? []) if (v[k] === undefined) refuse("schema", `${at} needs ${k}`, def.help);
  // a field's grammar narrows its pinned type (physics.shape is `any` in every value ever stored): spec/PHYSICS.md §3.1
  for (const [k, g] of Object.entries(def.grammar ?? {})) if (v[k] !== undefined && g === "sha256" && !(typeof v[k] === "string" && /^sha256:[0-9a-f]{64}$/.test(v[k])))
    refuse("shape", `${at}.${k} must be a content hash sha256:<64 hex>, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
  for (const [k, g] of Object.entries(def.grammar ?? {})) if (v[k] !== undefined && g === "shape") { const why = shapeError(v[k]);
    if (why) refuse("shape", `${at}.${k}: ${why}`, "PHYSICS §3.1: a box [[min], [max]] or {type: sphere|capsule|cylinder|box|convex|mesh|compound, …}; the authority stamps it from the model"); }
  for (const [k, r] of Object.entries(def.ranges ?? {})) { const x = v[k]; if (x === undefined) continue;
    // batch 2: a length cap on text (counted in graphemes, as a reader counts: a ZWJ family is 1) and a count cap on lists
    if (r.maxLen !== undefined || r.maxItems !== undefined) { const n = typeof x === "string" ? graphemes(x) : Array.isArray(x) ? x.length : 0;
      const cap = typeof x === "string" ? r.maxLen : r.maxItems;
      if (cap !== undefined && n > cap) refuse("bounds", `${at}.${k} is ${n.toLocaleString("en")} ${typeof x === "string" ? "characters" : "items"}; it must be ≤ ${cap}`, def.help);
      continue; }
    // a vector's range holds for each element (mesh.size)
    const bad = Array.isArray(x) ? x.some((n) => typeof n === "number" && outOfRange(r, n)) : outOfRange(r, x);
    if (bad) refuse("bounds", `${at}.${k} is ${JSON.stringify(x)}; ${Array.isArray(x) ? "each" : "it"} must be ${rangeWords(r)}`, def.help); }
  if (name === "script" && v.scope) unknownKeys(`${at}.scope`, v.scope, Object.keys(def.scopeFields), "a script's scope");
  if (name === "terrain") terrainShapeCheck(at, v, def);
  // batch 2: words everyone reads are checked once, here (shared/text.js): no direction overrides, no hidden controls, no zalgo
  for (const [k, how] of Object.entries(def.clean ?? {})) if (typeof v[k] === "string") { const bad = cleanText(v[k], { lines: how === "lines" });
    if (bad) refuse("shape", `${at}.${k} ${bad.why}`, bad.fix); }
}
// N5 (review 10-07): a handler is checked when it's WRITTEN, not when the first visitor uses it. What it would write is
// checked now as the authority would check that write (a light's intensity 'bright' was taken, and the visitor got "must be
// number"); a field it changes must be inside a component the thing has (a toggle on a plain crate wrote an invisible
// openable); toggle flips true/false fields; an impulse swings a pendulum. Rights stay a use-time question (reactionCap).
function effectCheck(s, id, act, h) {
  const c = s.entities[id]?.c ?? {}; const isObj = (x) => x && typeof x === "object" && !Array.isArray(x) && x !== PURGED;
  const where = `reactions.${act}`;
  const would = (comp, value) => { try { valueCheck(s, { id, comp, value }); }
    catch (e) { if (!(e instanceof Refusal)) throw e; refuse(e.code, `${where} would set ${id}.${comp} to something the authority refuses: ${e.reason}`, e.fix, e.didYouMean ? { didYouMean: e.didYouMean } : undefined); } };
  if (h.kind !== "set" && h.kind !== "toggle") return;
  const { comp, field } = h.kind === "toggle" ? toggleOf(h) : { comp: h.component, field: h.field };
  if (field !== undefined && !isObj(c[comp])) refuse("no-target", `${where} changes ${comp}.${field}, and ${id} has no ${comp}`,
    comp === "openable" && h.component === undefined ? "make it openable first (openable {open: false}), or name the component and field to flip" : `give it ${comp} first (in the same batch is fine)`);
  const ftype = COMPONENTS[comp.split(":")[0]]?.fields?.[field];
  if (h.kind === "toggle" && field !== undefined && ftype && ftype !== "bool" && ftype !== "any") refuse("shape", `${where} flips ${comp}.${field}, which is a ${ftype}; a toggle flips true/false`, "use a set handler to give it a value");
  if (h.kind === "toggle") { if (field === undefined) would(comp, !c[comp]); else { would(comp, { ...c[comp], [field]: true }); would(comp, { ...c[comp], [field]: false }); } }
  else would(comp, field === undefined ? h.value : { ...c[comp], [field]: h.value });
}
function handlerCheck(at, act, h) {
  const R = COMPONENTS.reactions; if (!R.handlers[h.kind]) return;   // a carried reserved kind keeps what it held
  const allowed = [...Object.keys(R.common), ...Object.keys(R.handlers[h.kind]?.args ?? {})];
  unknownKeys(`${at}.${act}`, h, [...new Set(allowed)], `a '${h.kind}' handler`);
}
// L3: a rest must equal the engine's value. The gate asks the engine itself, not the caller.
function restCheck(w, cap, after) {
  const sf = w.sim();
  for (const id of cap.ids) { const b = sf.sim?.bodies[id];   // every body the rest names (one change may rest a launch's whole batch)
    const lost = sf.rested.some((r) => r.id === id && r.seq === cap.launch && r.lost);   // crossed the edge in flight: rests on the record where it is
    if (!lost && (!b || !b.resting || sf.launched[id]?.seq !== cap.launch)) refuse("not-at-rest", `the engine doesn't have ${id} at rest from launch ${cap.launch}`, "");
    if (JSON.stringify(worldPose(after, id).pos) !== JSON.stringify(b.p)) refuse("not-the-engine's", `${id} would rest at ${JSON.stringify(worldPose(after, id).pos)}; the engine has it at ${JSON.stringify(b.p)}`, "");
    if (b.q && JSON.stringify(worldPose(after, id).q) !== JSON.stringify(b.q)) refuse("not-the-engine's", `${id} would rest turned ${JSON.stringify(worldPose(after, id).q)}; the engine has it at ${JSON.stringify(b.q)}`, ""); }
}
export { isLookAt, isNum, nearMiss, restCheck, unknownKeys, valueCheck };
