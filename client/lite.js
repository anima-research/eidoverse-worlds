// lite.js — the entry point for a device that cannot hold the world.
//
// Why a separate entry point and not a flag: main.js statically imports
// { THREE, scene, camera, renderer } at its line 10, and index.html modulepreloads
// three.webgpu and three-vrm besides. Static imports and preloads are fetched and
// parsed before any of our code gets a say, so a runtime `if (lite)` would render
// nothing and still pay the whole ~2.1MB on a phone. The choice is made in the HTML,
// ahead of the module graph; see the decision script there.
//
// What this is: chat, the emote row, and who's here. No scene, no camera, no renderer,
// no bodies. You can talk to people in the eidoverse from a phone that cannot draw it.
//
// What it is NOT: a viewer. There is deliberately no canvas.
//
// It runs the REAL net.js. The wire protocol is not forked — net.js takes its
// participant registry, asset ledger and snapshot renderer by injection now, so this
// file supplies renderer-free ones and the protocol has exactly one implementation.
import { CONFIG, bus, report, setToken } from './lib/base.js';
// NOT ui.js. That module is the DESKTOP shell: since #185 it imports videopanel.js and
// profile.js, which reach the engine through core.js, mybody.js and colliders.js, and it
// owns the settings sections and world panels besides. None of that belongs on a phone
// that cannot draw a world, so lite builds its surface from the primitives that are
// actually renderer-free. Sharing ui.js would mean gutting it; this costs less and
// leaves the desktop shell untouched.
import { makeFrame } from './lib/frames.js';
import { initChat, logChat } from './lib/chat.js';
import {
  net, connect, initIdentity, wireNet, sendVerb, sendWhisper, sendTyping, sendPoseExact,
  loginUrl,
} from './lib/net.js';
import { initBoot, markPhase, finishBoot } from './lib/boot.js';
import * as participants from './lib/participants_lite.js';
import { initLiteEmotes } from './lib/emotebar_lite.js';
// Turns live world entries into chat lines — including your own 'say' coming back from
// the server. Without it a lite client could SEND a message and never see it: the text
// only appeared on reload, when history replayed through social.js instead. It is the
// same narrator the full client uses, which is why it also reports builds and grants.
import { initCauses } from './lib/realize/causes.js';

// The boot watchdog in index.html fails the splash after 20s unless __ewEngineUp is
// set, and core.js only sets it after renderer.init(). There is no renderer here and
// never will be, so we claim the flag ourselves. What the watchdog actually guards
// against still works: if this module never runs, nothing sets it.
globalThis.__ewEngineUp = true;

// Why this session is lite, decided in index.html. 'crash' is the one that has to SAY
// so: being silently demoted after your browser died, with no explanation and no way
// back, is worse than the crash was.
const WHY = globalThis.__ewLiteWhy ?? 'url';
const WHY_TEXT = {
  crash: "last time this device opened the full world it didn't come back \u2014 this is the light version",
  ram: 'this device reports too little memory for the full world \u2014 this is the light version',
  'no-gpu': 'this browser has no 3D support \u2014 this is the light version',
  saved: 'lite mode \u2014 chat, emotes, and who\u2019s here',
  url: 'lite mode \u2014 chat, emotes, and who\u2019s here',
  default: 'lite mode \u2014 chat, emotes, and who\u2019s here',
};

/** The way out. A URL and not a saved preference on purpose: ?lite=0 is rule (1) in the
 *  decision script, so it wins for THIS load only. If the full client dies again, the
 *  tripwire it arms sends the next plain visit straight back here — one attempt, not a
 *  loop, and the escape stays a link the person can keep. */
export function tryFullWorld() {
  try { localStorage.removeItem('ew-lite'); } catch { /* nothing to clear */ }
  const u = new URL(location.href);
  u.searchParams.set('lite', '0');
  location.assign(u);
}

