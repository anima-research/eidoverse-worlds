// mictoggle — the mic badge beside the ∃ (self-injecting; main.js, ui-menu.js and the XR modules import its state): mic off by default, since a body
// wakes up silent. A headphone glyph beside it gates INCOMING voice separately; V toggles the mic.

import { micOn, toggleMic, setPttHeld, pttHeld } from './micstate.js';
import { setSTT, sttAvailable } from './stt.js';
import { CONFIG } from '../base.js';
import { receivingVoice, setReceiveVoice, ensureSttConsent, sttConsented,
  isHushed, setHush, pttMode } from './voiceconsent.js';
import { bus } from '../base.js';
import { register as registerAction } from '../ui/actions.js';
import { pathData } from '../ui/icons.js';

// Three states: off = dim + slash · live = brand · hot (your voice registering) = attention gold with a glow.
// ONE palette for both glyphs: they read as a pair, so any divergence reads as a state difference. The headphone's
// stroke is thinner (its filled cups carry more ink than the mic's thin strokes) so the two weigh the same to the eye.
// Inks come from the token sheet, read off the BUTTON on each paint so live token edits and build mode's re-pointed
// OFF inks (index.html body.edit-workspace #micbtn…: --dim, --edge-hi) restyle the glyphs too.
const tok = (n, fb) => (getComputedStyle((micBtn?.isConnected && micBtn) || document.documentElement).getPropertyValue(n) || fb).trim();
const INK = {
  get off()   { return tok('--dim', '#7d8f8a'); },
  get absent() { return tok('--edge-hi', 'rgb(255 255 255 / 0.32)'); },   // lighter than off: 'here, but nothing to talk to'
  get on()    { return tok('--brand', '#8fe8c8'); },   // live = brand, like the ∃
  get hot()   { return tok('--attn', '#ffd66b'); },
  // the slash is the OFF ink, not an alarm: silent is the rest state
  get slash() { return tok('--dim', '#7d8f8a'); },
};

