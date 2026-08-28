// browserlab-compare — put two receipts beside each other, and refuse to call
// a difference a BROWSER difference until it has earned that name (#42).
//
//   node tools/browserlab-compare.mjs tools/receipts-42/chrome-151.json \
//                                     tools/receipts-42/firefox-154.json
//
// Every field report on #42 so far has been a frame rate attached to a browser
// name, and none of them could be compared: different worlds, different crowds,
// different windows. So this checks the things that have to match BEFORE it
// prints a delta, and says plainly when they do not. A gate that fails is not a
// failure of the run — it is the run telling you what it is allowed to claim.
//
// The gate itself lives in client/lib/browserlab_core.js, so this tool and the
// in-page harness cannot drift apart about what "comparable" means, and so the
// rules are mutation-tested headless (tools/browserlab-core-test.ts).

import { readFileSync } from 'node:fs';
import { gateChecks, vsyncFloor, foliageCost } from '../client/lib/browserlab_core.js';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length < 2) {
  console.error('usage: node tools/browserlab-compare.mjs <receipt.json> <receipt.json> […]');
  process.exit(1);
}
const labs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) }));
const name = (l) => l.label ?? l.file;
const r2 = (n) => +Number(n).toFixed(2);
const arm = (lab, n) => (lab.arms ?? []).find((x) => x.arm === n);
const tick = String.fromCharCode(96);
const code = (v) => `${tick}${v}${tick}`;
const out = [];
const say = (s = '') => out.push(s);

say('');
say(`## browserlab comparison — ${labs.map(name).join('  vs  ')}`);
say('');

const gate = gateChecks(labs);
say('| gate | values | why it matters |');
say('|---|---|---|');
for (const row of gate.rows) {
  const vals = row.values.map((v) => (v === undefined || v === null ? '_absent_' : code(JSON.stringify(v)))).join(' · ');
  say(`| ${row.ok ? '✓' : '✗'} ${row.name} | ${vals} | ${row.ok ? '' : row.why} |`);
}
for (const t of gate.tainted) { say(''); say(`⚠ **${t.label ?? 'a run'} is TAINTED** — ${t.why}`); }
for (const n of labs.filter((l) => l.foliage === 'absent')) {
  say(''); say(`⚠ ${name(n)} had no grass field — its foliage arms changed nothing.`);
}

say('');
say('### environment');
say('');
say(`| | ${labs.map(name).join(' | ')} |`);
say(`|---|${labs.map(() => '---').join('|')}|`);
const envRow = (label, get) => {
  const cells = labs.map((l) => {
    let v; try { v = get(l); } catch { v = undefined; }
    return v === null || v === undefined || v === '' ? '_not exposed_' : `${v}`;
  });
  say(`| ${label} | ${cells.join(' | ')} |`);
};
envRow('backend', (l) => l.env?.backend);
envRow('adapter vendor', (l) => l.env?.adapter?.vendor);
envRow('adapter arch', (l) => l.env?.adapter?.architecture);
envRow('navigator.gpu', (l) => String(l.env?.hasNavigatorGpu));
envRow('devicePixelRatio', (l) => l.env?.devicePixelRatio);
envRow('render scale', (l) => l.env?.renderScale);
envRow('shadow casters', (l) => l.env?.casterBudget);
envRow('cadence', (l) => l.env?.refreshHint);
envRow('cores / memory', (l) => `${l.env?.cores ?? '?'} / ${l.env?.deviceMemoryGB ? l.env.deviceMemoryGB + 'GB' : '?'}`);
// draws are printed only when the harness could CLASSIFY the counter as a
// per-frame one; an unknown counter prints as unknown rather than as a number
envRow('draws / frame', (l) => {
  const a = arm(l, 'full');
  if (a?.drawCalls === null || a?.drawCalls === undefined) return `unknown (${String(a?.drawCounter ?? '').split(' — ')[0] || 'not recorded'})`;
  return `${a.drawCalls} (${String(a.drawCounter).split(' — ')[0]})`;
});
envRow('code under test', (l) => (l.build?.digest ? `${(l.build.sha ?? '?').slice(0, 7)} · ${l.build.digest}` : null));

