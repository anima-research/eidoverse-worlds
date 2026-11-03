// vrmic — ask for the microphone BEFORE the headset goes on, so voice just works inside it (the owner, 09-30: the
// first time a friend joins you in VR is when a missing mic is felt).
//
// A browser's permission prompt cannot be relied on to show during an immersive WebXR session — whether a given
// headset's own browser can is unknown, so this is built for the case where it can't. Two halves:
//
//   1. PRE-VR. The visor press reads the permission WITHOUT prompting (navigator.permissions.query). Only when the
//      answer is genuinely open ('prompt') and this browser has never chosen does a small 2D step ask "Voice in VR?" —
//      Allow runs getUserMedia on the flat page (the browser's own prompt shows normally) and stops those tracks at
//      once: permission is not consent to speak, the mic stays OFF until the person turns it on (voiceconsent.js).
//      Then an "Enter VR" button, because requestSession needs a FRESH user gesture and the prompt spent the first.
//   2. IN VR. The ring's mic press with the permission still open makes ONE bounded attempt through the one real
//      entry point (micstate.toggleMic → voicesfu's single acquisition). If no mic is live once it settles or TRY_MS
//      passes, the intent is RETRACTED (sfuMic(false): voicesfu re-reads intent after its await and drops whatever arrives late), a
//      head-locked note says why, and a flag makes the next flat-page moment ask. Nothing here is awaited by the exit.
//
// The decisions are vrmic_policy.js (pure, tested); this file is the effects.
import { bus, CONFIG } from './base.js';
import { flashHint, toast } from './ui.js';
import { THREE, camera, renderer } from './core.js';   // static: xr.js (our importer) already holds core, and the plate must land in the same breath as its words
import { quadMaterial } from './quadcolour.js';   // the plate's colours as authored, not ACES-washed (the VR panels' path)
import { preVrStep, inVrMicPlan, inVrAfterTry, afterExitStep, MIC_CHOICE_KEY, MIC_PENDING_KEY } from './vrmic_policy.js';

export const TRY_MS = 6000;          // long enough to answer a prompt the headset DOES show; short enough not to strand
const EXIT_ASK_DELAY_MS = 1500;      // after the session ends: lets a browser prompt left over from VR show first

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const remembered = () => { const v = ls.get(MIC_CHOICE_KEY); return v === 'allow' || v === 'later' ? v : null; };
const pending = () => ls.get(MIC_PENDING_KEY) === '1';
const setPending = (on) => ls.set(MIC_PENDING_KEY, on ? '1' : null);

/** The permission, read without prompting. Capped: a query that never answers must not hold up a VR entry. */
export async function micPermissionState() {
  try {
    const q = navigator.permissions?.query?.({ name: 'microphone' });
    if (!q) return 'unknown';
    const s = await Promise.race([q, new Promise((r) => setTimeout(() => r(null), 400))]);
    return ['granted', 'denied', 'prompt'].includes(s?.state) ? s.state : 'unknown';
  } catch { return 'unknown'; }
}

let presenting = false;
bus.on('xr:state', (on) => {
  presenting = !!on;
  if (presenting) return;
  clearNote();
  // NEVER awaited by the exit: a timer, and everything after it is its own business.
  if (pending()) setTimeout(() => { void askAfterExit(); }, EXIT_ASK_DELAY_MS);
});

const DENIED_FIX = 'open this site\'s settings (the icon at the left of the address bar), allow the microphone, then reload';
let deniedHinted = false;

// ── 1. the visor press ──────────────────────────────────────────────────────────────────────────────────────────────
let cardOpen = false, preflighting = false;
/** Called by xr.js's visor click with the rest of its entry flow. `proceed` runs at once (straight in) or from a later,
 *  fresh click on the step. Resolves to what happened: 'straight' | 'asked' | 'busy' (a press while one is in hand). */
