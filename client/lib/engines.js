/** The engine roster. Importing a module registers it — that is the entire
 *  contract, and the only place engines are named.
 *
 *  Deliberately NOT a switch, a map, or a `type` field anyone has to extend:
 *  those are the enum basin, where every new engine edits code that already
 *  works. Here a new engine is a new file plus one line here, and nothing else
 *  in the tree changes — not the panel, not the accept list, not the matcher.
 *
 *  Each import is guarded on its own: an engine whose dependency is missing must
 *  not take the others down with it. A broken plugin should cost you that
 *  plugin, never the feature.
 */
const load = async (p) => { try { await import(p); } catch (e) { console.warn(`[voice] engine ${p} unavailable:`, e?.message || e); } };

await Promise.all([
  load('./engine-piper.js'),
  // Add engines here. Each file calls registerEngine() and owns everything
  // specific to itself: which files it takes, how it recognises them, how it
  // turns text into {pcm, sampleRate}.
]);
