// tools/protocol/names-check.ts — names carry no body plan and set no kind against another (R 10-17 14:34–14:41, protocol
// minor 0, unreleased). Each row red first (against BASE: `--control` extracts it and runs every row there) and held by a
// mutation below; G rows are guards (green at base by design: what must NOT change).
//   bun tools/protocol/names-check.ts                 every row
//   bun tools/protocol/names-check.ts --only P1,C2    just those
//   bun tools/protocol/names-check.ts --tree <dir>    against another checkout (a mutant, or the base)
//   bun tools/protocol/names-check.ts --mutants       remove each fix in turn (a copy of shared/, server/, mcpl/, client/lib,
//                                                     spec/, docs/, AGENTS.md): its rows must go red; a no-op control stays green
//   bun tools/protocol/names-check.ts --control       every non-guard row must be red at BASE
// Rows:
//   N   refusal codes: hold-limit, beneath, not-pushable (were hands-full, underfoot, no-body); the old words map, never given
//   P   punt keeps its name; its flag is contact: true (shove: true taken at the door, recorded as contact); docs say no kick/feet
//   T   @world trusted-components (was trusted): the registry, the door, the load's rename (every load, idempotent), drafts.js
//   C   consent: tiers everyone/friends, cells allow/ask/deny, class displace, delegates apart from friends; old words on the
//       wire; a presence file and a browser's saved table in the old shape are rewritten
//   W   people: /worlds is one list with a declared word as a tag; no "(agent)"; the browser shows the declared word only;
//       no text sets humans against agents
//   O   leftover seat words → the occupy family (agent, client modules, socketRole, user-visible strings)
//   S   stale agent-visible addresses: light.daytime, sky.tz, the measure tool's socket child
//   A   grabbable.anim / station.anim (an open name of a pose or a clip; unknown → the body's default), grasp, anim-pose
//       reserved; old spellings taken at the door and renamed at load; wings-folded is a named pose; pose/animate by name
//   U   the action bar (UI ids and strings; was the bar of the old name)
//   L   layering (once overlays, a loop or hold replaces), where a name resolves (from), one form (name OR live keys)
//   B   body-mode: its own presence field (stand | sit | lie chosen; swim | fly | fall reported); a description that grants nothing
//   M   ONE agent tool anim (R 10-17 15:31/15:32): by name or live; mode once | loop | hold (at); each anim's own default;
//       {playing, mode}; stopped {name, why} when a loop or hold ends; the four old body tools are hidden aliases
//   K   anim {stop} (R 10-17 16:26/16:27): true stops every layer and rests in the CURRENT body-mode's own anim (never the
//       bind pose; the body-mode unchanged); a name stops that layer; "live" stops the ad-libbed ones, a reserved name
//   E   the old name of a gesture is gone (R 10-17 16:26): presence pose.anim (the old key read for one release), the
//       action bar's modules and defs, every identifier, comment and string; it is spelled in exactly two places: the
//       hidden tool alias's entry and the old key's read (EM below builds the word, so this file never spells it)
//   OS  a motion's back-and-forth along an axis is oscillate (R 10-17 21:40; was bob): the registry, the door (old spelling
//       taken, stored new), the load's rename (a field VALUE, per thing, every load, idempotent), the readers (the old spelling
//       read for one release: names.js motionType), the editor's card, the translator (@14), the docs
//   X   the version history records it
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const BASE = "a6d05a6b";
const EM = "em" + "ote";   // the old word, built so this file never spells it (row E3 scans every file, this one too)
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["hold-limit is hands-full again", "shared/protocol/authority/bodyverbs.js", "refuse(\"hold-limit\",", "refuse(\"hands-full\",", ["N1", "N2"]],
  ["beneath is underfoot again", "shared/protocol/authority/manipulate.js", "refuse(\"beneath\",", "refuse(\"underfoot\",", ["N2"]],
  ["no old-word map", "shared/protocol/refusalcodes.js", "export const RENAMED_CODES = Object.freeze({ \"hands-full\": \"hold-limit\", \"underfoot\": \"beneath\", \"no-body\": \"not-pushable\" });", "export const RENAMED_CODES = Object.freeze({});", ["N3"]],
  ["the door records shove", "shared/protocol/authority/bodyverbs.js", "a = { ...a, contact: a.shove }; delete a.shove; }", "a = { ...a, contact: a.shove }; }", ["P2"]],
  ["no old spelling at the door", "shared/protocol/verbspec.js", ", shove: { type: \"bool\", doc: \"old spelling of contact (recorded as contact)\" }", "", ["P2"]],
  ["both spellings at once taken", "shared/protocol/authority/bodyverbs.js", "if (a.contact !== undefined) refuse(\"shape\", \"contact, or its old spelling shove: not both\", \"send contact: true\");", "", ["P3"]],
  ["the punt doc kicks again", "shared/protocol/verbspec.js", "send a loose thing beside your body (low by it", "kick a thing at your feet (low by it", ["P4"]],
  ["the browser sends shove", "client/lib/thingphysics.js", "sendRequest('punt', { id, v, contact: true });", "sendRequest('punt', { id, v, shove: true });", ["P5"]],
  ["the registry says trusted", "shared/protocol/componentspec.js", "  \"trusted-components\": { on: \"world\",", "  trusted: { on: \"world\",", ["T1"]],
  ["no rename at load", "shared/protocol/shaperepair.js", "export const RENAMED_COMPONENTS = Object.freeze({ \"@world\": Object.freeze({ trusted: \"trusted-components\" }) });", "export const RENAMED_COMPONENTS = Object.freeze({});", ["T2"]],
  ["drafts reads only the new key", "shared/drafts.js", "(worldC?.[TRUSTED] ?? worldC?.[OLD_TRUSTED])?.components", "worldC?.[TRUSTED]?.components", ["T3"]],
  ["the old tier is the tier", "shared/protocol/consent.js", "export const TIERS = [\"everyone\", \"friends\"];", "export const TIERS = [\"strangers\", \"friends\"];", ["C1", "C2"]],
  ["no old words on the wire", "shared/protocol/consent.js", "const tierOf = (t) => (Object.hasOwn(LEGACY_TIER, t) ? LEGACY_TIER[t] : t);", "const tierOf = (t) => t;", ["C2"]],
  ["drag is move again", "shared/protocol/consent.js", "drag: \"displace\", occupy: \"displace\", carry: \"displace\"", "drag: \"move\", occupy: \"displace\", carry: \"displace\"", ["C1"]],
  ["a friend may close the table", "shared/protocol/consent.js", "!(t.delegates ?? []).includes(actor)", "!(t.friends ?? []).includes(actor)", ["C3"]],
  ["the old list isn't the delegates", "shared/protocol/consent.js", "if (Array.isArray(t.friends) && !Array.isArray(t.delegates)) t.delegates = t.friends.slice(); }", "}", ["C4"]],
  ["no presence migration at load", "shared/protocol/authority/storage.js", "if (migratePresence(w.presence)) w.presenceDirty = true;", "", ["C5"]],
  ["the reply says strangers", "shared/protocol/authority/bodyconsent.js", "table: { preset: t.preset, everyone: t.everyone,", "table: { preset: t.preset, strangers: t.everyone,", ["C6"]],
  ["the browser keeps the old words", "client/lib/consent.js", "if (old) lsSet(KEY, JSON.stringify(t));", "", ["C7"]],
  ["/worlds sorts by kind", "server/routes.ts", "people: present.map((c) => ({ id: c.id, ...(c.declares ? { declares: c.declares } : {}) })),", "people: present.filter((c) => c.declares !== \"agent\").map((c) => c.id), agents: present.filter((c) => c.declares === \"agent\").map((c) => c.id),", ["W1"]],
  ["the tool says (agent)", "mcpl/tools.ts", "p.declares ? `${p.id} (${p.declares})` : p.id", "p.declares === \"agent\" ? `${p.id} (agent)` : p.id", ["W2"]],
  ["the plate says agent", "client/lib/platecard.js", "const where = [typeof r.declares === 'string' && r.declares ? r.declares : null,", "const where = [r.agent ? 'agent' : null,", ["W3"]],
  ["the alt note sets agents against people", "shared/sound.js", "anyone who can\\'t hear it (or reads the world as text)", "agents and people who can\\'t hear it", ["W4"]],
  ["the agent's seat again", "mcpl/agent.ts", "mayVacate(kind: \"move\"", "mayLeaveSeat(kind: \"move\"", ["O1"]],
  ["socketRole says seat", "shared/protocol/authority/sockets.js", "(bag(c?.station) ? \"station\" :", "(bag(c?.station) ? \"seat\" :", ["O2"]],
  ["the toast says seat", "client/lib/localbody.js", "moved what you were occupying, so you stood up", "moved the seat you were on, so you stood up", ["O3"]],
  ["light.noon again", "shared/protocol/descriptors.js", "daytime: { k: 'daytime', param: 'burnsAtNoon'", "daytime: { k: 'noon', param: 'burnsAtNoon'", ["S1"]],
  ["sky.clock again", "shared/worldentity.js", "    { t: 'text', k: 'tz', label: 'timezone', value: real ? (s.tz ?? DEFAULT_TZ) : '', ...ro,", "    { t: 'enum', k: 'clock', label: 'clock', value: real ? 'real' : 'authored', def: 'authored', options: [{ v: 'authored', label: 'authored' }, { v: 'real', label: 'real time' }] },\n    { t: 'text', k: 'tz', label: 'timezone', value: real ? (s.tz ?? DEFAULT_TZ) : '', ...ro,", ["S2"]],
  ["measure teaches set sockets", "mcpl/tools.ts", "a socket is a child entity, made with create {components: {parent: {to: id}", "act {verb: 'set', args: {id, component: 'sockets', value: {seat: {pos: [cx, y, cz], body: {pose: 'sitchair'}}}}} — or create {components: {parent: {to: id}", ["S3"]],
  ["the history forgets", "spec/PROTOCOL.md", "the refusal codes `hold-limit`, `beneath`, `not-pushable`", "the refusal codes", ["X1"]],
  ["the registry keeps pose", "shared/protocol/componentspec.js", "hold: \"string\", anim: \"string\", grips:", "hold: \"string\", pose: \"string\", grips:", ["A1"]],
  ["no door translation", "shared/protocol/authority/writes.js", "if (comp === \"grabbable\" || comp === \"station\") { const r = renameFields(comp, value);", "if (false) { const r = renameFields(comp, value);", ["A2"]],
  ["two-hand is a name", "shared/protocol/shaperepair.js", "if (comp === \"grabbable\" && p === \"two-hand\") {", "if (false) {", ["A2"]],
  ["an unknown name is refused", "shared/grab.js", "if (v.anim !== undefined && !(typeof v.anim === 'string' && ANIM_RE.test(v.anim)))", "if (v.anim !== undefined && !HOLD_POSES.includes(v.anim))", ["A3"]],
  ["an unknown name is held as written", "shared/grab.js", "if (g?.anim && ARMS[g.anim] && g.anim !== BOTH_HANDS) return g.anim;", "if (g?.anim) return g.anim;", ["A3"]],
  ["no field renames at load", "shared/protocol/shaperepair.js", "export const RENAMED_FIELDS = Object.freeze({ grabbable: Object.freeze({ pose: \"anim\", \"grips.*.fingers\": \"grasp\" }), station: Object.freeze({ pose: \"anim\" }) });", "export const RENAMED_FIELDS = Object.freeze({});", ["A2", "A4"]],
  ["the lift keeps pose", "shared/protocol/authority/sockets.js", "const b = \"pose\" in b0 && !(\"anim\" in b0) ? (({ pose, ...r }) => ({ ...r, anim: pose }))(b0) : b0;", "const b = b0;", ["A5"]],
  ["the wire says wingsFolded", "shared/wingpresence.js", "return { poses: folded === true ? [WINGS_FOLDED] : [] };", "return { wingsFolded: folded === true };", ["A6"]],
  ["the old flag isn't read", "shared/wingpresence.js", "return typeof sample.wingsFolded === 'boolean' ? sample.wingsFolded : null;", "return null;", ["A6"]],
  ["the fence drops poses", "server/posecheck.ts", "if (\"poses\" in p) { const c = cleanPoses(p.poses); if (c) p.poses = c; else delete p.poses; }", "delete p.poses;", ["A6"]],
  ["anim takes no name", "mcpl/tools.ts", "properties: { name: { type: \"string\", description: \"an anim by name (a pose or a clip)\" }, bodyMode:", "properties: { bodyMode:", ["A7"]],
  ["anim-pose not reserved", "shared/protocol/componentspec.js", "  \"anim-pose\": \"a pose: one frame", "  \"x-anim-pose\": \"a pose: one frame", ["A1"]],
  ["the frame has the old name again", "client/lib/windows.js", "  actions:  { x: 'center'", `  ${EM}s:   { x: 'center'`, ["U1", "E3"]],
  ["the lite row has the old class again", "client/lib/actionbar_lite.js", "row.className = 'lite-actions';", `row.className = 'lite-${EM}s';`, ["U1", "E3"]],
  ["dance plays once", "mcpl/tools.ts", "  dance: \"loop\", sit: \"loop\",", "  dance: \"once\", sit: \"loop\",", ["M1"]],
  ["the call's mode is ignored", "mcpl/tools.ts", "const mode = (mode0 ?? ANIM_MODES[n] ?? \"once\") as", "const mode = (ANIM_MODES[n] ?? mode0 ?? \"once\") as", ["M2"]],
  ["hold doesn't freeze", "mcpl/agent.ts", "if (a.kind === \"clip\") this.animHold = a.mode === \"hold\" ? holdAt : null;", "if (a.kind === \"clip\") this.animHold = null;", ["M2"]],
  ["the reply hides the mode", "mcpl/tools.ts", "JSON.stringify({ playing: name, mode, ...(from", "JSON.stringify({ playing: name, ...(from", ["M3"]],
  ["no stopped when replaced", "mcpl/agent.ts", "    this.animEnded(\"replaced\", (b) => b.kind === a.kind);", "", ["M4", "L1"]],
  ["a move isn't noticed", "mcpl/agent.ts", "    this.watchAnim();\n", "", ["M4"]],
  ["stopped isn't said", "mcpl/agent.ts", "this.inbox.push({ ts, kind: \"act\", who: this.name, text }); this.onEvent?.({ ts, kind: \"act\", who: this.name, text });", "", ["M4"]],
  ["posture isn't an alias", "mcpl/tools.ts", `  pose: "anim", animate: "anim", ${EM}: "anim", posture: "anim" };`, `  pose: "anim", animate: "anim", ${EM}: "anim" };`, ["M5"]],
  ["a held frame of tracks is the first key", "mcpl/tools.ts", "const pick = at == null ? ks.at(-1) : ks.filter((k) => k.t <= at).at(-1) ?? ks[0];", "const pick = ks[0];", ["M6"]],
  ["once replaces what is held", "mcpl/tools.ts", "    if (mode === \"once\") { ag.playOnce(n);", "    if (mode === \"once\") { ag.animEnded(\"replaced\"); ag.playOnce(n);", ["L1"]],
  ["the result hides where it came from", "mcpl/tools.ts", "...(from ? { from } : {})", "", ["L2"]],
  ["name and joints guessed", "mcpl/tools.ts", "  if (a.name != null && (a.joints != null || a.tracks != null)) return", "  if (false) return", ["L3"]],
  ["no body-mode on the wire", "mcpl/agent.ts", "clip: this.clip, bodyMode: this.bodyModeNow(), clipTime: this.animHold ?? this.clipPhase(), clipTimeSlot: this.bodyClip(), clipRate: this.animHold != null ? 0 : 1,\n        ...wingFoldPresence(this.wingsFolded),\n        // a physics bag", "clip: this.clip, clipTime: this.animHold ?? this.clipPhase(), clipTimeSlot: this.bodyClip(), clipRate: this.animHold != null ? 0 : 1,\n        ...wingFoldPresence(this.wingsFolded),\n        // a physics bag", ["B1"]],
  ["an anim's end keeps its body-mode", "mcpl/agent.ts", "if (a.bodyMode && why !== \"stopped\") this.bodyMode = \"stand\";", "", ["B1"]],
  ["declaring stand leaves the body sitting", "mcpl/tools.ts", "{ const rest = ag.restClip(ag.bodyModeNow()); if (rest) ag.clip = rest; }", "{ }", ["B1"]],
  ["stop drops the body-mode", "mcpl/agent.ts", "if (a.bodyMode && why !== \"stopped\") this.bodyMode = \"stand\";", "if (a.bodyMode) this.bodyMode = \"stand\";", ["K1", "B1"]],
  ["stop rests in idle whatever the mode", "mcpl/agent.ts", "const rest = this.restClip(this.bodyModeNow());", "const rest = \"idle\";", ["K1", "K2"]],
  ["stop on a station stands the occupant up", "mcpl/agent.ts", "const rest = this.restClip(this.bodyModeNow()); if (rest) { this.stop(); this.clip = rest; }", "const rest = this.restClip(this.bodyModeNow()); if (rest) { this.stop(); this.clip = rest; } else this.setPosture(\"idle\");", ["K1"]],
  ["a pose struck over a sit replaces it", "mcpl/agent.ts", "this.animEnded(\"replaced\", (b) => b.kind === a.kind);", "this.animEnded(\"replaced\");", ["K2", "K3", "K4"]],
  ["stop by name stops every layer", "mcpl/agent.ts", "const hit = this.anims.filter((a) => which == null || a.name === which);", "const hit = this.anims.filter((a) => true);", ["K3", "K4"]],
  ["the relay isn't told to fade the tracks", "mcpl/agent.ts", "this.ws.send(JSON.stringify({ type: \"anim\", stop: true }));", "void 0;", ["K2", "K4"]],
  ["a tracks loop is a held frame (ends at the next tick)", "mcpl/tools.ts", "ag.animBegan({ name: \"live\", mode: \"loop\", kind: \"track\" });", "ag.animBegan({ name: \"live\", mode: \"loop\", kind: \"live\" });", ["K2", "K4"]],
  ["live may be a name", "mcpl/tools.ts", "    if (isReservedAnimName(n)) return", "    if (false) return", ["K4"]],
  ["a clip def may be called live", "shared/animdefs.js", "  if (isReservedAnimName(name)) errs.push(", "  if (false) errs.push(", ["K4"]],
  ["an object may hold live", "shared/grab.js", "  if (isReservedAnimName(v.anim)) return bad(", "  if (false) return bad(", ["K4"]],
  ["a station may play live", "shared/sockbody.js", "  if (isReservedAnimName(v.anim)) return bad(", "  if (false) return bad(", ["K4"]],
  ["the tool forgets the rest", "mcpl/tools.ts", "and rests in your body-mode's own anim (stand: idle, sit: the sit loop, lie: lie, swim: tread, fly: soar) — never the bind pose; the body-mode is unchanged", "", ["K5"]],
  ["the spec has no rest rule", "spec/PROTOCOL.md", "CURRENT body-mode's own anim (`stand`: idle; `sit`: its sit loop; `lie`;\n    `swim`: tread; `fly`: its hover), never the bind pose, and its", "CURRENT body-mode's own anim, and its", ["K5"]],
  ["sit asks for no body-mode", "mcpl/tools.ts", "const ANIM_BODY: Record<string, \"stand\" | \"sit\" | \"lie\"> = { sit: \"sit\", sitchair: \"sit\", lie: \"lie\", stand: \"stand\" };", "const ANIM_BODY: Record<string, \"stand\" | \"sit\" | \"lie\"> = {};", ["B1"]],
  ["an old sample's clip isn't read", "shared/bodymode.js", "return isBodyMode(sample.bodyMode) ? sample.bodyMode : (typeof sample.clip === 'string' ? modeFromClip(sample.clip) : null);", "return isBodyMode(sample.bodyMode) ? sample.bodyMode : null;", ["B2"]],
  ["the fence takes any body-mode", "server/posecheck.ts", "if (\"bodyMode\" in p && !isBodyMode(p.bodyMode)) delete p.bodyMode;", "", ["B2"]],
  ["flying isn't reported", "shared/bodymode.js", "  if (flying) return 'fly';\n", "", ["B3"]],
  ["a declaration is ignored", "shared/bodymode.js", "      return declared ?? real;", "      return real;", ["B3"]],
  ["the agent's once anim rides the old key", "mcpl/agent.ts", "...(this.pendingAnim ? { anim: this.pendingAnim } : {}),", `...(this.pendingAnim ? { ${EM}: this.pendingAnim } : {}),`, ["E1", "E3"]],
  ["the old key isn't read", "shared/onceanim.js", "const v = sample.anim ?? sample[OLD_KEY];", "const v = sample.anim;", ["E1", "E3"]],
  ["the server remembers the once anim", "shared/onceanim.js", "  for (const k of ONCE_KEYS) delete out[k];\n", "", ["E1"]],
  ["the browser sends the old key", "client/lib/net.js", "if (s.anim) { pose.anim = s.anim; s.anim = null; }", `if (s.anim) { pose.${EM} = s.anim; s.anim = null; }`, ["E1", "E3"]],
  ["a remote reads only today's key", "client/lib/remotes.js", "  const once = onceAnimOf(s);\n  if (once && once !== r.lastAnim) {", "  const once = s.anim;\n  if (once && once !== r.lastAnim) {", ["E1"]],
  ["the registry keeps the old key", "server/defs.ts", "    actionbar: loadSidecar(", `    ${EM}s: loadSidecar(`, ["E2", "E3"]],
  ["the slash command keeps the old name", "client/lib/commands/registry.js", "{ name: 'anim', help: '/anim <name>", `{ name: '${EM}', help: '/${EM} <name>`, ["E2", "E3"]],
  ["a comment says the old word", "client/lib/avatar.js", "  /** Play a gesture over locomotion.", `  /** Play an ${EM} over locomotion.`, ["E3"]],
  ["the spec says the old word", "spec/PROTOCOL.md", "poses, gestures (`pose.anim`), reach descriptors", `poses, ${EM}s, reach descriptors`, ["E3"]],
  ["the alias also translates", "mcpl/tools.ts", "  posture: (a) => { const k", `  ${EM}: (a) => ({ name: a.name, mode: "once" }),\n  posture: (a) => { const k`, ["M5", "E3"]],
  ["the registry says bob", "shared/protocol/componentspec.js", "enums: { type: [\"pendulum\", \"spin\", \"orbit\", \"oscillate\", \"path\"]", "enums: { type: [\"pendulum\", \"spin\", \"orbit\", \"bob\", \"path\"]", ["OS1"]],
  ["the card is still Bob", "shared/protocol/descriptors.js", "  Oscillate: { type: 'oscillate', show: ['axis', 'amp', 'period', 'phase'],", "  Bob: { type: 'oscillate', show: ['axis', 'amp', 'period', 'phase'],", ["OS1"]],
  ["the door stores bob as written", "shared/protocol/authority/writes.js", "if (comp === \"motion\" || comp.startsWith(\"motion:\")) { const r = renameFields(comp, value);", "if (false) { const r = renameFields(comp, value);", ["OS2"]],
  ["no motion rename", "shared/protocol/shaperepair.js", "  motion: Object.freeze({ \"type=bob\": \"type=oscillate\" }) });", "  });", ["OS2", "OS3"]],
  ["the load renames only bare keys", "shared/protocol/shaperepair.js", "for (const comp of Object.keys(c).filter((k) => Object.hasOwn(RENAMED_FIELDS, renamedFieldsKey(k))).sort())", "for (const comp of Object.keys(RENAMED_FIELDS))", ["OS3"]],
  ["the old word isn't read", "shared/protocol/names.js", "  return typeof t === \"string\" && Object.hasOwn(OLD_MOTION_TYPES, t) ? OLD_MOTION_TYPES[t] : t;", "  return t;", ["OS2", "OS3", "OS4"]],
  ["the closed form reads the raw type", "client/lib/motioneval.js", "  let r;\n  switch (motionType(m)) {", "  let r;\n  switch (m.type) {", ["OS4"]],
  ["the seat signals read the raw type", "client/lib/socksignals.js", "  switch (motionType(m)) {", "  switch (m.type) {", ["OS4"]],
  ["the editor's card reads the raw type", "shared/editschema.js", "      const ty = motionType(m);", "      const ty = m.type;", ["OS4"]],
  ["bob finds nothing", "shared/editschema.js", "Oscillate: ['float', 'hover', 'bob', 'back and forth', 'piston', 'sine']", "Oscillate: ['float', 'hover', 'back and forth', 'piston', 'sine']", ["OS5"]],
  ["Add Component writes bob", "shared/editschema.js", "Oscillate: { type: 'oscillate', amp: 0.3, period: 4 }", "Oscillate: { type: 'bob', amp: 0.3, period: 4 }", ["OS5"]],
  ["the translator keeps bob", "tools/protocol/import-v1/translate-v1.js", "  const m = motionType(m0) === m0.type ? m0 : { ...m0, type: motionType(m0) };", "  const m = m0;", ["OS6"]],
  ["AGENTS.md says bob", "AGENTS.md", "`{type: pendulum\\|spin\\|orbit\\|oscillate\\|path, …}`", "`{type: pendulum\\|spin\\|orbit\\|bob\\|path, …}`", ["OS7"]],
  ["the history forgets oscillate", "spec/PROTOCOL.md", "; and a motion's back-and-forth along an axis is `oscillate` (R 10-17 21:40; was `bob`:", "; and a motion's back-and-forth along an axis is the new word (R 10-17 21:40; was the old:", ["OS7"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/consent.js", "// Ported from the protocol lab (2026-10-05);", "//  Ported from the protocol lab (2026-10-05);", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/names-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/, server/, spec/, docs/, mcpl/ (without node_modules), client/lib and AGENTS.md copied; the rest linked back
function copyTree(tag: string) { const d = scratch(tag);
  for (const k of ["shared", "server", "spec", "docs"]) fs.cpSync(path.join(ENGINE, k), path.join(d, k), { recursive: true });
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* none */ }
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") fs.symlinkSync(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  fs.copyFileSync(path.join(ENGINE, "AGENTS.md"), path.join(d, "AGENTS.md"));
  fs.copyFileSync(path.join(ENGINE, "DESIGN.md"), path.join(d, "DESIGN.md"));
  // tools/protocol/import-v1 copied (the OS rows read the translator), the rest of tools/ linked back, entry by entry
  fs.mkdirSync(path.join(d, "tools", "protocol"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "tools"))) if (k !== "protocol") fs.symlinkSync(path.join(ENGINE, "tools", k), path.join(d, "tools", k));
  for (const k of fs.readdirSync(path.join(ENGINE, "tools", "protocol"))) if (k !== "import-v1") fs.symlinkSync(path.join(ENGINE, "tools", "protocol", k), path.join(d, "tools", "protocol", k));
  fs.cpSync(path.join(ENGINE, "tools", "protocol", "import-v1"), path.join(d, "tools", "protocol", "import-v1"), { recursive: true });
  for (const k of fs.readdirSync(ENGINE)) if (![".git", "worlds", "store"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("namesmut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[names-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  const d = scratch("namesctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server mcpl client spec docs AGENTS.md DESIGN.md tools/protocol/import-v1 | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* none */ }
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const guard = (l: string) => /^(ok|FAIL)\s+G\d/.test(l);
  const wrong = lines.filter((l) => (l.startsWith("ok ") && !guard(l)) || (l.startsWith("FAIL") && guard(l)));
  console.log(lines.map((l) => `${wrong.includes(l) ? "WRONG AT BASE:       " : "as expected at base: "}${l.slice(0, 150)}`).join("\n"));
  console.log(`[names-check --control] at ${BASE}: ${lines.length} rows, ${wrong.length} wrong (every row red there but the guards, which stay green)`);
  process.exit(wrong.length ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const ONLY = opt("only")?.split(",") ?? null;
const want = (id: string) => !ONLY || ONLY.includes(id);
const readText = (rel: string) => { try { return fs.readFileSync(TREE + rel, "utf8"); } catch { return ""; } };
const exists = (rel: string) => fs.existsSync(TREE + rel);
const root = scratch("names");
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const VS = await import(TREE + "shared/protocol/verbspec.js");
const RC = await import(TREE + "shared/protocol/refusalcodes.js");
const C = await import(TREE + "shared/protocol/consent.js");
const CS = await import(TREE + "shared/protocol/componentspec.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const ENG = { engine: Object.keys(SL.ENGINES).find((k: string) => k.startsWith("eidosim@")) };

function openWorld(name: string, presence: any = { bodies: {}, holds: {} }) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  w.catalogue = D.LAB_CATALOGUE;
  return w;
}
let T = 1800000000000, N = 0;
function session() {
  const name = `n${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 1000) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: Wd, entries: () => Wd().entries, reopen: (presence?: any) => (w = openWorld(name, presence)) };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const code = (r: any) => (r?.ok ? "ok" : r?.refused?.code ?? (r?.crashed ? "CRASH" : "?"));
// owner olive, visitor vic; a world running eidosim; loose crates anyone may punt or pick up
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
  s.call("olive", "set", { id: "@world", component: "physics-engine", value: ENG });
  for (const [id, x] of [["crate", 0], ["b", 3], ["c", 1.5]]) s.call("olive", "create", { id, model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [x, 0] } });
}
const AGAINST = [0, 0, -0.62];   // vic against the crate's -z face (0.3 m half-width + a 0.32 m body)
const lastAct = (s: any, verb: string, actor: string) => s.entries().findLast((e: any) => e.kind === "act" && e.verb === verb && e.actor === actor) ?? null;
const authoritySrc = () => [readText("shared/protocol/authority.js"), ...fs.readdirSync(TREE + "shared/protocol/authority").map((f: string) => readText(`shared/protocol/authority/${f}`))].join("\n");


// an offline agent body for the M rows (no server: the tool's own door, the agent's own state)
async function animAgent() {
  // offline: this sandbox drops a connection to a closed port rather than refusing it, so a fetch would wait out its own
  // timeout; the M rows need no network (a rig or clip that can't be read is the case they run in)
  globalThis.fetch = (async () => { throw new Error("offline (names-check)"); }) as any;
  const A: any = await import(TREE + "mcpl/agent.ts"); const T: any = await import(TREE + "mcpl/tools.ts");
  const ag: any = new A.WorldAgent({ name: "Hep", world: "names-bench", url: "ws://127.0.0.1:9/ws" });   // nothing listens: every fetch refuses at once
  const sent: any[] = [];
  ag.ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
  const ctx = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  return { ag, sent, call: (name: string, a: any) => (T.handleTool ? T.handleTool(ctx, name, a) : null) };
}
async function animAgent2(ag: any) { const T: any = await import(TREE + "mcpl/tools.ts"); const sent: any[] = []; ag.ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
  const ctx = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }; return { sent, call: (name: string, a: any) => T.handleTool(ctx, name, a) }; }
const played = (r: any) => { const m = String(r?.content?.[0]?.text ?? "").match(/\{"playing":[^}]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- N: refusal codes ----------------
  { id: "N1", what: "(R 14:34) a grab past MAX_HELD is refused hold-limit (never hands-full)", run(s) { cast(s);
      const take = (id: string, x: number) => { s.call("vic", "move", { to: [x, 0, -0.8] }); return code(s.call("vic", "grab", { id })); };
      return { r: [take("crate", 0), take("b", 3), take("c", 1.5)] }; },
    good: (o) => o.r.join() === "ok,ok,hold-limit" },
  { id: "N2", what: "…the registry holds hold-limit, beneath and not-pushable and none of the old three; the authority refuses with the new words only", run() {
      const src = authoritySrc();
      return { has: ["hold-limit", "beneath", "not-pushable"].every((c) => RC.isRefusalCode(c)), old: ["hands-full", "underfoot", "no-body"].filter((c) => RC.isRefusalCode(c)),
        gives: ["hold-limit", "beneath", "not-pushable"].every((c) => src.includes(`refuse("${c}"`)), givesOld: ["hands-full", "underfoot", "no-body"].filter((c) => src.includes(`refuse("${c}"`)) }; },
    good: (o) => o.has && !o.old.length && o.gives && !o.givesOld.length },
  { id: "N3", what: "…a reader maps an older log's word through RENAMED_CODES / canonicalCode", run() {
      return { map: RC.RENAMED_CODES ?? null, c: ["hands-full", "underfoot", "no-body", "rights"].map((x) => RC.canonicalCode?.(x) ?? null) }; },
    good: (o) => JSON.stringify(o.c) === '["hold-limit","beneath","not-pushable","rights"]' },
  { id: "G1", what: "(guard) the fold reads a log whose refused act carries an old code: status ok, the act kept as written", run(s) {
      s.call("olive", "create-world", { title: s.name }); const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world;
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), JSON.stringify({ world: wid, kind: "act", actor: "olive", verb: "grab", body: { args: ["id"], refused: { code: "hands-full" } }, ts: L.at(-1).ts + 1 }) + "\n");
      const w = s.reopen(); const st = w.state(); return { status: st.status, kept: w.entries.at(-1)?.body?.refused?.code ?? null }; },
    good: (o) => o.status === "ok" && o.kept === "hands-full" },
  // ---------------- P: punt {contact} ----------------
  { id: "P1", what: "(R 14:34) punt {contact: true} from a body against the crate is admitted, and the act records contact: true", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], contact: true });
      return { r: show(r), req: lastAct(s, "punt", "vic")?.body?.request ?? null }; },
    good: (o) => o.r === "ok" && o.req?.contact === true && !("shove" in o.req) },
  { id: "P2", what: "…its old spelling shove: true is taken at the door and recorded as contact (no shove in the act); help lists contact", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], shove: true });
      return { r: show(r), req: lastAct(s, "punt", "vic")?.body?.request ?? null, args: Object.keys(VS.VERBSPEC.punt.args) }; },
    good: (o) => o.r === "ok" && o.req?.contact === true && !("shove" in o.req) && o.args.includes("contact") },
  { id: "P3", what: "…both spellings at once is a shape refusal (and a refused contact push stays unrecorded)", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const n = s.entries().length; const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], contact: true, shove: true });
      return { r: show(r), logged: s.entries().length - n }; },
    good: (o) => /^refused shape/.test(o.r) && o.logged === 0 },
  { id: "P4", what: "…punt's words carry no feet and no kick: the verbspec row, the act tool's punt line, AGENTS.md", run() {
      const d = JSON.stringify(VS.VERBSPEC.punt), t = readText("mcpl/tools.ts"), a = readText("AGENTS.md");
      const punt = (t.match(/punt \{id, power\?\|v\?\} \([^)]*\)/) ?? [""])[0], ag = (a.match(/`punt \{id, power\? \| v\?\}`[^.]*\./) ?? [""])[0];
      return { d: /kick|feet/i.test(d), punt, ag: ag.slice(0, 160), t: /kick a thing at your feet/.test(t), a: /kicks a thing at your feet/.test(a) }; },
    good: (o) => !o.d && !!o.punt && !/kick|feet/.test(o.punt) && !!o.ag && !/kick a|feet/.test(o.ag) && !o.t && !o.a },
  { id: "P5", what: "…the browser and the agent send contact (never shove: true)", run() {
      const tp = readText("client/lib/thingphysics.js"), ag = readText("mcpl/agent.ts");
      return { tp: /sendRequest\('punt', \{ id, v, contact: true \}\)/.test(tp) && !/shove: true \}\)/.test(tp), ag: /request\("punt", \{ id, v, contact: true \}\)/.test(ag) && !/"punt", \{ id, v, shove: true/.test(ag) }; },
    good: (o) => o.tp && o.ag },
  // ---------------- T: trusted-components ----------------
  { id: "T1", what: "(R 14:34) @world trusted-components {components} is the owner's; @world trusted is no registered name any more (refused)", run(s) {
      s.call("olive", "create-world", { title: s.name }); const v = { components: ["hesperus/material"] };
      const a = s.call("olive", "set", { id: "@world", component: "trusted-components", value: v }), b = s.call("olive", "set", { id: "@world", component: "trusted", value: v });
      return { a: show(a), b: show(b), reg: Object.hasOwn(CS.COMPONENTS, "trusted-components"), old: Object.hasOwn(CS.COMPONENTS, "trusted"), c: s.w().state().entities["@world"].c["trusted-components"] ?? null }; },
    good: (o) => o.a === "ok" && /^refused/.test(o.b) && o.reg && !o.old && JSON.stringify(o.c) === '{"components":["hesperus/material"]}' },
  { id: "T2", what: "…a world whose log holds @world trusted is renamed at load (the system's rename-components act, the value kept, the old key gone); the next load writes nothing", run(s) {
      s.call("olive", "create-world", { title: s.name }); const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const v = { components: ["hesperus/material"] };
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), [{ world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "@world", component: "trusted", value: v } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "@world", comp: "trusted", value: v }, ts: ts + 1 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); const before = Object.keys(w1.state().entities["@world"].c); const out = D.liftWorld(w1);
      const w2 = s.reopen(); const c = w2.state().entities["@world"].c; const acts = w2.entries.filter((e: any) => e.kind === "act" && e.verb === "rename-components" && e.actor === "system");
      const k = w2.entries.length; D.liftWorld(w2); const again = s.reopen().entries.length - k;
      return { before, out: JSON.stringify(out).slice(0, 300), keys: Object.keys(c), val: c["trusted-components"] ?? null, acts: acts.length, body: acts[0]?.body ?? null, again, status: w2.state().status }; },
    good: (o) => o.before.includes("trusted") && !o.keys.includes("trusted") && JSON.stringify(o.val) === '{"components":["hesperus/material"]}' && o.acts === 1 && o.body?.renamed?.[0]?.to === "trusted-components" && o.again === 0 && o.status === "ok" },
  { id: "T3", what: "…drafts.js: TRUSTED is trusted-components and trustedOf reads a world not yet reloaded (the old key) too", async run() {
      const DR = await import(TREE + "shared/drafts.js");
      return { k: DR.TRUSTED, nw: DR.trustedOf({ "trusted-components": { components: ["a/b"] } }), old: DR.trustedOf({ trusted: { components: ["a/c"] } }) }; },
    good: (o) => o.k === "trusted-components" && JSON.stringify(o.nw) === '["a/b"]' && JSON.stringify(o.old) === '["a/c"]' },
  // ---------------- C: consent ----------------
  { id: "C1", what: "(R 14:41) the table's words: tiers everyone/friends, cells allow/ask/deny, class displace (no move), drag/occupy/carry → displace; every preset in those words", run() {
      const words = (p: any) => Object.keys(p).sort().join() === "everyone,friends" && Object.values(p).every((row: any) => Object.keys(row).every((c) => C.CLASSES.includes(c)) && Object.values(row).every((m) => ["allow", "ask", "deny"].includes(m as string)));
      return { tiers: C.TIERS ?? null, modes: C.MODES ?? null, cls: C.CLASSES, kinds: [C.KIND_CLASS.drag, C.KIND_CLASS.occupy, C.KIND_CLASS.carry], presets: Object.values(C.PRESETS).every(words) }; },
    good: (o) => JSON.stringify(o.tiers) === '["everyone","friends"]' && JSON.stringify(o.modes) === '["allow","ask","deny"]' && o.cls.includes("displace") && !o.cls.includes("move") && o.kinds.every((k: string) => k === "displace") && o.presets },
  { id: "C2", what: "…set {tier: everyone, mode: allow} is stored and read back; the old words (strangers, everyone|nobody, move) are still taken and stored in today's", run() {
      const P: any = {}; const now = 1e12;
      const a = C.setConsent(P, "u-a", { set: { class: "touch", tier: "everyone", mode: "allow" } }, now);
      const b = C.setConsent(P, "u-a", { set: { class: "move", tier: "strangers", mode: "nobody" } }, now);
      const c = C.setConsent(P, "u-a", { set: { class: "pose", tier: "friends", mode: "everyone" } }, now);
      return { ok: [a.ok, b.ok, c.ok], cells: JSON.parse(JSON.stringify(P.consent["u-a"].cells)), d: C.decide(P, "u-b", "u-a", "touch", now).mode, d2: C.decide(P, "u-b", "u-a", "displace", now).mode }; },
    good: (o) => o.ok.every(Boolean) && o.cells.everyone?.touch === "allow" && o.cells.everyone?.displace === "deny" && o.cells.friends?.pose === "allow" && !o.cells.strangers && o.d === "allow" && o.d2 === "deny" },
  { id: "C3", what: "…delegates apart from friends: a friend (mutual) gets the friends tier but can't close the table; a delegate closes it and never opens it", run() {
      const P: any = {}; const now = 1e12;
      C.setConsent(P, "u-a", { friend: "u-f" }, now); C.setConsent(P, "u-f", { friend: "u-a" }, now); C.setConsent(P, "u-a", { delegate: "u-d" }, now);
      const tier = C.decide(P, "u-f", "u-a", "touch", now).tier;
      const fClose = C.setConsent(P, "u-f", { of: "u-a", pause: true }, now), dOpen = C.setConsent(P, "u-d", { of: "u-a", preset: "open" }, now), dClose = C.setConsent(P, "u-d", { of: "u-a", pause: true }, now);
      const t = C.tableOf(P, "u-a");
      return { tier, fClose: fClose.ok, dOpen: dOpen.ok, dClose: dClose.ok, paused: t.paused, delegates: t.delegates, friends: t.friendsList, vs: Object.keys(VS.VERBSPEC.consent.args) }; },
    good: (o) => o.tier === "friends" && o.fClose === false && o.dOpen === false && o.dClose === true && o.paused && JSON.stringify(o.delegates) === '["u-d"]' && JSON.stringify(o.friends) === '["u-f"]' && o.vs.includes("delegate") },
  { id: "C4", what: "…migratePresence rewrites a table in the old shape (strangers/everyone/nobody/move) and makes the old friends list the delegates too; marked once, so a delegates list emptied since stays empty", run() {
      const P: any = { consent: { "u-a": { preset: "normal", cells: { strangers: { move: "everyone", touch: "nobody" }, friends: { shove: "nobody" } }, friends: ["u-f"], over: { "u-x": { move: { mode: "deny" } } } } } };
      const n = C.migratePresence?.(P); const t = JSON.parse(JSON.stringify(P.consent["u-a"]));
      P.consent["u-a"].delegates = []; C.migratePresence?.(P);
      return { n, t, again: P.consent["u-a"].delegates, mark: P.consentShape }; },
    good: (o) => o.n === 1 && o.t.cells.everyone?.displace === "allow" && o.t.cells.everyone?.touch === "deny" && o.t.cells.friends?.shove === "deny" && !o.t.cells.strangers && JSON.stringify(o.t.friends) === '["u-f"]' && JSON.stringify(o.t.delegates) === '["u-f"]' && o.t.over["u-x"]?.displace?.mode === "deny" && !o.t.over["u-x"].move && JSON.stringify(o.again) === "[]" && o.mark === 2 },
  { id: "C5", what: "…the authority's load (worldOf) reads a presence file in the old shape and holds today's", run(s) {
      s.call("olive", "create-world", { title: s.name });
      const w = s.reopen({ bodies: {}, holds: {}, consent: { "u-a": { cells: { strangers: { pose: "everyone" } }, friends: ["u-f"] } } });
      const t = C.tableOf(w.presence, "u-a"); return { pose: t.everyone?.pose ?? null, delegates: t.delegates ?? null, raw: JSON.stringify(w.presence.consent["u-a"]) }; },
    good: (o) => o.pose === "allow" && JSON.stringify(o.delegates) === '["u-f"]' && !/strangers/.test(o.raw) },
  { id: "C6", what: "…consent {} answers in today's words: table.everyone, friends, friendsList, delegates (no strangers, no trusted); look's own shield says everyone", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "move", { to: [0, 0, 0] });
      const r = s.call("olive", "consent", {}); const l = s.call("olive", "look", {});
      return { keys: Object.keys(r.table ?? {}), lk: JSON.stringify(l).match(/"shield":\{[^}]*\{[^}]*\}/)?.[0] ?? JSON.stringify(l).slice(0, 200) }; },
    good: (o) => ["everyone", "friends", "friendsList", "delegates"].every((k) => o.keys.includes(k)) && !o.keys.includes("strangers") && !o.keys.includes("trusted") && /"everyone":/.test(o.lk) && !/strangers/.test(o.lk) },
  { id: "C7", what: "…a browser's saved table in the old words (ew-consent) is read as today's and saved back; cells, presets and the switches speak allow/deny", async run() {
      const store: Record<string, string> = { "ew-consent": JSON.stringify({ strangers: { move: "everyone", pose: "nobody" }, friends: { touch: "nobody" } }) };
      globalThis.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } as any;
      const CC = await import(TREE + "client/lib/consent.js");
      return { t: CC.table(), saved: JSON.parse(store["ew-consent"]), push: CC.pushable(), tiers: CC.TIERS }; },
    good: (o) => o.t.everyone?.displace === "allow" && o.t.everyone?.pose === "deny" && o.t.friends?.touch === "deny" && !o.t.strangers && o.saved.everyone?.displace === "allow" && !o.saved.strangers && JSON.stringify(o.tiers) === '["everyone","friends"]' },
  // ---------------- W: people ----------------
  { id: "W1", what: "(R 14:41) /worlds answers ONE people list of {id, declares?} (no agents list)", run() {
      const src = readText("server/routes.ts"); const h = src.slice(src.indexOf('u.pathname === "/worlds"'), src.indexOf('u.pathname === "/worlds"') + 2000);
      return { one: /people: present\.map\(\(c\) => \(\{ id: c\.id, \.\.\.\(c\.declares \? \{ declares: c\.declares \} : \{\}\) \}\)\)/.test(h), agents: /agents:/.test(h) }; },
    good: (o) => o.one && !o.agents },
  { id: "W2", what: "…the worlds tool shows each id with its declared word, if any: no \"(agent)\" suffix, no agents list read", run() {
      const t = readText("mcpl/tools.ts"); return { suffix: /\(agent\)`/.test(t), agentsRead: /w\.agents/.test(t), tag: /p\.declares \? `\$\{p\.id\} \(\$\{p\.declares\}\)` : p\.id/.test(t) }; },
    good: (o) => !o.suffix && !o.agentsRead && o.tag },
  { id: "W3", what: "…the browser keeps the declared word as said (no agent boolean) and its nameplate card and chat line show that word only", run() {
      const net = readText("client/lib/net.js"), rem = readText("client/lib/remotes.js"), pc = readText("client/lib/platecard.js"), ch = readText("client/lib/chat.js"), ix = readText("client/index.html");
      return { net: (net.match(/declares: (msg|p)\.declares \?\? null/g) ?? []).length, rem: /declares: meta\.declares \?\? null/.test(rem) && !/agent: !!meta\.agent/.test(rem),
        pc: /r\.declares : null/.test(pc) && !/r\.agent \? 'agent'/.test(pc), ch: /w\.dataset\.declares = declared/.test(ch) && !/\?\.agent\)/.test(ch), css: /\.who\[data-declares\]::after/.test(ix) && !/\.line\.agent/.test(ix) }; },
    good: (o) => o.net === 2 && o.rem && o.pc && o.ch && o.css },
  { id: "W4", what: "…no text sets humans against agents: the gesture tool, the sound and picture alt notes, refusal.js, grab.js, sockbody.js, browservoice.js", run() {
      const t = readText("mcpl/tools.ts"), so = readText("shared/sound.js"), pi = readText("shared/picture.js"), rf = readText("shared/protocol/refusal.js"), gr = readText("shared/grab.js"), sb = readText("shared/sockbody.js"), bv = readText("client/lib/browservoice.js");
      return { bar: /one-shots humans have/.test(t), alt: /agents and people who can/.test(so + pi), rf: /shown to humans|for agents and people|by agents' tools/.test(rf), alike: /for people and agents alike/.test(gr + sb), bv: /a human and an\s*\/\/\s*agent|a human and an agent/.test(bv), same: /the same for people and agents/.test(t) }; },
    good: (o) => !o.bar && !o.alt && !o.rf && !o.alike && !o.bv && !o.same },
  // ---------------- O: the occupy family ----------------
  { id: "O1", what: "(R 14:41) the agent and the client speak the occupy family: no seatOf/seatName/mySeat/mayLeaveSeat/mySeatBody in agent.ts, no setSeatHook/inSitReach anywhere, seats.js/seatedit.js/seatbody.js renamed", run() {
      const ag = readText("mcpl/agent.ts"), tl = readText("mcpl/tools.ts"), ctl = readText("client/lib/controller.js"), sk = readText("shared/sockbody.js"), cu = readText("client/lib/clickuse.js");
      return { ag: /\b(seatOf|seatName|mySeat|mayLeaveSeat|mySeatBody)\b/.test(ag + tl), hooks: /\bsetSeatHook\b/.test(ctl) || /\binSitReach\b/.test(sk) || /\bseatOf\b/.test(cu),
        files: ["client/lib/seats.js", "client/lib/seatedit.js", "client/lib/seatbody.js"].filter(exists), now: ["client/lib/occupants.js", "client/lib/socketedit.js", "client/lib/occupybody.js"].every(exists) }; },
    good: (o) => !o.ag && !o.hooks && !o.files.length && o.now },
  { id: "O2", what: "…a socket with a station is a `station` (socketRole): inspect lists a host's sockets as station | snap | attach", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.call("olive", "create", { id: "sofa", model: "crate", place: { at: [3, 0] } });
      s.call("olive", "create", { id: "sofa-l", components: { parent: { to: "sofa" }, transform: { pos: [0, 0.45, 0] }, socket: { name: "left" }, station: { action: "sit" } } });
      const r = s.call("olive", "inspect", { id: "sofa" }); const SK = { a: readText("shared/sockbody.js") };
      return { r: show(r), as: (r.sockets ?? []).map((x: any) => x.as), sk: /isObj\(c\?\.station\) \? 'station'/.test(SK.a) }; },
    good: (o) => o.r === "ok" && JSON.stringify(o.as) === '["station"]' && o.sk },
  { id: "O3", what: "…the user-visible words: the editor's tool tile reads 'station', the toast says 'moved what you were occupying', '+ socket here'", run() {
      const ep = readText("client/lib/editpanels.js"), lb = readText("client/lib/localbody.js"), es = readText("shared/editschema.js");
      return { tile: /label: 'station', icon: 'armchair'/.test(ep), toast: /moved what you were occupying/.test(lb) && !/moved the seat you were on/.test(lb), add: /'\+ socket here'/.test(es) && !/'\+ seat here'/.test(es) }; },
    good: (o) => o.tile && o.toast && o.add },
  // ---------------- S: stale agent-visible addresses ----------------
  { id: "S1", what: "(R 14:41) a light's burns-at-noon is addressed light.daytime (never light.noon): the card's row and an edit through it", async run() {
      const ES = await import(TREE + "shared/editschema.js");
      const lamp = { model: "lamp", pos: [0, 0, 0], light: { color: 1, intensity: 16 } };
      const sch = ES.inspectSchema?.(lamp, "lamp", { materials: [] }); const g = (sch?.groups ?? []).find((x: any) => x.group === "light");
      const e = ES.editOps?.(lamp, "lamp", { "light.daytime": true }); const old = ES.editOps?.(lamp, "lamp", { "light.noon": true });
      const flat = (ops: any[]) => ops.flatMap((o: any) => (o.verb === "batch" ? o.args.ops : [o]));
      return { keys: (g?.fields ?? []).map((f: any) => f.k), w: JSON.stringify(flat(e?.ops ?? [])), oldErr: old?.errors ?? [] }; },
    good: (o) => o.keys.includes("daytime") && !o.keys.includes("noon") && /"daytime":"full"/.test(o.w) && o.oldErr.length > 0 },
  { id: "S2", what: "…the world's Sky card has sky.tz (empty: the authored clock) and no sky.clock; an edit of sky.clock is no field", async run() {
      const WE = await import(TREE + "shared/worldentity.js");
      const st = { entities: { "@world": { c: { sky: { hours: 12, rate: 0 } } } } };
      const sch = WE.worldSchema?.(st, { now: 0 }); const g = (sch?.groups ?? []).find((x: any) => x.group === "sky");
      const e = WE.worldEditOps?.(st, { "sky.clock": "real" }, { now: 0 }); const t = WE.worldEditOps?.(st, { "sky.tz": "Europe/Paris" }, { now: 0 });
      return { keys: (g?.fields ?? []).map((f: any) => f.k), err: e?.errors ?? [], tz: JSON.stringify(t?.ops ?? []) }; },
    good: (o) => o.keys.includes("tz") && !o.keys.includes("clock") && o.err.length > 0 && /"tz":"Europe\/Paris"/.test(o.tz) && !/"clock"/.test(o.tz) },
  { id: "S3", what: "…the measure tool teaches a socket child (create {components: {parent, transform, socket, station}}), never set sockets; the inspect tool lists light.daytime and sky.tz", run() {
      const t = readText("mcpl/tools.ts"); const at = (n: string) => { const i = t.indexOf(`name: "${n}", description: "`); return i < 0 ? "" : t.slice(i, t.indexOf("inputSchema", i)); }; const m = at("measure"), i = at("inspect");
      return { m: /create \{components: \{parent: \{to: id\}, transform: \{pos: \[cx, y, cz\]\}, socket: \{name: 'seat'\}, station: \{anim: 'sitchair'\}\}\}/.test(m), old: /component: 'sockets'/.test(m), i: /light\.daytime/.test(i) && /sky\.tz/.test(i) && !/light\.noon|sky\.clock/.test(i) }; },
    good: (o) => o.m && !o.old && o.i },
  // ---------------- A: anim (R 10-17 15:09/15:11) ----------------
  { id: "A1", what: "(R 15:09/15:11) the registry: grabbable.anim and station.anim (no pose, no closed enum), a grip's grasp, anim-pose reserved beside anim-clip", run() {
      const G = CS.COMPONENTS.grabbable, S = CS.COMPONENTS.station; const GR = readText("shared/grab.js");
      return { g: Object.keys(G.fields), genum: G.enums?.pose ?? null, s: Object.keys(S.fields), ap: CS.COMPONENTS["anim-pose"]?.status ?? null, ac: CS.COMPONENTS["anim-clip"]?.status ?? null, grasp: /GRIP_KEYS = \['pos', 'q', 'hand', 'role', 'grasp', 'part'\]/.test(GR) }; },
    good: (o) => o.g.includes("anim") && !o.g.includes("pose") && o.genum === null && o.s.includes("anim") && !o.s.includes("pose") && o.ap === "reserved" && o.ac === "reserved" && o.grasp },
  { id: "A2", what: "…a write in the old spelling is taken and stored in the new, with a note: grabbable {pose: torch, grips.fingers} → {anim: torch, grips.grasp}; pose two-hand → twoHanded: true; station {pose} → anim", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } }); s.call("olive", "create", { id: "rod", model: "book", place: { at: [2, 0] } });
      const a = s.call("olive", "set", { id: "cup", component: "grabbable", value: { pose: "torch", grips: { h: { pos: [0, 0.1, 0], fingers: "pinch" } } } });
      const b = s.call("olive", "set", { id: "rod", component: "grabbable", value: { pose: "two-hand" } });
      s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      const c = s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie", pose: "lie" } } });
      const E = s.w().state().entities; const kid = Object.keys(E).find((k) => E[k].c.socket?.name === "bunk");
      return { a: show(a), b: show(b), c: show(c), cup: E.cup?.c.grabbable ?? null, rod: E.rod?.c.grabbable ?? null, st: kid ? E[kid].c.station : null, notes: JSON.stringify(a.notes ?? []) }; },
    good: (o) => o.a === "ok" && o.b === "ok" && o.c === "ok" && o.cup?.anim === "torch" && !("pose" in o.cup) && o.cup?.grips?.h?.grasp === "pinch" && !("fingers" in o.cup.grips.h)
      && o.rod?.twoHanded === true && !("pose" in o.rod) && !("anim" in o.rod) && o.st?.anim === "lie" && !("pose" in o.st) && /renamed before release/.test(o.notes) },
  { id: "A3", what: "…anim is an OPEN name: one the body doesn't know is admitted and held as the body's default (by size), never refused; a built-in one (torch) is held as named", async run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      const r = s.call("olive", "set", { id: "cup", component: "grabbable", value: { anim: "juggle-overhand" } });
      const GB = await import(TREE + "shared/grab.js"); const g = GB.grabOf(s.w().state().entities.cup?.c ?? {});
      return { r: show(r), held: GB.holdPoseOf(g, [0.2, 0.2, 0.2]), big: GB.holdPoseOf(g, [1, 1, 1]), torch: GB.holdPoseOf(GB.grabOf({ grabbable: { anim: "torch" } }), [0.2, 0.2, 0.2]), two: GB.holdPoseOf(GB.grabOf({ grabbable: { twoHanded: true } }), [0.2, 0.2, 0.2]), named: GB.HOLD_POSES ?? null }; },
    good: (o) => o.r === "ok" && o.held === "hand" && o.big === "carry" && o.torch === "torch" && o.two === "both-hands" && JSON.stringify(o.named) === '["hand","carry","torch","pistol","shoulder"]' },
  { id: "A4", what: "…a log holding grabbable.pose / a grip's fingers / station.pose is renamed at load (rename-components, every load, idempotent): anim, grasp, twoHanded", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie" } } });
      const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const E0 = s.w().state().entities; const kid = Object.keys(E0).find((k) => E0[k].c.socket?.name === "bunk");
      const gv = { who: "visitor", pose: "pistol", grips: { h: { pos: [0, 0.1, 0], fingers: "point" } } }, sv = { action: "lie", anchor: "root", pose: "lie" };
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), [
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "cup", component: "grabbable", value: gv } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "cup", comp: "grabbable", value: gv }, ts: ts + 1 },
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: kid, component: "station", value: sv } }, ts: ts + 2 },
        { world: wid, kind: "change", actor: "olive", cause: n + 2, verb: "set", body: { id: kid, comp: "station", value: sv }, ts: ts + 2 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); D.liftWorld(w1); const w2 = s.reopen(); const E = w2.state().entities;
      const k = w2.entries.length; D.liftWorld(w2); const again = s.reopen().entries.length - k;
      const act = w2.entries.findLast((e: any) => e.kind === "act" && e.verb === "rename-components");
      return { g: E.cup?.c.grabbable ?? null, st: E[kid]?.c.station ?? null, again, renamed: act?.body?.renamed ?? null, status: w2.state().status }; },
    good: (o) => o.status === "ok" && o.g?.anim === "pistol" && !("pose" in o.g) && o.g?.grips?.h?.grasp === "point" && !("fingers" in o.g.grips.h) && o.st?.anim === "lie" && !("pose" in o.st) && o.again === 0 && Array.isArray(o.renamed) && o.renamed.some((r: any) => r.component === "station") },
  { id: "A5", what: "…the legacy sockets map's body block keeps pose: the lift makes it station.anim, and the map's readers get body.pose back (slotOf)", async run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      const r = s.call("olive", "set", { id: "bench", component: "sockets", value: { bunk: { pos: [0, 0.5, 0], body: { action: "lie", pose: "lie" } } } });
      const E = s.w().state().entities; const kid = Object.keys(E).find((k) => E[k].c.socket?.name === "bunk");
      const SK = await import(TREE + "shared/sockbody.js"); const slot = kid ? SK.slotOf(E[kid].c.socket, E[kid].c.transform, E[kid].c.station) : null;
      return { r: show(r), st: kid ? E[kid].c.station : null, body: slot?.body ?? null, b: SK.bodyOf?.(kid ? E[kid].c.station : null)?.clip ?? null }; },
    good: (o) => o.r === "ok" && o.st?.anim === "lie" && !("pose" in o.st) && o.body?.pose === "lie" && !("anim" in o.body) && o.b === "lie" },
  { id: "A6", what: "(R 15:09) folded wings are the named pose wings-folded on the wire (poses: [names]; [] holds none); an older sample's wingsFolded still reads; the server's fence keeps a clean poses list", async run() {
      const WP = await import(TREE + "shared/wingpresence.js"); const PC = await import(TREE + "server/posecheck.ts");
      const keep = PC.sanePose({ p: [0, 0, 0], poses: ["wings-folded"] }), bad = PC.sanePose({ p: [0, 0, 0], poses: [1, 2] });
      return { on: JSON.stringify(WP.wingFoldPresence(true)), off: JSON.stringify(WP.wingFoldPresence(false)), old: [WP.foldedIn?.({ wingsFolded: true }), WP.foldedIn?.({ wingsFolded: false }), WP.foldedIn?.({})],
        keep: JSON.stringify(keep?.poses ?? null), bad: bad ? "poses" in bad : "dropped" }; },
    good: (o) => o.on === '{"poses":["wings-folded"]}' && o.off === '{"poses":[]}' && JSON.stringify(o.old) === "[true,false,null]" && o.keep === '["wings-folded"]' && o.bad === false },
  { id: "A7", what: "…the agent's ONE anim tool (R 15:31/15:32) takes a name (a pose or a clip) or live joints / tracks, a mode (once | loop | hold) and at; nothing is required", run() {
      const t = readText("mcpl/tools.ts"); const i = t.indexOf('name: "anim", description: "'); const a = i < 0 ? "" : t.slice(i, t.indexOf("\n", i));
      return { name: /properties: \{ name: \{ type: "string"/.test(a), mode: /mode: \{ type: "string", enum: \["once", "loop", "hold"\]/.test(a), at: /at: \{ type: "number"/.test(a), joints: /joints: \{ type: "object"/.test(a), tracks: /tracks: \{ type: "object"/.test(a), req: /required:/.test(a) }; },
    good: (o) => o.name && o.mode && o.at && o.joints && o.tracks && !o.req },
  // ---------------- U: the action bar ----------------
  { id: "U1", what: "(R 15:18, the UI half) the bar of gestures is the action bar: its frame id, the lite client's ids and classes, its titles and strings say action", run() {
      const wn = readText("client/lib/windows.js"), eb = readText("client/lib/actionbar.js"), el = readText("client/lib/actionbar_lite.js"), ix = readText("client/index.html"), ui = readText("client/lib/ui.js"), lt = readText("client/lite.js");
      return { layout: /^  actions:  \{ x: 'center'/m.test(wn) && !new RegExp(`^  ${EM}s:`, "m").test(wn), frame: /makeFrame\('actions'/.test(eb) && /title: 'action bar'/.test(eb), lite: /lite-actions/.test(el) && !new RegExp(`lite-${EM}`).test(el + ix + lt),
        title: /actions: 'action bar'/.test(ui) && !new RegExp(`'${EM} bar'`).test(ui), strings: !new RegExp(`chat, ${EM}s`).test(lt + ui) }; },
    good: (o) => o.layout && o.frame && o.lite && o.title && o.strings },
  // ---------------- M: ONE agent tool, anim (R 10-17 15:31/15:32) ----------------
  { id: "M1", what: "(R 15:32) each built-in anim's own mode: wave/cheer/clap/point/salute/flail/talk once; dance, sit, sitchair, lie, stand loop; wings-folded (a one-frame pose) holds; a name the body doesn't know plays once", async run() {
      const { ag, call } = await animAgent();
      const out: any = {}; for (const n of ["wave", "cheer", "clap", "point", "salute", "flail", "talk", "dance", "sit", "sitchair", "lie", "stand", "juggle-overhand"]) out[n] = played(await call("anim", { name: n }))?.mode ?? null;
      out["wings-folded"] = played(await call("anim", { name: "wings-folded" }))?.mode ?? null;
      return out; },
    good: (o) => ["wave", "cheer", "clap", "point", "salute", "flail", "talk", "juggle-overhand"].every((n) => o[n] === "once") && ["dance", "sit", "sitchair", "lie", "stand"].every((n) => o[n] === "loop") && o["wings-folded"] === "hold" },
  { id: "M2", what: "…the call's mode overrides: wave {mode: loop} loops, sit {mode: once} plays once; sit {mode: hold, at: 0.5} freezes: the presence packet carries clipTime 0.5 at clipRate 0", async run() {
      const { ag, call, sent } = await animAgent();
      const a = played(await call("anim", { name: "wave", mode: "loop" })), b = played(await call("anim", { name: "sit", mode: "once" }));
      const c = played(await call("anim", { name: "sit", mode: "hold", at: 0.5 }));
      ag.joined = true; ag.tick(); const pk = sent.filter((m: any) => m.type === "pose").at(-1)?.pose ?? null; ag.joined = false;
      return { a: a?.mode, b: b?.mode, c: c?.mode, hold: ag.animHold, t: pk?.clipTime, rate: pk?.clipRate, clip: pk?.clip }; },
    good: (o) => o.a === "loop" && o.b === "once" && o.c === "hold" && o.hold === 0.5 && o.t === 0.5 && o.rate === 0 && o.clip === "sit" },
  { id: "M3", what: "…the reply states {playing, mode}: a name, or \"live\" for joints (a held frame: hold) and tracks (once, or loop)", async run() {
      const { call } = await animAgent();
      const n = played(await call("anim", { name: "dance" })), j = played(await call("anim", { joints: { head: [0, 0.1, 0, 0.995] } }));
      const tr = { head: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0.1, 0, 0.995] }] };
      const t1 = played(await call("anim", { tracks: tr, dur: 1 })), t2 = played(await call("anim", { tracks: tr, dur: 1, mode: "loop" }));
      return { n, j, t1, t2 }; },
    good: (o) => o.n?.playing === "dance" && o.n?.mode === "loop" && JSON.stringify(o.j) === '{"playing":"live","mode":"hold"}' && JSON.stringify(o.t1) === '{"playing":"live","mode":"once"}' && JSON.stringify(o.t2) === '{"playing":"live","mode":"loop"}' },
  { id: "M4", what: "…a loop or hold that ends tells the agent stopped {name, why}: another anim, a move, anim {stop}, being knocked over; a once anim ends silently", async run() {
      const { ag, call } = await animAgent(); const why = () => ag.animStops?.map((x: any) => `${x.name}:${x.why}`) ?? null;
      await call("anim", { name: "sit" }); await call("anim", { name: "dance" });                       // another anim
      ag.clip = "walk"; ag.tick();                                                                       // a move takes the clip
      await call("anim", { name: "lie" }); await call("anim", { stop: true });                           // stop
      await call("anim", { joints: { head: [0, 0.1, 0, 0.995] } }); ag.clip = "ragdoll"; ag.tick();      // knocked over
      ag.clip = "idle"; await call("anim", { name: "wave" }); ag.tick();                                 // once: silent
      const told = ag.inbox?.filter((m: any) => /^stopped \{/.test(m.text ?? "")).length ?? 0;
      return { why: why(), told }; },
    good: (o) => JSON.stringify(o.why) === '["sit:replaced","dance:moved","lie:stopped","live:knocked over"]' && o.told === 4 },
  { id: "M5", what: "…pose, animate, posture and the action bar's old tool are hidden aliases of anim (not advertised; each maps its old shape): pose {bones} → joints, pose {clear} → stop, pose {posture} / posture {kind} → a looped name, pose {wings: fold} → wings-folded, animate {tracks, loop} → mode loop; the old gesture tool's {name} passes through untranslated (R 16:26)", async run() {
      const T: any = await import(TREE + "mcpl/tools.ts"); const A = T.TOOL_ALIAS_ARGS ?? {};
      return { listed: ["pose", "animate", EM, "posture"].filter((n) => T.TOOLS.some((t: any) => t.name === n)), anim: T.TOOLS.some((t: any) => t.name === "anim"),
        to: ["pose", "animate", EM, "posture"].map((n) => T.resolveTool(n)?.name ?? null), pass: A[EM] === undefined,
        m: [A.pose?.({ bones: { head: [0, 0, 0, 1] } }), A.pose?.({ clear: true }), A.pose?.({ posture: "sit" }), A.posture?.({ kind: "lie" }), A.pose?.({ wings: "fold" }), A.animate?.({ tracks: {}, dur: 1, loop: true })].map((x) => JSON.stringify(x ?? null)) }; },
    good: (o) => !o.listed.length && o.anim && o.to.every((n: string) => n === "anim") && o.pass && JSON.stringify(o.m) === JSON.stringify(['{"joints":{"head":[0,0,0,1]}}', '{"stop":true}', '{"name":"sit","mode":"loop"}', '{"name":"lie","mode":"loop"}', '{"name":"wings-folded"}', '{"tracks":{},"dur":1,"mode":"loop"}']) },
  { id: "M6", what: "…live tracks in mode hold freeze on one frame: `at` picks it (the last key at or before), default the last key", async run() {
      const { ag, call } = await animAgent(); const tr = { head: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0.1, 0, 0.995] }, { t: 1, q: [0, 0.2, 0, 0.98] }] };
      const a = played(await call("anim", { tracks: tr, dur: 1, mode: "hold", at: 0.6 })); const f1 = JSON.stringify(ag.heldPose?.head ?? null);
      const b = played(await call("anim", { tracks: tr, dur: 1, mode: "hold" })); const f2 = JSON.stringify(ag.heldPose?.head ?? null);
      return { a, b, f1, f2 }; },
    good: (o) => o.a?.mode === "hold" && o.b?.playing === "live" && Math.abs(JSON.parse(o.f1)[1] - 0.1) < 1e-3 && Math.abs(JSON.parse(o.f2)[1] - 0.2) < 1e-3 },
  // ---------------- L / B: layering, where a name resolves, one form; body-mode (R 10-17 15:34–15:39) ----------------
  { id: "L1", what: "(R 15:34 A) a once anim overlays what is held and returns to it: sit then wave is still sitting, no stopped for sit; a new loop or hold replaces it (stopped {why: replaced})", async run() {
      const { ag, call } = await animAgent();
      await call("anim", { name: "sit" }); const w = played(await call("anim", { name: "wave" })); const still = ag.anim?.name ?? null, clip = ag.clip, n0 = ag.animStops.length;
      await call("anim", { name: "dance" }); const last = ag.animStops.at(-1) ?? null;
      return { w, still, clip, n0, last: last ? `${last.name}:${last.why}` : null }; },
    good: (o) => o.w?.mode === "once" && o.still === "sit" && o.clip === "sit" && o.n0 === 0 && o.last === "sit:replaced" },
  { id: "L2", what: "(R 15:34 B) the result says where a name resolved: from avatar | world | builtin (every name is built in today)", async run() {
      const { call } = await animAgent(); return { a: played(await call("anim", { name: "wave" })), b: played(await call("anim", { name: "dance" })) }; },
    good: (o) => o.a?.from === "builtin" && o.b?.from === "builtin" },
  { id: "L3", what: "(R 15:34 C) a name together with joints or tracks is refused, saying so (nothing guessed, nothing played)", async run() {
      const { ag, call } = await animAgent();
      const a = await call("anim", { name: "sit", joints: { head: [0, 0, 0, 1] } }), b = await call("anim", { name: "wave", tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }] }, dur: 1 });
      return { a: a?.isError === true && /a name OR live keys/.test(a.content[0].text), b: b?.isError === true && /a name OR live keys/.test(b.content[0].text), clip: ag.clip, anim: ag.anim }; },
    good: (o) => o.a && o.b && o.clip !== "sit" && o.anim === null },
  { id: "B1", what: "(R 15:34 D, 16:26) body-mode is its own presence field (bodyMode), apart from the clip: anim sit publishes sit; anim {stop} leaves it sit, a declared stand or a walk returns to stand", async run() {
      const { ag, call, sent } = await animAgent(); const pk = () => { ag.joined = true; ag.tick(); ag.joined = false; return sent.filter((m: any) => m.type === "pose").at(-1)?.pose ?? null; };
      const s0 = pk()?.bodyMode; await call("anim", { name: "sitchair" }); const s1 = pk(); await call("anim", { stop: true }); const s2 = pk()?.bodyMode;
      const clip2 = ag.clip; await call("anim", { bodyMode: "stand" }); const s2b = pk()?.bodyMode, clip2b = ag.clip;
      await call("anim", { name: "lie" }); const s3 = pk()?.bodyMode; ag.clip = "walk"; ag.tick(); const s4 = pk()?.bodyMode;
      return { s0, s1: s1?.bodyMode, clip1: s1?.clip, s2, clip2, s2b, clip2b, s3, s4 }; },
    good: (o) => o.s0 === "stand" && o.s1 === "sit" && o.clip1 === "sitchair" && o.s2 === "sit" && o.clip2 === "sitchair" && o.s2b === "stand" && o.clip2b === "idle" && o.s3 === "lie" && o.s4 === "stand" },
  { id: "B2", what: "…a sample written before (no bodyMode) is read from its clip (sitchair → sit, lie → lie, tread → swim); the server's fence keeps only the grammar", async run() {
      const BM = await import(TREE + "shared/bodymode.js"); const PC = await import(TREE + "server/posecheck.ts");
      const ok1 = PC.sanePose({ p: [0, 0, 0], bodyMode: "lie" }), bad = PC.sanePose({ p: [0, 0, 0], bodyMode: "infected" });
      return { r: ["sitchair", "lie", "tread", "idle"].map((c) => BM.readBodyMode({ clip: c })), own: BM.readBodyMode({ clip: "sit", bodyMode: "fly" }), keep: ok1?.bodyMode ?? null, bad: bad ? "bodyMode" in bad : "dropped", modes: BM.BODY_MODES }; },
    good: (o) => JSON.stringify(o.r) === '["sit","lie","swim","stand"]' && o.own === "fly" && o.keep === "lie" && o.bad === false && JSON.stringify(o.modes) === '["stand","sit","lie","swim","fly","fall"]' },
  { id: "B3", what: "…swim, fly and fall come from the mover's own states; every mode is declarable for looks (R 15:45): declared fly while walking publishes fly, and gains nothing: take-off without the fly permission is still refused", async run() {
      const BM = await import(TREE + "shared/bodymode.js"); const { ag } = await animAgent();
      const r = [BM.bodyModeOf({ flying: true, chosen: "sit" }), BM.bodyModeOf({ swimming: true }), BM.bodyModeOf({ falling: true }), BM.bodyModeOf({ chosen: "lie" })];
      const { call: c2, sent } = await animAgent2(ag); const d = await c2("anim", { bodyMode: "fly" }); ag.clip = "walk"; ag.joined = true; ag.tick(); ag.joined = false;
      const pk = sent.filter((m: any) => m.type === "pose").at(-1)?.pose ?? null;
      ag.myRights = { role: "visitor", fly: false }; const t = String(await ag.takeOff());
      const md = readText("spec/PROTOCOL.md");
      return { r, declared: pk?.bodyMode ?? null, clip: pk?.clip ?? null, t: t.slice(0, 120), flying: !!ag.flight, spec: /self-declared\s+description/.test(md) && /MUST\s+NOT\s+grant or relax/.test(md.slice(md.indexOf("pose.bodyMode"), md.indexOf("pose.bodyMode") + 1600)) }; },
    good: (o) => JSON.stringify(o.r) === '["fly","swim","fall","lie"]' && o.declared === "fly" && o.clip === "walk" && !o.flying && /cannot fly|not granted|no wings/.test(o.t) && o.spec },
  // ---------------- K: anim {stop} (R 10-17 16:26/16:27) ----------------
  { id: "K1", what: "(R 16:26) anim {stop: true} rests in the CURRENT body-mode's own anim and leaves the body-mode as it was: sit → sit, sitchair → sitchair (sit), lie → lie, dance → idle (stand), dance with swim declared → tread; never the bind pose (no held bones, a clip always); each told stopped {name, why: stopped}; on a station the occupant stays", async run() {
      const out: any = {};
      for (const [n, decl] of [["sit"], ["sitchair"], ["lie"], ["dance"], ["dance", "swim"]] as [string, string?][]) {
        const { ag, call } = await animAgent(); if (decl) await call("anim", { bodyMode: decl });
        await call("anim", { name: n }); const r = await call("anim", { stop: true });
        out[n + (decl ? `@${decl}` : "")] = { mode: ag.bodyModeNow(), clip: ag.clip, held: ag.heldPose != null, stops: ag.animStops.map((x: any) => `${x.name}:${x.why}`), err: r?.isError === true, playing: ag.anims?.length ?? (ag.anim ? 1 : 0) };
      }
      const { ag, call } = await animAgent(); ag.myOccupancy = { to: "sofa-l" }; ag.joined = true;
      await call("anim", { name: "sitchair" }); await call("anim", { stop: true }); ag.joined = false;
      out.occupant = { still: ag.myOccupancy?.to ?? null, mode: ag.bodyModeNow() };
      return out; },
    good: (o) => { const is = (k: string, mode: string, clip: string) => o[k]?.mode === mode && o[k]?.clip === clip && !o[k].held && !o[k].err && o[k].playing === 0 && JSON.stringify(o[k].stops) === JSON.stringify([`${k.split("@")[0]}:stopped`]);
      return is("sit", "sit", "sit") && is("sitchair", "sit", "sitchair") && is("lie", "lie", "lie") && is("dance", "stand", "idle") && is("dance@swim", "swim", "tread") && o.occupant.still === "sofa-l" && o.occupant.mode === "sit"; } },
  { id: "K2", what: "…anims are layers: a pose (joints) or a tracks loop struck over a sit leaves the sit playing; anim {stop: true} stops every layer (each told), drops the held bones, tells every client to fade the tracks, and rests in the sit; a tracks loop isn't ended by the next tick", async run() {
      const { ag, call, sent } = await animAgent(); ag.joined = true;
      await call("anim", { name: "sit" }); await call("anim", { joints: { head: [0, 0.1, 0, 0.995] } });
      await call("anim", { tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0.1, 0, 0.995] }] }, dur: 1, mode: "loop" }); ag.tick();
      const layers = (ag.anims ?? []).map((x: any) => x.name), before = ag.animStops.map((x: any) => `${x.name}:${x.why}`), clip0 = ag.clip, held0 = ag.heldPose != null;
      const n = sent.length; await call("anim", { stop: true }); ag.joined = false;
      return { layers, before, clip0, held0, stops: ag.animStops.map((x: any) => `${x.name}:${x.why}`), held: ag.heldPose != null, clip: ag.clip, mode: ag.bodyModeNow(), fade: sent.slice(n).some((m: any) => m.type === "anim" && m.stop === true) }; },
    good: (o) => JSON.stringify(o.layers) === '["sit","live","live"]' && o.before.length === 0 && o.clip0 === "sit" && o.held0 && JSON.stringify(o.stops) === '["sit:stopped","live:stopped","live:stopped"]' && !o.held && o.clip === "sit" && o.mode === "sit" && o.fade },
  { id: "K3", what: "…anim {stop: \"<name>\"} stops only that layer: sit + a pose, stop sit → the pose goes on (and the body-mode rests in sit); a name that isn't playing is a clear \"not playing\" note, not an error, and stops nothing", async run() {
      const { ag, call } = await animAgent();
      await call("anim", { name: "sit" }); await call("anim", { joints: { head: [0, 0.1, 0, 0.995] } });
      const r = await call("anim", { stop: "sit" }); const after = { layers: (ag.anims ?? []).map((x: any) => x.name), held: ag.heldPose != null, clip: ag.clip, mode: ag.bodyModeNow() };
      const r2 = await call("anim", { stop: "dance" });
      return { after, stops: ag.animStops.map((x: any) => `${x.name}:${x.why}`), t: r?.content?.[0]?.text, t2: r2?.content?.[0]?.text, e2: r2?.isError === true, layers2: (ag.anims ?? []).map((x: any) => x.name) }; },
    good: (o) => JSON.stringify(o.after.layers) === '["live"]' && o.after.held && o.after.clip === "sit" && o.after.mode === "sit" && JSON.stringify(o.stops) === '["sit:stopped"]' && /not playing "dance"/.test(o.t2) && !o.e2 && JSON.stringify(o.layers2) === '["live"]' },
  { id: "K4", what: "(R 16:27) anim {stop: \"live\"} stops only ad-libbed anims (joints, tracks), leaving the named ones and the body-mode: sit + a pose + a tracks loop → sit plays on; \"live\" is reserved: no anim by that name (the tool, a clip def, the action bar's table, an object's or a station's anim)", async run(s) {
      const { ag, call, sent } = await animAgent(); ag.joined = true;
      await call("anim", { name: "sit" }); await call("anim", { joints: { head: [0, 0.1, 0, 0.995] } }); await call("anim", { tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }] }, dur: 1, mode: "loop" });
      const n = sent.length; await call("anim", { stop: "live" }); ag.joined = false;
      const named = await call("anim", { name: "live" });
      const AD: any = await import(TREE + "shared/animdefs.js"); const side = AD.validateActionBar;
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } }); s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      const g = s.call("olive", "set", { id: "cup", component: "grabbable", value: { anim: "live" } });
      const st = s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie", anim: "live" } } });
      return { layers: (ag.anims ?? []).map((x: any) => x.name), stops: ag.animStops.map((x: any) => `${x.name}:${x.why}`), held: ag.heldPose != null, clip: ag.clip, mode: ag.bodyModeNow(), fade: sent.slice(n).some((m: any) => m.type === "anim" && m.stop === true),
        named: named?.isError === true && /reserved/.test(named.content[0].text), def: (AD.validateAnimationDef?.("live", {}) ?? []).length > 0, bar: (side?.({ live: { clip: "dance" } }) ?? []).length > 0, g: show(g), st: show(st) }; },
    good: (o) => JSON.stringify(o.layers) === '["sit"]' && JSON.stringify(o.stops) === '["live:stopped","live:stopped"]' && !o.held && o.clip === "sit" && o.mode === "sit" && o.fade && o.named && o.def && o.bar && /^refused/.test(o.g) && /^refused/.test(o.st) },
  { id: "K5", what: "…the words: the anim tool's description and AGENTS.md spell out stop (true: every layer, the body-mode's rest, never the bind pose, body-mode unchanged; a name: that layer; \"live\": the ad-libbed ones, a reserved name), and the spec gives the rest rule and the relay's anim {stop: true}", run() {
      const t = readText("mcpl/tools.ts"); const i = t.indexOf('name: "anim", description: "'); const d = i < 0 ? "" : t.slice(i, t.indexOf("\n", i));
      const a = readText("AGENTS.md"), md = readText("spec/PROTOCOL.md");
      const says = (x: string) => /rests in your body-mode's own anim \(stand: idle/.test(x) && /never the bind pose/i.test(x) && /body-mode[^.]{0,40}unchanged/i.test(x) && /stop: \\?"live\\?"/.test(x) && /reserved/.test(x) && /that layer/.test(x);
      const body = md.slice(0, md.indexOf("## Version history"));
      return { tool: says(d), agents: says(a), spec: /never the bind pose/i.test(body) && /`\{type: "anim", stop: true\}`/.test(md) && /`live` is reserved/.test(md) }; },
    good: (o) => o.tool && o.agents && o.spec },
  // ---------------- E: the old name of a gesture, gone (R 10-17 16:26) ----------------
  { id: "E1", what: "(R 16:26) presence pose.anim: the agent's once anim rides the next packet as anim (never the old key); the browser sends pose.anim; a receiver (browser, agent) reads either key; the server remembers neither", async run() {
      const { ag, call, sent } = await animAgent(); ag.joined = true; await call("anim", { name: "wave" }); ag.tick(); ag.tick(); ag.joined = false;
      const pk = sent.filter((m: any) => m.type === "pose").map((m: any) => m.pose);
      const OA = exists("shared/onceanim.js") ? await import(TREE + "shared/onceanim.js") : null;
      const old = { p: [0, 0, 0], clip: "idle", [EM]: "cheer" };
      const acts: any[] = []; const ag2: any = (await animAgent()).ag; ag2.inbox = []; try { ag2.noteActs?.("u-x", null, old, 1); ag2.noteActs?.("u-y", null, { p: [0, 0, 0], clip: "idle", anim: "clap" }, 1); } catch (e) { acts.push(String(e)); }
      const srv = readText("server/server.ts"), net = readText("client/lib/net.js"), rem = readText("client/lib/remotes.js");
      return { first: pk[0]?.anim ?? null, firstOld: pk[0] ? EM in pk[0] : null, second: pk[1] ? "anim" in pk[1] : null,
        read: OA ? [OA.onceAnimOf({ anim: "wave" }), OA.onceAnimOf(old), OA.onceAnimOf({})] : null, drop: OA ? JSON.stringify(OA.withoutOnceAnim({ a: 1, anim: "x", [EM]: "y" })) : null,
        heard: ag2.inbox.map((m: any) => m.text).join(" | ").slice(0, 300), acts,
        srv: /settledPose[^]*?withoutOnceAnim\(pose/.test(srv), net: /pose\.anim = s\.anim/.test(net), rem: (rem.match(/onceAnimOf\(s\)/g) ?? []).length }; },
    good: (o) => o.first === "wave" && o.firstOld === false && o.second === false && JSON.stringify(o.read) === '["wave","cheer",null]' && o.drop === '{"a":1}' && o.srv && o.net && o.rem === 2 },
  { id: "E2", what: "…the action bar's modules and defs: actionbar.js, actionbar_lite.js, animnames.js, defs/animations/_actionbar.json (the registry's actionbar key, validateActionBar); the old files are gone; the slash command is /anim", async run() {
      const AD: any = await import(TREE + "shared/animdefs.js"); const defs = readText("server/defs.ts"), reg = readText("client/lib/commands/registry.js");
      const olds = fs.readdirSync(TREE + "client/lib").concat(fs.readdirSync(TREE + "defs/animations")).filter((f: string) => new RegExp(`(?<![rd])${EM}`, "i").test(f));
      return { now: ["client/lib/actionbar.js", "client/lib/actionbar_lite.js", "client/lib/animnames.js", "defs/animations/_actionbar.json"].every(exists), olds,
        key: /actionbar: loadSidecar\("animations\/_actionbar\.json", validateActionBar\)/.test(defs), v: typeof AD.validateActionBar === "function" && AD.validateActionBar({ wave: { clip: "raise" } }).length === 0,
        slash: /\{ name: 'anim', help: '\/anim <name>/.test(reg) }; },
    good: (o) => o.now && !o.olds.length && o.key && o.v && o.slash },
  { id: "E3", what: "…the word appears nowhere but the hidden tool alias's entry (TOOL_ALIASES) and the old key's read (shared/onceanim.js) and the action bar's old id for carrying saved storage (client/lib/ui.js ACTIONBAR_OLD_ID): every file of the tree (spec/history, the frozen v1 record, aside), file names too; and both of those still work", async run() {
      const re = new RegExp(`(?<![rd])${EM}`, "i"); const hits: string[] = []; const SKIP = new Set(["node_modules", ".git", "worlds", "store", "history"]);
      const walk = (rel: string) => { let ents: any[] = []; try { ents = fs.readdirSync(TREE + rel, { withFileTypes: true }); } catch { return; }
        for (const e of ents) { const r = rel ? `${rel}/${e.name}` : e.name; if (SKIP.has(e.name)) continue;
          let st: any; try { st = fs.statSync(TREE + r); } catch { continue; }
          if (re.test(e.name)) hits.push(`${r} (its name)`);
          if (st.isDirectory()) { walk(r); continue; }
          if (st.size > 4e6 || /\.(png|jpe?g|glb|vrm|vrma|wasm|ico|webp|gz|zip|mp3|ogg|wav)$/i.test(e.name)) continue;
          const lines = fs.readFileSync(TREE + r, "utf8").split("\n"); lines.forEach((l: string, i: number) => { if (re.test(l)) hits.push(`${r}:${i + 1}: ${l.trim().slice(0, 120)}`); }); } };
      walk("");
      const allowed = (h: string) => /^mcpl\/tools\.ts:\d+: pose: "anim", animate: "anim", \w+: "anim", posture: "anim" \};$/.test(h) || /^shared\/onceanim\.js:\d+: const OLD_KEY = '\w+';$/.test(h)
        || /^client\/lib\/ui\.js:\d+: export const ACTIONBAR_OLD_ID = '\w+';$/.test(h);   // a returning person's saved pins/frame carried once (gym 10-17 20:00)
      const T: any = await import(TREE + "mcpl/tools.ts"); const OA = exists("shared/onceanim.js") ? await import(TREE + "shared/onceanim.js") : null;
      return { stray: hits.filter((h) => !allowed(h)).slice(0, 12), nStray: hits.filter((h) => !allowed(h)).length, kept: hits.filter(allowed).length, alias: T.resolveTool?.(EM)?.name ?? null, read: OA?.onceAnimOf({ [EM]: "wave" }) ?? null }; },
    good: (o) => o.nStray === 0 && o.kept === 3 && o.alias === "anim" && o.read === "wave" },
  // ---------------- OS: oscillate (R 10-17 21:40) ----------------
  { id: "OS1", what: "(R 21:40) the registry: motion.type is pendulum | spin | orbit | oscillate | path (no bob); oscillate's per-type defaults and units; the editor's card is Oscillate (descriptors, the component list, MOTION_TYPES)", async run() {
      const M = CS.COMPONENTS.motion; const DS: any = await import(TREE + "shared/protocol/descriptors.js"); const CO: any = await import(TREE + "shared/components.js"); const ES: any = await import(TREE + "shared/editschema.js");
      const m = CS.materialize("motion", { type: "oscillate" }).value;
      return { enum: M.enums.type, unit: M.units.amp, m, cards: Object.keys(DS.DESCRIPTORS ?? {}).filter((k: string) => /^(Bob|Oscillate)$/.test(k)), list: Object.keys(CO.RECORDS ?? {}).filter((k: string) => /^(Bob|Oscillate)$/.test(k)), types: ES.MOTION_TYPES, help: M.help }; },
    good: (o) => JSON.stringify(o.enum) === '["pendulum","spin","orbit","oscillate","path"]' && o.unit?.oscillate === "m" && !("bob" in (o.unit ?? {})) && JSON.stringify(o.m.axis) === "[0,1,0]" && o.m.amp === 0.3 && o.m.period === 4 && o.m.phase === 0
      && JSON.stringify(o.cards) === '["Oscillate"]' && JSON.stringify(o.list) === '["Oscillate"]' && JSON.stringify(o.types) === '["pendulum","spin","orbit","oscillate","path"]' && /oscillate \{axis, amp \(m\), period \(s\), phase\}/.test(o.help) && !/\bbob\b/.test(o.help) },
  { id: "OS2", what: "…the door takes the old spelling for one release and stores oscillate, with a note (a whole motion and a part's motion:<slot>); its defaults are oscillate's", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "drone", model: "book", place: { at: [0, 0] } }); s.call("olive", "create", { id: "arm", model: "book", place: { at: [2, 0] } });
      const a = s.call("olive", "set", { id: "drone", component: "motion", value: { type: "bob", amp: 0.4, period: 3 } });
      const b = s.call("olive", "set", { id: "arm", component: "motion:piston", value: { type: "bob", node: "Piston", axis: "x" } });
      const c = s.call("olive", "set", { id: "drone", component: "motion", value: { type: "oscillate", amp: 0.5 } });
      const E = s.w().state().entities;
      return { a: show(a), b: show(b), c: show(c), notes: JSON.stringify(a.notes ?? []), arm: E.arm?.c["motion:piston"] ?? null, drone: E.drone?.c.motion ?? null }; },
    good: (o) => o.a === "ok" && o.b === "ok" && o.c === "ok" && /"field":"type","from":"bob","to":"oscillate"/.test(o.notes) && /renamed before release/.test(o.notes)
      && o.arm?.type === "oscillate" && o.arm?.amp === 0.3 && o.arm?.period === 4 && JSON.stringify(o.arm?.axis) === "[1,0,0]" && o.drone?.type === "oscillate" && o.drone?.amp === 0.5 },
  { id: "OS3", what: "…a log holding a motion of type bob (whole, and a part's) is renamed at load (rename-components: the value kept, its type oscillate, per thing); the next load writes nothing", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "drone", model: "book", place: { at: [0, 0] } }); s.call("olive", "create", { id: "arm", model: "book", place: { at: [2, 0] } });
      const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const mv = { type: "bob", axis: [0, 1, 0], amp: 0.4, period: 3, phase: 0, t0: 1700000000000 }, pv = { type: "bob", node: "Piston", axis: [1, 0, 0], amp: 0.2, period: 2, phase: 0, t0: 1700000000000 };
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), [
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "drone", component: "motion", value: mv } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "drone", comp: "motion", value: mv }, ts: ts + 1 },
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "arm", component: "motion:piston", value: pv } }, ts: ts + 2 },
        { world: wid, kind: "change", actor: "olive", cause: n + 2, verb: "set", body: { id: "arm", comp: "motion:piston", value: pv }, ts: ts + 2 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); const before = w1.state().entities.drone?.c.motion?.type; D.liftWorld(w1); const w2 = s.reopen(); const E = w2.state().entities;
      const k = w2.entries.length; D.liftWorld(w2); const again = s.reopen().entries.length - k;
      const act = w2.entries.findLast((e: any) => e.kind === "act" && e.verb === "rename-components");
      return { before, drone: E.drone?.c.motion ?? null, arm: E.arm?.c["motion:piston"] ?? null, again, renamed: act?.body?.renamed ?? null, actor: act?.actor ?? null, status: w2.state().status }; },
    good: (o) => o.status === "ok" && o.before === "bob" && o.drone?.type === "oscillate" && o.drone?.amp === 0.4 && o.drone?.t0 === 1700000000000 && o.arm?.type === "oscillate" && o.arm?.node === "Piston" && o.again === 0 && o.actor === "system"
      && Array.isArray(o.renamed) && ["motion", "motion:piston"].every((c) => o.renamed.some((r: any) => r.component === c && r.field === "type" && r.from === "bob" && r.to === "oscillate")) },
  { id: "OS4", what: "…the readers read the old spelling for one release (names.js motionType): the closed form, the seat signals, the editor's channels and card draw a stored bob as an oscillate", async run() {
      const ME: any = await import(TREE + "client/lib/motioneval.js"), SS: any = await import(TREE + "client/lib/socksignals.js"), ES: any = await import(TREE + "shared/editschema.js"), NM: any = await import(TREE + "shared/protocol/names.js");
      const base = { pos: [1, 2, 3], yaw: 0 }, m = (type: string) => ({ type, axis: [0, 0, 1], amp: 0.5, period: 2, phase: 0.3, t0: 1000 });
      const now = ME.evalWholeMotion(base, m("oscillate"), 1700), old = ME.evalWholeMotion(base, m("bob"), 1700);
      const sch = ES.inspectSchema({ id: "d", model: "book", pos: [0, 0, 0], motion: m("bob") }, "d");
      const groups = JSON.stringify(sch); 
      return { now: now.ok && now.pos, old: old.ok && old.pos, cyc: [SS.cycleOf(m("oscillate"), 1700), SS.cycleOf(m("bob"), 1700)].map((c: any) => JSON.stringify(c)), ch: [ES.motionChannels(m("oscillate")), ES.motionChannels(m("bob"))].map((c: any) => [...c.t].join() + "|" + [...c.r].join()),
        card: /"Oscillate"/.test(groups), bobCard: /"Bob"/.test(groups), read: NM.motionType ? [NM.motionType({ type: "bob" }), NM.motionType({ type: "spin" }), NM.motionType(null)] : null }; },
    good: (o) => Array.isArray(o.now) && JSON.stringify(o.now) === JSON.stringify(o.old) && Math.abs(o.now[2] - 3) > 0.01 && o.cyc[0] === o.cyc[1] && o.ch[0] === o.ch[1] && o.ch[0] === "z|" && o.card && !o.bobCard && JSON.stringify(o.read) === '["oscillate","spin",null]' },
  { id: "OS5", what: "…Add Component offers Oscillate (bob, float, hover find it) and writes type oscillate", async run() {
      const ES: any = await import(TREE + "shared/editschema.js");
      const r = ES.addOps({ id: "d", model: "book", pos: [0, 0, 0] }, "d", "Oscillate");
      return { words: ES.ADD_WORDS?.Oscillate ?? null, old: "Bob" in (ES.ADD_WORDS ?? {}), ops: JSON.stringify(r?.ops ?? null), errors: r?.errors ?? null }; },
    good: (o) => Array.isArray(o.words) && ["bob", "float", "hover"].every((w) => o.words.includes(w)) && !o.old && /"type":"oscillate"/.test(o.ops) && !/"type":"bob"/.test(o.ops) && !(o.errors ?? []).length },
  { id: "OS6", what: "…the translator (@14) writes a v1 motion of type bob as oscillate (whole and a node's); its DROPPED table says so", async run() {
      const TV: any = await import(TREE + "tools/protocol/import-v1/translate-v1.js");
      const v1 = [{ seq: 0, ts: 1, actor: "world", verb: "grant", args: { id: "antra", role: "owner", gen: true } },
        { seq: 1, ts: 2, actor: "antra", verb: "spawn", args: { id: "drone", lib: "store/0123456789abcdef.glb", pos: [0, 1, 0] } },
        { seq: 2, ts: 3, actor: "antra", verb: "comp", args: { id: "drone", type: "motion", data: { type: "bob", amp: 0.4, period: 3 } } },
        { seq: 3, ts: 4, actor: "antra", verb: "comp", args: { id: "drone", type: "motion:Rotor", data: { type: "bob", amp: 0.1 } } }];
      const r = TV.translate(v1, {}); const e = r.final.translated.drone ?? {};
      return { t: TV.TRANSLATOR, s: TV.TRANSLATOR_SIM, whole: e.motion?.type ?? null, part: Object.entries(e).filter(([k]) => k.startsWith("motion:")).map(([, v]: any) => v.type), dropped: TV.DROPPED?.["motion.type"] ?? null, div: r.divergences?.length ?? 0 }; },
    good: (o) => /@14$/.test(o.t) && /@14$/.test(o.s) && o.whole === "oscillate" && JSON.stringify(o.part) === '["oscillate"]' && /oscillate/.test(o.dropped ?? "") },
  { id: "OS7", what: "…the docs say oscillate and never bob as a motion type (AGENTS.md, PROTOCOL.md, PHYSICS.md, DESIGN.md, the agent); the version history and the registry changelog record the rename", run() {
      const files = ["AGENTS.md", "spec/PROTOCOL.md", "spec/PHYSICS.md", "DESIGN.md", "mcpl/agent.ts"]; const md = readText("spec/PROTOCOL.md"); const vh = md.slice(md.indexOf("## Version history"));
      const motionBob = /pendulum[^\n]{0,40}\bbob\b|\bbob\b[^\n]{0,40}\bpath\b|type: ?['"]bob['"]/;
      return { stale: files.filter((f) => motionBob.test(readText(f))), says: files.filter((f) => /\boscillate\b/.test(readText(f))), vh: /`oscillate`/.test(vh) && /`bob`/.test(vh), cl: /oscillate/.test(readText("spec/REGISTRY-CHANGELOG.md").split("\n").filter((l: string) => /^- 2026-10-17/.test(l)).join("\n")) }; },
    good: (o) => !o.stale.length && o.says.length === 5 && o.vh && o.cl },
  // ---------------- X: the record ----------------
  { id: "X1", what: "the version history records the renames at minor 0, and the spec body speaks the new words (§5 consent, §7a rule 4)", run() {
      const md = readText("spec/PROTOCOL.md"); const vh = md.slice(md.indexOf("## Version history")); const body = md.slice(0, md.indexOf("## Version history"));
      return { vh: ["`hold-limit`", "`contact`", "`trusted-components`", "`rename-components`", "`displace`", "`delegates`", "`grabbable.anim`", "`grasp`", "`anim-pose`", "`wings-folded`", "`bodyMode`", "`{stop: true}`", "`live`"].every((w) => vh.includes(w)),
        body: /`allow`, `ask`, or `deny`/.test(body) && /\(`everyone` \/ `friends`\), `allow` \| `ask` \| `deny`/.test(body) && !/everyone, ask, or nobody/.test(body) && !/\(strangers \/ friends\)/.test(body) }; },
    good: (o) => o.vh && o.body },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (!want(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[names-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
