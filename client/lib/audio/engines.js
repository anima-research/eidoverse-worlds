/** The engine roster. Importing a module registers it: a new engine is a new file plus one line here, and nothing
 *  else changes (no switch or `type` field to extend). Each import is guarded on its own, so a broken engine costs
 *  only itself. */
const load = async (p) => { try { await import(p); } catch (e) { console.warn(`[voice] engine ${p} unavailable:`, e?.message || e); } };

await Promise.all([
  load('./engine-piper.js'),
  // Add engines here; each file calls registerEngine() and owns its file types, matching and text → {pcm, sampleRate}.
]);
