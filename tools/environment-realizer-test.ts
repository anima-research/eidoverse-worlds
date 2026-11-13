// environment-realizer-test — the world-scope realizer (client/lib/realize/environment.js) hands world.js what the fold says,
// including what it no longer says (house review of #260, client/lib I8, I55).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/environment-realizer-test.ts
// world.js (the builders) is stood in and records each call; state.js and the realizer are real.
// Mutation (must go red): in environment.js make groundArgs return null without st.terrain (I8), or apply terrain/grass in
// reconcileEnvironment only when present (I55).
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
const calls: [string, any][] = [];
mock.module(fileURLToPath(new URL('../client/lib/world.js', import.meta.url)), () => ({
  applyTerrainState: (a: any) => calls.push(['terrain', a]), applyGrassState: (a: any) => calls.push(['grass', a]),
  applySkyFolded: (a: any) => calls.push(['sky', a]), applyAssetState: (a: any) => calls.push(['asset', a]),
}));
const S: any = await import('../client/lib/state.js');
const { emptyView } = await import('../shared/protocol/view.js');
const { initEnvironmentRealizer } = await import('../client/lib/realize/environment.js');
initEnvironmentRealizer();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const last = (k: string) => calls.filter(([c]) => c === k).at(-1);
const water = { level: 0.4, color: 0x2a6f8f };

// I8: water in a world with no terrain reaches the ground's builder (the flat ground), at join and when it changes
calls.length = 0; S.hydrate({ ...emptyView(), water });
check('a flat world with water: the join hands the ground builder its water', JSON.stringify(last('terrain')?.[1]) === JSON.stringify({ stageFloor: true, water }), JSON.stringify(calls));
calls.length = 0; S.applyView({ ...emptyView(), water: { ...water, level: 0.8 } });
check('…and a water change in a flat world does too', JSON.stringify(last('terrain')?.[1]) === JSON.stringify({ stageFloor: true, water: { ...water, level: 0.8 } }), JSON.stringify(calls));
calls.length = 0; S.applyView({ ...emptyView(), terrain: { size: 160 }, water });
check('with terrain, the water rides on the terrain\'s args as before', JSON.stringify(last('terrain')?.[1]) === JSON.stringify({ size: 160, water }), JSON.stringify(calls));

// I55: a (re)join whose fold has no terrain or grass any more clears them, instead of keeping the last session's
S.hydrate({ ...emptyView(), terrain: { size: 160 }, grass: { density: 1 } });
calls.length = 0; S.hydrate(emptyView());
check('a rejoin with no terrain hands the builder null (the stage floor returns)', last('terrain') !== undefined && last('terrain')![1] === null, JSON.stringify(calls));
check('…and with no grass, a mow', JSON.stringify(last('grass')?.[1]) === JSON.stringify({ clear: true }), JSON.stringify(calls));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