export async function vrMicPreflight(proceed) {
  if (cardOpen) return 'asked';
  if (preflighting) return 'busy';   // a second press inside the (≤400 ms) permission read would open a second step
  preflighting = true;
  let state;
  try { state = await micPermissionState(); } finally { preflighting = false; }
  const d = preVrStep({ state, remembered: remembered(), pending: pending() });
  globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), lastPre: { state, ...d } };   // harness window
  if (d.step === 'straight') {
    if (d.hint === 'denied' && !deniedHinted) {
      deniedHinted = true;
      toast(`Microphone is blocked for this site, so voice won't work in VR. To fix it: ${DENIED_FIX}.`, 'warn', 10000);
    }
    proceed();
    return 'straight';
  }
  openCard({ mode: 'enter', proceed });
  return 'asked';
}

// ── 2. the ring's mic press while presenting ────────────────────────────────────────────────────────────────────────
let trying = false;
/** main.js routes the ring's 'xr:mic' here. Outside VR, or turning the mic off, it is exactly toggleMic. */
export async function xrMicPress() {
  const M = await import('./micstate.js');
  const turningOn = !M.micOn();
  const plan = turningOn && presenting ? inVrMicPlan({ turningOn, presenting, state: await micPermissionState() }) : 'proceed';
  if (plan === 'proceed') return M.toggleMic(CONFIG.name);
  if (plan === 'blocked') { vrNote('Microphone is blocked for this site — allow it in the browser\'s site settings after you leave VR'); return false; }
  if (trying) return false;                       // one attempt in flight is the whole budget
  trying = true;
  let rec = null;
  try {
    const t = M.toggleMic(CONFIG.name).then(() => 'settled', () => 'settled');
    const how = await Promise.race([t, new Promise((r) => setTimeout(() => r('timeout'), TRY_MS))]);
    const v = inVrAfterTry({ micOn: M.micOn(), state: await micPermissionState() });
    rec = { how, verdict: v };
    if (v === 'ok') return true;
    // Retract whether the try timed out OR settled without a mic: a press that landed before the voice lane had a
    // connection is only an INTENT (voicesfu wantMic), and the bridge replays it when the credential arrives — which
    // would be this same unanswerable request, made later, in the headset (probe 09-30: settled, wantMic still true).
    await retract();
    if (v === 'blocked') { vrNote(`Microphone is blocked for this site — allow it in the browser's site settings${presenting ? ' after you leave VR' : ''}`); return false; }
    setPending(true);
    // the session may have ended during the try: its exit read pending() before this set it, so the ask is ours to schedule
    if (presenting) vrNote('Microphone needs permission — you\'ll be asked when you leave VR');
    else setTimeout(() => { void askAfterExit(); }, EXIT_ASK_DELAY_MS);
    watchForGrant();
    return false;
  } finally {
    trying = false;
    // the harness window is written LAST, after every effect above has landed (a probe waiting on it saw the verdict
    // before the flag and the note existed)
    if (rec) globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), lastTry: rec };
  }
}

/** Take back a mic intent whose acquisition is still hanging. voicesfu re-reads intent after its getUserMedia await,
 *  so a device that arrives later is stopped there, not published (the ONE-ACQUISITION / re-read-intent rules). */
async function retract() {
  try {
    const S = await import('./voicesfu.js');
    if (S.sfuMicWanted() && !S.sfuMicOn()) { await S.sfuMic(false); bus.emit('audio:mic', false); }
  } catch { /* no transport in this context */ }
}

/** The permission can still change while in VR (a prompt the headset showed late, answered after the timeout).
 *  One watcher however many tries failed: each query is a fresh PermissionStatus, so N listeners meant N announcements. */
let watchingGrant = false;
function watchForGrant() {
  if (watchingGrant) return;
  const q = navigator.permissions?.query?.({ name: 'microphone' });
  if (!q) return;                                 // no Permissions API: nothing to watch, so not 'watching'
  watchingGrant = true;
  q.then((st) => {
    const on = () => {
      if (st.state !== 'granted') return;
      st.removeEventListener?.('change', on);
      watchingGrant = false;
      setPending(false);
      if (presenting) vrNote('Microphone allowed — press the mic to talk'); else flashHint('microphone allowed — press the mic to talk');
    };
    st.addEventListener?.('change', on);
  }, () => { watchingGrant = false; });
}