const MIC_SVG = (on, hot) => {
  const c = hot ? INK.hot : on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 32 32" width="26" height="26" style="${hot ? `filter:drop-shadow(0 0 5px ${INK.hot})` : ''}">
  <g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round">
    <rect x="12" y="5" width="8" height="14" rx="4" fill="${hot ? c : 'none'}"${hot ? ' fill-opacity=".35"' : ''}/>
    <path d="M8 15 a8 8 0 0 0 16 0"/>
    <line x1="16" y1="23" x2="16" y2="27"/>
    <line x1="11" y1="27" x2="21" y2="27"/>
    ${on ? '' : `<line x1="7" y1="4" x2="25" y2="28" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

// the headphone: consent to HEAR voices (peers and agent TTS), off by default; ambience has its own slider
const EAR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  const [band, cupL, cupR, slash] = pathData('headphonesOff');
  return `
<svg viewBox="0 0 24 24" width="26" height="26">
  <g fill="none" stroke="${c}" stroke-width="1.35" stroke-linecap="round">
    <path d="${band}"/>
    <path d="${cupL}"/>
    <path d="${cupR}"/>
    ${on ? '' : `<path d="${slash}" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

// Phosphor 'visor' (MIT)
const VISOR = { regular: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.85.74,32-5.9,49.38-20.3a15.88,15.88,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56Zm40.81,111.34A55.63,55.63,0,0,1,184,184c-13.88,0-27-9.51-35.65-16.67a31.91,31.91,0,0,0-40.65,0C93.52,179,80.94,184.49,69.28,183.94a56.36,56.36,0,0,1-53.22-53.28A56,56,0,0,1,72,72H183.05c31,0,56.55,24.79,56.95,55.25A55.66,55.66,0,0,1,223.86,167.34ZM184,96a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,96Z', fill: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.84.72,32-5.9,49.38-20.3a15.87,15.87,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56ZM176,104H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Z' };
const XR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 256 256" width="26" height="26" fill="${c}"><path d="${VISOR.regular}"/>${on ? '' : `<line x1="56" y1="32" x2="200" y2="224" stroke="${INK.slash}" stroke-width="14" stroke-linecap="round"/>`}</svg>`;
};

let micBtn = null, earBtn = null, xrBtn = null;
// OPTIONAL: xr.js registers it only where isSessionSupported('immersive-vr')
let xrHook = null;   // { onclick, live: () => bool }
// isSessionSupported answers once at boot: when a request is refused for want of a device, the visor greys, blinks
// twice and keeps an attention tooltip until the next successful entry, rather than failing silently
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
// the glyph reads the LIVE transport: it must never say private while the room hears you
const micIsOn = () => {
  // never throw: a throw aborts the tick before paint() and freezes the glyph
  // prefer the cheap getter: relayDiag() allocates, and this runs 8×/s
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return window.relayDiag?.().micPublished ?? micOn();
  } catch { return micOn(); }
};
// mic and hearing state ride the pose packet to everyone, agents included (docs/reference/POSE-WIRE.md "Voice state — who sees
// it"); the tooltip says so
const SHARED = '\nmic and hearing on/off are visible to everyone in this world';
function paint() {
  if (!micBtn) return;
  const on = micIsOn();
  const deaf = on && !receivingVoice();
  micBtn.innerHTML = MIC_SVG(on, on && micHot);
  micBtn.style.opacity = deaf ? '0.55' : '1';
  // under PTT an armed mic isn't heard until the key is down: never say live while private, or private while live
  micBtn.title = !on ? (pttMode() ? 'mic off (click to arm push-to-talk)' : 'mic off (V to talk)')
    : pttMode() ? (pttHeld() ? 'transmitting — release V to stop'
                             : 'push-to-talk armed — hold V to speak')
    : deaf ? 'mic LIVE — but you are not hearing the room (click the headphones to listen)'
    : 'mic LIVE — the world hears you (V)';
  micBtn.title += SHARED;
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
    // hushed reads as OFF; hushed vs revoked lives in the tooltip and panel
    earBtn.style.opacity = '1';
    earBtn.title = !consented
      ? 'not receiving voices at all — click to allow (world sound unaffected)'
      : isHushed()
        ? 'hushed — voices still arriving, click to listen again mid-sentence'
        : 'hearing voices — click to hush (Audio panel revokes entirely)';
    earBtn.title += SHARED;
  }
}
// hot = your voice is registering: an analyser polled at 8 Hz
import { micAnalyserLevel as meshMicLevel } from './micstate.js';
// ask the live transport's level first (the SFU's), or the glyph can never go hot
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

setInterval(() => {
  if (!micIsOn()) { if (micHot) { micHot = false; paint(); } return; }
  const lvl = micLevelNow();
  // the analyser reads the RAW side, so under PTT the glow also needs the key: gold means the mic is on and loud (under voice activation the gate may still be shut)
  const hot = lvl > 0.02 && (!pttMode() || pttHeld());
  if (hot !== micHot) { micHot = hot; paint(); }
}, 125);

// ---- pair API for the ∃ menu: rows toggle these; per-glyph pins decide whether each hangs off the ∃
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
// in PTT mode V holds to talk instead
registerAction({ id: 'voice:mic', title: 'microphone on / off', group: 'voice', key: 'V', icon: 'mic',
  keywords: ['mic', 'mute', 'unmute', 'talk', 'speak', 'voice'], run: () => flipMic() });
registerAction({ id: 'voice:ear', title: 'hear voices on / off', group: 'voice', icon: 'headphones',
  keywords: ['ear', 'hush', 'deafen', 'headphones', 'listen', 'voice'], run: () => flipEar() });
export const xrGlyph = (size = 16) => XR_SVG(xrLive()).replace('width="26" height="26"', `width="${size}" height="${size}"`);
/** For the in-VR indicator (xrmicicon.js): hot = on and loud (raw level; under PTT only while the key or left A/X is held). */
export const micIndicatorState = () => (!micIsOn() ? 'off' : micHot ? 'hot' : 'on');
export const micIndicatorSvg = (size = 64) => MIC_SVG(micIsOn(), micHot).replace('width="26" height="26"', `width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"`);
export const micGlyph = (size = 16) => MIC_SVG(micIsOn(), false).replace('width="26" height="26"', `width="${size}" height="${size}"`);
/** The glyphs for a given state, in the inks they would paint now (harness: client-check MIC reads them in and out of build mode). */
export const micGlyphFor = (on, hot) => MIC_SVG(!!on, !!hot);
export const earGlyphFor = (on) => EAR_SVG(!!on);
export const earGlyph = (size = 16) => { let on = false; try { on = receivingVoice() && !isHushed(); } catch {} return EAR_SVG(on).replace('width="26" height="26"', `width="${size}" height="${size}"`); };