/** Stay here and stop asking. Saved, because this one IS a preference — and a proven
 *  crash still overrides it, which is what keeps a saved 'full' from being a trap. */
export function stayLite() {
  try { localStorage.setItem('ew-lite', '1'); } catch { /* best effort */ }
}

// A lite client still ARRIVES: the server announces it and everyone else builds a body
// for it, whether or not we ever say where that body is. So the choice was never "appear
// or not" - it is "appear as the resident the world remembers, or as a default".
//
// THE RESTORE IS HELD VERBATIM AND SENT BACK VERBATIM. It is the server's own settled
// pose for this body - position, facing, clip, pitch, wings, held bones, pins, and
// anything added to that vocabulary later. A pose is the resident's WHOLE public body,
// not a delta, so re-composing one from what this client happens to know is how a wave
// stood someone up out of a sit, unfolded their wings and dropped their held pose
// (#188 B2). We add the one-shot and change nothing else.
//
// An emote is not a verb, either: the verb set is closed by design, and asking for one
// earns "verb not allowed: emote". It rides the presence pose, which is why a client
// with no body still has to have something to say about where that body is.
let restored = null;

/** The body the world remembers. Before any restore lands - a first-ever visit - the
 *  origin is all we can honestly claim, and sanePose() requires a finite `p`. */
const rememberedBody = () => restored ?? { p: [0, 0, 0], yaw: 0 };

/** One emote: the remembered body, unchanged, carrying a one-shot. */
function emote(name) {
  if (!sendPoseExact({ ...rememberedBody(), emote: name })) {
    toast('not connected - emote not sent', 'warn');
  }
}

/** The roster in the shape chat.js wants for @-completion and its people pane.
 *  `dist` is always null: distance is a property of a world we are not drawing. */
function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null }];
  for (const r of participants.remotes.values()) {
    list.push({ id: r.id, me: false, agent: !!r.agent, dist: null });
  }
  return list;
}

/** The few lines of ui.js that lite actually needed. Deliberately not a shared module:
 *  if this grows past a screenful it wants to BE one, and the growth is the signal. */
function toast(message, kind = 'info', ttl = 5000) {
  const host = document.getElementById('toasts') ?? document.body;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), ttl);
}

function liteDock(entries) {
  const dock = document.createElement('nav');
  dock.id = 'lite-dock';
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = e.id;
    b.title = e.title ?? e.id;
    b.textContent = e.label;
    b.addEventListener('click', e.act);
    dock.appendChild(b);
  }
  document.body.appendChild(dock);
  return dock;
}

/** The key door, renderer-free.
 *
 *  A key-gated world refuses an unknown visitor with close code 4003, and net.js turns
 *  that into `bad-key`. The full client answers it by reopening openDoor - which lives in
 *  ui.js, needs a roster of avatars to show, and arrives with the engine attached. None
 *  of that is available here, and "try the full world" is not a door for someone whose
 *  phone the full world kills (#188 B3). So: an input, on the page that is already up.
 *
 *  Idempotent - a refused key re-emits `bad-key`, and that should refill the same door
 *  rather than stack another. */
function keyDoor() {
  let host = document.getElementById('lite-door');
  if (host) { host.querySelector('.lite-door-msg').textContent = 'that key was refused'; return; }

  host = document.createElement('div');
  host.id = 'lite-door';
  host.innerHTML = `
    <div class="lite-door-card">
      <div class="lite-door-title">this world needs a key</div>
      <div class="lite-door-msg">enter the door key to come in</div>
      <input class="lite-door-key" type="password" autocomplete="off" spellcheck="false"
             placeholder="door key" aria-label="door key">
      <button class="lite-door-go" type="button">enter</button>
    </div>`;
  document.body.appendChild(host);

  const input = host.querySelector('.lite-door-key');
  const msg = host.querySelector('.lite-door-msg');
  const submit = () => {
    const key = input.value.trim();
    if (!key) { msg.textContent = 'a key is needed to come in'; return; }
    setToken(key);          // CONFIG.token + the 'ew-key' the early socket reads next time
    msg.textContent = 'trying that key\u2026';
    host.remove();
    connect();
  };
  host.querySelector('.lite-door-go').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  // A deployment that wants a login rather than a key already redirects through authcfg;
  // where one is offered, show it too, because a key box is no use to someone who has an
  // account instead.
  const url = loginUrl?.();
  if (url) {
    const a = document.createElement('a');
    a.className = 'lite-door-login';
    a.href = url;
    a.textContent = 'or sign in';
    host.querySelector('.lite-door-card').appendChild(a);
  }
  input.focus();
}

