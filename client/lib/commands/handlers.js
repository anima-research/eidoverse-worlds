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
import { captureFrame } from '../capture.js';
import { register, dispatch } from './registry.js';
import { entities, roleOf, worldHasOwner } from '../world.js';
import {
  net, sendVerb, sendMod, sendPuppet, sendWorldFork, sendWorldReset, requestDebug,
} from '../net.js';
import { remotes } from '../remotes.js';
import { myState, setPosture, flightReport } from '../controller.js';
import { kick } from '../physobj.js';
import { logChat } from '../chat.js';
import { toggleHelp, flashHint } from '../ui.js';
import { sceneAttach, sceneDetach } from '../scenegraph.js';
import { EMOTE_ORDER, EMOTES } from '../avatar.js';
import { setPushable, pushable } from '../consent.js';
import { trySitOn } from '../localbody.js';
import { getMe } from '../mybody.js';
import { setMyReach, clearMyReach } from '../reachnet.js';
import { SIM_ID } from '../../../shared/sim.js';
import { canonicalPoint, CONTACT_POINTS } from '../../../shared/contact.js';
import { TOUCH_GAP } from '../../../shared/reachwire.js';

register('help', () => toggleHelp());
// Flight's own diagnostic, in the chat log where a person can read it and
// paste it back. See controller.js flightReport() for why this is not just
// the console probe.
register('flight', () => { for (const line of flightReport().split('\n')) logChat('*', line); });

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

register('role', (arg) => {
  const who = (arg || '').trim() || CONFIG.name;
  if (who === CONFIG.name && !worldHasOwner() && net.myRights?.open !== false) {
    return logChat('*', 'this world is open — everyone here can build');
  }
  const r = who === CONFIG.name ? (roleOf(who) ?? net.myRights) : roleOf(who);
  if (!r) return logChat('*', `${who} holds no role here (visitor)`);
  return logChat('*', `${who}: ${r.role}${r.gen ? ' +gen' : ''}`);
});

register('grant', (arg) => {
  // /grant <name> owner|builder|visitor [+gen|-gen] [+fly|-fly]
  // server enforces owner-only. `fly` is orthogonal to the ladder like gen,
  // and default-off everywhere -- including open worlds, and including for
  // owners. Somebody says so, in the log, or nobody flies.
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const id = parts[0];
  const role = parts.find((p) => ['owner', 'builder', 'visitor'].includes(p.toLowerCase()))?.toLowerCase();
  const genFlag = parts.find((p) => p === '+gen' || p === '-gen');
  const flyFlag = parts.find((p) => p === '+fly' || p === '-fly');
  if (!id || (!role && !genFlag && !flyFlag)) {
    return logChat('*', 'usage: /grant <name> owner|builder|visitor [+gen|-gen] [+fly|-fly]');
  }
  sendVerb('grant', { id, ...(role ? { role } : {}),
                      ...(genFlag ? { gen: genFlag === '+gen' } : {}),
                      ...(flyFlag ? { fly: flyFlag === '+fly' } : {}) });
});

// /kick /ban <name> [reason…] — owner-only, the server enforces (and
// narrates the act into chat via the log entry it broadcasts back).
function moderate(cmd, arg) {
  const [id, ...rest] = (arg || '').trim().split(/\s+/).filter(Boolean);
  if (!id) return logChat('*', `usage: /${cmd} <name> [reason] — ${cmd === 'kick' ? 'they can rejoin; /ban keeps them out' : 'a kick that sticks — /unban lifts it'}`);
  sendVerb(cmd, { id, ...(rest.length ? { reason: rest.join(' ') } : {}) });
}

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
  kick(arg);
});
register('ban', (arg) => moderate('ban', arg));

// /epoch [tickMs] — enter the deterministic-sim epoch (PROTOCOL_v2 §3).
// Owner-ranked: the server refuses below rank 2 and refuses any sim name
// this sequencer does not carry; the client only makes the door REACHABLE
// (before this, entering an epoch took a raw world_verb — which is how a
// playtest "of the new physics" ran the legacy volunteer sim instead).
register('epoch', (arg) => {
  const a = (arg || '').trim();
  // /epoch off — LEAVE the sim epoch (ruling 2026-09-01: explicit, never a
  // toggle): every flight is released to the fold where it stands, and punts
  // go back to the volunteer physics. Owners only; the world refuses or announces.
  if (/^(off|leave|exit|none)$/i.test(a)) {
    sendVerb('epoch', { sim: null });
    logChat('*', 'asked the world to LEAVE its sim epoch — every flight comes to rest where it is and punts return to volunteer physics (owners only; the world will refuse or announce)');
    return;
  }
  const tickMs = Math.round(Number(a)) || 66;
  sendVerb('epoch', { sim: SIM_ID, tickMs });
  logChat('*', `asked the world to enter ${SIM_ID} at a ${tickMs}ms tick — flights become log-replayable physics (owners only; the world will refuse or announce)`);
});

