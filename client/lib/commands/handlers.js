// The behavior behind /commands — every branch of main.js's old
// bus.on('command') if-chain, registered into the pure registry (§14 6c).
// Each handler imports its own deps; chat.js never imports THIS file (only
// registry.js), or the cycle chat→handlers→net→chat closes.
//
// The kick and push disambiguators are each ONE handler doing its own
// entities/remotes checks — the old if-chain's fallthrough ORDER was
// semantic (things win the name lookup because they were here first), and
// it is preserved inside the handler bodies rather than across them.

import { CONFIG, bus, report } from '../base.js';
import { SHOVE_REACH } from '../../../shared/protocol/physconst.js';
import { CUSTOM_ID, isOwner } from '../../../shared/protocol/roles.js';
import { DOORS, doorOf, doorWrites, durationMs, leftWords } from '../../../shared/protocol/access.js';
import { actorName as actorLabel } from '../../../shared/protocol/names.js';
/** This world's @world components, from this client's own fold (roles, access, the default role). */
const worldComponents = () => replica.st?.entities?.['@world']?.c ?? {};
import { captureFrame } from '../capture.js';
import { register, dispatch } from './registry.js';
import { entities, worldHasOwner, bagOf } from '../world.js';
import { resolveThing, handleOf } from '../../../shared/thingref.js';
// a thing by what a person types (R 10-17: ids are minted and opaque): its id, its label, or a unique id prefix of 4+.
// A label two things share is refused with their handles, never resolved by picking one. {id} | {err} | null (nothing)
function thingNamed(word) {
  if (!word) return null;
  const r = resolveThing(word, [...entities.keys()].map((id) => ({ id, label: bagOf(id)?.label })));
  if (r.id) return { id: r.id };
  if (r.ambiguous) return { err: `"${word}" names ${r.ambiguous.length} things — say which (its handle works): ${r.ambiguous.slice(0, 6).map((t) => `${typeof t.label === 'string' ? `"${t.label}" ` : ''}#${handleOf(t.id, entities.keys())}`).join(', ')}` };
  return null;
}
import {
  net, replica, identityOf, sendMod, sendPuppet, sendWorldFork, sendWorldFound, sendWorldReset, requestDebug, sendRequest,
} from '../net.js';
import { remotes } from '../remotes.js';
import { serverNow, serverUntil } from '../serverclock.js';   // straight from the clock: through remotes.js this closes an import cycle and the re-export is unbound at load
import { myState, setPosture, flightReport } from '../controller.js';
import { punt as puntThing, grab, put, drop, throwHeld } from '../thingphysics.js';
import { logChat } from '../chat.js';
import { toggleHelp, flashHint } from '../ui.js';
import { sceneAttach, sceneDetach } from '../scenegraph.js';
import { ANIM_ORDER, ANIM_CLIPS } from '../avatar.js';
import { setPushable, pushable } from '../consent.js';
import { trySitOn } from '../localbody.js';
import { getMe } from '../mybody.js';
import { setMyReach, clearMyReach } from '../reachnet.js';
import { SIM_ID } from '../../../shared/sim.js';
import { send } from '../editwrites.js';   // roles, the door and moderation send record: false: they are not build edits, and Ctrl+Z must never revoke a grant or lift a ban
import * as OP from '../../../shared/protocol/requests.js';
import { canonicalPoint, CONTACT_POINTS } from '../../../shared/contact.js';
import { TOUCH_GAP } from '../../../shared/reachwire.js';
import { panelAlpha, setPanelAlpha } from '../stylepanel.js';

register('help', () => toggleHelp());
// Flight's own diagnostic, in the chat log where a person can read it and
// paste it back. See controller.js flightReport() for why this is not just
// the console probe.
register('flight', () => { for (const line of flightReport().split('\n')) logChat('*', line); });

// Panel opacity — the glass escape hatch. Adaptive translucency fails over
// bright scenes (Apple shipped "Tinted" after the Liquid Glass backlash);
// this is our version of that lesson, one number, user-owned, persisted.
register('panels', (arg) => {
  const v = parseFloat(arg);
  if (!(v >= 0.3 && v <= 1)) return logChat('*', `usage: /panels <0.3–1> — desktop panel opacity (current ${panelAlpha().toFixed(2)})`);
  setPanelAlpha(v);
  logChat('*', `panels at ${Math.round(v * 100)}% opacity`);
});

// Eyelids are BONES on rigs that have them (L_/R_Eyelid_Upper) — most VRMs
// blink with a blendshape instead and have none, so this says so plainly
// rather than appearing to work. Local: your eyes are yours to close, and
// nothing about them is on the wire yet.
register('eyes', (arg) => {
  const me = getMe();
  const want = /^(close|closed|shut)$/i.test((arg || '').trim()) ? true
    : /^(open|up)$/i.test((arg || '').trim()) ? false
      : null;
  if (!me?.setEyes) return logChat('*', 'no body to close the eyes of');
  const shut = want === null ? !me._eyesGoal : want;
  if (!me.setEyes(shut)) return logChat('*', 'this body has no eyelid bones — nothing to close');
  logChat('*', shut ? 'you close your eyes' : 'you open your eyes');
});

/** Who a typed name is here, through the world's own lookup (the server's directory, scoped to the people this world
 *  has seen): {id, name, declares?, guest?, imported?, role, here, banned}[]. Someone present answers from the roster without asking. */
export async function lookupPerson(name) {
  const id = identityOf(name);
  const r = await sendRequest('whois', { name: id ?? name });
  return r?.ok ? r.people ?? [] : null;
}
const personLine = (p) => `${p.name}: ${p.role}${p.guest ? ' (a guest)' : ''}${typeof p.declares === 'string' ? ` (declares ${p.declares})` : ''}${p.here ? '' : ', not here now'}${p.banned ? ', banned' : ''}`;
/** One identity for a typed name, or a chat line saying why not (nobody / several). */
async function onePerson(name, what) {
  const id = identityOf(name); if (id) return id;
  const ppl = await lookupPerson(name);
  if (ppl === null) { logChat('*', `couldn't look up ${name} just now — try again`); return null; }
  if (!ppl.length) { logChat('*', `nobody called "${name}" has been in this world — a ${what} goes to someone it knows`); return null; }
  if (ppl.length > 1) { logChat('*', `${ppl.length} people here have gone by "${name}": ${ppl.map((p) => `${p.id} (${p.role}${p.here ? ', here' : ''})`).join('; ')} — /${what} <id> picks one`); return null; }
  return ppl[0].id;
}

register('role', (arg) => {
  // the DOOR's role (it's what admits writes): your own comes with your rights; anyone else's from the world's lookup,
  // present or not (roles are keyed by identity, never by name)
  const who = (arg || '').trim();
  if (!who || who === CONFIG.name) {
    const r = net.myRights;
    if (!r) return logChat('*', 'not in a world yet');
    if (!worldHasOwner()) return logChat('*', `you: ${r.role} — this world has no owner, so nobody builds here until someone owns it`);
    return logChat('*', `you: ${r.role}${!r.permissions?.includes('build') ? ' — you can look, talk and use things; an owner can make you a builder' : ''}`);
  }
  lookupPerson(who).then((ppl) => {
    if (ppl === null) return logChat('*', `couldn't look up ${who} just now — try again`);
    if (!ppl.length) return logChat('*', `nobody called "${who}" has been in this world`);
    for (const p of ppl) logChat('*', personLine(p));
  });
});

register('grant', (arg) => {
  // /grant <name> <role> [+gen|-gen] [+fly|-fly] [for 2h|forever] — a role is any role this world has (inhabitant, builder,
  // moderator, owner, or one its owner defined); +gen/+fly are per-person exceptions (roles:<id>.can.generate / .fly,
  // research roles S5); `for <duration>` ends the grant then (roles:<id>.until; 30m, 2h, 1d, 1w), `forever` clears an end
  // (upstream #258). The authority decides: owners grant anything, a grantRoles holder only roles ranked below their own,
  // with permissions they hold; ownership never ends by itself.
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const id = parts[0];
  const forAt = parts.findIndex((p, i) => i > 0 && p.toLowerCase() === 'for');
  const durWord = forAt > 0 ? parts.slice(forAt + 1, forAt + 3).join(' ').match(/^\d+(?:\.\d+)?\s*[a-z]+/i)?.[0] : undefined;
  const dur = durWord ? durationMs(durWord) : null;
  const forever = parts.some((p, i) => i > 0 && /^(forever|permanent|permanently)$/i.test(p));
  if (forAt > 0 && !dur) return logChat('*', 'for wants a duration: 30m, 2h, 1d or 1w (at most a year)');
  const words = new Set(['for', 'forever', 'permanent', 'permanently', ...(durWord ? durWord.toLowerCase().split(/\s+/) : [])]);
  const role = parts.slice(1).map((p) => p.toLowerCase()).find((p) => CUSTOM_ID.test(p) && !words.has(p));
  const flag = (k) => { const f = parts.find((p) => p === `+${k}` || p === `-${k}`); return f === undefined ? undefined : f[0] === '+'; };
  const gen = flag('gen'), fly = flag('fly');
  if (!id || (!role && gen === undefined && fly === undefined && !dur && !forever)) {
    return logChat('*', 'usage: /grant <name> <role> [+gen] [+fly] [for 2h|forever] — roles: inhabitant, builder, moderator, owner, or one this world defines; /grant * <role> for everyone who signed in');
  }
  const can = gen !== undefined || fly !== undefined ? { ...(gen !== undefined ? { generate: gen } : {}), ...(fly !== undefined ? { fly } : {}) } : null;
  // * = the world's newcomer role for people who signed in (guests stay inhabitants unless the world opts in)
  if (id === '*') {
    if (isOwner({ role })) return logChat('*', 'everyone can\'t be an owner — /grant * builder or /grant * inhabitant');
    if (dur || forever) return logChat('*', 'the world\'s default role never expires — /access invite-only|watch closes a world instead');
    if (!role) return logChat('*', 'usage: /grant * <role> (exceptions like +fly go to one person)');
    // merge: the default role also carries the world's guest opt-in (guests) and gen, which /grant * must not wipe
    send({ verb: 'set', args: { id: '@world', component: 'default-role', value: { role }, merge: true } }, { what: `make everyone ${role}`, record: false });
    return;
  }
  // a role goes to the person's IDENTITY (the u-… id the world knows them by), never to a typed name
  onePerson(id, 'grant').then((who) => { if (!who) return;
    const cur = worldComponents()[`roles:${who}`];
    // a time or exceptions alone change a grant, so there must be one: a role-less record is refused by the authority (I42)
    if (!role && !cur) return logChat('*', `${id} holds no role here to ${dur || forever ? 'time' : 'add exceptions to'} — /grant ${id} <role>${dur ? ` for ${durWord}` : ''}`);
    // the whole grant, changed only where the command says (house review I6: a new role kept neither the person's
    // exceptions nor their end): a new duration replaces the end, forever drops it (a set, not a merge: a merge can't
    // remove a field), and new exceptions join the old ones
    // an owner's grant never ends: the authority refuses an owner with an end, so none is kept or sent
    if (isOwner(role) && dur) return logChat('*', `ownership never expires — /grant ${id} owner, without a time`);
    const { until: was, ...rest } = cur ?? {};
    const until = forever || isOwner(role) ? undefined : dur ? serverUntil(dur) : was;
    const exceptions = can || rest.can ? { ...(rest.can ?? {}), ...(can ?? {}) } : null;
    const value = { ...rest, ...(role ? { role } : {}), ...(exceptions ? { can: exceptions } : {}), ...(until !== undefined ? { until } : {}) };
    send({ verb: 'set', args: { id: '@world', component: `roles:${who}`, value } },
      { what: `${role ? `make ${id} ${role}` : forever ? `make ${id}'s grant permanent` : dur ? `time ${id}'s grant` : `change ${id}'s exceptions`}${dur ? ` for ${durWord}` : ''}`, record: false }); });
});

// /revoke <name> — take back someone's role: they hold this world's default role again (in a world that admits only
// people listed, that means they may not come in, and the door removes them).
register('revoke', (arg) => {
  const id = (arg || '').trim();
  if (!id) return logChat('*', 'usage: /revoke <name>');
  onePerson(id, 'revoke').then((who) => { if (!who) return;
    if (!worldComponents()[`roles:${who}`]) return logChat('*', `${id} holds no role here — nothing to take back`);
    send({ verb: 'delete', args: { id: '@world', component: `roles:${who}` } }, { what: `take back ${id}'s role`, record: false }); });
});

// /access [invite-only|watch|public|open] — who may come into this world (@world.access and default-role; the four doors of
// shared/protocol/access.js DOORS). No argument: show it, and who is listed. Owner-only to change; the authority decides.
register('access', (arg) => {
  const a = (arg || '').trim().toLowerCase();
  if (!a) return showMembers();
  const door = { 'invite-only': 'invite-only', invite: 'invite-only', private: 'invite-only', closed: 'invite-only', listed: 'invite-only', watch: 'watch', spectators: 'watch',
                 public: 'public', inhabitants: 'public', open: 'open', builders: 'open' }[a];
  if (!door) return logChat('*', 'usage: /access invite-only|watch|public|open — or /access to see who can come in');
  const ws = doorWrites(door, worldComponents());
  const ops = ws.map((w) => ({ verb: 'set', args: { id: '@world', component: w.component, value: w.value } }));
  send(ops.length === 1 ? ops[0] : { verb: 'batch', args: { ops } }, { what: `make this world ${door === 'invite-only' ? 'invite-only' : door === 'watch' ? 'watch only' : door}`, record: false });
});
register('members', () => showMembers());
/** Who may come into this world, and until when: the door (shared/protocol/access.js) and everyone listed, from this
 *  client's own fold. */
function showMembers() {
  const wc = worldComponents(), now = serverNow();
  const door = doorOf(wc);
  const rows = Object.entries(wc).filter(([k, v]) => k.startsWith('roles:') && v && typeof v === 'object')
    .map(([k, v]) => `${actorLabel(k.slice(6))} — ${v.role}${Number.isSafeInteger(v.until) ? ` (${leftWords(v.until, now)})` : ''}`);
  logChat('*', `who can come into "${CONFIG.world}": ${door === 'signed-in' ? 'anyone signed in' : DOORS[door]}${rows.length ? `\n${rows.join('\n')}` : '\nnobody is listed by name'}`);
}

// /kick <name> [reason…], /ban <name> [days|forever] [reason…], /mute <name> [minutes] [voice|chat] [reason…],
// /warn <name> <reason…>: the authority enforces the permission and the rank (only below you);
// everyone else is told "A removed B" by the server. A kick takes someone out now (they must be here, and may come straight back); the others also
// reach someone who has left (the world's lookup).
function moderate(cmd, arg) {
  const [id, ...rest0] = (arg || '').trim().split(/\s+/).filter(Boolean);
  const USAGE = { kick: '<name> [reason] (they may come straight back; /ban keeps someone out)', ban: '<name> [days | forever] [reason]', mute: '<name> [minutes, default 60] [voice|chat] [reason]', warn: '<name> <reason>' };
  if (!id) return logChat('*', `usage: /${cmd} ${USAGE[cmd]}`);
  let rest = rest0.slice(); const args = {};
  const num = () => (rest.length && /^\d+(\.\d+)?$/.test(rest[0]) ? Number(rest.shift()) : undefined);
  if (cmd === 'kick') { const m = num(); if (m !== undefined) args.minutes = m; }   // the authority refuses a length, pointing at ban
  if (cmd === 'ban') { if (rest[0] === 'forever') rest.shift(); else { const d = num(); if (d !== undefined) args.days = d; } }
  if (cmd === 'mute') args.minutes = num() ?? 60;
  if (cmd === 'mute' && (rest[0] === 'voice' || rest[0] === 'chat')) args.channels = [rest.shift()];
  if (rest.length) args.reason = rest.join(' ');
  if (cmd === 'warn' && !args.reason) return logChat('*', `usage: /warn ${USAGE.warn} — a warning says why`);
  const go = (who) => send({ verb: cmd, args: { who, ...args } }, { what: `${cmd} ${id}`, record: false });
  if (cmd === 'kick') { const who = identityOf(id); return who ? go(who) : logChat('*', `${id} isn't here to remove — /ban keeps someone away`); }
  onePerson(id, cmd).then((who) => { if (who) go(who); });
}
register('mute', (arg) => moderate('mute', arg));
register('warn', (arg) => moderate('warn', arg));
for (const verb of ['unmute']) register(verb, (arg) => { const id = (arg || '').trim();
  if (!id) return logChat('*', `usage: /${verb} <name>`);
  onePerson(id, verb).then((who) => { if (who) send({ verb: verb, args: { who } }, { what: `${verb} ${id}`, record: false }); }); });

// /kick is MODERATION, solidly (tel0s ruling, playtest 2026-08-31). The old
// one-word-two-acts overload sent a typo'd object name into the moderation
// path and made "kick the barrel" and "kick the visitor" the same word for
// two very different acts. /punt owns the physics wholly now — and gained
// the fun half: punting a PERSON is the consented ragdoll shove (their
// client owns their body and decides, exactly as /push).
register('kick', (arg) => moderate('kick', arg));
register('punt', (arg) => {
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((x) => !/^[\d.]+$/.test(x));
  // things win the name lookup (they were here first); a person's name is
  // the shove. No name at all = the object kick's nearest-thing search.
  if (named && !entities.has(named) && remotes.has(named)) {
    const pow = Math.min(4, Math.max(0.5, parseFloat(parts.find((x) => /^[\d.]+$/.test(x))) || 2.6));
    shovePerson(named, pow, 'punt');
    return;
  }
  puntThing(arg);
});
// carrying (requests; T and C are the keys)
register('grab', (arg) => grab((arg || '').trim() || undefined));
register('put', (arg) => put((arg || '').trim() || undefined));
register('drop', (arg) => drop((arg || '').trim() || undefined));
register('throw', (arg) => throwHeld(arg));
register('ban', (arg) => moderate('ban', arg));

// /epoch [tickMs] (/physics) — run physics in this world: set @world.physics-engine (design 20 P4). Owner-ranked: the authority
// refuses below owner and refuses an engine this server doesn't carry; it stamps the build and every thing's shape.
register('epoch', (arg) => {
  const a = (arg || '').trim();
  // /epoch off — stop physics (explicit, never a toggle): the authority refuses while anything is in flight (P6: a cut
  // waits for rests). Owners only; the world refuses or announces.
  if (/^(off|leave|exit|none)$/i.test(a)) {
    send(OP.unset('@world', 'physics-engine'), { what: 'leave the physics epoch' });
    logChat('*', 'asked the world to turn physics off — refused while anything is in flight (owners only; the world will refuse or announce)');
    return;
  }
  const tickMs = Math.round(Number(a)) || 66;
  send(OP.set('@world', 'physics-engine', { engine: SIM_ID, tickMs }), { what: 'enter the physics epoch' });
  logChat('*', `asked the world to run ${SIM_ID} at a ${tickMs}ms tick — throws and punts fly, and the log records where they rest (owners only; the world will refuse or announce)`);
});

register('unban', (arg) => {
  const id = (arg || '').trim();
  if (!id) return logChat('*', 'usage: /unban <name>');
  onePerson(id, 'unban').then((who) => { if (who) send({ verb: 'unban', args: { who } }, { what: `unban ${id}`, record: false }); });
});

// /bans: what is in force here now — bans and mutes — from the authority's `bans` (the
// Moderation panel's source). The legacy world-bans message listed bans only, so a mute in force read "nobody is banned"
// (audit 10-07). Moderators may ask; the authority says so to anyone else.
register('bans', async () => {
  const r = await sendRequest('bans', {});
  if (!r?.ok) return logChat('*', r?.refused?.reason ?? "couldn't read what's in force here");
  const now = r.now ?? [];
  const until = (t) => (Number.isFinite(t) ? `until ${new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'until lifted');
  const why = (x) => (x?.reason ? ` — ${x.reason}` : '');
  const lines = [];
  for (const x of now) {
    const who = x.name ?? x.who;
    if (x.ban) lines.push(`banned: ${who} ${until(x.ban.until)}${why(x.ban)}`);
    if (x.mute) lines.push(`muted (${(x.mute.channels ?? ['voice', 'chat']).join(' + ')}): ${who} ${until(x.mute.until)}${why(x.mute)}`);
  }
  if (!lines.length) return logChat('*', 'nobody is banned or muted here');
  for (const l of lines) logChat('*', l);
});

// global moderation — server operators only, the server enforces
function moderateGlobal(cmd, arg) {
  const [id, ...rest] = (arg || '').trim().split(/\s+/).filter(Boolean);
  if (!id) return logChat('*', `usage: /${cmd} <name>${cmd === 'gban' ? ' [reason] — bans from every world on this server' : ''}`);
  sendMod(cmd === 'gban' ? 'global-ban' : 'global-unban', { id, ...(rest.length ? { reason: rest.join(' ') } : {}) });
}
register('gban', (arg) => moderateGlobal('gban', arg));
register('gunban', (arg) => moderateGlobal('gunban', arg));
register('gbans', () => sendMod('global-bans'));

register('push', (arg) => {
  // /push [name] [power] — a REQUEST to the target's client, which owns the
  // body and decides (pushable). Range-gated here out of honesty, not
  // security: a shove is an arm's reach, and the receiver caps magnitude
  // anyway. No name = the nearest person within reach.
  const REACH = SHOVE_REACH;
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((p) => !/^[\d.]+$/.test(p));
  // one word, two acts: /push swing1 is the swing's use-reaction (the old
  // alias, kept working), /push bob is a shove. Things win the name lookup
  // because they were here first; /shove is always the person verb.
  { const t = thingNamed(named); if (t?.err) return logChat('*', t.err); if (t) { send(OP.use(t.id, 'push'), { what: `push ${named}` }); return; } }
  const pow = Math.min(4, Math.max(0.5, parseFloat(parts.find((p) => /^[\d.]+$/.test(p))) || 2.2));
  let target = named ?? null;
  if (!target) {
    let bestD = REACH;
    for (const [id, r] of remotes) {
      if (!r.avatar) continue;
      const d = Math.hypot(r.avatar.root.position.x - myState.pos.x, r.avatar.root.position.z - myState.pos.z);
      if (d < bestD) { bestD = d; target = id; }
    }
    if (!target) return logChat('*', 'nobody within reach to push');
  }
  shovePerson(target, pow, 'push');
});

/** The person-shove, shared by /push and /punt: a REQUEST to the target's
 *  client, which owns the body and decides (pushable). Range-gated here out
 *  of honesty, not security — the receiver caps magnitude anyway. */
function shovePerson(target, pow, word) {
  const REACH = SHOVE_REACH;
  const r = remotes.get(target);
  if (!r?.avatar) return logChat('*', `${target} isn't here to ${word}`);
  const tp = r.avatar.root.position;
  const d = Math.hypot(tp.x - myState.pos.x, tp.z - myState.pos.z);
  if (d > REACH) return logChat('*', `${target} is too far away to ${word} (${d.toFixed(1)}m)`);
  // straight through the target from where I stand; face-to-face at zero
  // distance falls back to the way I'm facing
  const nx = d > 0.05 ? (tp.x - myState.pos.x) / d : Math.sin(myState.yaw);
  const nz = d > 0.05 ? (tp.z - myState.pos.z) / d : Math.cos(myState.yaw);
  sendPuppet(target, { ragdoll: { lean: [nx * pow, 0, nz * pow] } });
  logChat('*', word === 'punt' ? `you punt ${target} — they go flying (their client willing)` : `you push ${target}`);
}

// ---- /touch — the human hand on the reach surface (shared/reachwire.js).
// The same descriptor an agent's `reach` tool streams: every client
// re-solves it, the arm tracks the person, and THEY hear about it (a
// "reaches toward you" line, then a "rests on" line when the hand lands).
const LIMB_WORD = { leftHand: 'left hand', rightHand: 'right hand', leftFoot: 'left foot', rightFoot: 'right foot' };
const pointOf = (words) => {
  const joined = words.join(' ');
  if (!joined) return null;
  if (/^head$/i.test(joined)) return 'head_top';   // the one name canonicalPoint can't guess
  return canonicalPoint(joined);
};

register('touch', (arg) => {
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  // a person's name may lead; resolve it among those present (or yourself)
  let who = null, rest = parts;
  if (parts.length) {
    const first = parts[0].toLowerCase();
    if (first === 'me' || first === 'self' || first === CONFIG.name.toLowerCase()) {
      who = CONFIG.name; rest = parts.slice(1);
    } else {
      const hit = [...remotes.keys()].find((id) => id.toLowerCase() === first);
      if (hit) { who = hit; rest = parts.slice(1); }
    }
  }
  // your hand rides at the END ("/touch bob shoulder left") — and "left" is
  // only a hand when the words before it still name a point without it, so
  // "/touch bob left shoulder" keeps meaning the shoulder
  let limb = 'rightHand';
  let words = rest;
  const last = rest[rest.length - 1]?.toLowerCase();
  if (last === 'left' || last === 'right') {
    const before = rest.slice(0, -1);
    if (before.length === 0 || pointOf(before)) {
      limb = last === 'left' ? 'leftHand' : 'rightHand';
      words = before;
    }
  }
  const point = words.length ? pointOf(words) : 'shoulder_l';
  if (!point) {
    // an unresolved first word is at least as likely a name as a point —
    // say both, or an absent person masquerades as a bad landmark
    if (!who && parts.length) {
      return logChat('*', `nobody here called "${parts[0]}" (and no contact point by that name) — /who lists people; points: ${Object.keys(CONTACT_POINTS).join(', ')}`);
    }
    return logChat('*', `no contact point called "${words.join(' ')}" — try: ${Object.keys(CONTACT_POINTS).join(', ')}`);
  }
  if (!who) {
    // nearest person — the reach tracks, so a few metres is a fine start
    let bestD = 6;
    for (const [id, r] of remotes) {
      if (!r.avatar) continue;
      const d = Math.hypot(r.avatar.root.position.x - myState.pos.x, r.avatar.root.position.z - myState.pos.z);
      if (d < bestD) { bestD = d; who = id; }
    }
    if (!who) return logChat('*', 'nobody nearby to touch — /touch <name> works from farther away');
  }
  if (who !== CONFIG.name && !remotes.get(who)?.avatar) return logChat('*', `${who} isn't here (or still loading)`);
  const err = setMyReach(limb, { who, point });
  if (err) return logChat('*', err);
  const whose = who === CONFIG.name ? 'your own' : `${who}'s`;
  logChat('*', `you reach for ${whose} ${point} (${LIMB_WORD[limb]})…`);
  // The solve runs in the frame loop; read after the initial weight blend.
  setTimeout(() => {
    const s = getMe()?.reachStatus?.()?.[limb];
    if (!s || !Number.isFinite(s.gap)) return;
    if (s.gap <= TOUCH_GAP) {
      logChat('*', `…your ${LIMB_WORD[limb]} reaches ${whose} ${point} (endpoint gap ${Math.round(s.gap * 1000)}mm) — tracking continues until /letgo`);
    } else {
      logChat('*', `…${s.gap.toFixed(2)}m short${s.bound?.length ? ` (${s.bound.join(', ')})` : ''} — the arm stays reaching; step closer and it will land`);
    }
  }, 600);
});

register('letgo', (arg) => {
  const v = (arg || '').trim().toLowerCase();
  const limb = v === 'left' ? 'leftHand' : v === 'right' ? 'rightHand' : null;
  clearMyReach(limb);
  logChat('*', limb ? `you lower your ${LIMB_WORD[limb]}` : 'you let go');
});
register('pushable', (arg) => {
  const v = (arg || '').trim().toLowerCase();
  if (v === 'on' || v === 'off') setPushable(v === 'on');
  return logChat('*', `shoves and blasts ${pushable() ? 'CAN' : 'can NOT'} knock you over${v ? '' : ' — /pushable on|off to change'}`);
});

register('fork', (arg) => {
  // /fork <new-name> — copy this world as it stands now into a new one (owner-only, the server enforces). Its chat and
  // history stay here: the copy's founding act names this world. The reply arrives as a world-forked message.
  const to = (arg || '').trim();
  if (!to) return logChat('*', 'usage: /fork <new-name> — copies this world into a new one');
  if (!/^[a-z0-9_-]{1,64}$/i.test(to)) return logChat('*', `"${to}" won't do as a world name — letters, digits, - and _ only`);
  sendWorldFork(to);
});

register('newworld', (arg) => {
  // /newworld <name> [title…] — found a new, empty world that you own (a signed-in account; no quotas, R 10-28).
  // The reply arrives as world-founded, with the link.
  const [name, ...rest] = (arg || '').trim().split(/\s+/);
  if (!name) return logChat('*', 'usage: /newworld <name> [title] — founds a new, empty world that you own');
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(name)) return logChat('*', `"${name}" won't do as a world name — 3 to 32 lowercase letters, digits and -`);
  sendWorldFound(name, rest.join(' ') || undefined);
});

register('reset', (arg) => {
  // /reset alone only tells you what it would do; erasing a world takes
  // typing its own name back. The server checks the same confirmation.
  const confirm = (arg || '').trim();
  if (confirm !== CONFIG.world) {
    return logChat('*', `this erases "${CONFIG.world}" back to zero — everything built and said here goes to the archive. `
      + `if you mean it: /reset ${CONFIG.world}`);
  }
  sendWorldReset();
});

register('debug', (arg) => {
  // /debug [n] — why things bounced: denials, rejections, rate limits,
  // reaction outcomes. The log says what happened; this says why it didn't.
  const n = Math.min(50, Math.max(1, parseInt(arg, 10) || 12));
  requestDebug({ limit: n }).then(({ events }) => {
    if (!events?.length) return logChat('*', 'flight recorder is empty — nothing has bounced recently');
    for (const { ts, kind, ...rest } of events) {
      const t = new Date(ts).toTimeString().slice(0, 8);
      logChat('*', `${t} [${kind}] ${Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}`);
    }
  });
});

register('mount', (arg) => {
  // /mount <thing> <onto> [slot] — glue where it stands, or seat in a socket
  const [childW, parentW, slot] = (arg || '').trim().split(/\s+/);
  if (!childW || !parentW) return logChat('*', 'usage: /mount <thing> <onto> [slot] — parents one thing to another, keeping its pose');
  const c = thingNamed(childW), p = thingNamed(parentW); const e = c?.err ?? p?.err; if (e) return logChat('*', e);
  if (!c || !p || !entities.get(c.id) || !entities.get(p.id)) return logChat('*', 'both things must exist (and be loaded) here');
  sceneAttach(c.id, p.id, slot);
});

register('dismount', (arg) => {
  const word = (arg || '').trim();
  if (!word) return logChat('*', 'usage: /dismount <thing>');
  const t = thingNamed(word); if (t?.err) return logChat('*', t.err);
  if (!t || !entities.get(t.id)?.userData?.mountedTo) return logChat('*', `${word} isn't mounted on anything`);
  sceneDetach(t.id);
});

register('use', (arg) => {
  // /use <entity> [action] — rank 0: using the world is for everyone.
  // Reactions (the swing's push, a door's open) come back as log entries.
  const [word, action] = (arg || '').trim().split(/\s+/);
  if (!word) return logChat('*', 'usage: /use <thing> [action] — e.g. /push swing1');
  const t = thingNamed(word); if (t?.err) return logChat('*', t.err);
  if (!t) return logChat('*', `nothing here called "${word}"`);
  const id = t.id;
  // no action: the authority does the thing's one action, or says what it offers (it was sent 'use', which most don't)
  send(OP.use(id, action || null), { what: action ? `${action} ${id}` : `use ${id}` });
});

register('sit', (arg) => {
  // /sit [thing] [slot] — a declared seat nearby wins; otherwise sit on the ground
  const [word, slot] = (arg || '').trim().split(/\s+/);
  const t = thingNamed(word); if (t?.err) return logChat('*', t.err);   // by id, label or handle (R 10-17)
  if (!trySitOn(t?.id ?? (word || null), slot || null)) setPosture('sit');
});

register('anim', (arg) => {
  const name = (arg || '').trim().toLowerCase();
  if (!ANIM_ORDER.includes(name) && !Object.keys(ANIM_CLIPS).includes(name)) {
    return logChat('*', `actions: ${Object.keys(ANIM_CLIPS).join(', ')}`);
  }
  getMe()?.playOnce(name);
  myState.anim = name;
});

register('goto', (arg) => {
  const target = [...remotes.values()].find((r) =>
    r.id.toLowerCase() === (arg || '').trim().toLowerCase());
  if (!target?.avatar) return logChat('*', `no one here called "${arg}"`);
  // walk-to is the agent verb; for a person it's a hint plus a marker
  const p = target.avatar.root.position;
  flashHint(`${target.id} is ${p.distanceTo(myState.pos).toFixed(0)}m away, bearing ${bearingTo(p)}`);
});

register('rename', () => {
  // chat.js emitted this command for years with nobody subscribed (§14.1
  // found bug) — a silently dead command. Until mid-session renames exist,
  // say so instead of saying nothing.
  logChat('*', "renaming mid-session isn't supported yet — set your name at the authority (clear ew-name in devtools to re-open it)");
});

function bearingTo(p) {
  const a = Math.atan2(p.x - myState.pos.x, p.z - myState.pos.z);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}

export async function saveScreenshot() {
  try {
    const url = captureFrame();
    const a = document.createElement('a');
    a.href = url;
    a.download = `eidoverse-${CONFIG.world}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    flashHint('saved');
  } catch (e) { report('screenshot', e); }
}

/** The bus subscriptions — called once from main's boot sequence. The
 *  register() table above filled at import; this turns it on. */
export function initCommands() {
  let saidRights = null;
  bus.on('your-rights', (r) => {
    // only worth a line when the world actually restricts — open worlds stay silent — and only when what you may do
    // changed (a server re-sends your rights after a sanction or anyone's role change: the same line again is noise)
    const key = JSON.stringify([r.role, r.roleName, r.permissions ?? null, r.gen, r.fly, !!r.muted]);
    if (key === saidRights) return; saidRights = key;
    if (!r.open && !isOwner(r)) {
      const extra = Array.isArray(r.permissions) ? '' : r.gen ? ' +gen' : '';
      logChat('*', `this world has an owner — you are ${/^[aeiou]/i.test(r.roleName ?? r.role) ? 'an' : 'a'} ${(r.roleName ?? r.role).toLowerCase()}${extra} here`);
    }
  });

  bus.on('command', ({ cmd, arg }) => dispatch(cmd, arg));

  // Hands aimed at YOUR body (reachnet's bus edges) become chat lines — the
  // human ear for the same events an agent hears through its door. Reach and
  // touch carry a per-(person, hand) quiet window because a hand trembling
  // across the touch threshold re-fires the edge; a release only happens on
  // purpose, so it always speaks.
  const recentReach = new Map();
  const narrate = (type, { who, limb, point }) => {
    const lw = LIMB_WORD[limb] ?? limb;
    if (type !== 'release') {
      const key = `${type}:${who}:${limb}`;
      const now = performance.now();
      if (now - (recentReach.get(key) ?? 0) < 10_000) return;
      recentReach.set(key, now);
    }
    if (type === 'reach') logChat('*', `${who} reaches toward your ${point ?? 'position'} (${lw})`);
    else if (type === 'touch') logChat('*', `${who}'s ${lw} touches your ${point ?? 'position'}`);
    else logChat('*', `${who} withdraws their ${lw}`);
  };
  bus.on('reach', (e) => narrate('reach', e));
  bus.on('touch', (e) => narrate('touch', e));
  bus.on('release', (e) => narrate('release', e));
}