async function main() {
  document.documentElement.classList.add('lite');
  // The splash is static markup that only boot.js takes down, and nothing here would
  // ever have called it — a lite client would have sat on 'waking the engine' forever
  // while a perfectly good chat window waited behind it. The engine and body phases are
  // marked done because in this client they are: there is no engine to wake and no body
  // to assemble, and a progress bar must never wait on something that will not happen.
  // Wired before connect(), because the refusal it answers arrives during connect().
  bus.on('bad-key', keyDoor);

  initBoot({ world: CONFIG.world, name: CONFIG.name });
  markPhase('engine', 1);
  markPhase('body', 1);

  // The renderer-free half of the client, handed to the real protocol.
  wireNet({
    participants,
    toast,                       // net.js takes a notifier rather than importing ui.js
    // The SAME avatar the inline early socket joined with, published by index.html before
    // any of its guards. net.js adopts that socket only when the join it would send
    // matches byte for byte; asking for '' here missed, so the early socket was dropped
    // and a second one opened - the server saw arrive -> leave -> arrive, and a held
    // whisper delivered to the first socket could be marked delivered and then thrown
    // away with it (#188 B1). We cannot DRAW the avatar; that was never what this
    // answers. Everyone else draws our body, and it should be the right one.
    myAvatarPath: () => globalThis.__ewWantAvatar ?? 'claude',
    // null, both of them, and deliberately: sendPose() SAMPLES a live body and returns
    // immediately without these. There is no body here to sample. The one pose this
    // client ever emits goes through sendPoseExact, which re-asserts what the server
    // already remembers instead of composing something new.
    me: () => null,
    myState: null,
    onRestore: (r) => { restored = r; },   // held whole; see rememberedBody()
  });

  await initIdentity();

  // No door screen: openDoor lives in ui.js, and the door's job (pick a body, see who is
  // here before you commit) is mostly about a world this client does not render. A lite
  // arrival steps straight in. TODO: the key/login path still needs a home here for a
  // world that requires one (net.js exports loginUrl/bounceToLogin).
  {
    {
      markPhase('connect', 1);
      await connect();
      markPhase('world', 1);
      finishBoot('lite');

      initChat({
        send: (text) => sendVerb('say', { text }),
        whisper: sendWhisper,
        typing: (to) => sendTyping(to),   // no local avatar to show typing on
        people,
      });

      const emoteHost = document.createElement('div');
      emoteHost.id = 'lite-emote-host';
      document.body.appendChild(emoteHost);
      initLiteEmotes(emoteHost, emote);

      initCauses();   // live says become chat lines; see the import note

      logChat('', WHY_TEXT[WHY] ?? WHY_TEXT.default, 'sys');
      bus.emit('roster');

      // TODO: tryFullWorld() still needs a real control in the dock. A person demoted
      // by a crash must be able to SEE the door, not just be told there is one.
      globalThis.__ewTryFullWorld = tryFullWorld;

      liteDock([
        { id: 'full', label: '\u{1F30D}', title: 'try the full world', act: tryFullWorld },
      ]);
    }
  }
}

main().catch((e) => {
  report?.('lite boot', e);
  toast(`lite boot failed: ${e.message}`, 'err');
});
