// panels (client/lib/panels.js) — one schema, two renderers. renderDOM builds the desktop rows and wires
// each control to edit(k, payload); renderCanvas paints the VR quad and returns hit REGIONS carrying the
// same (action, payload); hitRegion turns a laser UV into one of them, snapping a slider to its step.
// Drives the REAL module under happy-dom with a recording 2D context.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/panels-schema-test.ts
//
// Each block names the product line that would silence it:
//   hitRegion returning the unsnapped slider value   → "slider hit snaps to step" goes red
//   check region payload no longer !value            → "check region payload is the flipped value" goes red
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'panels-stubs',
  setup(b) { b.onResolve({ filter: /^\.\/frames\.js$/ }, () => ({ path: here('./chat-frames-stub.mjs') })); },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

// a 2D context that records what was painted and accepts every property write
const paintLog: string[] = [];
HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : (...a: any[]) => { paintLog.push(`${String(k)}(${a.map((x) => typeof x === 'string' ? JSON.stringify(x) : x).join(',')})`); }),
    set: () => true,
  }) as any;
};

const { renderDOM, renderCanvas, hitRegion, makeSchemaFrame } = await import('../client/lib/panels.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const edits: any[][] = [];
const edit = (...a: any[]) => { edits.push(a); };
const last = () => JSON.stringify(edits.at(-1));
const FIELDS = [
  { t: 'info', label: 'world', value: 'garden' },
  { t: 'text', k: 'name', label: 'name', value: 'lamp', placeholder: 'a name' },
  { t: 'num', k: 'h', label: 'height', value: 1.5, step: 0.5, dp: 1, min: 0, max: 2 },
  { t: 'range', k: 'vol', label: 'volume', value: 0.25, min: 0, max: 1, step: 0.05, dp: 2, unit: '×' },
  { t: 'check', k: 'lit', label: 'lit', value: true },
  { t: 'check', k: 'dim', label: 'dim', value: false },
  { t: 'btn', k: 'del', label: 'remove', danger: true },
  { t: 'vec3', k: 'pos', label: 'pos', value: [1, 2, 3], step: 1, dp: 0 },
  { t: 'list', label: 'seats', rows: [{ id: 's1', label: 'bench', sub: 'north', active: true, actions: [{ k: 'sit', label: 'sit' }, { k: 'rm', label: 'x', danger: true }] }] },
];

console.log('PANELS — renderDOM: one row per field, each control wired to edit(k, payload)');
const body = document.createElement('div'); document.body.append(body);
renderDOM(body, FIELDS, edit);
const rows = [...body.children] as HTMLElement[];
check('nine rows, classed sp-f-<type>', rows.length === 9 && rows.every((r, i) => r.classList.contains(`sp-f-${FIELDS[i].t}`)), rows.map((r) => r.className).join('|'));
check('info shows the value as text', rows[0].querySelector('.sp-info')?.textContent === 'garden');
{ const inp = rows[1].querySelector('input.sp-text') as HTMLInputElement;
  check('text: an <input> with value + placeholder', inp?.value === 'lamp' && inp.placeholder === 'a name');
  inp.value = 'lantern'; inp.onchange!(new Event('change'));
  check('text change → edit("name", "lantern")', last() === '["name","lantern"]', last()); }
{ const num = rows[2].querySelector('input.sp-num') as HTMLInputElement, [minus, , plus] = [...rows[2].querySelectorAll('.sp-step > *')] as HTMLButtonElement[];
  check('number: stepper shows value at dp', num?.value === '1.5' && minus.className === 'sp-bump' && plus.className === 'sp-bump');
  plus.onclick!(new Event('click'));
  check('+ steps by step and clamps to max: edit("h", 2)', last() === '["h",2]', last());
  minus.onclick!(new Event('click'));
  check('− steps down from the typed value: edit("h", 1)', last() === '["h",1]', last());
  num.value = '-4'; num.onchange!(new Event('change'));
  check('a typed value clamps to min: edit("h", 0)', last() === '["h",0]', last());
  num.value = 'nope'; const n = edits.length; num.onchange!(new Event('change'));
  check('a non-number is ignored', edits.length === n); }
{ const sl = rows[3].querySelector('input.sp-range') as HTMLInputElement, out = rows[3].querySelector('.sp-range-val')!;
  check('slider: type=range with min/max/step and a unit readout', sl?.type === 'range' && sl.min === '0' && sl.max === '1' && sl.step === '0.05' && out.textContent === '0.25×', `${sl?.type} ${sl?.min}..${sl?.max}/${sl?.step} "${out.textContent}"`);
  check('progress fill --p follows the value', sl.style.getPropertyValue('--p') === '25%', sl.style.getPropertyValue('--p'));
  sl.value = '0.6'; sl.oninput!(new Event('input'));
  check('slider input → edit("vol", 0.6) as a NUMBER, readout repainted', last() === '["vol",0.6]' && out.textContent === '0.60×', `${last()} "${out.textContent}"`); }
{ const on = rows[4].querySelector('input[type=checkbox]') as HTMLInputElement, off = rows[5].querySelector('input[type=checkbox]') as HTMLInputElement;
  check('check: checkbox reflects value', on?.checked === true && off?.checked === false);
  on.checked = false; on.onchange!(new Event('change'));
  check('unticking → edit("lit", false)', last() === '["lit",false]', last());
  off.checked = true; off.onchange!(new Event('change'));
  check('ticking → edit("dim", true)', last() === '["dim",true]', last()); }
{ const b = rows[6].querySelector('button.sp-btn') as HTMLButtonElement;
  check('button: label is the button, danger classed, no separate label', b?.textContent === 'remove' && b.classList.contains('danger') && !rows[6].querySelector('.sp-label'));
  b.onclick!(new Event('click'));
  check('click → edit("del") with no payload', last() === '["del"]', last()); }
{ const steps = [...rows[7].querySelectorAll('.sp-step')];
  check('vec3: three steppers', steps.length === 3);
  (steps[1].lastElementChild as HTMLButtonElement).onclick!(new Event('click'));
  check('bumping y → edit("pos", [1,3,3])', last() === '["pos",[1,3,3]]', last()); }
{ const item = rows[8].querySelector('.sp-item') as HTMLElement;
  check('list: row is active, label + sub', item?.classList.contains('active') && item.querySelector('.sp-item-label')?.textContent === 'bench' && item.querySelector('.sp-item-sub')?.textContent === 'north');
  (item.querySelector('.sp-item-main') as HTMLElement).onclick!(new Event('click'));
  check('row click → edit("row", "s1")', last() === '["row","s1"]', last());
  const [sit, rm] = [...item.querySelectorAll('button.sp-mini')] as HTMLButtonElement[];
  rm.onclick!(Object.assign(new Event('click'), { stopPropagation() {} }));
  check('row action → edit("rm", "s1"), danger classed', last() === '["rm","s1"]' && rm.classList.contains('danger') && sit.textContent === 'sit', last());
  renderDOM(body, [{ t: 'list', label: 'x', rows: [], empty: 'no seats' }], edit);
  check('an empty list shows its empty text', body.querySelector('.sp-empty')?.textContent === 'no seats'); }

console.log('PANELS — makeSchemaFrame holds a refresh while an input is focused');
{ const { frame, set } = makeSchemaFrame('t', {});
  set([{ t: 'text', k: 'a', label: 'a', value: 'one' }], edit);
  const scroll = frame.body.querySelector('.schema-scroll')!;
  const inp = scroll.querySelector('input') as HTMLInputElement; inp.focus();
  set([{ t: 'text', k: 'a', label: 'a', value: 'two' }], edit);
  check('focused: the old input survives (caret kept)', scroll.querySelector('input') === inp && inp.value === 'one');
  inp.blur();
  check('blur: the queued state paints', (scroll.querySelector('input') as HTMLInputElement)?.value === 'two'); }

console.log('PANELS — renderCanvas: regions carry the same action/payload');
const cv = document.createElement('canvas');
const W = 512, ROW = 44, PAD = 12;
const regions = renderCanvas(cv, FIELDS, { width: W, rowH: ROW, pad: PAD, title: 'lamp' });
const rowsPainted = FIELDS.length + 1;   // + one list row
check('canvas sized to header + rows + padding', cv.width === W && cv.height === 30 + rowsPainted * ROW + PAD * 2, `${cv.width}×${cv.height}`);
check('title painted upper-cased', paintLog.some((l) => l.startsWith('fillText("LAMP"')));
const byAction = (a: string) => regions.filter((r: any) => r.action === a);
check('info/text paint but claim no region', byAction('name').length === 0 && !regions.some((r: any) => r.action === undefined));
check('btn: one region, action "del", no payload', byAction('del').length === 1 && !('payload' in byAction('del')[0]));
check('check region payload is the flipped value: lit(true)→false, dim(false)→true', byAction('lit')[0]?.payload === false && byAction('dim')[0]?.payload === true, JSON.stringify([byAction('lit')[0]?.payload, byAction('dim')[0]?.payload]));
check('check region is a square inside its row', (() => { const r = byAction('lit')[0]; return r && r.w === r.h && r.w === ROW - 16; })());
check('num: two bump regions with ±step, axis null', byAction('h').length === 2 && byAction('h').map((r: any) => r.payload.delta).join() === '-0.5,0.5' && byAction('h').every((r: any) => r.payload.axis === null));
check('vec3: six bumps, axes 0,0,1,1,2,2', byAction('pos').length === 6 && byAction('pos').map((r: any) => r.payload.axis).join() === '0,0,1,1,2,2');
check('list: row region + one region per action, payload = row id', byAction('row')[0]?.payload === 's1' && byAction('sit')[0]?.payload === 's1' && byAction('rm')[0]?.payload === 's1');
const slider = byAction('vol')[0];
check('range: ONE track region carrying {lo,hi,st}', byAction('vol').length === 1 && JSON.stringify(slider.slider) === '{"lo":0,"hi":1,"st":0.05}', JSON.stringify(slider?.slider));
check('rows stack: every region lies inside the canvas', regions.every((r: any) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= cv.height));

console.log('PANELS — hitRegion: UV → region; a slider hit is its snapped value');
const uvAt = (r: any, fx = 0.5, fy = 0.5) => [(r.x + r.w * fx) / cv.width, (r.y + r.h * fy) / cv.height];
{ const [u, v] = uvAt(byAction('del')[0]);
  check('a UV inside the button resolves to it', hitRegion(regions, cv, u, v)?.action === 'del'); }
check('a UV in the padding resolves to null', hitRegion(regions, cv, 0.5, 0.001) === null);
{ const [u, v] = uvAt(byAction('dim')[0]);
  check('a check hit hands back the flipped payload', hitRegion(regions, cv, u, v)?.payload === true); }
// the track proper is the region inset 6px each side; frac is measured along it
const trackU = (frac: number) => (slider.x + 6 + frac * (slider.w - 12)) / cv.width;
const vMid = (slider.y + slider.h / 2) / cv.height;
check('slider hit snaps to step: frac 0.333 → 0.35 (not 0.333)', hitRegion(regions, cv, trackU(0.333), vMid)?.payload === 0.35, String(hitRegion(regions, cv, trackU(0.333), vMid)?.payload));
check('slider hit: frac 0.5 → 0.5', hitRegion(regions, cv, trackU(0.5), vMid)?.payload === 0.5);
check('slider hit: frac 0.9 → 0.9', hitRegion(regions, cv, trackU(0.9), vMid)?.payload === 0.9, String(hitRegion(regions, cv, trackU(0.9), vMid)?.payload));
check('left edge (in the 6px inset) → lo', hitRegion(regions, cv, (slider.x + 1) / cv.width, vMid)?.payload === 0);
check('right edge (in the 6px inset) → hi', hitRegion(regions, cv, (slider.x + slider.w - 1) / cv.width, vMid)?.payload === 1);
{ const r2 = renderCanvas(cv, [{ t: 'range', k: 'deg', label: 'turn', value: 90, min: -180, max: 180, step: 15 }], {});
  const s = r2[0];
  check('a wide range with a coarse step: frac 0.6 → 36 snaps to 30, never 36', hitRegion(r2, cv, (s.x + 6 + 0.6 * (s.w - 12)) / cv.width, (s.y + s.h / 2) / cv.height)?.payload === 30, String(hitRegion(r2, cv, (s.x + 6 + 0.6 * (s.w - 12)) / cv.width, (s.y + s.h / 2) / cv.height)?.payload));
  check('value clamps into [min,max] before painting (no region past the track)', s.x + s.w <= cv.width); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