async function flipMic() {
  const on = await toggleMic(CONFIG.name);
  // speech-to-text is a separate consent (audio goes to the browser vendor's cloud): ask once, remember the answer
  if (on && sttAvailable()) {
    // the question can stay open while the mic goes off again: a yes still counts, but the recognizer holds its own capture
    if (await ensureSttConsent() && micIsOn()) setSTT(true);
  } else setSTT(false);
  paint();
}

// CLICK = hush (a gain change; unhushing rejoins mid-line); revoking consent (the server stops forwarding voice) is the Audio panel's.
// Clicking while unconsented grants consent first.
function flipEar() {
  if (!receivingVoice()) { setReceiveVoice(true); setHush(false); }
  else setHush(!isHushed());
  paint();
}

function ensure() {
  const hud = document.querySelector('#hud');
  if (!hud || (document.contains(micBtn) && document.contains(earBtn) && document.contains(xrBtn))) return;
  // a sibling AFTER the hud: setHud(innerHTML) would erase a child
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
  placeMic();
}
// ResizeObserver on the hud's box; the slow interval only catches what no observer sees (font swaps, zoom)
let _hudRO = null, _hudSeen = null;
function placeMic() {
  const hud = document.querySelector('#hud');
  if (!hud || !micBtn) return;
  const r = hud.getBoundingClientRect();
  // along the ∃'s edge; fold perpendicular only when a corner leaves no room
  const edge = document.getElementById('dock')?.dataset.edge || 'left';
  // windows.js CHROME_ANCHOR reads `dataset.edge` (else `|| 'left'` wins), in both placements
  for (const b of [micBtn, earBtn, xrBtn]) if (b) b.dataset.edge = edge;
  const cx = Math.round(r.left + (r.width - 26) / 2);
  const cy = Math.round(r.top + (r.height - 26) / 2);
  const pos = (b, x, y) => { b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.right = b.style.bottom = ''; };
  const vert = edge === 'left' || edge === 'right';
  const room = vert ? r.top : r.left;              // space before the ∃ along the rail
  // mic is ALWAYS top/left; a lone pinned glyph packs into the slot nearest the ∃
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
bus.on('dock-moved', placeMic);   // while the rail is dragged
setInterval(placeMic, 2000);          // safety net only
// the glyph REFLECTS state, never owns it: every surface that changes hush/consent repaints it
bus.on('audio:hush', paint);
bus.on('audio:receive', paint);
bus.on('audio:mic', paint);   // without it the glyph repaints only from its poll
bus.on('style', paint);
bus.on('xr:state', paint);
// build mode moves the ∃ into the workspace's corner and re-inks the glyphs: re-seat and repaint once its CSS is on
bus.on('build-mode', () => requestAnimationFrame(() => { paint(); placeMic(); }));
setInterval(ensure, 1000);
ensure();

// "typing" means a text field, not any input: focus stays on a checkbox after a click (e.g. enabling PTT), and V must
// still work there; only where V would insert a character is it ignored
const TEXT_INPUT = /^(text|search|url|email|password|number|tel|)$/i;   // '' = default type
const typingTarget = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type ?? '');
};
window.addEventListener('keydown', (e) => {
  if (e.repeat || typingTarget()) return;
  if (e.code !== 'KeyV' || e.shiftKey) return;
  // V only speaks: hush is a click on 🎧, revoking lives in the Audio panel (near-identical gestures mislead)
  if (pttMode()) {
    if (micIsOn()) { setPttHeld(true); paint(); }
    return;
  }
  flipMic();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'KeyV') return;
  setPttHeld(false);   // harmless in voice-activation mode; vital in PTT
  if (pttMode()) paint();
});
// the stuck key: keyup never arrives if focus left with the key down, and PTT would ship an open mic that says closed
window.addEventListener('blur', () => { setPttHeld(false); if (pttMode()) paint(); });
