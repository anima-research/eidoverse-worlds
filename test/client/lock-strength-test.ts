// lock-strength-test — the Hierarchy row's padlock word is the strength of the lock the thing holds now.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/lock-strength-test.ts
import { scratchBench, mkCheck } from '../harness/harness.ts';
import { pagedEval } from '../harness/idalias.ts';
import { pageWaiter, tryUntil } from '../gate/wait.ts';
import { helloOf } from '../../shared/protocol/hello.js';

const WORLD = 'locks';
const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench('lock-strength', { worlds: [WORLD], owner: 'editbot', serverEnv: { TRUST_NAMES: '1', ACT_RATE: '1000' } });
const evalJson = pagedEval(evalRaw, ['crate', 'chest']);
const { check, tally } = mkCheck();
const waitFor = pageWaiter(evalJson, 20000);
const rowOf = (id: string) => `import('/lib/edit/panels.js').then((E) => E.editPanelsDebug().hierFields().flatMap((f) => f.rows ?? []).find((r) => r.id === '${id}') ?? null)`;
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
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'join', hello: helloOf(), world: WORLD, id: 'bob', avatar: '', replica: true }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'snapshot' && m.actor) res(m.actor); if (m.type === 'reply') replies.get(m.id)?.(m); };
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
  check('LS2 …and its row says "Builder and up", the new lock\'s strength, not the lifted lock\'s', await word('crate', 'Builder and up'), JSON.stringify(await evalJson(rowOf('crate'))));

  // LS3 a refused ask is asked again: the page's first inspect of the chest goes out naming nothing there, and is refused
  await evalJson(`import('/lib/net.js').then((m) => { window.__refused = 0; const real = m.net.ws.send.bind(m.net.ws); m.net.ws.send = (x) => { const r = JSON.parse(x);
    if (r.type === 'request' && r.verb === 'inspect' && r.args?.id === 'chest' && window.__refused === 0) { window.__refused++; r.args = { id: 'no-such-thing' }; return real(JSON.stringify(r)); } return real(x); }; return true; })`);
  await ask('set', `{ id: 'chest', component: 'lock', value: true }`);
  check('(setup) the chest\'s first ask is refused', await waitFor(`window.__refused === 1`) && await waitFor(`${rowOf('chest')}.then((r) => r?.lockLevel === 'Builder and up')`), JSON.stringify(await evalJson(rowOf('chest'))));
  check('LS3 …and is asked again: the row comes to say "owners only"', await word('chest', 'owners only'), JSON.stringify(await evalJson(rowOf('chest'))));
  // LS4 (#291) the Console frame's scripts list tells a roster read the world never answered from a world with no scripts
  await evalJson(`import('/lib/edit/build.js').then((b) => { b.setBuildMode(true); return true; })`);   // the panels poll the roster while build mode is on
  const cwatch = `import('/lib/edit/panels.js').then((E) => E.editPanelsDebug().consoleFields().find((f) => f.k === 'cwatch')?.empty ?? null)`;
  check('(control) LS4 the answered roster of a world with no scripts says so', await waitFor(`${cwatch}.then((e) => /^no scripts in this world/.test(e ?? ''))`), JSON.stringify(await evalJson(cwatch)));
  // the page's debug reads: 'pass' to the world, 'drop' (counted), 'fake': answered here with one script and its log, or
  // 'hold': a log read is kept in __held for the test to answer (the roster is answered as 'fake')
  await evalJson(`import('/lib/net.js').then((m) => { const real = m.net.ws.send.bind(m.net.ws); window.__debugMode = 'drop'; window.__dropped = 0;
    m.net.ws.send = (x) => { const q = JSON.parse(x); if (q.type !== 'debug' || window.__debugMode === 'pass') return real(x);
      if (window.__debugMode === 'drop') { window.__dropped++; return; }
      if (window.__debugMode === 'hold' && !q.scripts) { window.__held.push(q); return; }   // a log read answered later, by the test
      setTimeout(() => m._dispatch(q.scripts ? { type: 'debug', reqId: q.reqId, events: [{ ts: 0, kind: 'script', id: 'chest/blink', attach: 'chest', status: 'active' }] }
        : { type: 'debug', reqId: q.reqId, status: 'active', events: [{ ts: Date.now(), kind: 'script-log', line: 'blink says hi' }] }), 0); };
    return m.net.ws; }).then((s) => (window.__debugWs = s, true))`);
  const unanswered = await pageWaiter(evalJson, 30000)(`${cwatch}.then((e) => /couldn't be read/.test(e ?? ''))`);
  check("LS4 …and when the world stops answering it, says the scripts couldn't be read, not that there are no scripts", unanswered, JSON.stringify(await evalJson(cwatch)));
  check('(setup) LS4 …the reads were dropped, on the socket the page still uses', await evalJson(`import('/lib/net.js').then((m) => window.__dropped > 0 && m.net.ws === window.__debugWs)`), JSON.stringify(await evalJson(`window.__dropped`)));
  await evalJson(`(window.__debugMode = 'pass', true)`);
  check('LS4 …and says no scripts again once the world answers', await waitFor(`${cwatch}.then((e) => /^no scripts in this world/.test(e ?? ''))`), JSON.stringify(await evalJson(cwatch)));
  // LS5 a nonempty roster and a watched log, then no answer: both are kept and marked, neither read as answered
  const consoleNow = `import('/lib/edit/panels.js').then((E) => { const f = E.editPanelsDebug().consoleFields();
    return { rows: (f.find((x) => x.k === 'cwatch')?.rows ?? []).map((r) => r.id), notes: f.filter((x) => x.t === 'info').map((x) => x.value).join(' | '),
      log: f.find((x) => x.k === 'clog')?.label ?? null, lines: f.find((x) => x.k === 'clines')?.lines ?? null, empty: f.find((x) => x.k === 'clines')?.empty ?? null }; })`;
  await evalJson(`(window.__debugMode = 'fake', true)`);
  await evalJson(`import('/lib/edit/panels.js').then((E) => E.editPanelsDebug().watch('chest/blink')).then(() => true)`);
  check('(control) LS5 the answered roster lists the script, and its answered log its line', await waitFor(`${consoleNow}.then((c) => c.rows.includes('chest/blink') && /active/.test(c.log ?? '') && c.lines?.some((l) => /blink says hi/.test(l)))`), JSON.stringify(await evalJson(consoleNow)));
  await evalJson(`(window.__debugMode = 'drop', true)`);
  const kept = await pageWaiter(evalJson, 30000)(`${consoleNow}.then((c) => /couldn't be read/.test(c.notes))`);
  let c5 = await evalJson(consoleNow);
  check("LS5 …with no answer, the script is kept and said to be from the last answer", kept && c5.rows.includes('chest/blink') && /from the last answer/.test(c5.notes), JSON.stringify(c5));
  const logMiss = await pageWaiter(evalJson, 30000)(`${consoleNow}.then((c) => /couldn't be read/.test(c.log ?? ''))`);
  c5 = await evalJson(consoleNow);
  check("LS5 …and the log's line is kept under a status saying it couldn't be read", logMiss && c5.lines?.some((l: string) => /blink says hi/.test(l)) && !/active/.test(c5.log ?? ''), JSON.stringify(c5));
  // LS6 two log reads in flight (the Console polls every 2.5 s, a read waits 8 s): the older answer, landing last, changes nothing
  const heldFor = (id: string) => `window.__held.filter((q) => q.script === '${id}')`;
  await evalJson(`(window.__held = [], window.__debugMode = 'hold', true)`);
  check('(setup) LS6 two log reads of the watched script are in flight at once', await pageWaiter(evalJson, 15000)(`${heldFor('chest/blink')}.length >= 2`), JSON.stringify(await evalJson(`window.__held`)));
  const answerLog = (pick: string, status: string, line: string) => evalJson(`import('/lib/net.js').then(async (m) => { const q = ${pick};
    await m._dispatch({ type: 'debug', reqId: q.reqId, status: '${status}', events: [{ ts: Date.now(), kind: 'script-log', line: '${line}' }] }); return q.reqId; })`);   // one evaluate each: the newer lands first
  await answerLog(`${heldFor('chest/blink')}.at(-1)`, 'active', 'the newer read');
  await answerLog(`${heldFor('chest/blink')}.at(-2)`, 'asleep', 'the older read');   // the read just before: one poll (2.5 s) old, inside its 8 s, so it is still waiting
  const c6 = await evalJson(consoleNow);
  check('LS6 …the newer answer stands: its status and line, not the older one\'s', /active/.test(c6.log ?? '') && c6.lines?.some((l: string) => /the newer read/.test(l)) && !c6.lines?.some((l: string) => /the older read/.test(l)), JSON.stringify(c6));
  // LS7 the script watched before: its read, landing after a switch to another script, isn't shown as that one's log
  const before = await evalJson(`${heldFor('chest/blink')}.length`);
  check('(setup) LS7 a fresh log read of chest/blink is in flight', await pageWaiter(evalJson, 15000)(`${heldFor('chest/blink')}.length > ${before}`));
  await evalJson(`import('/lib/edit/panels.js').then((E) => { E.editPanelsDebug().watch('crate/glow'); return true; })`);   // not awaited: its own read is held
  await answerLog(`${heldFor('chest/blink')}.at(-1)`, 'active', 'blink after the switch');
  const c7 = await evalJson(consoleNow);
  check("LS7 …watching crate/glow, chest/blink's late answer isn't shown under crate/glow's name", /^crate\/glow — …$/.test(c7.log ?? '') && !c7.lines?.some((l: string) => /blink after the switch/.test(l)), JSON.stringify(c7));
  await evalJson(`import('/lib/edit/panels.js').then((E) => E.editPanelsDebug().watch(null)).then(() => (window.__debugMode = 'pass', true))`);
  check('no page errors', (await evalJson(`window.__errs`))?.length === 0, JSON.stringify(await evalJson(`window.__errs`)));
} catch (e: any) { check('the test ran to the end', false, String(e?.stack ?? e).slice(0, 500)); }
finally {
  (ws as WebSocket | null)?.close();
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