say('');
say('### frame time by arm (ms)');
say('');
say(`| arm | metric | ${labs.map(name).join(' | ')} | delta |`);
say(`|---|---|${labs.map(() => '---').join('|')}|---|`);
for (const armName of ['full', 'static', 'off']) {
  const as = labs.map((l) => arm(l, armName));
  if (as.some((a) => !a)) continue;
  for (const metric of ['p50', 'p95', 'p99', 'max', 'over40ms']) {
    const vals = as.map((a) => a[metric]);
    const d = vals.length === 2 ? r2(vals[1] - vals[0]) : '';
    say(`| ${armName} | ${metric} | ${vals.join(' | ')} | ${d === '' ? '' : (d > 0 ? '+' : '') + d} |`);
  }
}

for (const l of labs) {
  const fc = foliageCost(arm(l, 'full'), arm(l, 'off'), { foliage: l.foliage });
  say('');
  say(`${name(l)} — foliage cost: ${fc.ok ? `**${fc.p50}ms** p50, **${fc.p95}ms** p95` : `_not computed — ${fc.why}_`}`);
  const st = arm(l, 'static')?.armEffect;
  if (st) {
    say(`  static arm scope: ${st.hooksFrozen} meadow-owned hooks released, ${st.windZeroed} wind amplitudes zeroed, `
      + `${st.foreignHooksLeftRunning} non-meadow hooks (sky, weather, emitters) left running.`);
  }
}

say('');
if (!gate.comparable) {
  say('**No browser delta is claimed.** One or more gates failed above: the two runs '
    + 'were not looking at the same thing, or one of them is not trustworthy, so any difference '
    + 'in frame time is unattributed. The camera pose travels with --camera=<receipt>.json, the '
    + 'buffer with --size=WxH, and a matching scene comes from measuring both browsers against '
    + 'the same seeded world without touching it in between.');
  console.log(out.join('\n'));
  process.exit(3);
}

say('### verdict');
say('');
say('Gates pass: the runs are comparable.');
const floor = vsyncFloor(labs);
if (floor) {
  say('');
  say(`**Both are vsync-locked at ~${floor.floor}ms (${floor.hz}Hz) in every arm.** `
    + 'That is a FLOOR result, not a tie: this scene leaves both browsers enough headroom to hit '
    + 'the refresh interval, so the comparison can only report that neither one failed. '
    + 'To discriminate, run it where the reports came from — more skinned bodies, more triangles, '
    + 'a denser meadow — or against a display with a higher refresh rate.');
} else {
  const worst = labs.map((l) => arm(l, 'full')?.p95).filter(Number.isFinite);
  const spread = r2(Math.max(...worst) - Math.min(...worst));
  say('');
  say(`Full-foliage p95 spans ${worst.join(' → ')}ms — a spread of ${spread}ms between browsers `
    + 'at an identical camera, buffer, scene digest and build. That difference is attributable to the browser.');
}
const blind = labs.filter((l) => !l.env?.adapter?.vendor);
if (blind.length) {
  say('');
  say(`**Capability reporting gap:** ${blind.map(name).join(', ')} exposed no adapter `
    + 'vendor/architecture. #42 asks that "browser/adapter capability and selected quality tier are '
    + 'inspectable in the HUD/debug receipt" — on those browsers the adapter half of that is '
    + 'currently unavailable to any receipt, ours included.');
}

say('');
say('_Scope: this comparison is valid for FROZEN SEEDED SCENES — a world whose entities and '
  + 'population do not change between the two runs, which the scene-digest and world-seq gates '
  + 'enforce. It is NOT yet validated for a live populated commons, where bodies move between '
  + 'sequential browser runs by definition; there the two runs would have to be simultaneous, or '
  + 'the scene frozen first._');
console.log(out.join('\n'));
