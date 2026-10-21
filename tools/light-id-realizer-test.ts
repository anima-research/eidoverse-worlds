// light-id-realizer-test — the client realizer keys a light by its id's text,
// as the fold does.
//
//   bun tools/light-id-realizer-test.ts
//
// The fold keys entities by an object key, so a history light of {id: 5}
// and a later update authored as "5" are one light in world state. #216's
// own advice for such a light is to supply id: "5". The realizer keyed its
// maps by the raw id, so that update realized a second light beside the
// first. This runs the real
// client/lib/realize/models.js and the real state and fold over the stub
// cone tools/lod-client-stub.mjs, which lod-client-test also uses: no
// renderer, a light is a bare group in the stub's scene.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('./lod-client-stub.mjs', import.meta.url));
plugin({
  name: 'light-id-realizer-stub',
  setup(b) {
    for (const f of ['^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$',
      '^\\.\\./lightrig\\.js$', '^\\.\\./lights\\.js$', '^\\.\\./world\\.js$',
      '^\\./core\\.js$', '^\\./warmqueue\\.js$', '^\\./loadwork\\.js$', '^\\./lightrig\\.js$',
      '^\\./emitters\\.js$', '^\\./terrain\\.js$', '^\\./remotes\\.js$', '^\\./frame\\.js$', '^\\./ui\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const stub: any = await import('./lod-client-stub.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const { emptyState } = await import('../shared/fold.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

M.initModelsRealizer();
S.hydrate(emptyState(), [], 0);
let seq = 1;
const fold = (verb: string, args: unknown) => S.foldLive({ seq: seq++, ts: 1_000_000 + seq, actor: 'old', verb, args });
const realized = (id: string) => stub.scene.children.filter((o: any) => o.userData?.entityId !== undefined && String(o.userData.entityId) === id);

// A light from before #216, with a numeric id, then the update #216 advises.
fold('light', { id: 5, pos: [1, 2, 3], color: 0xabcdef, intensity: 4, range: 8, placer: { id: 'builder' } });
check('the history light is realized once', realized('5').length === 1, String(realized('5').length));
fold('light', { id: '5', intensity: 9 });
check('the fold holds one light under "5", updated', Object.keys(S.state.st.entities).length === 1 && S.state.st.entities['5']?.intensity === 9,
  JSON.stringify(S.state.st.entities));
check('an update authored as "5" refreshes that light rather than realizing a second', realized('5').length === 1,
  realized('5').map((o: any) => JSON.stringify(o.userData.entityId)).join(', '));
check('the realized light is keyed by the text "5"', realized('5')[0]?.userData.entityId === '5', JSON.stringify(realized('5')[0]?.userData.entityId));
fold('remove', { id: 5 });
check('a remove authored with the number retires it', realized('5').length === 0, String(realized('5').length));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
