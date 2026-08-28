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

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length < 2) {
  console.error('usage: node tools/browserlab-compare.mjs <receipt.json> <receipt.json> […]');
  process.exit(1);
}
const labs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) }));
const A = labs[0];

const r2 = (n) => +Number(n).toFixed(2);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const arm = (lab, name) => lab.arms.find((x) => x.arm === name);

// ---- the gate ---------------------------------------------------------------
// Each check names what it protects. A frame-time delta that survives all of
// them is about the renderer; one that does not is about the scene.
const CHECKS = [
  ['camera pose', (l) => l.camera && [l.camera.pos, l.camera.yaw, l.camera.pitch, l.camera.fov],
    'a few metres of dolly changes tile count, frustum and draw calls together'],
  ['drawing buffer', (l) => l.env.drawingBuffer,
    'fewer pixels is a rendering advantage nobody granted'],
  ['people present', (l) => l.scene?.people ?? null,
    'skinned bodies dominate frame cost at commons scale'],
  ['triangles', (l) => l.scene?.triangles ?? null, 'a different scene is a different question'],
  ['blades planted', (l) => l.scene?.grassDrawn ?? null, 'the foliage arms need the same meadow'],
  ['seconds per arm', (l) => l.secsPerArm, 'a shorter run has a shorter tail'],
];

console.log(`\n## browserlab comparison — ${labs.map((l) => l.label ?? l.file).join('  vs  ')}\n`);

let comparable = true;
const gate = [];
for (const [name, get, why] of CHECKS) {
  const vals = labs.map(get);
  const ok = vals.every((v) => same(v, vals[0]));
  if (!ok) comparable = false;
  gate.push(`| ${ok ? '✓' : '✗'} ${name} | ${vals.map((v) => `\`${JSON.stringify(v)}\``).join(' · ')} | ${ok ? '' : why} |`);
}
console.log('| gate | values | why it matters |');
console.log('|---|---|---|');
console.log(gate.join('\n'));

const tainted = labs.filter((l) => l.tainted);
for (const t of tainted) console.log(`\n⚠ **${t.label ?? t.file} is TAINTED** — ${t.tainted}`);
if (tainted.length) comparable = false;

const noFoliage = labs.filter((l) => l.foliage === 'absent');
for (const n of noFoliage) console.log(`\n⚠ ${n.label ?? n.file} had no grass field — its foliage arms changed nothing.`);

// ---- what they measured -----------------------------------------------------
console.log('\n### environment\n');
console.log(`| | ${labs.map((l) => l.label ?? l.file).join(' | ')} |`);
console.log(`|---|${labs.map(() => '---').join('|')}|`);
const envRow = (name, get) => console.log(`| ${name} | ${labs.map((l) => { const v = get(l); return v === null || v === undefined || v === '' ? '_not exposed_' : `${v}`; }).join(' | ')} |`);
envRow('backend', (l) => l.env.backend);
envRow('adapter vendor', (l) => l.env.adapter?.vendor);
envRow('adapter arch', (l) => l.env.adapter?.architecture);
envRow('navigator.gpu', (l) => String(l.env.hasNavigatorGpu));
envRow('devicePixelRatio', (l) => l.env.devicePixelRatio);
envRow('render scale', (l) => l.env.renderScale);
envRow('shadow casters', (l) => l.env.casterBudget);
envRow('cadence', (l) => l.env.refreshHint);
envRow('cores / memory', (l) => `${l.env.cores ?? '?'} / ${l.env.deviceMemoryGB ? l.env.deviceMemoryGB + 'GB' : '?'}`);

console.log('\n### frame time by arm (ms)\n');
console.log(`| arm | metric | ${labs.map((l) => l.label ?? l.file).join(' | ')} | delta |`);
console.log(`|---|---|${labs.map(() => '---').join('|')}|---|`);
for (const name of ['full', 'static', 'off']) {
  const as = labs.map((l) => arm(l, name));
  if (as.some((a) => !a)) continue;
  for (const metric of ['p50', 'p95', 'p99', 'max', 'over40ms']) {
    const vals = as.map((a) => a[metric]);
    const d = vals.length === 2 ? r2(vals[1] - vals[0]) : '';
    console.log(`| ${name} | ${metric} | ${vals.join(' | ')} | ${d === '' ? '' : (d > 0 ? '+' : '') + d} |`);
  }
}

// ---- the verdict ------------------------------------------------------------
console.log('');
if (!comparable) {
  console.log('**No browser delta is claimed.** One or more gates failed above: the two runs '
    + 'were not looking at the same thing, so any difference in frame time is unattributed. '
    + 'Fix the failing row and run again — the camera pose travels with `--camera=<receipt>.json`, '
    + 'and the buffer with `--size=WxH`.');
  process.exit(3);
}

// vsync headroom: when every arm sits on the refresh interval, the comparison
// has a FLOOR and cannot see a difference smaller than the monitor.
const allP50 = labs.flatMap((l) => l.arms.map((a) => a.p50));
const floor = Math.min(...allP50);
const pinned = allP50.every((p) => Math.abs(p - floor) < 0.5) && floor < 20;
const fulls = labs.map((l) => arm(l, 'full')).filter(Boolean);
const worst = fulls.map((a) => a.p95);

console.log('### verdict\n');
console.log(`Gates pass: the runs are comparable.`);
if (pinned) {
  console.log(`\n**Both are vsync-locked at ~${r2(floor)}ms (${Math.round(1000 / floor)}Hz) in every arm.** `
    + 'That is a FLOOR result, not a tie: this scene leaves both browsers enough headroom to hit '
    + 'the refresh interval, so the comparison can only report that neither one failed. '
    + 'To discriminate, run it where the reports came from — more skinned bodies, more triangles, '
    + 'a denser meadow — or against a display with a higher refresh rate.');
} else {
  const spread = r2(Math.max(...worst) - Math.min(...worst));
  console.log(`\nFull-foliage p95 spans ${worst.join(' → ')}ms — a spread of ${spread}ms between browsers `
    + 'at an identical camera, buffer and scene. That difference is attributable to the browser.');
}
const blind = labs.filter((l) => !l.env.adapter?.vendor);
if (blind.length) {
  console.log(`\n**Capability reporting gap:** ${blind.map((l) => l.label).join(', ')} exposed no adapter `
    + 'vendor/architecture. #42 asks that "browser/adapter capability and selected quality tier are '
    + 'inspectable in the HUD/debug receipt" — on those browsers the adapter half of that is currently '
    + 'unavailable to any receipt, ours included.');
}
console.log('');
