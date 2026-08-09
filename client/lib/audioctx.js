// ONE AudioContext for the whole page.
//
// Chrome caps a document at roughly six AudioContexts and then refuses to make
// more — and a refused context does not throw where you are looking, it simply
// never produces sound. This page was creating FIVE from four modules, one of
// them (`micAnalyserLevel`) a fresh context on every mic-stream change, never
// closed. Toggle the mic a few times and the page is out of contexts; whatever
// asks next — the ambient world sound, a peer's analyser — silently gets a dead
// one. The world goes quiet with nothing in the console to see.
//
// So: everybody shares this. A single context is also the only way distance,
// the category sliders and the ambient bed can compose as one gain graph
// instead of several that cannot hear each other.
let ctx = null;

/** The page's AudioContext. Created on first use, resumed opportunistically. */
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Has one been made yet? (Probes: do not CREATE one just to look at it.) */
export const audioContextState = () => ctx?.state ?? 'none';

/** Resume on a real user gesture — the only thing that reliably works. */
export function resumeOnGesture(after) {
  const kick = () => {
    if (!ctx) return;
    ctx.resume().then(() => {
      if (ctx.state === 'running') {
        try { after?.(); } catch { /* caller's problem, not ours */ }
        for (const e of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(e, kick);
      }
    }).catch(() => {});
  };
  for (const e of ['pointerdown', 'keydown', 'touchstart']) addEventListener(e, kick);
}
