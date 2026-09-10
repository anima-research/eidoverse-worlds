// mictoggle — the mic badge: voice controls out of the dock, one clean SVG
// toggle riding beside the ∃, muted by default.
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

// three states: off = grey + slash · live = clean bright white ·
// hot (picking up your voice for STT) = warm yellow glow. No rings.
// ONE palette for both glyphs. They sit side by side and are read as a pair,
// so any divergence reads as a state difference that is not there (in the
// field the off-states looked noticeably unalike). The apparent
// weight difference was never the hex — it was INK COVERAGE: the headphone
// carries two filled earcups and a long band, the mic is thin strokes with
// air between them, so identical stroke colour lands heavier on the ear.
// Equalising by giving the heavier glyph a slightly thinner stroke, which
// matches perceived weight rather than nominal colour.
// glyph inks come from the token sheet (no hex outside it) —
// read fresh each paint (1Hz + events): live token edits restyle us too.
const tok = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || fb).trim();
const INK = {
  get off()   { return tok('--dim', '#7d8f8a'); },
  get absent() { return tok('--edge-hi', 'rgb(255 255 255 / 0.32)'); },   // lighter than off: 'here, but nothing to talk to'
  get on()    { return tok('--brand', '#8fe8c8'); },   // live = brand, like the ∃
  get hot()   { return tok('--attn', '#ffd66b'); },
  // the slash is the OFF state's own ink, not an alarm: a silent body is the
  // rest state here ("a body should wake up silent"), and --err read as the one
  // thing on screen outside the scheme (R, 09-03)
  get slash() { return tok('--dim', '#7d8f8a'); },
};

const MIC_SVG = (on, hot) => {
  const c = hot ? INK.hot : on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 32 32" width="26" height="26" style="${hot ? `filter:drop-shadow(0 0 5px ${INK.hot})` : ''}">
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

// Phosphor 'visor' (MIT; R, 09-04 23:25: "the visor reads better"): the
// REGULAR weight in every state — its neighbours are line drawings (R,
// 09-04 23:48: "keep it just the outline"). Ink follows the pair: --dim
// off, --brand live.
const VISOR = { regular: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.85.74,32-5.9,49.38-20.3a15.88,15.88,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56Zm40.81,111.34A55.63,55.63,0,0,1,184,184c-13.88,0-27-9.51-35.65-16.67a31.91,31.91,0,0,0-40.65,0C93.52,179,80.94,184.49,69.28,183.94a56.36,56.36,0,0,1-53.22-53.28A56,56,0,0,1,72,72H183.05c31,0,56.55,24.79,56.95,55.25A55.66,55.66,0,0,1,223.86,167.34ZM184,96a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,96Z', fill: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.84.72,32-5.9,49.38-20.3a15.87,15.87,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56ZM176,104H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Z' };
const XR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 256 256" width="26" height="26" fill="${c}"><path d="${VISOR.regular}"/>${on ? '' : `<line x1="56" y1="32" x2="200" y2="224" stroke="${INK.slash}" stroke-width="14" stroke-linecap="round"/>`}</svg>`;
};

let micBtn = null, earBtn = null, xrBtn = null;
// the third glyph is OPTIONAL: xr.js registers it only where the browser
// answers isSessionSupported('immersive-vr'); until then it does not exist
let xrHook = null;   // { onclick, live: () => bool }
// R 09-08 01:12: a headset switched off after the page loaded still showed a live-looking visor (isSessionSupported is
// answered once at boot) and the click failed silently. When a session request is refused for want of a device, the
// visor goes lighter grey, blinks twice, and carries an attention-coloured tooltip until the next successful entry.
let xrAbsent = false;
export function markXrAbsent(on = true) { xrAbsent = !!on; paint(); if (on && xrBtn) { xrBtn.classList.remove('hud-blink'); void xrBtn.offsetWidth; xrBtn.classList.add('hud-blink'); } }
export function registerXrGlyph(hook) {
  xrHook = hook;
  ensure();
  applyPairVisibility(); paint(); placeMic();
  bus.emit('xr-glyph');   // the ∃ menu adds its row
}
export const xrGlyphAvailable = () => !!xrHook;
export const xrLive = () => { try { return !!xrHook?.live?.(); } catch { return false; } };
export function flipXr() { xrHook?.onclick?.(); }

