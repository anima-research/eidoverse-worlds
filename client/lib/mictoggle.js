// mictoggle — the porch-old mic badge, reborn for eidoverse. (R, 15:42: voice
// controls out of the dock, one clean SVG toggle riding beside the top-left
// HUD pane, muted by default.)
//
// Ours, whole: self-injecting like the workshop button, deletable with this
// file. States, porch doctrine:
//   grey + slash  = mic off (the default — a body should wake up silent)
//   warm ring     = mic live, world can hear you
// A small headphone glyph beside it mutes INCOMING voice separately.
// V toggles the mic from the keyboard, exactly like the porch.

import { micOn, toggleMic } from './micstate.js';
import { setSTT, sttAvailable } from './stt.js';
import { CONFIG } from './base.js';
import { receivingVoice, setReceiveVoice, ensureSttConsent, sttConsented,
  isHushed, setHush } from './voiceconsent.js';
import { bus } from './base.js';

// three states (R, 17:09): off = grey + slash · live = clean bright white ·
// hot (picking up your voice for STT) = warm yellow glow. No rings.
// ONE palette for both glyphs. They sit side by side and are read as a pair,
// so any divergence reads as a state difference that is not there (field
// report 12:43: the off-states looked noticeably unalike). The apparent
// weight difference was never the hex — it was INK COVERAGE: the headphone
// carries two filled earcups and a long band, the mic is thin strokes with
// air between them, so identical stroke colour lands heavier on the ear.
// Equalising by giving the heavier glyph a slightly thinner stroke, which
// matches perceived weight rather than nominal colour.
const INK = { off: '#7d8f8a', on: '#f2f7f5', hot: '#ffd66b', slash: '#c0574f' };

