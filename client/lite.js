// lite.js — the entry point for a device that cannot hold the world: chat, the action row and who's here, with no
// scene, camera, renderer or bodies. A separate entry point rather than a flag because main.js's static imports and
// index.html's modulepreloads are fetched before any of our code runs; index.html's decideLite chooses between them.
// It runs the real net.js, which takes its participant registry, asset ledger and snapshot renderer by injection,
// so the protocol has exactly one implementation. test/client/lite-graph-test.ts checks that nothing here reaches core.js.
import { say } from './lib/net.js';
import { chooseClient } from './lib/ui/litechoice.js';
import { CONFIG, bus, report, setToken } from './lib/base.js';
// not ui.js: the desktop shell reaches the engine through videopanel.js and profile.js
import { makeFrame } from './lib/ui/windows.js';
import { initChat, logChat } from './lib/ui/chat.js';
import {
  net, connect, initIdentity, wireNet, sendTyping, sendPoseExact,
  loginUrl,
} from './lib/net.js';
import { initBoot, markPhase, finishBoot } from './lib/boot.js';
import * as participants from './lib/ui/participants_lite.js';
import { initLiteActions } from './lib/ui/actionbar_lite.js';
// live world entries as chat lines (your own 'say' included), the same narrator the full client uses
import { initCauses } from './lib/realize/livechat.js';
import { initRecentChat } from './lib/realize/recentchat.js';

// index.html's boot watchdog fails the splash after 20 s unless this is set; core.js sets it after renderer.init(),
// and there is no renderer here. If this module never runs, nothing sets it, so the watchdog still guards.
globalThis.__ewEngineUp = true;

// why this session is lite, decided in index.html
const WHY = globalThis.__ewLiteWhy ?? 'url';
const WHY_TEXT = {
  // the card (liteBanner) says why for every reason now; this line is only for a reason with no card
  default: 'lite client \u2014 chat, the action bar, and who\u2019s here',
};

/** The way into the 3D world: the person's choice, saved, the address left clean (litechoice.js says why). */
export function tryFullWorld() { chooseClient(false); }

// A lite client still arrives: everyone else builds a body for it. The restore is the server's own settled pose for
// this body (the whole public body, not a delta), held verbatim and sent back verbatim with only the one-shot anim
// added. A gesture is not a verb; it rides the presence pose.
let restored = null;

/** The body the world remembers; before any restore lands, the origin (sanePose() requires a finite `p`). */
const rememberedBody = () => restored ?? { p: [0, 0, 0], yaw: 0 };

/** One anim, played once: the remembered body, unchanged, carrying pose.anim. */
function playOnce(name) {
  if (!sendPoseExact({ ...rememberedBody(), anim: name })) {
    toast('not connected - action not sent', 'warn');
  }
}

/** The roster in the shape chat.js wants. `dist` is always null: there is no world to measure in. */
function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null }];
  for (const r of participants.remotes.values()) {
    list.push({ id: r.id, me: false, declares: r.declares ?? null, dist: null });
  }
  return list;
}

/** The few lines of ui.js lite needs; if this grows past a screenful it wants to be a shared module. */
function toast(message, kind = 'info', ttl = 5000) {
  const host = document.getElementById('toasts') ?? document.body;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), ttl);
}


// The card says why this is the lite client where it can't scroll away (a chat line would be buried by the join
// snapshot's history). Shown for every reason, including a saved choice.
const TAP = globalThis.matchMedia?.('(pointer: coarse)').matches ? 'Tap' : 'Click';
const BANNER_TEXT = {
  phone: `You're on a phone, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  crash: `This world didn't finish loading on this device last time, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
    'no-gpu': "This browser has no 3D support, so you're in the lite client: chat, the action bar and who's here.",
  saved: `You chose the lite client on this device: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  url: `This link opens the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
};
const NO_WAY_IN = new Set(['no-gpu']);
// One column: the top bar, the card if it's up, then the chat filling everything below. Only the chat's box is set
// here, through --lite-top, which index.html's html.lite rules read.
export function liteLayout() {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('lite-action-host');
  const card = document.getElementById('lite-banner');
  // flush under the bar; a breath under the card while it's up
  const below = card ? card.getBoundingClientRect().bottom + 8 : (bar?.getBoundingClientRect().bottom ?? 0);
  document.documentElement.style.setProperty('--lite-top', `${Math.round(below)}px`);
}