let micHot = false;
// 🔴 THE GLYPH MUST READ WHICHEVER TRANSPORT IS LIVE.
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
  // 🔴 NEVER THROW OUT OF THE INDICATOR. The first version
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
  if (xrBtn) {
    const live = xrLive();
    xrBtn.innerHTML = xrAbsent && !live ? XR_SVG(false).replace(new RegExp(INK.off.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), INK.absent) : XR_SVG(live);
    xrBtn.title = live ? 'in VR — click to leave' : xrAbsent ? 'no headset detected — put it on (or wake it) and click again' : 'enter VR';
    xrBtn.classList.toggle('hud-absent', xrAbsent && !live);
  }
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
// 🔴 ASK THE LIVE TRANSPORT (seen in the HUD: the mic icon stopped turning
// gold while transmitting). voice.js's
// micAnalyserLevel() reads the MESH's micStream, which is null forever on an
// SFU client — so it returns 0 at line one and the glyph can never go hot, and
// the sensitivity bar sits at zero while looking merely quiet. Fifth instance
// of this defect class; see stt.js / voicemouths.js / tts.js.
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

// ---- pair API for the ∃ menu: rows toggle these; the pin
// controls whether the pair hangs off the ∃ at all
// per-glyph pins (forcing the pair to pin together was wrong)
const PIN_LS = { mic: 'ew-mic-pinned', ear: 'ew-ear-pinned', xr: 'ew-xr-pinned' };
const _pinned = { mic: true, ear: true, xr: true };
try { for (const k of ['mic', 'ear', 'xr']) _pinned[k] = localStorage.getItem(PIN_LS[k]) !== '0'; } catch {}
export const glyphPinned = (k) => !!_pinned[k];
export function setGlyphPinned(k, v) {
  _pinned[k] = !!v;
  try { localStorage.setItem(PIN_LS[k], v ? '1' : '0'); } catch {}
  applyPairVisibility(); placeMic();
}
function applyPairVisibility() {
  if (micBtn) micBtn.style.display = _pinned.mic ? 'inline-block' : 'none';
  if (earBtn) earBtn.style.display = _pinned.ear ? 'inline-block' : 'none';
  if (xrBtn) xrBtn.style.display = (_pinned.xr && xrHook) ? 'inline-block' : 'none';
}
export const micLive = () => { try { return micIsOn(); } catch { return false; } };
export const earOn = () => { try { return receivingVoice() && !isHushed(); } catch { return false; } };
export { flipMic, flipEar };
/** the menu wears the SAME glyphs as the floating pair */
export const xrGlyph = (size = 16) => XR_SVG(xrLive()).replace('width="26" height="26"', `width="${size}" height="${size}"`);
export const micGlyph = (size = 16) => MIC_SVG(micIsOn(), false).replace('width="26" height="26"', `width="${size}" height="${size}"`);
export const earGlyph = (size = 16) => { let on = false; try { on = receivingVoice() && !isHushed(); } catch {} return EAR_SVG(on).replace('width="26" height="26"', `width="${size}" height="${size}"`); };

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

