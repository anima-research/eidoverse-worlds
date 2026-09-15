// lite.js — the phone entry point. SKETCH, not yet runnable (see BLOCKERS).
//
// Why a separate file and not a flag inside main.js: main.js line 10 statically
// imports { THREE, scene, camera, renderer } from core.js, and index.html
// modulepreloads three.webgpu + three-vrm besides. Static imports and preloads
// are fetched and parsed BEFORE any of our code gets a say, so a runtime
// `if (lite)` would render nothing and still pay ~2.1MB of engine on a phone —
// the whole cost, none of the world. The choice has to be made in the HTML,
// before the module graph exists. Hence: two entry points, one shared lib/.
//
// What lite mode is: chat, the emote bar, and who's here. No scene, no camera,
// no renderer, no bodies. You can talk to people in the eidoverse from a phone.
//
// What it is NOT: a viewer. There is deliberately no canvas. If you want to see
// the world, that is main.js and it is a different machine's job.

import { bus, CONFIG, report } from './lib/base.js';
import {
  toast, setHint, initDock, panelFrame, openDoor, togglePeopleHere,
} from './lib/ui.js';
import { initChat, logChat } from './lib/chat.js';

// BLOCKER 1 — netlite.js does not exist yet.
// net.js:4 imports { THREE, camera } from core.js, so importing it here would
// drag the engine back in through the side door and undo the whole point.
// netlite.js is net.js's wire protocol with a null renderer behind it: same
// socket, same verbs, but `remotes` holds {id, name, agent} rows instead of
// avatars, pushPose() is dropped on the floor (~15Hz per person — most of the
// battery win), and the profile-snapshot path (net.js:829-841, the only real
// THREE use) is simply absent.
import { connect, initIdentity, sendVerb, sendWhisper, sendTyping, people } from './lib/netlite.js';

// BLOCKER 2 — emotebar.js:9 imports { EMOTE_ORDER, EMOTE_ICONS } from avatar.js.
// Those two are pure data (avatar.js:254-255, hydrated from
// defs/animations/_emotes.json at runtime), but the import pulls avatar.js and
// therefore the engine. Lift them into lib/emotedefs.js and have BOTH avatar.js
// and emotebar.js import from there — then this line is free.
import { initEmoteBar } from './lib/emotebar.js';

// The boot watchdog in index.html (~line 1600) fails the splash after 20s
// unless globalThis.__ewEngineUp is set, and core.js only sets it after
// renderer.init(). In lite mode there is no renderer and never will be, so we
// claim the flag ourselves: the thing it guards against (a hung module graph)
// is still caught, because if this file never runs the flag never gets set.
globalThis.__ewEngineUp = true;

// Why this session is lite, set by the decision script in index.html. 'crash' is the
// one that has to SAY so: being silently demoted after your browser died, with no
// explanation and no way back, is worse than the crash.
const WHY = globalThis.__ewLiteWhy ?? 'url';

const WHY_TEXT = {
  crash:  "the last time this device opened the full world, it didn't come back — so this is the light version",
  ram:    'this device reports too little memory for the full world — this is the light version',
  'no-gpu': 'this browser has no 3D support — this is the light version',
  saved:  'lite mode — chat, emotes and who’s here',
  url:    'lite mode — chat, emotes and who’s here',
  default: 'lite mode — chat, emotes and who’s here',
};

/** The way out. Deliberately a URL and not a saved preference: ?lite=0 is rule (1) in
 *  the decision script, so it wins for THIS load only. If the full client dies again,
 *  the tripwire it arms sends the next plain visit straight back here — one attempt,
 *  not a loop, and the escape is still a link the person can keep. */
export function tryFullWorld() {
  try { localStorage.removeItem('ew-lite'); } catch { /* nothing to clear */ }
  const u = new URL(location.href);
  u.searchParams.set('lite', '0');
  location.assign(u);
}

/** Stay here, and stop asking. Saved rather than per-URL, because this one IS a
 *  preference — and rule (2) still overrides it if the device later proves otherwise. */
export function stayLite() {
  try { localStorage.setItem('ew-lite', '1'); } catch { /* best effort */ }
}

async function main() {
  document.documentElement.classList.add('lite');   // CSS hook: hide world-only chrome

  await initIdentity();

  openDoor({
    roster: [],
    needsKey: false,
    login: null,
    onEnter: async () => {
      await connect();

      initChat({
        send:    (text) => sendVerb('say', { text }),
        whisper: (to, text) => sendWhisper(to, text),
        typing:  (state) => sendTyping(state),
        people,                                      // chat.js asks this for @-completion
      });

      initDock([]);            // TODO: the lite dock — chat, people, settings. Nothing world-shaped.
      initEmoteBar();          // sends the verb; the animation plays on everyone else's machine
      togglePeopleHere();      // the player list, open by default on a phone

      logChat('', WHY_TEXT[WHY] ?? WHY_TEXT.default, 'sys');
      // TODO: surface tryFullWorld() as a real control (a row in the lite dock).
      // A crash-demoted person must be able to see the door, not just be told
      // there is one. Exported meanwhile so the console can reach it.
      globalThis.__ewTryFullWorld = tryFullWorld;
    },
  });
}

main().catch((e) => {
  report?.(e);
  toast(`lite boot failed: ${e.message}`, 'err');
});
