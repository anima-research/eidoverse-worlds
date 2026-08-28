// conjure — the Orrery panel: prompt → image candidates (you pick one) →
// 3D mesh → into the world, with the queue and progress visible in-world.
//
// Orrery (orrery.animalabs.ai) is the multistage 3D prompting service:
// gpt-image turnarounds → Tripo mesh → texture/rig, stored as a version
// tree. This panel drives its API directly, cross-origin with credentials
// (Orrery ships CORS + a SameSite=None session for exactly this — including on
// the asset endpoint, checked 2026-08-16). The heavy
// bytes NEVER pass through this client: Orrery pushes finished GLBs to the
// sequencer's /upload itself, and what we place is the returned store path.
//
// The spend shape mirrors the permission model: generating needs your
// Orrery identity (archipelago login, its own allowance metering), and
// bringing the RESULT into the world is the `asset` verb — which needs the
// gen capability here. The image-approval stage is Orrery's chain pause
// (select: "starred"): candidates render as thumbnails, clicking one stars
// it, the chain resumes into mesh generation.
//
// ?orrery=<url> (or localStorage ew-orrery-url) overrides the service for
// dev — a MOCK_APIS Orrery instance makes the whole flow testable offline.

import { CONFIG, bus, report } from './core.js';
import { makeSection, toast, flashHint } from './ui.js';
import { sendVerb, net } from './net.js';
import { holdGhost } from './build.js';
import { logChat } from './chat.js';

const ORRERY = CONFIG.params.get('orrery')
  || localStorage.getItem('ew-orrery-url')
  || 'https://orrery.animalabs.ai';
if (CONFIG.params.get('orrery')) localStorage.setItem('ew-orrery-url', ORRERY);