// Two acts, deliberately separated (in-world, deafening cut the
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
  if (!hud || (document.contains(micBtn) && document.contains(earBtn) && document.contains(xrBtn))) return;
  // IN LINE with the bar: a bare glyph riding at the end of the
  // hud's own row — no box, no chrome, just the mic. The hud repaints via
  // setHud(innerHTML) which would erase a child, so we sit AFTER the hud text
  // as a sibling-styled inline element inside the same visual bar.
  micBtn = document.createElement('span');
  micBtn.id = 'micbtn'; micBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  micBtn.onclick = flipMic;
  document.body.appendChild(micBtn);
  earBtn = document.createElement('span');
  earBtn.id = 'earbtn'; earBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  earBtn.onclick = flipEar;
  document.body.appendChild(earBtn);
  xrBtn = document.createElement('span');
  xrBtn.id = 'xrbtn'; xrBtn.style.cssText = 'cursor:pointer;display:none;line-height:0;position:fixed;z-index:45;';
  xrBtn.onclick = flipXr;
  document.body.appendChild(xrBtn);
  paint();
  applyPairVisibility();
  placeMic();          // position + bind the observer the moment we exist
}
// Anchored to the hud panel's LIVE box. This used to re-measure on a 1s
// setInterval, which is exactly what it looked like: the mic visibly chased
// the panel for a second or two whenever the hud changed width (it never rode
// with it cleanly, always a second or two behind). A poll is
// the wrong instrument for "follow this box" — ResizeObserver fires in the
// same frame the box changes, so the mic moves WITH the panel instead of
// after it. The interval remains only as a slow safety net for changes
// neither observer sees (font swaps, zoom).
let _hudRO = null, _hudSeen = null;
function placeMic() {
  const hud = document.querySelector('#hud');
  if (!hud || !micBtn) return;
  const r = hud.getBoundingClientRect();
  // hang off the ∃ ALONG its own edge (the rail's line continues through
  // them); fold perpendicular only when a corner leaves no room
  const edge = document.getElementById('dock')?.dataset.edge || 'left';
  const cx = Math.round(r.left + (r.width - 26) / 2);
  const cy = Math.round(r.top + (r.height - 26) / 2);
  const pos = (b, x, y) => { b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.right = b.style.bottom = ''; };
  const vert = edge === 'left' || edge === 'right';
  const room = vert ? r.top : r.left;              // space before the ∃ along the rail
  // mic is ALWAYS the top/left of whatever is visible, and a lone
  // pinned glyph packs into the slot nearest the ∃ (pins are per-glyph)
  const vis = [ _pinned.mic && micBtn, _pinned.ear && earBtn, _pinned.xr && xrHook && xrBtn ].filter(Boolean);
  const n = vis.length;
  if (n) {
    if (room >= 42 + 32 * (n - 1)) {
      // along the edge, stacked before the ∃ (slot 0 = adjacent)
      vis.forEach((b, i) => {
        const off = 34 + 32 * (n - 1 - i);
        if (vert) pos(b, cx, Math.round(r.top) - off);
        else pos(b, Math.round(r.left) - off, cy);
      });
    } else {
      // corner: fold around it, perpendicular into the canvas
      vis.forEach((b, i) => {
        if (edge === 'left')       pos(b, Math.round(r.right) + 6 + 32 * i, cy);
        else if (edge === 'right') pos(b, Math.round(r.left) - 32 - 32 * (n - 1 - i), cy);
        else if (edge === 'top')   pos(b, cx, Math.round(r.bottom) + 6 + 32 * i);
        else                       pos(b, cx, Math.round(r.top) - 32 - 32 * (n - 1 - i));
      });
    }
  }
  applyPairVisibility();
  // (re)bind the observer if the hud element itself was replaced
  if (hud !== _hudSeen) {
    _hudSeen = hud;
    _hudRO?.disconnect();
    _hudRO = new ResizeObserver(placeMic);
    _hudRO.observe(hud);
  }
}
addEventListener('resize', placeMic);
addEventListener('dockmoved', placeMic);   // live re-anchor while the rail is dragged
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
bus.on('style', paint);
bus.on('xr:state', paint);   // session start/end (R 09-05 22:04)       // the badge is baked from tokens (INK) — a Style change repaints it (R, 09-05)
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
