// shared/protocol/authority/reads.js — describe (a thing as an accessibility tree) and the read verbs (help, look, inspect,
// measure, find, lint, history) as READ_VERBS, which authority.js spreads into VERBS. schema is verbs.js's (SCHEMA_VERBS), beside the
// capacity it reports. The history readers are above it, reached through UP.
import { grabOf, describeGrab } from "../../grab.js";
import { verbHelp, VERBSPEC, REMOVED_VERBS } from "../verbspec.js";
import { graphemes } from "../../text.js";
import { saysOf } from "../../says.js";
import { readOut } from "../../a11y.js";
import { enginePoses } from "../simlayer.js";
import { r3 } from "../round.js";
import { CTX, UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { modelOf } from "./catalogue.js";
import { readback, isE, lockedC, versionOf } from "./storage.js";
import { tileSaid } from "../../terrainshape.js";
import { aabb, qrot, surfacesOf, worldT } from "./math.js";
import { kidsMap } from "./spatial.js";
import { isSocketC, socketsOf, socketRole } from "./sockets.js";
import { backward, creatorOf, effective, lockStrength, madeBy, roleOf } from "./rights.js";
import { shieldOf } from "./bodyconsent.js";
import { actionsOf, offersFor, pivotOf } from "./use.js";
import { BLUEPRINTS } from "./blueprints.js";
// the layers above this one, reached through UP (ctx.js; a leaf may not import them: authority-layers-check)
const danglingRefs = (...a) => UP.danglingRefs(...a);
const guess = (...a) => UP.guess(...a);
const historyDiff = (...a) => UP.historyDiff(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const opsTouching = (...a) => UP.opsTouching(...a);
const touchedOf = (...a) => UP.touchedOf(...a);
const warnings = (...a) => UP.warnings(...a);

// a surface's size as a placement reads it: a turned top's own rectangle (with its x axis on the ground), else its box
const surfaceSize = (s) => (s.rect ? { size: [r3(2 * s.rect.hx), r3(2 * s.rect.hz)], xAxis: s.rect.u.map(r3) } : { size: [r3(s.max[0] - s.min[0]), r3(s.max[1] - s.min[1])] });
// a thing reads like an accessibility tree (PROTOCOL §4): its name, its description (a look clips it, inspect has it
// whole), then what it can do and its state, generated from its components by shared/a11y.js, the reading mcpl's look and
// the inspector share
function describe(st, id, live = {}, holds = {}, { full = false, w = null } = {}) {
  const e = st.entities[id]; const t = worldT(st, id); const g = grabOf(e.c); const name = e.c.label ?? modelOf(e.c.model)?.label ?? e.c.model ?? id;
  const ax = readOut(e.c, { name, heldBy: holds[id] ? said(holds[id].by) : null, sockets: socketsOf(st, id) });
  const desc = ax.description == null ? null : full || graphemes(ax.description) <= 200 ? ax.description : `${[...ax.description].slice(0, 200).join("")}… (inspect for all)`;
  return { id, name, ...(desc ? { description: desc } : {}), ...(ax.can.length ? { can: ax.can } : {}), ...(ax.state.length ? { state: ax.state } : {}), at: t.pos.map((n) => Math.round(n * 100) / 100),
    ...(live[id] && !live[id].resting ? { moving: live[id] } : {}),
    // stopped, its rest not logged yet: where the engine has it, said so (the record still has where it was thrown from)
    ...(live[id]?.resting ? { at: live[id].pos.map((n) => Math.round(n * 100) / 100), atRest: "where it came to rest; not yet on the record" } : {}), ...(holds[id] ? { heldBy: holds[id].by, heldAt: holds[id].pose.pos.map((n) => Math.round(n * 100) / 100), ...(holds[id].hand ? { heldIn: holds[id].hand } : {}) } : {}),
    ...(g ? { grab: describeGrab(g, typeof name === "string" ? name : id) } : {}),
    ...(actionsOf(st, id).length ? { actions: actionsOf(st, id) } : {}), ...socketsLine(st, id), ...(e.c.parent ? { in: e.c.parent.to } : {}), ...(lockedC(e.c) ? { lock: w ? { rank: lockStrength(w, st, id) } : true } : {}), ...(e.c.openable && typeof e.c.openable === "object" ? { openable: e.c.openable } : {}),
    ...sayOf(st, e.c) };
}
const socketsLine = (st, id) => { const socks = socketsOf(st, id).filter((x) => x.id); return socks.length ? { sockets: socks.map((x) => ({ id: x.id, name: x.name, as: socketRole(st.entities[x.id].c) })) } : {}; };
// what its words and media say (shared/says.js, the same lines mcpl's look prints); things it names by their names
const sayOf = (st, c) => { const lines = saysOf(c, { nameOf: (x) => (st.entities[x] ? st.entities[x].c.label ?? modelOf(st.entities[x].c.model)?.label ?? x : said(x)), now: CTX.mintW?.now?.() ?? null });
  return lines.length ? { says: lines } : {}; };

const READ_VERBS = {
  help(w, actor, a) {
    if (a?.verb && Object.hasOwn(REMOVED_VERBS, a.verb)) return { ok: false, refused: { code: "no-detail", reason: `'${a.verb}' was removed: ${REMOVED_VERBS[a.verb].why}`, fix: REMOVED_VERBS[a.verb].fix } };
    if (a?.verb) return verbHelp(a.verb) ? { ok: true, ...verbHelp(a.verb) } : { ok: false, refused: { code: "no-detail", reason: `no detailed help for '${a.verb}' yet`, fix: `detailed: ${Object.keys(VERBSPEC).join(", ")}` } };
    const st = w.exists ? w.state() : null; const role = st ? roleOf(st, actor) : null; const eff = st ? effective(st, actor) : null;
    return { ok: true, world: st?.entities?.["@world"]?.c.about, you: { id: actor, role, ...(eff ? { rank: eff.rank, permissions: eff.permissions } : {}) },
      verbs: { read: ["look", "inspect {id}", "measure {id}", "find {kind: 'model'|'blueprint', query?}", "lint {id?}", "history {id?, limit?, before?, after?, verbs?}", "schema {component?}"],
        world: ["create-world {title, text?} — found this world if it doesn't exist (you become its owner)"],
        write: ["create {model?, components?, id?: '$name'} | {from: <blueprint hash | a thing to duplicate>, at?} — the authority mints ids; a '$name' placeholder names the new thing within one request (the reply's ids map it)", "set {id, component, value, merge?}", "delete {id} | {id, component}",
          "place {id, on|beside|hang|against|near|at, facing?, height?, along?, level?, offset?, side?, gap?, attach?}", "turn {id, axis, deg, space?: object|parent|world, about?: pivot|origin}", "batch {requests: [{verb, args}…], label?}", "use {id, action?, args?}", "say {text, to?}",
          "undo {label?|act?}: a bare undo takes back your latest change (a redo first); the reply names what it undid", "publish {from, name}", "update {copy, to, resolve?}"],
        people: ["warn {who, reason}", "mute {who, minutes, channels?: ['voice','chat'], reason?} / unmute {who}", "kick {who, reason?} (out now; they may come straight back: a ban keeps someone out)", "ban {who, days?, reason?} (leave days out for until lifted) / unban {who}",
          "modlog {who?, before?, limit?}", "bans {}", "who may: your permissions (you.permissions); act only on ranks below yours"],
        scripts: ["upload {text} → src (JavaScript; docs/guide/SCRIPTS.md)", "set {id, component: 'script:<name>', value: {src, scope, on, every?, knobs?}}", "scripts {id?} — what runs here and why not", "scripts {id, script, test: {on: 'use'}} — a dry run", "adopt {id, script, base?} — become a dormant script's sponsor"],
        body: ["move {to: [x, y, z]}", "grab {id, hand?, grip?}", "put {id, pos?}", "throw {id, v: [x, y, z], pos?}", "drop {id, pos?, hand?}", "use {id} while holding it: its grabbable.use (args {phase: 'up'} for the release)", "punt {id, power? | v?}", "leave", "wait"],
        physics: "the world runs physics when @world has a physics-engine component: set {id: '@world', component: 'physics-engine', value: {engine: 'eidosim@1.0.0'}} (owner). A thing can be picked up when it has a grabbable component (schema {component: 'grabbable'}: who may, grips, where it goes when let go, use while held), or physics {kind: 'dynamic', who?}. Grabbable makes it carryable; physics makes it fall", every_write: "may add dry: true to preview (not say, nor the body and people verbs: move, grab, put, throw, drop, punt, drive, warn, mute, kick, ban), expect: [{id, component, value?}] to be refused (code changed) if any of those isn't what you started from, and throughLock: true to act through a lock you may remove (§7: a lock stops accidents and binds everyone, its locker included)", details: "help {verb: 'place'} (or create, set, delete, use, grab, put, throw, punt) shows every argument with its type and an example" },
      world: st?.entities?.["@world"]?.c.about ?? { name: w.name } };
  },
  look(w, actor, a) {
    const st = w.state(); const ids = Object.keys(st.entities).filter((k) => k !== "@world" && !st.entities[k].c.parent);
    const lim = a.limit ?? 40;
    const live = enginePoses(w.sim());
    // the tree through the index's children map; only what's shown is described (else look is O(N²) on a big world)
    // a socket is listed with its host (describe's sockets), not as a thing; what sits in it shows at its place
    const kids = kidsMap(st); const order = []; const tree = (id, d, n = 0) => { if (n > 64) return; const sock = isSocketC(st.entities[id]?.c); if (!sock) order.push([id, d]); for (const k of kids.get(id) ?? []) tree(k, sock ? d : d + 1, n + 1); };
    ids.forEach((id) => tree(id, 0));
    const all = order.slice(0, lim).map(([id, d]) => ({ ...describe(st, id, live, w.presence.holds, { w }), depth: d })); const total = order.length;
    // consent is each person's own: a viewer sees THEIR table, and who poses, drags or touches them; of anyone else only
    // where they stand, plus what the viewer is doing to them (showing another's table would undo the uniform refusal
    // words, and who touches whom is nobody else's business)
    const P = w.presence; const bodies = Object.entries(P.bodies).map(([id, b]) => ({ id, at: b.at,
      ...(id === actor ? { shield: shieldOf(P, id) } : {}),
      ...(b.poseBy && (id === actor || b.poseBy === actor) ? { posedBy: b.poseBy } : {}), ...(b.draggedBy && (id === actor || b.draggedBy === actor) ? { draggedBy: b.draggedBy } : {}),
      touchedBy: Object.entries(P.reaches ?? {}).filter(([k, r]) => r.to === id && (id === actor || k === actor)).map(([k]) => k) }));
    return { ok: true, things: all.slice(0, lim), ...(total > lim ? { truncated: true, total } : {}), bodies };
  },
  inspect(w, actor, a) {
    const st = w.state(); const e = st.entities[a.id];
    if (!e) return { ok: false, refused: { code: "not-found", reason: `no '${a.id}'`, didYouMean: guess(String(a.id), Object.keys(st.entities)) } };
    const piv = e.c.motion?.type === "pendulum" ? pivotOf(st, a.id) : undefined;
    // the ground's sculpted tiles (up to 1024 on @world, 1024 samples each) are said in a line apiece, and their versions and
    // last touch aren't worked out: nobody writes a tile against a base
    const keys = Object.keys(e.c).filter((k) => !k.startsWith("terrain-tile:")), said = Object.fromEntries(Object.entries(e.c).map(([k, v]) => [k, tileSaid(k, v)]));
    return { ok: true, ...describe(st, a.id, enginePoses(w.sim()), w.presence.holds, { full: true, w }), born: e.born, components: said, versions: Object.fromEntries(keys.map((k) => [k, versionOf(w, lastTouch(w, a.id, k)?.seq)])), touched: touchedOf(w, a.id, keys), world: worldT(st, a.id),
      derived: { madeBy: madeBy(w, a.id), ...(piv !== undefined ? { pivot: piv } : {}), ...(modelOf(e.c.model)?.credits ? { asset: modelOf(e.c.model).credits } : {}) },
      children: Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === a.id), ...offersFor(st, a.id, actor), yourRole: roleOf(st, actor) };
  },
  measure(w, actor, a) {
    const st = w.state(); const b = aabb(st, a.id); if (!b) return { ok: false, refused: { code: "no-model", reason: `${a.id} has no model or mesh to measure` } };
    const t = worldT(st, a.id);
    return { ok: true, id: a.id, bounds: { min: b.min.map(r3), max: b.max.map(r3) }, size: b.max.map((v, i) => r3(v - b.min[i])),
      front: qrot(t.q, [0, 0, 1]).map(r3), surfaces: surfacesOf(st, a.id).map((s) => ({ level: s.level, y: r3(s.y), ...surfaceSize(s) })) };
  },
  find(w, actor, a) {
    const q = (a.query ?? "").toLowerCase();
    if (a.kind === "blueprint") { const lib = w.state().entities["@world"]?.c ?? {};
      return { ok: true, blueprints: Object.entries(lib).filter(([k]) => k.startsWith(BLUEPRINTS)).map(([k, v]) => ({ hash: `sha256:${k.slice(BLUEPRINTS.length)}`, ...v, by: creatorOf(w, "@world", k)?.rights ?? null })).filter((b) => String(b.name ?? "").toLowerCase().includes(q)) }; }
    return { ok: true, models: CTX.cat.list(q).slice(0, 50).map(([k, m]) => ({ model: k, ...(m.size ? { size: m.size } : { size: null, note: "not measured here" }), about: m.label, surfaces: (m.surfaces ?? []).map((s) => s.y) })) };
  },
  lint(w, actor, a) { const st = w.state(); const ids = a.id ? [a.id] : Object.keys(st.entities);
    return { ok: true, warnings: [...warnings(st, ids, true), ...danglingRefs(st, ids)] }; },
  history(w, actor, a) {
    // one thing's history, newest first, paged backwards (recent by default, deeper on request): before = the seq
    // to continue from (the reply's `next`), limit = how many acts per page
    if (a.id != null) {
      if (a.verbs !== undefined || a.after !== undefined) refuse("shape", "one thing's history pages back with before only", "leave id out to filter the whole log by verbs, or page it with after");
      const id = String(a.id); const lim = Math.max(1, Math.min(50, a.limit ?? 5)); const before = a.before ?? Infinity; const out = [];
      let next = null;
      for (const i of backward(w, id)) { if (i >= before) continue; const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
        const ops = opsTouching(e, id); if (!ops.length) continue;
        if (out.length === lim) { next = out.at(-1).seq; break; }
        const act = Number.isInteger(e.cause) ? w.entries[e.cause] : null;
        // an imported act reads as what it was (spawn, place, comp), never "imported"
        out.push({ seq: i, by: e.actor, who: said(e.actor), ts: e.ts, verb: (isE(act) && act.kind === "request" ? (act.verb === "imported" && typeof act.body?.verb === "string" ? act.body.verb : act.verb) : null) ?? ops[0].op,
          changed: [...new Set(ops.map((o) => o.op === "create" ? "(created)" : o.op === "delete" && o.comp === undefined ? "(deleted)" : o.comp))],
          ...(() => { const d = historyDiff(w, id, i, ops); return d ? { diff: d } : {}; })(),
          ...(isE(act) && readback(w, e.cause)?.undoes !== undefined ? { undoes: readback(w, e.cause).undoes } : {}), ...(Number.isInteger(e.cause) ? { act: e.cause } : {}) }); }
      return { ok: true, id, entries: out, ...(next !== null ? { next, more: "send the same with before: next for older" } : {}) };
    }
    // the whole world's log, a page at a time. verbs
    // matches an entry's verb or kind, and an imported act's original verb (its body names it); before/after page by seq
    if (a.verbs !== undefined && !(Array.isArray(a.verbs) && a.verbs.length <= 32 && a.verbs.every((v) => typeof v === "string"))) refuse("shape", "verbs is a list of verb names (at most 32)", "e.g. history {verbs: ['set', 'use']} — an imported entry matches its original verb too ('comp', 'mount')");
    if (a.before !== undefined && a.after !== undefined) refuse("shape", "page one way: before or after, not both", "before: older than that seq (the reply's next); after: newer than it");
    const lim = Math.max(1, Math.min(200, a.limit ?? 12)); const vs = a.verbs?.length ? new Set(a.verbs) : null;   // [] = no filter
    // speech is arrival-only: a say from before the asker arrived leaves the page too, unless the host says they're
    // an admin (no floor). The log keeps every say; only an admin reads one back from before they came (storage.js sayFloor)
    const floor = typeof w.sayFloor === "function" ? w.sayFloor(actor) : null;
    const match0 = (e) => !vs || !isE(e) ? !vs : vs.has(e.verb) || vs.has(e.kind) || (e.verb === "imported" && vs.has(e.body?.verb));
    const match = (e, seq) => match0(e) && !(isE(e) && e.kind === "say" && floor !== null && !(seq > floor));
    const row = (e, seq) => isE(e) ? { seq, actor: e.actor, ts: e.ts, kind: e.kind, verb: e.verb, ...(e.cause !== undefined ? { cause: e.cause } : {}), body: e.kind === "request" || e.kind === "say" ? e.body : JSON.stringify(e.body).slice(0, 160) } : { seq, malformed: e.code };
    const out = []; let more = false;
    if (a.after !== undefined) { for (let i = Math.max(0, a.after + 1); i < w.entries.length; i++) { if (!match(w.entries[i], i)) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } }
    else { for (let i = Math.min(w.entries.length, a.before ?? Infinity) - 1; i >= 0; i--) { if (!match(w.entries[i], i)) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } out.reverse(); }
    return { ok: true, entries: out, ...(more ? a.after !== undefined ? { next: out.at(-1).seq, more: "send after: next for newer" } : { next: out[0].seq, more: "send before: next for older" } : {}) }; },
};
export { READ_VERBS };
