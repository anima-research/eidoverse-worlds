// micgate.js makeOnsetGate, driven one 20ms tick at a time on a clock we hold. One tick over the line opens the gate:
// that's deliberate.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/micgate-onset-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fileURLToPath } from 'node:url';
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };

const { makeOnsetGate } = await import(lib('audio/micgate.js'));
let clock = 1_000_000, tick = null, lv = 0.001;
const realNow = Date.now, realSI = globalThis.setInterval;
Date.now = () => clock;
globalThis.setInterval = (fn) => { tick = fn; return 1; };
const g = makeOnsetGate({ level: () => lv, threshold: () => 0.25, drive() {}, announce() {} });
g.start();
t('setup: start() handed us its tick', typeof tick === 'function');
const step = (level, n = 1) => { for (let i = 0; i < n; i++) { lv = level; clock += 20; tick(); } };
step(0.001, 40);                                   // settle + learn a quiet room (800ms)
t('setup: a quiet room is closed', g.info().speaking === false);
step(0.4, 1);
t('one tick over the line opens it (the deliberate one-tick open)', g.info().speaking === true);
step(0.001, 20);                                   // 400ms of quiet: inside the 700ms hang
t('the hang still holds through a pause', g.info().speaking === true);
step(0.001, 30);
t('and it closes after the hang', g.info().speaking === false);
step(0.001, 40);
step(0.4, 2);
t('setup: open before the restart', g.info().speaking === true);
g.stop(); g.start();                               // release + reacquire inside the 700ms hang
t('a restarted gate starts closed, not inside the old hang', g.info().speaking === false);
Date.now = realNow; globalThis.setInterval = realSI; g.stop();
console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);