// ── the first flat-page moment after VR ─────────────────────────────────────────────────────────────────────────────
async function askAfterExit() {
  if (presenting || cardOpen) return;
  const step = afterExitStep({ pending: pending(), state: await micPermissionState() });
  if (step === 'none') return;
  if (step === 'clear') { setPending(false); flashHint('microphone allowed — it will work in VR now'); return; }
  if (step === 'clear-denied') { setPending(false); toast(`Microphone is blocked for this site. To use voice: ${DENIED_FIX}.`, 'warn', 10000); return; }
  openCard({ mode: 'after' });
}
export const __askAfterExit = askAfterExit;   // harness

// ── the 2D step ─────────────────────────────────────────────────────────────────────────────────────────────────────
function openCard({ mode, proceed = null }) {
  cardOpen = true;
  const scrim = document.createElement('div');
  scrim.id = 'vrmic'; scrim.className = 'scrim open';
  scrim.innerHTML = `<div class="sheet panel" role="dialog" aria-modal="true" aria-labelledby="vrmic-title">
    <div class="fr-head"><span class="fr-title" id="vrmic-title">${mode === 'enter' ? 'Voice in VR?' : 'Voice needs permission'}</span></div>
    <div class="vrmic-body">
      <p class="vrmic-say">${mode === 'enter'
        ? 'Inside the headset, the browser may not be able to ask for your microphone. Allow it here and voice will just work in VR.'
        : 'Your microphone couldn\'t be asked for inside VR. Allow it here and it will work next time you\'re in.'}</p>
      <p class="sub">Your mic stays off until you turn it on.</p>
      <div class="vrmic-btns">
        <button class="go" data-act="allow">Allow microphone</button>
        <button data-act="later">Not now</button>
      </div>
    </div></div>`;
  document.body.appendChild(scrim);
  const body = scrim.querySelector('.vrmic-body');
  const close = () => { if (!scrim.isConnected) return; scrim.remove(); cardOpen = false; removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });   // a cancel, not a choice: nothing remembered, no entry
  scrim.querySelector('[data-act=later]').onclick = () => {
    ls.set(MIC_CHOICE_KEY, 'later'); setPending(false);
    close();
    if (mode === 'enter') proceed?.();   // this click IS a fresh gesture: straight in
  };
  scrim.querySelector('[data-act=allow]').onclick = async (e) => {
    setPending(false);
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'waiting for the browser…';
    // Remembered only once the browser answers: while its prompt is open the permission still reads 'prompt', and a
    // stored 'allow' would send every later press straight in with nothing ever asking again.
    const asked = askDevice().then((r) => { ls.set(MIC_CHOICE_KEY, 'allow'); return r; });
    // bounded: a browser prompt left unanswered must not hold the way into VR (a late answer's tracks are still stopped)
    const got = await Promise.race([asked, new Promise((r) => setTimeout(() => r({ ok: false, name: 'unanswered' }), TRY_MS))]);
    globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), lastAsk: got };
    if (!scrim.isConnected) return;
    const result = (r) => (r.ok ? 'allowed' : r.name === 'unanswered' ? 'unanswered' : 'blocked');
    const sayFor = (r) => (r.ok
      ? 'Microphone allowed. It stays off until you turn it on — press the mic when you want to talk.'
      : r.name === 'NotFoundError'
        ? 'No microphone was found. VR works fine without one — you just won\'t be heard.'
        : r.name === 'unanswered'
          ? `The browser hasn't answered${mode === 'enter' ? ' — you can still enter VR' : ''}. If its prompt shows, answer it there.`
          : `The browser blocked the microphone, so VR will be without your voice. To change it later: ${DENIED_FIX}.`);
    body.innerHTML = `<p class="vrmic-say" data-result="${result(got)}">${sayFor(got)}</p>
      <div class="vrmic-btns"><button class="go" data-act="${mode === 'enter' ? 'enter' : 'done'}">${mode === 'enter' ? 'Enter VR' : 'Done'}</button></div>`;
    const go = body.querySelector('.go');
    go.onclick = () => { close(); if (mode === 'enter') proceed?.(); };   // the fresh gesture requestSession needs
    go.focus();
    if (got.name === 'unanswered') {
      void asked.then((late) => {
        globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), lastAsk: late };
        const p = scrim.isConnected && body.querySelector('.vrmic-say');
        if (p) { p.dataset.result = result(late); p.textContent = sayFor(late); }
      });
    }
  };
  scrim.querySelector('[data-act=allow]').focus();
}