register('unban', (arg) => {
  const id = (arg || '').trim();
  if (!id) return logChat('*', 'usage: /unban <name>');
  sendVerb('unban', { id });
});

register('bans', () => sendMod('world-bans'));

// global moderation — WORLD_ADMIN only, the server enforces
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
  const REACH = 2.5;
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((p) => !/^[\d.]+$/.test(p));
  // one word, two acts: /push swing1 is the swing's use-reaction (the old
  // alias, kept working), /push bob is a shove. Things win the name lookup
  // because they were here first; /shove is always the person verb.
  if (named && entities.has(named)) { sendVerb('use', { id: named, action: 'push' }); return; }
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
  const REACH = 2.5;
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
  // the solve runs in the frame loop; read the verdict once the arm settles
  setTimeout(() => {
    const s = getMe()?.reachStatus?.()?.[limb];
    if (!s || !Number.isFinite(s.gap)) return;
    if (s.gap <= TOUCH_GAP) {
      logChat('*', `…your ${LIMB_WORD[limb]} rests on ${whose} ${point} — it follows them until /letgo`);
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

register('boom', (arg) => {
  // /boom [power] [radius] — an instantaneous force verb at my feet. The
  // server gates it at builder rank and bounds the numbers; every pushable
  // body in radius (mine included — standing at your own blast is on you)
  // applies its own shove.
  const nums = (arg || '').trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  sendVerb('force', {
    at: [myState.pos.x, myState.pos.y, myState.pos.z],
    ...(nums[0] ? { power: nums[0] } : {}),
    ...(nums[1] ? { radius: nums[1] } : {}),
  });
});

register('fork', (arg) => {
  // /fork <new-name> — copy this world, all history included (owner-only,
  // the server enforces). The reply arrives as a world-forked message.
  const to = (arg || '').trim();
  if (!to) return logChat('*', 'usage: /fork <new-name> — copies this world into a new one');
  if (!/^[a-z0-9_-]{1,64}$/i.test(to)) return logChat('*', `"${to}" won't do as a world name — letters, digits, - and _ only`);
  sendWorldFork(to);
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
  const [child, parent, slot] = (arg || '').trim().split(/\s+/);
  if (!child || !parent) return logChat('*', 'usage: /mount <thing> <onto> [slot] — parents one thing to another, keeping its pose');
  if (!entities.get(child) || !entities.get(parent)) return logChat('*', 'both things must exist (and be loaded) here');
  sceneAttach(child, parent, slot);
});

register('dismount', (arg) => {
  const id = (arg || '').trim();
  if (!id) return logChat('*', 'usage: /dismount <thing>');
  if (!entities.get(id)?.userData?.mountedTo) return logChat('*', `${id} isn't mounted on anything`);
  sceneDetach(id);
});

register('use', (arg) => {
  // /use <entity> [action] — rank 0: using the world is for everyone.
  // Reactions (the swing's push, a door's open) come back as log entries.
  const [id, action] = (arg || '').trim().split(/\s+/);
  if (!id) return logChat('*', 'usage: /use <thing> [action] — e.g. /push swing1');
  if (!entities.has(id)) return logChat('*', `nothing here called "${id}"`);
  sendVerb('use', { id, action: action || 'use' });
});

register('sit', (arg) => {
  // /sit [thing] — a declared seat nearby wins; otherwise sit on the ground
  if (!trySitOn((arg || '').trim() || null)) setPosture('sit');
});

register('emote', (arg) => {
  const name = (arg || '').trim().toLowerCase();
  if (!EMOTE_ORDER.includes(name) && !Object.keys(EMOTES).includes(name)) {
    return logChat('*', `emotes: ${Object.keys(EMOTES).join(', ')}`);
  }
  getMe()?.playEmote(name);
  myState.emote = name;
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
  logChat('*', "renaming mid-session isn't supported yet — set your name at the door (clear ew-name in devtools to re-open it)");
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
  bus.on('your-rights', (r) => {
    // only worth a line when the world actually restricts — open worlds stay silent
    if (!r.open && r.role !== 'owner') {
      logChat('*', `this world has an owner — you are a ${r.role}${r.gen ? ' +gen' : ''} here`);
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
    else if (type === 'touch') logChat('*', `${who}'s ${lw} rests on your ${point ?? 'position'}`);
    else logChat('*', `${who} withdraws their ${lw}`);
  };
  bus.on('reach', (e) => narrate('reach', e));
  bus.on('touch', (e) => narrate('touch', e));
  bus.on('release', (e) => narrate('release', e));
}
