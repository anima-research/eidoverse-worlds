// The guard's label on every surface — ONE principal (Mica, #190 round 2, B2).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/guard-label-test.ts
//
// The state under test is the one guard-principal-test.ts proves the fold
// makes: Bobbie (subject human:discord:9002) placed and guarded a lamp; the
// world's owner, Ra, brightened it. The fold keeps the first placer and moves
// `actor` to Ra — deliberately, a re-light is a partial update. Round one's
// panels authorized by the placer and LABELLED by `actor`, so a stranger was
// correctly refused while every label told them the owner guarded it.
//
// Four surfaces, one fixture, three viewers (the placer, a stranger, the
// owner). Each label must name bobbie and must not name ra as the guard.
// Put `meta.actor` back into any of them and its leg goes red:
//   A. the edit-mode inspector bar (build.js showInspector);
//   B. the Del / drag refusal hint (build.js lockedHint — one function serves
//      both paths; the Del key is the one a test can press);
//   C. the scene panel: the disabled pose fields' reason, and "placed by"
//      (scenegraph.js paintScene);
//   D. MCPL look() (mcpl/agent.ts), serverless through the shared fold.
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SUB_BOB = 'human:discord:9002', SUB_CAROL = 'human:discord:9003', SUB_RA = 'human:discord:9001';
const PLACER = { id: 'bobbie', sub: SUB_BOB };
const T0 = 1_754_000_000_000;

// ---------------------------------------------------------------- D. MCPL look()
// First, before the DOM is registered: the agent is a node program.
console.log('\nD. MCPL look() — the fold-side label');
{
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const ag = new WorldAgent({ name: 'eye' });
  const A = ag as any;
  let seq = 1;
  const entry = (verb: string, args: Record<string, unknown>, actor: string) =>
    A.applyEntry({ verb, args, ts: T0 + seq, seq: seq++, actor }, false);
  // what the server logs: the stamp rides the light's args (verbs.ts stamps it)
  entry('light', { id: 'lamp1', pos: [1, 1, 1], intensity: 10, placer: PLACER }, 'bobbie');
  entry('comp', { id: 'lamp1', type: 'guard', data: true }, 'bobbie');
  entry('light', { id: 'lamp1', intensity: 40 }, 'ra');   // the owner brightens it
  const e = ag.entities.get('lamp1') as any;
  check('fixture: the fold kept the first placer and moved actor to the owner', e?.placer?.id === 'bobbie' && e?.actor === 'ra' && e?.comp?.guard === true, JSON.stringify({ placer: e?.placer, actor: e?.actor, guard: e?.comp?.guard }));
  const out = ag.look();
  const line = out.split('\n').find((l) => l.includes('lamp1')) ?? '';
  check('look() says guarded by the PLACER', /guarded by bobbie/.test(line), line);
  check('...and never by the latest actor', !/guarded by ra\b/.test(line), line);
}

// ---------------------------------------------------------------- the browser
plugin({ name: 'guard-label-stubs', setup(b) {
  for (const m of ['core', 'base', 'assets', 'lights', 'world', 'colliders', 'terrain', 'net', 'controller', 'ui', 'frames', 'seatedit', 'inspect', 'chat'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./guard-label-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
// sceneSelect scrolls the row into view and escapes the id for the selector
(globalThis as any).CSS ??= { escape: (s: string) => s };
(Element.prototype as any).scrollIntoView ??= () => {};

const stub = await import('./guard-label-stub.mjs');
const build = await import('../client/lib/build.js');
const sg = await import('../client/lib/scenegraph.js');

// the fixture, as realize/models.js mirrors it into entityMeta
const lamp = new (stub.THREE as any).Object3D();
lamp.userData.isLight = true;
stub.entities.set('lamp1', lamp);
stub.entityMeta.set('lamp1', { actor: 'ra', kind: 'light', ts: T0, placer: { ...PLACER } });
stub.comps.set('lamp1', { guard: true });

const as = (id: string, sub: string, role: string) => { const n = stub.net as any; n.myId = id; n.mySub = sub; n.myRights = { role }; };
const VIEWERS = [
  { who: 'the stranger', id: 'carol', sub: SUB_CAROL, role: 'builder', may: false },
  { who: 'the placer', id: 'bobbie', sub: SUB_BOB, role: 'builder', may: true },
  { who: 'the owner', id: 'ra', sub: SUB_RA, role: 'owner', may: true },
];
const inspectorHtml = () => { const ps = document.querySelectorAll('.panel'); return (ps[ps.length - 1] as HTMLElement)?.innerHTML ?? ''; };

console.log('\nA. the inspector bar');
for (const v of VIEWERS) {
  as(v.id, v.sub, v.role);
  build.select('lamp1');
  const html = inspectorHtml();
  check(`${v.who}: attribution names the placer, and the re-light as a last change`, /placed by bobbie · last change by ra/.test(html), html.slice(0, 200));
  if (!v.may) {
    check(`${v.who}: the read-only line says guarded by bobbie`, /🛡 guarded by bobbie/.test(html), html.slice(0, 300));
    check(`${v.who}: the guard checkbox's reason names bobbie`, /only bobbie or the world's owner can set or clear/.test(html), html.slice(0, 300));
  } else {
    check(`${v.who}: not read-only (authorized by ${v.role === 'owner' ? 'role' : 'subject'})`, !/🛡 guarded by/.test(html), html.slice(0, 300));
  }
  check(`${v.who}: no label anywhere says the owner guards it`, !/guarded by ra\b/.test(html) && !/only ra or/.test(html), html.slice(0, 300));
  build.deselect();
}

console.log('\nB. the Del / drag hint (lockedHint)');
{
  as('carol', SUB_CAROL, 'builder');
  build.setEditMode(true);
  build.select('lamp1');
  const h0 = stub.hints.length;
  stub.bus.emit('key', { code: 'Delete' });
  const hint = stub.hints.slice(h0).find((t: string) => /guarded/.test(t)) ?? '';
  check('the stranger pressing Del is refused with the placer\'s name', /guarded<\/b> by bobbie/.test(hint), JSON.stringify(stub.hints.slice(h0)));
  check('...not the latest actor\'s', !/by ra\b/.test(hint), hint);
  check('...and the thing is still selected (the removal never went out)', build.hasSelection() === true);
  build.deselect();

  as('bobbie', SUB_BOB, 'builder');
  build.select('lamp1');
  const h1 = stub.hints.length;
  stub.bus.emit('key', { code: 'Delete' });
  check('the placer pressing Del is not refused', !stub.hints.slice(h1).some((t: string) => /guarded/.test(t)) && build.hasSelection() === false, JSON.stringify(stub.hints.slice(h1)));
  build.setEditMode(false);
}

console.log('\nC. the scene panel');
sg.initSceneGraph();
for (const v of VIEWERS) {
  as(v.id, v.sub, v.role);
  sg.sceneSelect('lamp1');
  const html = stub.sections.get('scene')?.body.innerHTML ?? '';
  check(`${v.who}: "placed by" names the placer, and the re-light as a last change`, /placed by bobbie · last change by ra/.test(html), html.slice(0, 400));
  const posField = /<input type="number" data-tf="x"[^>]*>/.exec(html)?.[0] ?? '';
  if (!v.may) {
    check(`${v.who}: the pose fields are disabled with bobbie's name as the reason`, /disabled[^>]*title="guarded by bobbie/.test(posField), posField);
  } else {
    check(`${v.who}: the pose fields are live`, posField !== '' && !/disabled/.test(posField), posField);
  }
  check(`${v.who}: nothing says the owner guards it`, !/guarded by ra\b/.test(html), html.slice(0, 400));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
