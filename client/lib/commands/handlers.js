// The behavior behind /commands — every branch of main.js's old
// bus.on('command') if-chain, registered into the pure registry (§14 6c).
// Each handler imports its own deps; chat.js never imports THIS file (only
// registry.js), or the cycle chat→handlers→net→chat closes.
//
// The kick and push disambiguators are each ONE handler doing its own
// entities/remotes checks — the old if-chain's fallthrough ORDER was
// semantic (things win the name lookup because they were here first), and
// it is preserved inside the handler bodies rather than across them.

import { scene, camera, renderer, CONFIG, bus, report } from '../core.js';
import { register, dispatch } from './registry.js';
import { entities, roleOf, worldHasOwner } from '../world.js';
import {
  net, sendVerb, sendMod, sendPuppet, sendWorldFork, sendWorldReset, requestDebug,
} from '../net.js';
import { remotes } from '../remotes.js';
import { myState, setPosture } from '../controller.js';
import { kick } from '../physobj.js';
import { logChat } from '../chat.js';
import { toggleHelp, flashHint } from '../ui.js';
import { sceneAttach, sceneDetach } from '../scenegraph.js';
import { EMOTE_ORDER, EMOTES } from '../avatar.js';
import { setPushable, pushable } from '../consent.js';
import { trySitOn } from '../localbody.js';
import { getMe } from '../mybody.js';

register('help', () => toggleHelp());

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
  // /grant <name> owner|builder|visitor [+gen|-gen] — server enforces owner-only
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const id = parts[0];
  const role = parts.find((p) => ['owner', 'builder', 'visitor'].includes(p.toLowerCase()))?.toLowerCase();
  const genFlag = parts.find((p) => p === '+gen' || p === '-gen');
  if (!id || (!role && !genFlag)) {
    return logChat('*', 'usage: /grant <name> owner|builder|visitor [+gen|-gen]');
  }
  sendVerb('grant', { id, ...(role ? { role } : {}), ...(genFlag ? { gen: genFlag === '+gen' } : {}) });
});

// /kick /ban <name> [reason…] — owner-only, the server enforces (and
// narrates the act into chat via the log entry it broadcasts back).
function moderate(cmd, arg) {
  const [id, ...rest] = (arg || '').trim().split(/\s+/).filter(Boolean);
  if (!id) return logChat('*', `usage: /${cmd} <name> [reason] — ${cmd === 'kick' ? 'they can rejoin; /ban keeps them out' : 'a kick that sticks — /unban lifts it'}`);
  sendVerb(cmd, { id, ...(rest.length ? { reason: rest.join(' ') } : {}) });
}

register('kick', (arg) => {
  // one word, two acts (the /push pattern): a THING within the world gets
  // the physics kick; a PERSON gets moderation. Things win the lookup —
  // and /punt is always the physics verb, /ban always the moderation one.
  const first = (arg || '').trim().split(/\s+/)[0];
  if (!first || entities.has(first) || !remotes.has(first)) { kick(arg); return; }
  moderate('kick', arg);   // a person's name — the old chain's fallthrough
});
register('punt', (arg) => { kick(arg); });
register('ban', (arg) => moderate('ban', arg));

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
  const r = remotes.get(target);
  if (!r?.avatar) return logChat('*', `${target} isn't here to push`);
  const tp = r.avatar.root.position;
  const d = Math.hypot(tp.x - myState.pos.x, tp.z - myState.pos.z);
  if (d > REACH) return logChat('*', `${target} is too far away to push (${d.toFixed(1)}m)`);
  // straight through the target from where I stand; face-to-face at zero
  // distance falls back to the way I'm facing
  const nx = d > 0.05 ? (tp.x - myState.pos.x) / d : Math.sin(myState.yaw);
  const nz = d > 0.05 ? (tp.z - myState.pos.z) / d : Math.cos(myState.yaw);
  sendPuppet(target, { ragdoll: { lean: [nx * pow, 0, nz * pow] } });
  logChat('*', `you push ${target}`);
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
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
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
}