const api = async (path, opts = {}) => {
  const r = await fetch(`${ORRERY}${path}`, {
    credentials: 'include',
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
  });
  if (r.status === 401) { const e = new Error('not signed in'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 180)}`);
  return r.json();
};

// ---------------------------------------------------------------- job store
// Jobs are chains; the list is local (your queue, not the world's). Survives
// reloads so a 10-minute mesh doesn't need the tab babysat.

const JOBS_KEY = 'ew-conjure-jobs';
let jobs = [];
try { jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch { jobs = []; }
const saveJobs = () => localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(-20)));

// ---------------------------------------------------------------- polling

let bodyEl = null;          // the section body while open
let timer = null;
const active = (j) => !j.dismissed && !['completed', 'failed', 'cancelled'].includes(j.status ?? '');

function schedule() {
  clearTimeout(timer);
  // poll while the panel is open, or while anything is still cooking
  if (bodyEl || jobs.some(active)) timer = setTimeout(poll, 2500);
}

async function poll() {
  for (const j of jobs.filter(active)) {
    try {
      const chain = await api(`/api/chains/${j.chainId}`);
      const prev = j.status;
      j.status = chain.status;
      j.cursor = chain.cursor;
      j.error = chain.error;
      j.anchor = chain.anchor_node_id;
      const tree = await api(`/api/projects/${j.projectId}/tree`);
      j.nodes = tree.nodes.filter((n) => (n.group_id ?? '').startsWith(`${j.chainId}:`));
      if (prev !== j.status) {
        if (j.status === 'waiting_selection') {
          flashHint('✨ image candidates ready — pick one in the conjure panel');
          logChat('*', `conjure: "${j.prompt.slice(0, 40)}" wants your pick of images`);
        }
        if (j.status === 'completed') logChat('*', `conjure: "${j.prompt.slice(0, 40)}" is ready to place`);
        if (j.status === 'failed') logChat('*', `conjure failed: ${j.error ?? 'unknown'}`);
      }
    } catch (e) {
      if (e.auth) { connected = false; break; }
      console.warn('[conjure] poll', e.message);
    }
  }
  saveJobs();
  if (bodyEl) paint(bodyEl);
  schedule();
}

// ---------------------------------------------------------------- rendering

let connected = null;      // null = unknown, false = needs login, object = me

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STAGES = ['images', 'compose', 'mesh'];
function stageOf(j) {
  if (j.status === 'completed') return 'done';
  if (j.status === 'waiting_selection') return 'your pick';
  return STAGES[j.cursor ?? 0] ?? '…';
}

/** running-node progress for the current stage, 0-100 */
function progressOf(j) {
  const running = (j.nodes ?? []).filter((n) => n.status === 'running');
  if (!running.length) return null;
  return Math.round(running.reduce((s, n) => s + (n.progress ?? 0), 0) / running.length);
}

function imageCandidates(j) {
  // the chain's first group = the image_gen siblings; thumbnails are their
  // image assets, fetched straight from Orrery.
  //
  // 🔴 NOT a plain <img> any more (2026-08-16). A bare <img> is a NO-CORS
  // subresource, and under COEP `credentialless` — which this server now sends
  // so wasm gets its threads — no-cors requests are sent WITHOUT credentials.
  // These are private per-user assets, so they would have 404'd/403'd and the
  // pick stage would have shown broken thumbnails with no explanation.
  //
  // crossorigin="use-credentials" moves them to CORS mode, which COEP does not
  // touch. VERIFIED against the live service rather than assumed: the asset
  // endpoint answers an eidoverse Origin with
  //   access-control-allow-credentials: true
  //   access-control-allow-origin: https://eidoverse.animalabs.ai
  // (non-wildcard, as credentialed CORS requires).
  return (j.nodes ?? [])
    .filter((n) => n.op_type === 'image_gen' && n.status === 'completed')
    .map((n) => ({
      node: n,
      // image_gen output is a 'grid' (the 2x2 turnaround); accept plain
      // 'image' too so image_edit branches would render as well
      img: (n.assets ?? []).find((a) => a.kind === 'grid' || a.kind === 'image'),
    }))
    .filter((c) => c.img);
}

async function paint(body) {
  const genOk = net.myRights?.gen !== false;

  if (connected === null) {
    try { connected = await api('/api/auth/me'); }
    catch (e) { connected = e.auth ? false : null; }
  }

  if (connected === false) {
    body.innerHTML = `
      <p class="sub">conjure new objects from a prompt — images you approve,
        then a 3D mesh, straight into the world. Powered by orrery.</p>
      <button id="cj-connect">connect to orrery</button>`;
    body.querySelector('#cj-connect').onclick = async () => {
      try {
        const cfg = await api('/api/auth/config');
        const w = window.open(cfg.login_url, 'orrery-auth', 'width=520,height=680');
        // 🔴 DO NOT DEPEND ON postMessage FROM THE POPUP (2026-08-16). Under
        // COOP `same-origin` — which cross-origin isolation requires, and which
        // this server now sends so wasm gets its threads — a cross-origin popup
        // lands in a different browsing-context group: its `window.opener` is
        // null, so it CANNOT message us back, and our handle `w` is a severed
        // proxy whose close() is a no-op. Sign-in would hang forever with no
        // error anywhere.
        //
        // So: keep the message path (it still works when isolation is off, and
        // it is instant), but treat it as an optimisation over POLLING, which
        // needs no opener relationship at all. /api/auth/me is a CORS fetch —
        // credentialless does not touch cors-mode requests, only no-cors
        // subresources (MDN: "requests made in cors mode won't be blocked by
        // COEP"), so the session cookie still rides.
        let done = false;
        // ONE teardown, idempotent, shared by every exit (review on the
        // isolation PR: the timeout branch used to clear only the interval —
        // the message listener stayed installed and accumulated across retry
        // attempts, `done` stayed false, and the abandoned flow had no
        // visible completion or retry state).
        const cleanup = () => {
          if (done) return false;
          done = true;
          removeEventListener('message', onMsg);
          clearInterval(poll);
          try { w?.close(); } catch { /* severed under COOP, or already closed */ }
          return true;
        };
        const finish = () => {
          if (!cleanup()) return;
          connected = null;                       // unknown → paint re-checks auth
          paint(body).catch((e) => report('conjure', e));
        };
        const abandon = (reason) => {
          if (!cleanup()) return;
          connected = false;                      // retryable: the connect button paints again
          console.warn(`[conjure] orrery login ${reason}`);
          paint(body).catch((e) => report('conjure', e));
        };
        const onMsg = (ev) => {
          // The message path is an optimisation retained for non-isolated
          // browsers — but the data string alone is not identity: any window
          // that can obtain a reference could post it. Origin must match the
          // configured Orrery.
          if (ev.origin !== new URL(ORRERY).origin) return;
          if (ev.data === 'orrery:signed-in') finish();
        };
        addEventListener('message', onMsg);
        // 90s at 2s intervals: long enough for a slow Discord sign-in, bounded
        // so a user who abandons the popup does not leave a timer running.
        let tries = 0;
        const poll = setInterval(async () => {
          if (done) return;
          if (++tries > 45) { abandon('timed out after 90s — connect again to retry'); return; }
          try { await api('/api/auth/me'); finish(); } catch { /* not yet */ }
        }, 2000);
      } catch (e) { report('orrery login', e); }
    };
    return;
  }

  const rows = jobs.filter((j) => !j.dismissed).slice(-8).reverse().map((j, i) => {
    const idx = jobs.indexOf(j);
    const prog = progressOf(j);
    const stage = stageOf(j);
    let inner = '';
    if (j.status === 'waiting_selection') {
      inner = `<div class="cj-pick">${imageCandidates(j).map((c) => `
        <img crossorigin="use-credentials"
             src="${ORRERY}/api/assets/${esc(c.img.id)}/file" data-star="${esc(c.node.id)}"
             title="use this one (starts the mesh)">`).join('')
        || '<span class="sub">candidates finished but none readable — open orrery</span>'}</div>`;
    } else if (j.status === 'completed') {
      inner = `<div class="cj-done">
        <button data-place="${idx}">⚡ into the world</button>
        <button data-avatar="${idx}" title="rigged results only">as avatar</button>
      </div>`;
    } else if (j.status === 'failed') {
      inner = `<div class="sub">failed: ${esc(j.error ?? 'unknown')}</div>`;
    } else {
      inner = `<div class="cj-bar"><div style="width:${prog ?? 4}%"></div></div>`;
    }
    return `<div class="cj-job">
      <div class="cj-head">
        <span class="cj-prompt" title="${esc(j.prompt)}">${esc(j.prompt.slice(0, 44))}</span>
        <span class="cj-stage">${esc(stage)}${prog != null ? ` ${prog}%` : ''}</span>
        ${active(j) ? `<button class="cj-x" data-cancel="${idx}" title="cancel">✕</button>`
                    : `<button class="cj-x" data-dismiss="${idx}" title="dismiss">✕</button>`}
      </div>${inner}</div>`;
  }).join('');

  body.innerHTML = `
    <div class="cj-new">
      <input id="cj-prompt" type="text" maxlength="400" spellcheck="false"
        placeholder="describe a thing… e.g. a rusted brass lighthouse" ${genOk ? '' : 'disabled'}>
      <button id="cj-go" ${genOk ? '' : 'disabled'}>✨ conjure</button>
    </div>
    ${genOk ? '' : '<p class="sub">bringing new objects into this world needs the <b>gen</b> capability — ask its owner (<b>/grant you +gen</b>)</p>'}
    <div id="cj-jobs">${rows || '<p class="sub">nothing cooking — your conjures queue here with progress, and pause for your pick of the image candidates before any mesh is spent.</p>'}</div>
    <p class="sub" style="margin-top:6px"><a href="${ORRERY}/" target="_blank" rel="noopener">open orrery ↗</a> for refs, retries, rigging and the full version tree.</p>`;

  const promptEl = body.querySelector('#cj-prompt');
  const go = async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) return;
    promptEl.value = '';
    try {
      const r = await api('/api/quick', {
        method: 'POST',
        body: JSON.stringify({ prompt, n_images: 4, n_meshes: 1, approve_images: true }),
      });
      jobs.push({ chainId: r.chain_id, projectId: r.project_id, prompt, ts: Date.now(), status: 'running' });
      saveJobs();
      toast('conjuring — four image candidates first, then you pick', 'info');
      paint(body).catch(() => {});
      schedule();
    } catch (e) {
      if (e.auth) { connected = false; paint(body).catch(() => {}); }
      else report('conjure', e);
    }
  };
  body.querySelector('#cj-go').onclick = go;
  promptEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  body.querySelectorAll('[data-star]').forEach((img) => {
    img.onclick = async () => {
      try {
        await api(`/api/nodes/${img.dataset.star}`, { method: 'PATCH', body: JSON.stringify({ starred: true }) });
        toast('starred — meshing begins', 'info');
        poll();
      } catch (e) { report('star', e); }
    };
  });
  body.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      const j = jobs[Number(b.dataset.cancel)];
      try { await api(`/api/chains/${j.chainId}/cancel`, { method: 'POST' }); } catch { /* already done */ }
      j.dismissed = true; saveJobs(); paint(body).catch(() => {});
    };
  });
  body.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.onclick = () => { jobs[Number(b.dataset.dismiss)].dismissed = true; saveJobs(); paint(body).catch(() => {}); };
  });
  const place = (idx, asAvatar) => async () => {
    const j = jobs[idx];
    if (!j.anchor) return toast('no final node — open orrery to inspect', 'warn');
    try {
      toast('orrery is delivering it to the world…', 'info');
      const r = await api(`/api/nodes/${j.anchor}/send-to-eidoverse`, {
        method: 'POST',
        body: JSON.stringify(asAvatar ? { as_avatar: true, name: j.prompt.slice(0, 32) } : {}),
      });
      if (asAvatar) {
        toast(`avatar "${r.name}" is on the roster — pick it in the avatar panel`, 'info', 9000);
      } else {
        const label = j.prompt.slice(0, 40);
        sendVerb('asset', { name: label, path: r.path });   // the gen-gated verb
        await holdGhost(r.path, label);
        flashHint('on your cursor — click to set it down');
      }
    } catch (e) { report('place', e); }
  };
  body.querySelectorAll('[data-place]').forEach((b) => { b.onclick = place(Number(b.dataset.place), false); });
  body.querySelectorAll('[data-avatar]').forEach((b) => { b.onclick = place(Number(b.dataset.avatar), true); });
}

// ---------------------------------------------------------------- section

export function initConjure() {
  const style = document.createElement('style');
  style.textContent = `
    .cj-new { display:flex; gap:4px; margin-bottom:6px; }
    .cj-new input { flex:1; min-width:0; }
    .cj-job { border:1px solid var(--line, #333); border-radius:6px; padding:5px 6px; margin:5px 0; }
    .cj-head { display:flex; gap:6px; align-items:center; }
    .cj-prompt { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cj-stage { color: var(--dim, #8a8f98); font-size: 11px; }
    .cj-x { padding:0 5px; }
    .cj-bar { height:5px; border-radius:3px; background:var(--line,#333); overflow:hidden; margin-top:5px; }
    .cj-bar div { height:100%; background:var(--acc, #7ec8a9); transition:width .6s; }
    .cj-pick { display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-top:5px; }
    .cj-pick img { width:100%; border-radius:4px; cursor:pointer; border:2px solid transparent; }
    .cj-pick img:hover { border-color: var(--acc, #7ec8a9); }
    .cj-done { display:flex; gap:4px; margin-top:5px; }`;
  document.head.appendChild(style);

  makeSection('✨ conjure', async (body) => {
    bodyEl = body;
    await paint(body);
    schedule();
  }, { id: 'conjure' });

  bus.on('your-rights', () => { if (bodyEl) paint(bodyEl).catch(() => {}); });
  schedule();   // resume polling for jobs left cooking before a reload
}