/** One flat-page getUserMedia, for the PERMISSION only: every track is stopped before this returns, so the device
 *  light goes out and nothing is published. The voice lane acquires its own stream when the person turns the mic on. */
async function askDevice() {
  let s = null;
  try {
    s = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, name: e?.name ?? String(e) };
  } finally {
    for (const t of s?.getTracks?.() ?? []) { try { t.stop(); } catch { /* gone */ } }
    if (s) globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), stoppedTracks: s.getTracks().map((t) => t.readyState) };
  }
}

// ── the in-headset note ─────────────────────────────────────────────────────────────────────────────────────────────
// No toast reaches the eyes (toasts and the hint bar are DOM; only registered frames ride quads), so a short message
// gets its own head-locked plate: a child of the camera, 0.9 m out and a little low, drawn over the world.
let note = null;
export function vrNote(text, ms = 7000) {
  globalThis.__vrmic = { ...(globalThis.__vrmic ?? {}), note: text };
  if (!presenting) { flashHint(text); return; }
  try {
    clearNote();
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 176;
    const g = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const tok = (k, d) => css.getPropertyValue(k).trim() || d;
    const font = tok('--font', 'system-ui, sans-serif');
    g.fillStyle = `rgb(${tok('--panel-rgb', '5 20 20').split(/\s+/).join(',')})`;
    g.beginPath(); g.roundRect(6, 6, 1012, 164, 36); g.fill();
    g.strokeStyle = tok('--attn', '#ffc46b'); g.lineWidth = 4; g.stroke();
    g.fillStyle = tok('--fg', '#ebebe9'); g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 44; g.font = `500 ${size}px ${font}`;
    while (g.measureText(text).width > 940 && size > 24) { size -= 2; g.font = `500 ${size}px ${font}`; }
    g.fillText(text, 512, 88);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.56 * 176 / 1024),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    quadMaterial(mesh, renderer);
    mesh.renderOrder = 3000; mesh.frustumCulled = false; mesh.position.set(0, -0.14, -0.9); mesh.name = 'vrmic-note';
    camera.add(mesh);
    note = { mesh, tex, canvas: cv, timer: setTimeout(clearNote, ms) };
    const m = mesh.material;
    Object.assign(globalThis.__vrmic, { noteCanvas: cv, noteMesh: mesh, noteAt: performance.now(), noteParent: mesh.parent?.type ?? null, noteZ: mesh.position.z,
      noteMat: { node: !!m.isNodeMaterial, output: !!m.outputNode, depthTest: m.depthTest, depthWrite: m.depthWrite } });
  } catch (e) { flashHint(text); console.warn('[vrmic] note', e); }
}
function clearNote() {
  if (!note) return;
  clearTimeout(note.timer);
  if (globalThis.__vrmic) Object.assign(globalThis.__vrmic, { noteClearedAt: performance.now(), noteCanvas: null, noteMesh: null });
  note.mesh.removeFromParent(); note.mesh.geometry.dispose(); note.mesh.material.dispose(); note.tex.dispose();
  note = null;
}
export const vrNoteShown = () => !!note?.mesh?.parent;
