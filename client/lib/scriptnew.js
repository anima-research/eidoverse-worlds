// scriptnew — the editor's "new script" card (ship list 10-07: the editor couldn't make a script).
//
// A small centre card on the selected thing: a name, what starts it (someone using it, or a timer), what it may change,
// whether it may speak, and the source (a template that runs as it stands). Create plans the requests an agent sends
// (shared/v4/newscript.js) and sends them through the editor's one write path (v4edit.js):
//   upload {text} → {src}, then ONE batch: script:<name> {src, scope, on, every?} + (on use) its reaction. One act, so
//   one Ctrl+Z takes it off again.
// A refusal (the scripts switch, a syntax error, a scope beyond your rights) is shown on the card in the door's words,
// and the card stays open with what you typed. Esc or Cancel closes it; nothing is written until Create.
//
//   openNewScript(id) → Promise<{ok, id, name} | {ok: false}>
import * as V4 from './v4edit.js';
import { net } from './net.js';
import { refusalText } from '../../shared/v4/refusal.js';
import { planNewScript, TEMPLATES, TEMPLATE_SCOPE } from '../../shared/v4/newscript.js';

/** May I install a script here (the scripts switch; the door decides either way)? */
export const mayScript = () => { const r = net.myRights; if (!r) return false;
  return Array.isArray(r.switches) ? r.switches.includes('scripts') : r.role === 'owner'; };

const CSS = `#script-new { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / .55); }
#script-new .sn-card { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 16px 18px; border-radius: 10px; border: 1px solid var(--edge-hi); box-shadow: var(--rim); display: flex; flex-direction: column; gap: 8px; }
#script-new b { color: var(--fg); font-size: 15px; font-weight: 600; }
#script-new label { display: flex; gap: 8px; align-items: center; color: var(--dim); font-size: 12px; }
#script-new input[type=text], #script-new input[type=number] { flex: 1; min-width: 0; background: var(--chip); color: var(--fg); border: 1px solid var(--edge); border-radius: 5px; padding: 4px 6px; }
#script-new input[type=number] { flex: 0 0 64px; }
#script-new textarea { width: 100%; box-sizing: border-box; min-height: 180px; resize: vertical; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--chip); color: var(--fg); border: 1px solid var(--edge); border-radius: 5px; padding: 6px; }
#script-new .sn-err { color: var(--warn, #f0a060); font-size: 12px; white-space: pre-wrap; min-height: 1em; }
#script-new .sn-hint { color: var(--dim); font-size: 11px; line-height: 1.4; }
#script-new .sn-btns { display: flex; justify-content: flex-end; gap: 8px; }
#script-new .sn-btns button { min-height: 32px; padding: 0 14px; border-radius: 6px; cursor: pointer; font-size: 13px; background: var(--chip); color: var(--fg); border: 1px solid var(--edge); }
#script-new .sn-ok { background: var(--brand-deep) !important; color: var(--ink-on-brand, var(--bg)) !important; border-color: var(--brand) !important; font-weight: 600; }`;

let open = null;
/** Open the card for thing `id` (as the view names it). Resolves when it's created or closed. */
export function openNewScript(id) {
  if (typeof document === 'undefined' || !id) return Promise.resolve({ ok: false });
  open?.close();
  if (!document.getElementById('script-new-css')) { const st = document.createElement('style'); st.id = 'script-new-css'; st.textContent = CSS; document.head.append(st); }
  return new Promise((resolve) => {
    const root = document.createElement('div'); root.id = 'script-new';
    root.innerHTML = `<div class="sn-card panel" role="dialog" aria-modal="true" aria-labelledby="sn-title">
      <b id="sn-title"></b>
      <label>name <input type="text" class="sn-name" maxlength="64" placeholder="e.g. bell"></label>
      <label><input type="radio" name="sn-on" value="use" checked> when someone uses it</label>
      <label><input type="radio" name="sn-on" value="timer"> every <input type="number" class="sn-every" min="5" step="1" value="10"> seconds while someone is here</label>
      <label>it may change <input type="text" class="sn-comps" placeholder="components on this thing, comma-separated"></label>
      <label><input type="checkbox" class="sn-say"> it may speak in chat</label>
      <textarea class="sn-src" spellcheck="false" aria-label="the script's source"></textarea>
      <div class="sn-hint">JavaScript, run on the server with your rights and no more (docs/SCRIPTS-v4.md). world.on('use' | 'tick', fn), world.get / world.set on this thing, world.say, world.log (its console).</div>
      <div class="sn-err" role="status"></div>
      <div class="sn-btns"><button type="button" class="sn-no">Cancel</button><button type="button" class="sn-ok">Create</button></div></div>`;
    const $ = (s) => root.querySelector(s);
    $('#sn-title').textContent = `New script on ${id}`;
    const src = $('.sn-src'), name = $('.sn-name'), comps = $('.sn-comps'), say = $('.sn-say'), every = $('.sn-every'), err = $('.sn-err'), okB = $('.sn-ok');
    let touched = false;
    const trig = () => root.querySelector('input[name=sn-on]:checked')?.value ?? 'use';
    const fill = () => { const t = trig(); src.value = TEMPLATES[t]; comps.value = TEMPLATE_SCOPE[t].comps.join(', '); say.checked = TEMPLATE_SCOPE[t].say; };
    fill();
    src.oninput = () => { touched = true; };
    for (const r of root.querySelectorAll('input[name=sn-on]')) r.onchange = () => { if (!touched) fill(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ ok: false }); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); create(); }
      else e.stopPropagation(); };   // typing here is never walking or a hotkey
    function finish(v) { if (open?.root !== root) return; open = null; removeEventListener('keydown', onKey, true); root.remove(); resolve(v); }
    async function create() {
      if (okB.disabled) return;
      const thing = V4.compsOf(id) ?? {};
      const plan = planNewScript({ id, name: name.value, text: src.value, trigger: trig(), every: Number(every.value), comps: comps.value.split(','), say: say.checked }, thing);
      if (plan.errors.length) { err.textContent = plan.errors.join('\n'); return; }
      okB.disabled = true; err.textContent = 'uploading…';
      try {
        const up = await V4.send(plan.upload, { what: `upload the script '${plan.name}'`, record: false });
        if (!up.ok) { err.textContent = refusalText(`upload the script '${plan.name}'`, up); return; }
        const r = await V4.sendOps(plan.install(up.src), { what: `script '${plan.name}' on ${id}` });
        if (!r.ok) { err.textContent = refusalText(`script '${plan.name}' on ${id}`, r); return; }
        finish({ ok: true, id, name: plan.name, action: plan.action });
      } finally { okB.disabled = false; }
    }
    $('.sn-no').onclick = () => finish({ ok: false });
    okB.onclick = create;
    root.onpointerdown = (e) => { if (e.target === root) finish({ ok: false }); };
    addEventListener('keydown', onKey, true);
    document.body.append(root);
    open = { root, close: () => finish({ ok: false }) };
    name.focus();
  });
}
