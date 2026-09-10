// Settings panels (rung 3, desktop UI): the style dial, the video rows, the profile's presence and
// the bodies list — driven through the REAL stylepanel.js / videopanel.js / profile.js / bodies.js /
// mybody.js / presence.js / ui.js / frames.js / panels.js, with only the renderer-bound edge stubbed
// (tools/settings-panels-stub.mjs). Each block names the product line that must turn it red:
//   · setPanelAlpha not persisted (stylepanel.js)          → "survives a re-apply from storage"
//   · renderer select without needsReload (videopanel.js) → "grows the reload button"
//   · presence dispatch not reaching setPresence (profile.js) → "presence() is busy" / "dock dot"
//   · announceWorn not emitting avatar-worn (mybody.js)          → "announceWorn emits avatar-worn with the name (the switch site and the initial body call it)"
//
// RED AT HEAD 1fd6af8 (a product finding, kept honest rather than skipped): mybody.setMe emits
// avatar-worn with a `{ name, path }` payload, but bodies.js's `noteWorn(name)` — its only consumer —
// treats the payload as the name string, so `worn` fills with objects, the roster filter never matches,
// and the list stays "nothing worn yet" no matter what you put on. One of the two files must change
// (noteWorn accepting `{name}`, or setMe emitting the name); the five BODIES list checks turn green then.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/settings-panels-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'settings-stubs', setup(b) {
  for (const m of ['core', 'base', 'governor', 'lightrig', 'xrpanels', 'net', 'palette', 'avatar', 'controller', 'capnotice', 'assets', 'mictoggle'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./settings-panels-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
// happy-dom's global registrar ships no `Option`; videopanel builds its selects with `new Option(text, value)`
(globalThis as any).Option = function (text: string, value?: string) { const o = document.createElement('option'); o.text = text; if (value !== undefined) o.value = value; return o; };
// mybody starts a roster fetch at import on a cold cache; nothing to fetch here
globalThis.fetch = (async () => new Response('[]', { status: 200 })) as any;
// the elements ui.js binds at import, plus the sheet's own tokens the style panel reads back
for (const id of ['hud', 'loading', 'toasts', 'hintbar', 'door', 'help', 'dock', 'touch']) { const d = document.createElement('div'); d.id = id; document.body.append(d); }
const sheet = document.createElement('style');
sheet.textContent = ':root{--panel-a:.9;--panel-rgb:20 24 28;--brand:#aabbcc;--attn:#ff5533;--fg:#eeeeee}';
document.head.append(sheet);
// the dock's profile button: what paintPresence (ui.js) repaints on presence:me
const dockBtn = document.createElement('button'); dockBtn.dataset.toggles = 'profile'; document.getElementById('dock')!.append(dockBtn);

const stub = await import('./settings-panels-stub.mjs');
const { calls, emitted, xrPanels, net, bus } = stub;
const ui = await import('../client/lib/ui.js');
const style = await import('../client/lib/stylepanel.js');
const video = await import('../client/lib/videopanel.js');
const profile = await import('../client/lib/profile.js');
const mybody = await import('../client/lib/mybody.js');
const presence = await import('../client/lib/presence.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const root = () => document.documentElement.style;
const computed = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const tokens = () => JSON.parse(localStorage.getItem('ew-style-tokens') || '{}');
const since = (i: number, name: string) => calls.slice(i).filter((c) => c[0] === name);
const emits = (i: number, t: string) => emitted.slice(i).filter((e) => e[0] === t).length;
const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
const openSection = async (id: string) => { const sec = document.getElementById(`sec-${id}`)!; (sec.querySelector('.head') as HTMLElement).click(); await tick(); return sec.querySelector('.body')!; };

// ============================================================ style: --panel-a
console.log('STYLE — setPanelAlpha persists and repaints --panel-a');
{ style.initStylePanel();
  const body = await openSection('style');
  const slider = body.querySelector('input[type=range]') as HTMLInputElement;
  const readout = slider.nextElementSibling as HTMLElement;
  check('the slider starts from the sheet\'s value', slider.value === '0.9', slider.value);
  slider.value = '0.5'; fire(slider, 'input');
  check('dragging the dial repaints --panel-a on :root', computed('--panel-a') === '0.5', computed('--panel-a'));
  check('the readout follows', readout.textContent === '0.50', readout.textContent ?? '');
  check('the value is persisted with the style tokens', tokens()['--panel-a'] === '0.5', JSON.stringify(tokens()));
  style.setPanelAlpha(0.66);
  check('setPanelAlpha(0.66) repaints', computed('--panel-a') === '0.66', computed('--panel-a'));
  check('…and persists', tokens()['--panel-a'] === '0.66', JSON.stringify(tokens()));
  // persistence is what a reload would read: wipe the live property and re-apply from storage
  root().removeProperty('--panel-a');
  check('(control) the sheet value shows once the live property is gone', computed('--panel-a') === '.9', computed('--panel-a'));
  style.applyStyleTokens();
  check('survives a re-apply from storage (what the next boot does)', computed('--panel-a') === '0.66', computed('--panel-a'));
  // a colour swatch: live token + persisted + the repaint event sprites listen for
  const e0 = emitted.length;
  const sw = body.querySelectorAll('input[type=color]')[1] as HTMLInputElement;   // accent (--brand)
  sw.value = '#112233'; fire(sw, 'input');
  check('a swatch repaints its token', computed('--brand') === '#112233', computed('--brand'));
  check('…persists it', tokens()['--brand'] === '#112233');
  check('…and emits style{--brand}', emitted.slice(e0).some((e) => e[0] === 'style' && e[1]?.key === '--brand'));
  (body.querySelector('button') as HTMLElement).click();   // reset to defaults
  check('reset clears the live tokens', computed('--panel-a') === '.9' && computed('--brand') === '#aabbcc', `${computed('--panel-a')} ${computed('--brand')}`);
  check('reset empties the store', Object.keys(tokens()).length === 0, JSON.stringify(tokens()));
  check('reset repaints the slider from the sheet', slider.value === '0.9', slider.value);
}

// ============================================================ video rows
console.log('VIDEO — renderer select persists PREF_BACKEND and needs a reload');
{ video.initVideoPanel();
  const body = await openSection('video');
  const sel = (label: string) => body.querySelector(`select[aria-label^="${label}"]`) as HTMLSelectElement;
  const row = (el: Element) => el.closest('.row') as HTMLElement;
  const renderer = sel('renderer');
  check('renderer row exists with three choices', !!renderer && renderer.options.length === 3);
  check('no reload button before a change', !row(renderer).querySelector('.reload'));
  renderer.value = 'webgl'; fire(renderer, 'change');
  check('force WebGL writes PREF_BACKEND', localStorage.getItem(stub.PREF_BACKEND) === 'webgl', String(localStorage.getItem(stub.PREF_BACKEND)));
  check('grows the reload button (the row needs a reload)', !!row(renderer).querySelector('button.reload'));
  renderer.value = 'webgpu'; fire(renderer, 'change');
  check('force WebGPU writes PREF_BACKEND', localStorage.getItem(stub.PREF_BACKEND) === 'webgpu');
  check('the reload button is not duplicated', row(renderer).querySelectorAll('button.reload').length === 1);
  renderer.value = 'auto'; fire(renderer, 'change');
  check('auto removes the key', localStorage.getItem(stub.PREF_BACKEND) === null);
  check('force WebGPU is greyed on a machine without WebGPU (stub: WEBGPU_POSSIBLE=false)', (renderer.querySelector('option[value=webgpu]') as HTMLOptionElement).disabled);

  console.log('VIDEO — render scale reaches the governor and repaints the label');
  const c0 = calls.length;
  const scale = sel('render scale');
  scale.value = '0.7'; fire(scale, 'change');
  check('setRenderScale("0.7") called once', since(c0, 'setRenderScale').length === 1 && since(c0, 'setRenderScale')[0][1] === '0.7', JSON.stringify(since(c0, 'setRenderScale')));
  check('the hint bar repaints "render scale: 70%"', ui.el.hint.innerHTML.includes('render scale: 70%'), ui.el.hint.innerHTML);
  check('the select shows 70%', scale.selectedOptions[0]?.text === '70%', scale.selectedOptions[0]?.text);

  console.log('VIDEO — shadows / shadow resolution / antialiasing');
  const c1 = calls.length;
  const res = sel('shadow resolution');
  res.value = '4096'; fire(res, 'change');
  check('setShadowRes(4096) called with a NUMBER', since(c1, 'setShadowRes').length === 1 && since(c1, 'setShadowRes')[0][1] === 4096, JSON.stringify(since(c1, 'setShadowRes')));
  check('the hint says 4096²', ui.el.hint.innerHTML.includes('4096²'));
  const boxes = [...body.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
  const shadows = boxes.find((b) => row(b).textContent?.includes('shadows'))!;
  const msaa = boxes.find((b) => row(b).textContent?.includes('antialiasing'))!;
  check('shadows row starts on; resolution row shown', shadows.checked && !row(res).hidden);
  shadows.checked = false; fire(shadows, 'change');
  check('unchecking calls setShadows(false)', since(c1, 'setShadows').length === 1 && since(c1, 'setShadows')[0][1] === false, JSON.stringify(since(c1, 'setShadows')));
  check('…and hides the resolution row', row(res).hidden === true);
  shadows.checked = true; fire(shadows, 'change');
  check('re-checking shows it again', row(res).hidden === false && since(c1, 'setShadows')[1]?.[1] === true);
  check('antialiasing starts on', msaa.checked);
  msaa.checked = false; fire(msaa, 'change');
  check('unchecking writes PREF_MSAA=0', localStorage.getItem(stub.PREF_MSAA) === '0', String(localStorage.getItem(stub.PREF_MSAA)));
  check('…and the row needs a reload', !!row(msaa).querySelector('button.reload'));

  console.log('VIDEO — the same dials as a VR quad');
  const quad = xrPanels.get('settings');
  check('registered under the rail\'s settings id', !!quad && quad.title === 'settings · video');
  const c2 = calls.length, e2 = emitted.length;
  quad.dispatch('scale', '0.85');
  check('quad dispatch(scale) reaches setRenderScale', since(c2, 'setRenderScale')[0]?.[1] === '0.85');
  check('…and asks the quad to repaint', emits(e2, 'xr:repaint') === 1);
  quad.dispatch('shadowres', '1024');
  check('quad dispatch(shadowres) is numeric', since(c2, 'setShadowRes')[0]?.[1] === 1024);
  const f = quad.fields();
  const scaleList = f.find((x: any) => x.label === 'render scale');
  check('the quad\'s scale list marks the current value active', scaleList?.rows.find((r: any) => r.active)?.id === '0.85', JSON.stringify(scaleList?.rows.map((r: any) => [r.id, r.active])));
  check('the quad\'s msaa check reads the pref', f.find((x: any) => x.k === 'msaa')?.value === false);
}

// ============================================================ profile: presence
console.log('PROFILE — presence dispatch reaches setPresence; the dock dot repaints on presence:me');
{ const frame = profile.initProfile();
  const quad = xrPanels.get('profile');
  check('profile quad registered', !!quad && quad.title === 'profile');
  check('starts present', presence.presence() === 'present');
  // the desk frame paints only while visible (profile.js paint); open it first so the header follows
  frame.show(); await tick();
  const e0 = emitted.length;
  quad.dispatch('presence', 'busy');
  check('presence() is busy', presence.presence() === 'busy', presence.presence());
  check('presence:me was emitted', emits(e0, 'presence:me') === 1);
  check('the dock dot repaints (data-presence=busy)', dockBtn.dataset.presence === 'busy', String(dockBtn.dataset.presence));
  check('the dock title names the state', dockBtn.title === 'profile · busy', dockBtn.title);
  check('the quad repaints', emits(e0, 'xr:repaint') >= 1);
  check('the quad lists busy as active', quad.fields().find((x: any) => x.label === 'presence').rows.find((r: any) => r.active).id === 'busy');
  // the desk: the portrait IS the presence control
  const b = frame.body as HTMLElement;
  const portrait = b.querySelector('.pf-portrait') as HTMLElement;
  check('the portrait carries the state', portrait?.dataset.presence === 'busy', String(portrait?.dataset.presence));
  portrait.click();
  const pop = b.querySelector('.pf-pop');
  check('clicking opens a three-way pop', !!pop && pop.querySelectorAll('.pf-pop-row').length === 3);
  check('aria-expanded flips', portrait.getAttribute('aria-expanded') === 'true');
  (pop!.querySelector('.pf-pop-row[data-presence=away]') as HTMLElement).click();
  check('choosing away sets presence()', presence.presence() === 'away', presence.presence());
  check('the pop closes and the header repaints', !b.querySelector('.pf-pop') && b.querySelector('.pf-state')?.textContent === 'away', b.querySelector('.pf-state')?.textContent ?? '');
  check('the dock dot follows', dockBtn.dataset.presence === 'away');
  quad.dispatch('presence', 'present');
  check('present hands control back', presence.presence() === 'present' && dockBtn.dataset.presence === 'present');
}

// ============================================================ profile: the bodies list
console.log('BODIES — the list populates on avatar-worn, which setMe emits');
{ const frame = profile.initProfile();
  const b = frame.body as HTMLElement;
  net.avatars = [{ name: 'fox', path: 'library/fox.vrm', height: 1.52 }, { name: 'owl', path: 'library/owl.vrm' }];
  bus.emit('avatars', net.avatars);
  const pane = () => b.querySelector('.pf-pane[data-tab=avatars] .pf-bodies') as HTMLElement;
  check('the avatars tab hosts the bodies list', !!pane());
  check('wearing shows the current name', pane().querySelector('.sp-f-info .sp-info')?.textContent === 'claude', pane().querySelector('.sp-f-info .sp-info')?.textContent ?? '');
  check('nothing worn yet', pane().querySelector('.sp-empty')?.textContent?.startsWith('nothing worn yet') === true, pane().querySelector('.sp-list')?.textContent ?? '');
  const e0 = emitted.length;
  mybody.announceWorn('fox', 'library/fox.vrm');
  check('announceWorn emits avatar-worn with the name (the switch site and the initial body call it)', emitted.slice(e0).some((e) => e[0] === 'avatar-worn' && e[1]?.name === 'fox'), JSON.stringify(emitted.slice(e0)));
  check('the list shows the worn body', !pane().querySelector('.sp-empty') && pane().querySelector('.sp-list')?.textContent?.includes('fox') === true, pane().querySelector('.sp-list')?.textContent ?? '');
  check('…with its height', pane().querySelector('.sp-list')?.textContent?.includes('1.52 m') === true);
  check('worn is remembered per browser (ew-worn)', JSON.parse(localStorage.getItem('ew-worn') || '[]')[0] === 'fox', String(localStorage.getItem('ew-worn')));
  mybody.announceWorn('owl', 'library/owl.vrm');
  const txt = pane().querySelector('.sp-list')?.textContent ?? '';
  check('a second body lists newest first', txt.indexOf('owl') < txt.indexOf('fox') && txt.indexOf('owl') >= 0, txt);
  const c0 = calls.length;
  const wear = [...pane().querySelectorAll('button')].find((x) => x.textContent === 'wear') as HTMLElement;
  check('a body that is not current offers "wear"', !!wear);
  wear?.click(); await tick();
  check('wear dispatches into switchAvatar(path, name)', since(c0, 'switchAvatar').length === 1 && since(c0, 'switchAvatar')[0][1].startsWith('library/'), JSON.stringify(since(c0, 'switchAvatar')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
