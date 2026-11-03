// debug tabs (client/lib/debug.js dbgTabs) — a group builds the first time its tab is SEEN, not at boot.
// The remembered tab is chosen at boot while Debug is still closed; before the tabs, every group was a
// collapsible that built on first open, and the tabs must keep that (an unvisited panel costs nothing).
//
// frames.js is the REAL module (only its ./base.js is stubbed), so every way the frame comes back on screen is
// the shipped one — including the viewport auto-restore, which never goes through show().
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/debug-tabs-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'debug-stubs', setup(b) {
  for (const m of ['core', 'base', 'xrpanels', 'gputime', 'perf', 'render', 'perfscope', 'colliders', 'ragdoll', 'ammodoll', 'avatar', 'ui'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./debug-stub.mjs') }));
  b.onResolve({ filter: /^three-mesh-bvh$/ }, () => ({ path: here('./debug-stub.mjs') }));
} });
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
// happy-dom's registrar ships no `Option`; rows.js selectRow builds with `new Option(text, value)`
(globalThis as any).Option = function (text: string, value?: string) { const o = document.createElement('option'); o.text = text; if (value !== undefined) o.value = value; return o; };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

localStorage.setItem('ew-tab-debug', 'body');   // the tab remembered from last time
await import('../client/lib/frames.js');           // stamps the layout version first, so the save below is not purged
// last session the viewport auto-hid Debug while it was open; it comes back when the window is wide enough again
localStorage.setItem('ew-frame-debug', JSON.stringify({ x: 700, y: 200, w: 250, h: 460, hidden: true, autoHidden: true }));
const { initDebug } = await import('../client/lib/debug.js');
const f = initDebug() as any;
await tick();   // perfscope's groups arrive by dynamic import
const built = (tab: string) => [...f.body.querySelectorAll(`.dbg-pane[data-tab="${tab}"] .dbg-group-body`)].filter((b: any) => b.childElementCount > 0).length;
const groups = (tab: string) => f.body.querySelectorAll(`.dbg-pane[data-tab="${tab}"] .dbg-group-body`).length;

console.log('DEBUG — tabs build lazily');
check('the remembered tab (body) is the chosen one', f.body.querySelector('.dbg-tabs .pf-tab.on')?.dataset.tab === 'body');
check('closed at boot: none of its groups are built', groups('body') > 0 && built('body') === 0, `${built('body')}/${groups('body')} built`);
window.dispatchEvent(new Event('resize')); await tick();
check('setup: the viewport restores it without show()', f.visible === true);
check('restored by the viewport: the chosen tab\'s groups build', built('body') === groups('body'), `${built('body')}/${groups('body')} built`);
check('…and only that tab\'s (physics stays unbuilt)', built('physics') === 0, `${built('physics')} built`);
f.hide();
(f.body.querySelector('.dbg-tabs .pf-tab[data-tab="physics"]') as HTMLElement).click();
check('choosing physics while closed builds nothing yet', built('physics') === 0, `${built('physics')} built`);
f.show(); await tick();
check('shown: physics builds its groups', built('physics') === groups('physics') && groups('physics') > 0, `${built('physics')}/${groups('physics')}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
