// lock-strength-test — the Hierarchy row's padlock word is the strength of the lock the thing holds now.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/lock-strength-test.ts
import { scratchBench, mkCheck } from './harness.ts';
import { pagedEval } from './protocol/idalias.ts';
import { pageWaiter, tryUntil } from './protocol/wait.ts';

const WORLD = 'locks';
const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench('lock-strength', { worlds: [WORLD], owner: 'editbot', serverEnv: { TRUST_NAMES: '1', ACT_RATE: '1000' } });
const evalJson = pagedEval(evalRaw, ['crate', 'chest']);
const { check, tally } = mkCheck();
const waitFor = pageWaiter(evalJson, 20000);
const rowOf = (id: string) => `import('/lib/editpanels.js').then((E) => E.editPanelsDebug().hierFields().flatMap((f) => f.rows ?? []).find((r) => r.id === '${id}') ?? null)`;
const word = (id: string, w: string) => waitFor(`${rowOf(id)}.then((r) => r?.lockLevel === ${JSON.stringify(w)})`);
const ask = (verb: string, args: string) => evalJson(`import('/lib/net.js').then((m) => m.sendRequest('${verb}', ${args}))`);
const folded = (expr: string) => waitFor(`import('/lib/net.js').then((m) => { const e = m.replica.st.entities; return ${expr}; })`);

let ws: WebSocket | null = null;
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));` });
  await cdp.send('Page.navigate', { url: `${BASE}/?name=editbot&world=${WORLD}` });
  const secs = (await tryUntil('the client boots', async () => { const n = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; return n >= 4 ? n : 0; }, { ms: 60000 })) ?? 0;
  check('client boots', secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, 'the client did not boot');
  check('the fold is live', await waitFor(`import('/lib/net.js').then((m) => m.replica.active)`));

  const replies = new Map<string, (r: any) => void>();
  const bob = await new Promise<string>((res, rej) => {
    ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'join', world: WORLD, id: 'bob', avatar: '', replica: true }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'snapshot' && m.cut?.you) res(m.cut.you); if (m.type === 'reply') replies.get(m.id)?.(m); };
    ws.onerror = rej; setTimeout(() => rej(new Error('bob never joined')), 15000);
  });
  const bobAsks = (verb: string, args: unknown) => new Promise<any>((res) => { const id = `bob-${Math.random()}`; replies.set(id, res); ws!.send(JSON.stringify({ type: 'request', id, verb, args })); });
  check('(setup) bob is made a builder', (await ask('set', `{ id: '@world', component: 'roles:${bob}', value: { role: 'builder' } }`))?.ok === true);
  check('(setup) the owner makes a crate and a chest', (await ask('create', `{ id: 'crate', components: { transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'crate' } }`))?.ok === true
    && (await ask('create', `{ id: 'chest', components: { transform: { pos: [3, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'chest' } }`))?.ok === true);
  const crate = evalJson.ids.get('crate');

  // LS1 the owner's lock reads as the owner's
  await ask('set', `{ id: 'crate', component: 'lock', value: true }`);
  check('LS1 the owner locks the crate: its row says "owners only"', await word('crate', 'owners only'), JSON.stringify(await evalJson(rowOf('crate'))));
  await ask('delete', `{ id: 'crate', component: 'lock' }`);
  check('(setup) the owner lifts it', await folded(`!e['crate']?.c.lock`) && await waitFor(`${rowOf('crate')}.then((r) => !!r && r.lockLevel === undefined)`));
  // LS2 bob sets a new lock: a builder's
  const set = await bobAsks('set', { id: crate, component: 'lock', value: true });
  check('(setup) bob, a builder, locks it again', set?.ok === true && await folded(`!!e['crate']?.c.lock`), JSON.stringify(set));
  check('LS2 …and its row says "builders and up", the new lock\'s strength, not the lifted lock\'s', await word('crate', 'builders and up'), JSON.stringify(await evalJson(rowOf('crate'))));

  // LS3 a refused ask is asked again: the page's first inspect of the chest goes out naming nothing there, and is refused
  await evalJson(`import('/lib/net.js').then((m) => { window.__refused = 0; const real = m.net.ws.send.bind(m.net.ws); m.net.ws.send = (x) => { const r = JSON.parse(x);
    if (r.type === 'request' && r.verb === 'inspect' && r.args?.id === 'chest' && window.__refused === 0) { window.__refused++; r.args = { id: 'no-such-thing' }; return real(JSON.stringify(r)); } return real(x); }; return true; })`);
  await ask('set', `{ id: 'chest', component: 'lock', value: true }`);
  check('(setup) the chest\'s first ask is refused', await waitFor(`window.__refused === 1`) && await waitFor(`${rowOf('chest')}.then((r) => r?.lockLevel === 'builders and up')`), JSON.stringify(await evalJson(rowOf('chest'))));
  check('LS3 …and is asked again: the row comes to say "owners only"', await word('chest', 'owners only'), JSON.stringify(await evalJson(rowOf('chest'))));
  check('no page errors', (await evalJson(`window.__errs`))?.length === 0, JSON.stringify(await evalJson(`window.__errs`)));
} catch (e: any) { check('the test ran to the end', false, String(e?.stack ?? e).slice(0, 500)); }
finally {
  (ws as WebSocket | null)?.close();
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