const MIC_SVG = (on, hot) => {
  const c = hot ? INK.hot : on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 32 32" width="26" height="26" style="${hot ? 'filter:drop-shadow(0 0 5px rgba(255,214,107,.9))' : ''}">
  <g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round">
    <rect x="12" y="5" width="8" height="14" rx="4" fill="${hot ? 'rgba(255,214,107,.35)' : 'none'}"/>
    <path d="M8 15 a8 8 0 0 0 16 0"/>
    <line x1="16" y1="23" x2="16" y2="27"/>
    <line x1="11" y1="27" x2="21" y2="27"/>
    ${on ? '' : `<line x1="7" y1="4" x2="25" y2="28" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

// The headphone: consent to HEAR, independent of consent to SPEAK. Off by
// default like the mic — voice is opt-in in both directions. This mutes
// VOICES only (peer speech and agent TTS, which is a resident speaking);
// world ambience has its own slider in settings, because ambience is taste
// you set once, not a thing you toggle situationally. That split is the
// convention everywhere it matters (Discord's deafen, VRChat's voice
// controls) and it is the one people already have hands for.
const EAR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 32 32" width="26" height="26">
  <g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round">
    <path d="M6 19 v-3 a10 10 0 0 1 20 0 v3"/>
    <rect x="4" y="18" width="6" height="9" rx="3"/>
    <rect x="22" y="18" width="6" height="9" rx="3"/>
    ${on ? '' : `<line x1="7" y1="4" x2="25" y2="28" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

let micBtn = null, earBtn = null;

let micHot = false;
// 🔴 THE GLYPH MUST READ WHICHEVER TRANSPORT IS LIVE (2026-08-15).
// micOn() is voice.js's MESH state — `!!micStream && _micLive && !muted` — and
// on the SFU path micStream is never set, so it is permanently false while the
// SFU happily publishes. Measured in a real browser: relayDiag().micPublished
// true, glyph slashed, tooltip "mic off (V to talk)".
//
// A control that says PRIVATE while the room hears you is the one failure this
// UI must never have — micgate fails CLOSED for the same reason. toggleMic
// already routes by transport; the indicator has to make the same turn or the
// button and the badge describe different bodies.
const micIsOn = () => {
  // 🔴 NEVER THROW OUT OF THE INDICATOR (review, 2026-08-15). The first version
  // was `window.relayDiag ? !!window.relayDiag().micPublished : micOn()` — no
  // try, no `?.` on the CALL. voicerelay.js installs window.relayDiag at module
  // top level, so it exists before its state does; a throw there aborts the tick
  // before paint(), FREEZING the glyph at its last value — and a frozen glyph
  // that says "off" while the room hears you is the exact bug fb33ffb existed to
  // kill, re-entered through a different door. Worse in flipMic(), where the
  // throw escapes the click handler AFTER toggleMic already succeeded.
  //
  // Prefer the CHEAP dedicated getter over the diag blob: sfuDiagClient()
  // allocates an object and spreads the speaker map, and this runs 8×/second.
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return window.relayDiag?.().micPublished ?? micOn();
  } catch { return micOn(); }
};
function paint() {
  if (!micBtn) return;
  const on = micIsOn();
  const deaf = on && !receivingVoice();
  micBtn.innerHTML = MIC_SVG(on, on && micHot);
  micBtn.style.opacity = deaf ? '0.55' : '1';
  micBtn.title = !on ? 'mic off (V to talk)'
    : deaf ? 'mic LIVE — but you are not hearing the room (Shift+V to listen)'
    : 'mic LIVE — the world hears you (V)';
  if (earBtn) {
    const consented = receivingVoice();
    const on = consented && !isHushed();
    earBtn.innerHTML = EAR_SVG(on);
    // hushed reads as OFF (grey, slashed) like any other off-state — it used
    // to also carry opacity:0.5, which made this glyph literally translucent
    // beside a fully-opaque mic and was most of the 'they look different'
    // report. The distinction between hushed and revoked lives in the
    // tooltip and the panel, not in a second visual language.
    earBtn.style.opacity = '1';
    earBtn.title = !consented
      ? 'not receiving voices at all — click to allow (world sound unaffected)'
      : isHushed()
        ? 'hushed — voices still arriving, click to listen again mid-sentence'
        : 'hearing voices — click to hush (Audio panel revokes entirely)';
  }
}
// hot = your voice is actually registering: a tiny analyser on the mic track,
// polled at 8Hz, drives the yellow glow in step with STT pickup
import { micAnalyserLevel as meshMicLevel } from './micstate.js';
// 🔴 ASK THE LIVE TRANSPORT (2026-08-15, R found this one in the HUD: "the mic
// icon isn't turning gold anymore when it is transmitting"). voice.js's
// micAnalyserLevel() reads the MESH's micStream, which is null forever on an
// SFU client — so it returns 0 at line one and the glyph can never go hot, and
// the sensitivity bar sits at zero while looking merely quiet. Fifth instance
// of this defect class in one night; see stt.js / voicemouths.js / tts.js.
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

setInterval(() => {
  if (!micIsOn()) { if (micHot) { micHot = false; paint(); } return; }
  const lvl = micLevelNow();
  const hot = lvl > 0.02;
  if (hot !== micHot) { micHot = hot; paint(); }
}, 125);

async function flipMic() {
  const on = await toggleMic(CONFIG.name);
  // Speech-to-text is a SEPARATE consent from speaking: it ships microphone
  // audio to the browser vendor's cloud service. Turning a mic on in a world
  // is not agreement to that, so we ask once, plainly, and remember either
  // answer. Voice chat works fine without it.
  if (on && sttAvailable()) {
    if (await ensureSttConsent()) setSTT(true);
  } else setSTT(false);
  paint();
}

// Two acts, deliberately separated (R, in world 12:11 — deafening cut the
// utterance and jumped to the next one, because consent-off tears the peer
// down and the in-flight audio dies with it):
//   CLICK    = hush — a gain change. The stream keeps arriving and advancing,
//              so unhushing rejoins the line already in progress, same as a
//              human voice you stopped attending to.
//   SHIFT+V  = consent — the privacy act. Tears the inbound path down so no
//              media is negotiated at all (the review's requirement).
// Clicking while unconsented grants consent first, so the button is never a
// dead end for someone who just wants to hear people.
function flipEar() {
  if (!receivingVoice()) { setReceiveVoice(true); setHush(false); }
  else setHush(!isHushed());
  paint();
}

function ensure() {
  const hud = document.querySelector('#hud');
  if (!hud || (document.contains(micBtn) && document.contains(earBtn))) return;
  // IN LINE with the bar (R, 15:47): a bare glyph riding at the end of the
  // hud's own row — no box, no chrome, just the mic. The hud repaints via
  // setHud(innerHTML) which would erase a child, so we sit AFTER the hud text
  // as a sibling-styled inline element inside the same visual bar.
  micBtn = document.createElement('span');
  micBtn.id = 'mictoggle';
  micBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  micBtn.onclick = flipMic;
  document.body.appendChild(micBtn);
  earBtn = document.createElement('span');
  earBtn.id = 'eartoggle';
  earBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  earBtn.onclick = flipEar;
  document.body.appendChild(earBtn);
  paint();
  placeMic();          // position + bind the observer the moment we exist
}
// Anchored to the hud panel's LIVE box. This used to re-measure on a 1s
// setInterval, which is exactly what it looked like: the mic visibly chased
// the panel for a second or two whenever the hud changed width (R, 01:00 —
// "doesn't ride with it cleanly... always lags a second or two"). A poll is
// the wrong instrument for "follow this box" — ResizeObserver fires in the
// same frame the box changes, so the mic moves WITH the panel instead of
// after it. The interval remains only as a slow safety net for changes
// neither observer sees (font swaps, zoom).
let _hudRO = null, _hudSeen = null;
function placeMic() {
  const hud = document.querySelector('#hud');
  if (!hud || !micBtn) return;
  const r = hud.getBoundingClientRect();
  const top = Math.round(r.top + (r.height - 26) / 2);
  micBtn.style.left = Math.round(r.right + 6) + 'px';
  micBtn.style.top = top + 'px';
  if (earBtn) { earBtn.style.left = Math.round(r.right + 38) + 'px'; earBtn.style.top = top + 'px'; }
  // (re)bind the observer if the hud element itself was replaced
  if (hud !== _hudSeen) {
    _hudSeen = hud;
    _hudRO?.disconnect();
    _hudRO = new ResizeObserver(placeMic);
    _hudRO.observe(hud);
  }
}
addEventListener('resize', placeMic);
setInterval(placeMic, 2000);          // safety net only; the observer does the work
// the glyph REFLECTS state, it does not own it: any surface that changes
// hush/consent repaints it, so a panel tick and a HUD click can never
// disagree about what you are hearing
bus.on('audio:hush', paint);
bus.on('audio:receive', paint);
// 🔴 'audio:mic' was EMITTED from three sites (voice.js:510, and twice in
// voicesfubridge.js) and subscribed by nobody. The glyph repainted only from
// its own 125ms poll, which read mesh state — so under SFU it never moved.
bus.on('audio:mic', paint);
setInterval(ensure, 1000);
ensure();

window.addEventListener('keydown', (e) => {
  if (e.repeat || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.code !== 'KeyV' || e.shiftKey) return;
  // V speaks. Hushing is a CLICK on the 🎧, and revoking consent entirely
  // lives only in the Audio panel — deliberately not on a key next to the
  // hush, because two near-identical gestures with different guarantees is
  // how someone ends up believing they are private when they are not. The
  // frequent act gets the fast path; the structural one you go looking for.
  flipMic();
});
