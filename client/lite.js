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
import { CONFIG, bus, report } from './lib/base.js';
// NOT ui.js. That module is the DESKTOP shell: since #185 it imports videopanel.js and
// profile.js, which reach the engine through core.js, mybody.js and colliders.js, and it
// owns the settings sections and world panels besides. None of that belongs on a phone
// that cannot draw a world, so lite builds its surface from the primitives that are
// actually renderer-free. Sharing ui.js would mean gutting it; this costs less and
// leaves the desktop shell untouched.
import { makeFrame } from './lib/frames.js';
import { initChat, logChat } from './lib/chat.js';
import {
  net, connect, initIdentity, wireNet, sendVerb, sendWhisper, sendTyping,
} from './lib/net.js';
import { initBoot, markPhase, finishBoot } from './lib/boot.js';
import * as participants from './lib/participants_lite.js';
import { initLiteEmotes } from './lib/emotebar_lite.js';

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
 *  tripwire it arms sends the next plain visit straight back here \u2014 one attempt, not a
 *  loop, and the escape stays a link the person can keep. */
export function tryFullWorld() {
  try { localStorage.removeItem('ew-lite'); } catch { /* nothing to clear */ }
  const u = new URL(location.href);
  u.searchParams.set('lite', '0');
  location.assign(u);
}

/** Stay here and stop asking. Saved, because this one IS a preference \u2014 and a proven
 *  crash still overrides it, which is what keeps a saved 'full' from being a trap. */
export function stayLite() {
  try { localStorage.setItem('ew-lite', '1'); } catch { /* best effort */ }
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

async function main() {
  document.documentElement.classList.add('lite');
  // The splash is static markup that only boot.js takes down, and nothing here would
  // ever have called it — a lite client would have sat on 'waking the engine' forever
  // while a perfectly good chat window waited behind it. The engine and body phases are
  // marked done because in this client they are: there is no engine to wake and no body
  // to assemble, and a progress bar must never wait on something that will not happen.
  initBoot({ world: CONFIG.world, name: CONFIG.name });
  markPhase('engine', 1);
  markPhase('body', 1);

  // The renderer-free half of the client, handed to the real protocol.
  wireNet({
    participants,
    toast,                       // net.js takes a notifier rather than importing ui.js
    myAvatarPath: () => '',      // we wear nothing we can draw; the server still resolves a name
    me: () => null,              // no local body, so nothing to pose
    myState: null,               // sendPose() early-returns on this \u2014 we never send presence
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
      initLiteEmotes(emoteHost, sendVerb);

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
