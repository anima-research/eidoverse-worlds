// ONE AudioContext for the whole page.
//
// Chrome caps a document at roughly six AudioContexts and then refuses to make
// more — and a refused context does not throw where you are looking, it simply
// never produces sound.
//
// SCOPE, precisely (Mica's review of #86, and she was right to narrow it): on
// current `main` there are **two** construction sites, both in `voice.js` —
// `micAnalyserLevel` at :258 and the peer analyser at :389. The first is the
// leak that matters: a FRESH context on every mic-stream change, never closed.
// Toggle the mic a handful of times and the document is out of contexts;
// whatever asks next — the ambient bed, a peer's analyser — silently gets a dead
// one, and the world goes quiet with nothing in the console to see.
//
// (An earlier version of this header said "five from four modules". That counted
// sites across in-flight branches, not what is on main. Two is the number a
// reviewer can check, so two is the number that belongs here.)
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

/** TEST-ONLY: drop the cached context so a suite can swap the constructor
 *  (deterministic graph-construction failure needs a FRESH broken context —
 *  the cache would happily keep serving the working one). */
export function __resetForTest() { ctx = null; }

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