// The same card as the full client's capability notice (capnotice.js markup), built here because capnotice.js pulls core.js.
export function liteBanner(why) {
  const text = BANNER_TEXT[why];
  if (!text || document.getElementById('lite-banner')) return null;
  const card = document.createElement('div');
  card.id = 'lite-banner';
  card.className = 'panel capnotice';
  card.setAttribute('role', 'status');
  const item = document.createElement('div');
  item.className = 'cn-item';
  item.innerHTML = '<b></b><p></p><div class="cn-btns"><button type="button" class="cn-ok">got it</button></div>';
  item.querySelector('b').textContent = 'Lite client';
  item.querySelector('p').textContent = text;
  let ro = null;
  item.querySelector('.cn-ok').addEventListener('click', () => { ro?.disconnect(); card.remove(); liteLayout(); });
  card.appendChild(item);
  document.body.appendChild(card);
  // under the action row, whose height depends on how many gestures wrap: follow it
  const host = document.getElementById('lite-action-host');
  const place = () => { card.style.top = `${Math.round((host?.getBoundingClientRect().bottom ?? 0) + 8)}px`; liteLayout(); };
  place();
  if (host && globalThis.ResizeObserver) (ro = new ResizeObserver(place)).observe(host);
  return card;
}

/** The key door, renderer-free: a key-gated world's refusal arrives as `bad-key` (net.js), and the full client's
 *  openDoor lives in ui.js with the engine attached. Idempotent: a refused key refills the same door. */
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

  // where a login is offered (authcfg), show it too: a key box is no use to someone with an account
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
  bus.on('bad-key', keyDoor);   // before connect(), where the refusal arrives

  // the splash is static markup that only boot.js takes down; the engine and body phases have nothing to wait on here

  initBoot({ world: CONFIG.world, name: CONFIG.name });
  markPhase('engine', 1);
  markPhase('body', 1);

  // the renderer-free half of the client, handed to the real protocol
  wireNet({
    participants,
    toast,
    // the same avatar index.html's early socket joined with: net.js adopts that socket only when the join it would
    // send matches byte for byte
    myAvatarPath: () => globalThis.__ewWantAvatar ?? 'claude',
    // no body to sample, so sendPose() returns at once; the one pose this client emits goes through sendPoseExact
    me: () => null,
    myState: null,
    onRestore: (r) => { restored = r; },   // held whole; see rememberedBody()
  });

  await initIdentity();

  // Every consumer of socket traffic is built before connect(), which adopts the early socket and drains what raced
  // ahead; a consumer that doesn't exist yet loses it for good. No await between here and connect().
  initChat({
    send: (text) => say(text),
    typing: (to) => sendTyping(to),   // no local avatar to show typing on
    people,
  });
  initCauses();        // live entries -> chat lines (says, builds, grants)
  initRecentChat();    // the join snapshot's chat window (empty since speech became arrival-only)

  // chrome: none of it consumes socket traffic
  const actionHost = document.createElement('div');
  actionHost.id = 'lite-action-host';
  document.body.appendChild(actionHost);
  initLiteActions(actionHost, playOnce);
  // the ∃ logo leads the top bar and loads the full 3D world (in the full client it opens the menu); where the
  // browser has no 3D at all it is just the mark
  const mark = document.getElementById('hud');
  if (mark) {
    actionHost.prepend(mark);
    if (NO_WAY_IN.has(WHY)) { mark.disabled = true; mark.title = 'eidoverse'; }
    else { mark.title = 'load the full 3D world'; mark.setAttribute('aria-label', 'load the full 3D world'); mark.addEventListener('click', tryFullWorld); }
  }
  liteLayout();
  if (globalThis.ResizeObserver) new ResizeObserver(liteLayout).observe(actionHost);
  addEventListener('resize', liteLayout);
  globalThis.__ewTryFullWorld = tryFullWorld;   // also reachable from the console

  // the card says why; the chat line only where there is no card
  if (!liteBanner(WHY)) logChat('', WHY_TEXT[WHY] ?? WHY_TEXT.default, 'sys');

  // no door screen (picking a body is about a world this client doesn't render): a lite arrival steps straight in;
  // a key-gated world gets keyDoor() above
  markPhase('connect', 1);
  await connect();
  markPhase('world', 1);
  finishBoot('lite');
  bus.emit('roster');
}

main().catch((e) => {
  report?.('lite boot', e);
  toast(`lite boot failed: ${e.message}`, 'err');
});
