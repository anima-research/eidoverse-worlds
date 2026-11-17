// Settings panels (desktop UI): the style dial, the video rows, the profile's presence and the bodies list, through the
// REAL stylepanel/videopanel/profile/bodies/mybody/presence/ui/windows/fieldpanels.js with only the renderer-bound edge
// stubbed (test/stubs/settings-panels-stub.mjs). Each block names the product line that must turn it red:
//   · setPanelAlpha not persisted (stylepanel.js)          → "survives a re-apply from storage"
//   · renderer select without needsReload (videopanel.js) → "grows the reload button"
//   · presence dispatch not reaching setPresence (profile.js) → "presence() is busy" / "dock dot"
//   · announceWorn not emitting avatar-worn (mybody.js)          → "announceWorn emits avatar-worn with the name (the switch site and the initial body call it)"
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/settings-panels-test.ts
import { fileURLToPath } from "node:url";
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({ name: 'settings-stubs', setup(b) {
  const OLD_ROOT = /\/client\/lib\/((ui|render|player)\/)?[^/]+$/;   // the importers these stubs were written for: files of the lib root before tier two
  for (const m of ['core', 'base', '(render/)?governor', '(render/)?lightrig', '(render/)?materials', '(xr/)?xrpanels', 'net', 'edit/catalog', '(avatar/)?avatar(-thumbnail)?', '(player/)?controller', '(audio/)?mictoggle'])
    stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), (a) => (OLD_ROOT.test(a.importer.replace(/\\/g, '/')) ? { path: here('../stubs/settings-panels-stub.mjs') } : undefined));
  // vegetation/foliage.js asks for core one folder up
  stubResolve(b, /^\.\.\/core\.js$/, (a) => (/\/vegetation\/foliage\.js$/.test(a.importer.replace(/\\/g, '/')) ? { path: here('../stubs/settings-panels-stub.mjs') } : undefined));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register();
// happy-dom's global registrar ships no `Option`; videopanel builds its selects with `new Option(text, value)`
(globalThis as any).Option = function (text: string, value?: string) { const o = document.createElement('option'); o.text = text; if (value !== undefined) o.value = value; return o; };
// mybody starts a roster fetch at import on a cold cache; nothing to fetch here
globalThis.fetch = (async () => new Response('[]', { status: 200 })) as any;
// the elements ui.js binds at import, plus the sheet's own tokens the style panel reads back
for (const id of ['hud', 'loading', 'toasts', 'hintbar', 'door', 'help', 'dock', 'touch']) { const d = document.createElement('div'); d.id = id; document.body.append(d); }
const sheet = document.createElement('style');
sheet.textContent = ':root{--panel-a:.9;--xr-panel-a:1;--panel-rgb:20 24 28;--brand:#aabbcc;--attn:#ff5533;--fg:#eeeeee}';
document.head.append(sheet);
// the dock's profile button: what paintPresence (ui.js) repaints on presence:me
const dockBtn = document.createElement('button'); dockBtn.dataset.toggles = 'profile'; document.getElementById('dock')!.append(dockBtn);

const stub = await import('../stubs/settings-panels-stub.mjs');
const { calls, emitted, xrPanels, net, bus } = stub;
const ui = await import('../../client/lib/ui/ui.js');
await import('../../client/lib/ui/ui-menu.js');   // the ∃ menu, as the page loads it (it was part of ui.js)
const { getFrame } = await import('../../client/lib/ui/windows.js');
const style = await import('../../client/lib/ui/stylepanel.js');
const video = await import('../../client/lib/ui/videopanel.js');
const profile = await import('../../client/lib/ui/profile.js');
const mybody = await import('../../client/lib/player/mybody.js');
const presence = await import('../../client/lib/ui/presence.js');

const S = suite("settings-panels");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

console.log("ESCAPER — ui.js's escapeHtml is markup.js's, the one that escapes ' (a single-quoted attribute)");
{ const m = await import('../../client/lib/ui/markup.js'); const said = ui.escapeHtml("O'Neil <b>");
  check("ui.escapeHtml escapes ' and < (markup.js's)", said === "O&#39;Neil &lt;b&gt;" && ui.escapeHtml === m.escapeHtml, said); }
const tick = () => new Promise((r) => setImmediate(r));
const root = () => document.documentElement.style;
const computed = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const tokens = () => JSON.parse(localStorage.getItem('ew-style-tokens') || '{}');
const since = (i: number, name: string) => calls.slice(i).filter((c) => c[0] === name);
const emits = (i: number, t: string) => emitted.slice(i).filter((e) => e[0] === t).length;
const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
// Settings is TABBED (ui.js makeSection): #sec-<id>-tab chooses the pane #sec-<id>
const openSection = async (id: string) => { (document.getElementById(`sec-${id}-tab`) as HTMLElement).click(); await tick(); return document.getElementById(`sec-${id}`)!.querySelector('.body')!; };

// ============================================================ style: every swatch and dial
console.log('STYLE — every swatch and dial repaints its token, persists it, survives a re-apply; reset clears them all');
{ style.initStylePanel();
  const body = await openSection('style');
  const SHEET: Record<string, string> = { '--panel-rgb': '20 24 28', '--brand': '#aabbcc', '--attn': '#ff5533', '--fg': '#eeeeee', '--panel-a': '.9', '--xr-panel-a': '1' };
  const inline = () => Object.fromEntries(Array.from({ length: root().length }, (_, i) => root().item(i)).map((k) => [k, root().getPropertyValue(k)]));
  // the key a control wrote is read off :root, not off its own emit, so a swatch that forgets to emit still has a row
  const wrote = (before: Record<string, string>) => Object.keys(inline()).filter((k) => before[k] !== root().getPropertyValue(k));
  const survives = (key: string) => {
    const v = computed(key);
    root().removeProperty(key);
    check(`${key}: (control) the sheet value shows once the live property is gone`, computed(key) === SHEET[key], computed(key));
    style.applyStyleTokens();
    check(`${key}: survives a re-apply from storage (what the next boot does)`, computed(key) === v, computed(key));
  };
  const swatchKeys: string[] = [];
  for (const [i, sw] of ([...body.querySelectorAll('input[type=color]')] as HTMLInputElement[]).entries()) {
    const before = inline(), e0 = emitted.length;
    sw.value = `#1122${(0x30 + i).toString(16)}`; fire(sw, 'input');
    const [key, ...more] = wrote(before);
    const name = sw.nextElementSibling?.textContent ?? `swatch ${i}`;
    check(`the ${name} swatch repaints one token the sheet declares`, !!key && key in SHEET && more.length === 0 && computed(key) !== SHEET[key], `${key} ${more}`);
    if (!key) continue;
    swatchKeys.push(key);
    check(`${key}: …persists it`, tokens()[key] === computed(key), JSON.stringify(tokens()));
    check(`${key}: …and emits style{${key}} (what token-baked sprites repaint on)`, emitted.slice(e0).some((e) => e[0] === 'style' && e[1]?.key === key));
    survives(key);
  }
  check('every colour token the sheet declares has a swatch', ['--panel-rgb', '--brand', '--attn', '--fg'].every((k) => swatchKeys.includes(k)), swatchKeys.join(' '));

  // the two opacity dials: the desktop one says it is the desktop's, and VR has its own
  const DIALS = [
    { label: 'desktop panel opacity', key: '--panel-a', start: '0.9', min: '0.3', max: '1', drag: '0.5', set: style.setPanelAlpha, code: 0.66, emits: true, follows: true },
    { label: 'VR panel opacity', key: '--xr-panel-a', start: '1', min: '0.6', max: '1', drag: '0.6', set: style.setXrPanelAlpha, code: 0.7, emits: true, follows: true, clamp: [0.2, '0.6'] as const },
  ];
  const dials = [...body.querySelectorAll('input[type=range]')] as HTMLInputElement[];
  const label = (el: Element) => el.closest('.row')?.querySelector('.nm')?.textContent ?? '';
  check('two opacity dials: desktop, then VR', dials.length === DIALS.length && DIALS.every((d, i) => label(dials[i]!) === d.label), dials.map(label).join(' | '));
  for (const [i, d] of DIALS.entries()) {
    const el = dials[i]!, readout = el.nextElementSibling as HTMLElement;
    const others = () => DIALS.filter((o) => o !== d).map((o) => computed(o.key)).join();
    check(`${d.key}: the dial starts from the sheet's value and spans ${d.min}–${d.max}`, el.value === d.start && el.min === d.min && el.max === d.max, `${el.value} ${el.min}–${el.max}`);
    const o0 = others(), e0 = emitted.length;
    el.value = d.drag; fire(el, 'input');
    check(`${d.key}: dragging the dial repaints it on :root, and leaves the other dial's token alone`, computed(d.key) === d.drag && others() === o0, `${computed(d.key)} ${others()}`);
    check(`${d.key}: the readout follows`, readout.textContent === Number(d.drag).toFixed(2), readout.textContent ?? '');
    check(`${d.key}: …persists it with the style tokens`, tokens()[d.key] === d.drag, JSON.stringify(tokens()));
    if (d.emits) check(`${d.key}: …and emits style{${d.key}} (what the VR quads re-raster on)`, emitted.slice(e0).some((e) => e[0] === 'style' && e[1]?.key === d.key));
    const e1 = emitted.length; d.set(d.code);
    if (d.emits) check(`${d.key}: setting it from code emits style{${d.key}} too`, emitted.slice(e1).some((e) => e[0] === 'style' && e[1]?.key === d.key && e[1]?.value === String(d.code)));
    check(`${d.key}: setting it from code (${d.code}) repaints and persists`, computed(d.key) === String(d.code) && tokens()[d.key] === String(d.code), `${computed(d.key)} ${JSON.stringify(tokens())}`);
    if (d.follows) check(`${d.key}: …and moves the dial too (value and readout)`, el.value === String(d.code) && readout.textContent === d.code.toFixed(2), `${el.value} ${readout.textContent}`);
    if (d.clamp) { d.set(d.clamp[0]); check(`${d.key}: setting it from code clamps to the dial's range`, computed(d.key) === d.clamp[1], computed(d.key)); }
    survives(d.key);
  }

  (body.querySelector('button') as HTMLElement).click();   // reset to defaults
  const all = [...swatchKeys, ...DIALS.map((d) => d.key)];
  const left = all.filter((k) => computed(k) !== SHEET[k]);
  check('reset clears every live token back to the sheet', left.length === 0, left.map((k) => `${k}=${computed(k)}`).join(' '));
  check('reset empties the store', Object.keys(tokens()).length === 0, JSON.stringify(tokens()));
  check('reset repaints every dial from the sheet', DIALS.every((d, i) => dials[i]!.value === d.start), dials.map((x) => x.value).join(' '));
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
  quad.dispatch('fulldetail', true);
  check('quad dispatch(fulldetail) reaches setFullDetail', since(c2, 'setFullDetail')[0]?.[1] === true);
  check('…and the quad\'s full-detail check reads it back', quad.fields().find((x: any) => x.k === 'fulldetail')?.value === true);
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
  check('the dock title names the state', dockBtn.title === 'Profile · busy', dockBtn.title);
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
  // Esc closes the pop and GOES NO FURTHER: profile.js's onKey stops propagation so the global Esc (windows.js
  // close-all) yields to an open pop, and dismiss() takes the capture listeners down with it
  portrait.click();
  check('the pop reopens', !!b.querySelector('.pf-pop'));
  let globalEsc = 0;
  const spy = (ev: any) => { if (ev.key === 'Escape') globalEsc++; };
  addEventListener('keydown', spy);            // bubble phase: profile's capture listener runs first
  dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape closes the presence pop', !b.querySelector('.pf-pop'));
  check('...and the global Esc never sees it (stopPropagation)', globalEsc === 0, `globalEsc=${globalEsc}`);
  globalEsc = 0;
  dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('a second Escape is NOT swallowed — the pop took its listeners down with it', globalEsc === 1, `globalEsc=${globalEsc}`);
  removeEventListener('keydown', spy);

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
  // NO BODY IS IN THE SCENE here (setMe is never called): getMyAvatarName() is INTENT (never cleared on a failed load),
  // getMe() is fact, and the header must say the fact
  check('with no body in the scene the HEADER says None, not the intended name', /wearing <b>None<\/b>/.test(document.body.innerHTML), (document.body.innerHTML.match(/wearing <b>[^<]*<\/b>/) ?? ['(no header)'])[0]);
  check("...and the bodies panel agrees — no 'claude' beside 'nothing worn yet'", pane().querySelector('.sp-f-info .sp-info')?.textContent === 'None', pane().querySelector('.sp-f-info .sp-info')?.textContent ?? '');
  check('nothing worn yet', pane().querySelector('.sp-empty')?.textContent?.startsWith('nothing worn yet') === true, pane().querySelector('.sp-list')?.textContent ?? '');
  const e0 = emitted.length;
  mybody.announceWorn('fox', 'library/fox.vrm');
  check('announceWorn emits avatar-worn with the name (the switch site and the initial body call it)', emitted.slice(e0).some((e) => e[0] === 'avatar-worn' && e[1]?.name === 'fox'), JSON.stringify(emitted.slice(e0)));
  check('the list shows the worn body', !pane().querySelector('.sp-empty') && pane().querySelector('.sp-list')?.textContent?.includes('fox') === true, pane().querySelector('.sp-list')?.textContent ?? '');
  check('…with its height', pane().querySelector('.sp-list')?.textContent?.includes('1.52 m') === true);
  check('worn is remembered per browser (ew-worn)', JSON.parse(localStorage.getItem('ew-worn') || '[]')[0] === 'fox', String(localStorage.getItem('ew-worn')));
  // a REAL switch: palette.switchAvatar → mybody's wireAvatarSwitch handler → makeAvatar (an Avatar with no name/path) → announceWorn
  { const e1 = emitted.length; await stub.switchAvatar('library/owl.vrm', 'owl'); await tick();
    const w = emitted.slice(e1).find((e) => e[0] === 'avatar-worn');
    check('a real switch announces the SWITCH\'s name, not a field on the Avatar (it has none)', w?.[1]?.name === 'owl' && w?.[1]?.path === 'library/owl.vrm', JSON.stringify(w ?? null)); }
  const txt = pane().querySelector('.sp-list')?.textContent ?? '';
  check('a second body lists newest first', txt.indexOf('owl') < txt.indexOf('fox') && txt.indexOf('owl') >= 0, txt);
  const c0 = calls.length;
  const wear = [...pane().querySelectorAll('button')].find((x) => x.textContent === 'wear') as HTMLElement;
  check('a body that is not current offers "wear"', !!wear);
  wear?.click(); await tick();
  check('wear dispatches into switchAvatar(path, name)', since(c0, 'switchAvatar').length === 1 && since(c0, 'switchAvatar')[0][1].startsWith('library/'), JSON.stringify(since(c0, 'switchAvatar')));
}
  // re-wearing a body already in the list MOVES it to the front, never duplicates (bodies.js noteWorn)
  { const e2 = emitted.length;
    mybody.announceWorn('fox', 'library/fox.vrm');
    const stored = JSON.parse(localStorage.getItem('ew-worn') || '[]');
    check('re-wearing an existing body does not duplicate it', stored.filter((n: string) => n === 'fox').length === 1, JSON.stringify(stored));
    check('...and moves it to the front (newest first)', stored[0] === 'fox', JSON.stringify(stored));
    void e2; }

// ============================================================ tabs
console.log('TABS — every registered section is a tab; choosing one shows its pane alone, and its action opens it');
{ const actions = await import('../../client/lib/ui/actions.js');
  const frame = ui.settingsFrame() as any;
  const strip = frame.strip as HTMLElement;
  // every section the host registered, whoever registered it: the built-ins, the bodies list, a mod's
  const secs = () => frame.sections as Array<{ key: string; box: HTMLElement; head: HTMLElement }>;
  check('the settings frame carries a tab strip with one tab per section, in registration order (style, video, safety among them)',
    [...strip.querySelectorAll('.pf-tab')].every((b, i) => b === secs()[i]?.head) && strip.querySelectorAll('.pf-tab').length === secs().length
      && ['style', 'video', 'safety'].every((k) => secs().some((x) => x.key === k)),
    [...strip.querySelectorAll('.pf-tab')].map((b) => b.id).join());
  check('no pane lives in the strip, no tab in a pane (a strip, not an accordion)',
    !strip.querySelector('.sec') && secs().every((x) => !x.box.querySelector('.pf-tab')));
  const state = () => secs().map((x) => `${x.key}:${x.box.classList.contains('open') ? 'open' : '-'}/${x.head.classList.contains('on') ? 'on' : '-'}/${x.head.getAttribute('aria-selected')}`).join(' ');
  const alone = (key: string) => secs().map((x) => (x.key === key ? `${x.key}:open/on/true` : `${x.key}:-/-/false`)).join(' ');
  for (const x of secs()) {
    x.head.click(); await tick();
    check(`clicking the ${x.key} tab shows its pane ALONE, the tab marked chosen`, state() === alone(x.key), state());
  }
  frame.hide();
  for (const x of secs()) {
    actions.run(`section:settings:${x.head.title}`); await tick(); await tick();
    check(`the lantern action section:settings:${x.head.title} opens the frame on the ${x.key} tab`, frame.visible && state() === alone(x.key), `${frame.visible} ${state()}`);
  }
  // a frame shown with no tab chosen opens the one last chosen (never an empty pane)
  ui.collapseAll(); await tick();
  check('collapseAll folds the pane away (placing a ghost wants the view)', !secs().some((x) => x.box.classList.contains('open')), state());
  { const ws = ui.makeSection('WS probe', () => {}, { id: 'ws-probe', host: 'world-settings' }); ws.toggle(true); await tick();
    const opened = ws.box.classList.contains('open'); ui.collapseAll(); await tick();
    check('...and a World Settings tab too (every tabbed frame, #577)', opened && !ws.box.classList.contains('open'), { opened, after: ws.box.className }); }
  frame.hide(); frame.show(); await tick();
  check('shown again with nothing chosen, the frame opens its last tab (the last of them)', state() === alone(secs().at(-1)!.key), state());

  // a mod's section may share a built-in's label (mods.js passes no id): removing the mod's must keep the built-in's row
  const builtinRun = actions.get('section:settings:video')?.run;
  const mod = ui.makeSection('video', () => {}, { host: 'settings' });
  mod.remove(); await tick();
  check('removing a mod section that shares a label keeps the built-in\'s lantern row',
    !!actions.get('section:settings:video') && actions.get('section:settings:video')!.run === builtinRun,
    `row=${!!actions.get('section:settings:video')} sameRun=${actions.get('section:settings:video')?.run === builtinRun}`);
  const again = ui.makeSection('🎨 extra', () => {}, { host: 'settings' });
  check('a removed section\'s own row goes with it', (again.remove(), await tick(), actions.get('section:settings:extra') === null));


  // toggle() with no argument flips, as the accordion's did (mods call ctx.ui.section(…).toggle())
  const video = frame.sections.find((x: any) => x.key === 'video');
  await video.toggle(true);
  await video.toggle();
  check('toggle() on the chosen tab folds it', !video.isOpen, state());
  await video.toggle();
  check('toggle() on a folded tab chooses it', video.isOpen, state());
}

console.log('WORLD — a viewport restore opens a tab, like show() does');
{
  // World's sections register while the viewport has auto-hidden it, so the queued ensureTab finds it closed; when the
  // viewport rule un-hides it WITHOUT show(), it must still open a tab, not come back as an empty pane
  check('setup: World is not built yet', !getFrame('world'));
  localStorage.setItem('ew-frame-world', JSON.stringify({ x: 700, y: 52, w: 280, h: 320, hidden: true, autoHidden: true }));
  const sec = ui.makeSection('🧪 probe', () => {}, { id: 'probe' });
  await tick();
  const w: any = getFrame('world');
  check('setup: World comes up auto-hidden, no tab open', !w.visible && !sec.isOpen, JSON.stringify({ visible: w.visible, open: sec.isOpen }));
  const vp = (x: number, y: number) => { (window as any).innerWidth = x; (window as any).innerHeight = y; window.dispatchEvent(new Event('resize')); };
  const w0 = innerWidth, h0 = innerHeight;
  vp(390, 844); vp(w0, h0); await tick();
  check('setup: the viewport restores World', w.visible === true);
  check('…with its remembered (or first) tab open, not an empty pane', sec.isOpen, JSON.stringify(w.sections.map((x: any) => [x.key, x.isOpen])));
}

S.done();
