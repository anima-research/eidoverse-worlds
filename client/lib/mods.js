// mods — runtime-loaded client scripts: physics, animation, in-game UI.
//
// The trust model, decided deliberately (docs/leases.md §self-animation):
//
//   * A LOCAL mod is a TRUSTED MOD — full access, an in-page ES module with
//     the whole EW surface (your bones, your leases, the scene, the wire).
//     It can act as you; loading one is a mod-install decision, like a
//     browser extension. Stored in IndexedDB, yours alone, survives reloads.
//   * A WORLD mod is an OFFER: the owner promotes a script to the server
//     (content-addressed, exact bytes pinned) and every visitor chooses —
//     per script, or by wildcard for a world they trust. Nothing ever
//     auto-executes in your page. Consent is keyed to the script's HASH,
//     so a changed script means a fresh question; a world wildcard is the
//     deliberate exception ("run whatever this place offers, sight unseen").
//
// What a mod can DO needs no new machinery — that is the lease thesis: it
// animates your own body freely (it is you), other bodies by their consent
// (bodydrag), objects via leases, and it may build in-game UI through the
// same panel primitives the client itself uses. The engine cannot tell a
// mod's output from anyone else's, which is the point.
//
// Contract: a mod is an ES module. Its default export (if any) is called
// with a context: { name, world, EW, ui, onTick, onDispose }. Ticks are
// wrapped; five consecutive throws pause the mod loudly (the behavior
// tier's rule). Disabling runs your onDispose handlers and removes your
// panels — but a module, once imported, cannot be UNLOADED; a mod that
// grabbed globals keeps them until reload. Trusted means trusted.

import { bus, CONFIG, report } from './core.js';
import { behaviors } from './world.js';
import { sendVerb } from './net.js';
import { makeSection, toast, flashHint } from './ui.js';
import { physicsEnabled, setPhysicsEnabled } from './physobj.js';
import { bodyEngine, setBodyEngine, currentBodyEngine, listBodyEngines } from './bodysim.js';
import { makeFrame } from './frames.js';
import { logChat } from './chat.js';

// ---------------------------------------------------------------- storage

const DB = 'ew-mods';
let db = null;
function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('scripts', { keyPath: 'name' });
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('scripts', mode);
    const out = fn(t.objectStore('scripts'));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};
const listScripts = () => tx('readonly', (s) => s.getAll()).then((r) => r ?? []);
const putScript = (rec) => tx('readwrite', (s) => s.put(rec));
const delScript = (name) => tx('readwrite', (s) => s.delete(name));

// world-mod consent, keyed to exact bytes (the src path IS the hash)
const GRANTS = 'ew-mod-grants';
const grants = () => { try { return JSON.parse(localStorage.getItem(GRANTS) ?? '{}'); } catch { return {}; } };
const grant = (key) => { const g = grants(); g[key] = 1; localStorage.setItem(GRANTS, JSON.stringify(g)); };
const ungrant = (key) => { const g = grants(); delete g[key]; localStorage.setItem(GRANTS, JSON.stringify(g)); };
const scriptKey = (id, src) => `script:${CONFIG.world}:${id}:${src}`;
const worldKey = () => `world:${CONFIG.world}`;

// ---------------------------------------------------------------- runtime

// name -> { ticks: [], disposers: [], sections: [], frames: [], errors, dead }
const running = new Map();

function makeCtx(name) {
  const inst = { ticks: [], disposers: [], sections: [], frames: [], errors: 0, dead: false };
  running.set(name, inst);
  return {
    name,
    world: CONFIG.world,
    EW: globalThis.EW,
    ui: {
      /** A collapsible section in the world panel — removed on disable. */
      section: (title, onOpen) => { const s = makeSection(title, onOpen); inst.sections.push(s); return s; },
      /** A free-floating draggable frame — removed on disable. */
      frame: (id, opts) => { const f = makeFrame(`mod-${name}-${id}`, opts); inst.frames.push(f); return f; },
      toast, flashHint, logChat,
    },
    onTick: (fn) => inst.ticks.push(fn),
    onDispose: (fn) => inst.disposers.push(fn),
  };
}

async function runSource(name, source) {
  stopMod(name);                       // re-run = fresh registrations
  const ctx = makeCtx(name);
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default === 'function') await mod.default(ctx);
    flashHint(`mod "${name}" running`);
  } catch (e) {
    report(`mod ${name}`, e);
    toast(`mod "${name}" failed to start: ${e.message}`, 'err', 9000);
    stopMod(name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function stopMod(name) {
  const inst = running.get(name);
  if (!inst) return;
  running.delete(name);
  for (const fn of inst.disposers) { try { fn(); } catch (e) { report(`mod ${name} dispose`, e); } }
  for (const s of inst.sections) s.box?.remove();
  for (const f of inst.frames) { try { f.hide?.(); f.el?.remove(); } catch { /* gone */ } }
}

export function tickMods(dt, now) {
  for (const [name, inst] of running) {
    if (inst.dead) continue;
    for (const fn of inst.ticks) {
      try { fn(dt, now); inst.errors = 0; }
      catch (e) {
        report(`mod ${name} tick`, e);
        if (++inst.errors >= 5) {
          inst.dead = true;
          toast(`mod "${name}" paused after repeated errors — re-enable it in 🧩 mods`, 'err', 9000);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- world offers

const offers = () => [...behaviors].filter(([, b]) => b.runtime === 'client');

async function runOffer(id, b) {
  const runName = `world:${id}`;
  if (running.has(runName)) return;
  try {
    const res = await fetch(`/library/${b.src}`);
    if (!res.ok) throw new Error(`fetch ${b.src}: ${res.status}`);
    await runSource(runName, await res.text());
  } catch (e) { report(`world mod ${id}`, e); toast(`world mod "${id}" failed: ${e.message}`, 'err'); }
}

/** Consent resolution + autorun — on join and on every roster change. */
function reconcileOffers({ live = false } = {}) {
  const g = grants();
  for (const [id, b] of offers()) {
    const runName = `world:${id}`;
    if (running.has(runName)) continue;
    if (g[scriptKey(id, b.src)] || g[worldKey()]) { runOffer(id, b); continue; }
    if (live) {
      logChat('*', `this world offers a mod: "${id}" by ${b.author} — open 🧩 mods to run it`);
    }
  }
  // unbound offers stop running
  const liveIds = new Set(offers().map(([id]) => `world:${id}`));
  for (const name of [...running.keys()]) {
    if (name.startsWith('world:') && !liveIds.has(name)) stopMod(name);
  }
  paint?.();
}

// ---------------------------------------------------------------- the panel

let paint = null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TEMPLATE = `// an eidoverse mod — full client access, trusted like a browser extension.
// export default gets { name, world, EW, ui, onTick, onDispose }.
// EW: entities, remotes, myState, me(), THREE, scene, sendVerb, lease, bus…
export default ({ EW, ui, onTick }) => {
  ui.flashHint('hello from a mod');
  let t = 0;
  onTick((dt) => {
    t += dt;
    // your per-frame work here — e.g. drive your own bones, hold leases…
  });
};
`;

/** The scriptable face of the mod system — same acts as the panel buttons.
 *  (Also what the e2e drives: UI and API share one implementation.) */
export const modsApi = {
  list: listScripts,
  put: putScript,
  run: (name, source) => runSource(name, source),
  stop: stopMod,
  running: () => [...running.keys()],
  offers: () => offers().map(([id, b]) => ({ id, src: b.src, author: b.author })),
  accept: async (id, always = false) => {
    const b = behaviors.get(id);
    if (!b) return false;
    if (always) grant(scriptKey(id, b.src));
    await runOffer(id, b);
    return true;
  },
};

export function initMods() {
  makeSection('🧩 mods', async (body) => {
    let editing = null;      // name being edited, '' = new
    const render = async () => {
      const mine = await listScripts();
      const g = grants();
      const rows = mine.map((s) => {
        const on = running.has(s.name);
        return `<div class="stack" style="gap:2px">
          <div><b>${esc(s.name)}</b> ${on ? '· running' : ''}
            <button data-run="${esc(s.name)}">${on ? 'stop' : 'run'}</button>
            <button data-auto="${esc(s.name)}">${s.auto ? 'autorun ✓' : 'autorun'}</button>
            <button data-edit="${esc(s.name)}">edit</button>
            <button data-promote="${esc(s.name)}" title="upload + offer to everyone in this world (owner)">promote</button>
            <button data-del="${esc(s.name)}">✕</button></div>
        </div>`;
      }).join('');
      const offerRows = offers().map(([id, b]) => {
        const on = running.has(`world:${id}`);
        const granted = g[scriptKey(id, b.src)] || g[worldKey()];
        return `<div><b>${esc(id)}</b> <span style="color:var(--dim)">by ${esc(b.author)}</span>
          ${on ? '· running' : ''}
          <button data-orun="${esc(id)}">${on ? 'stop' : 'run once'}</button>
          <button data-oalways="${esc(id)}">${g[scriptKey(id, b.src)] ? 'trusted ✓' : 'always (this script)'}</button>
          <button data-osrc="${esc(id)}" title="read the code before trusting it">view</button></div>`;
      }).join('');
      body.innerHTML = `<div class="stack">
        <div><b>built-in</b> — the house plugins, dogfooding the same tier</div>
        <div>⚙ object physics <span style="color:var(--dim)">(balls, boxes, punts — the SIM half; you always SEE others' physics)</span>
          <button data-corephys="1">${physicsEnabled() ? 'on ✓' : 'off'}</button></div>
        <div>⚙ body engine <span style="color:var(--dim)">(how YOUR falls simulate — verlet: particles · rapier: rigid bones, muscle tone · ammo: Bullet, the janus rig — click to cycle)</span>
          <button data-bodyeng="1">${bodyEngine()}</button></div>
        <hr>
        <div style="color:var(--dim)">local mods run with FULL access, as you — load only code you trust</div>
        ${rows || '<div style="color:var(--dim)">no local mods yet</div>'}
        <div><button data-new="1">+ new mod</button></div>
        <hr>
        <div><b>world offers</b> — scripts this world's owner promoted</div>
        ${offerRows || '<div style="color:var(--dim)">none here</div>'}
        <div><button data-wworld="1">${g[worldKey()] ? `trusting everything in "${esc(CONFIG.world)}" ✓ (click to revoke)` : `trust ALL scripts in "${esc(CONFIG.world)}", now and future`}</button></div>
        ${editing != null ? `<hr><div class="stack">
          <input id="mod-name" placeholder="mod name" value="${esc(editing)}" ${editing ? 'disabled' : ''}>
          <textarea id="mod-src" rows="14" spellcheck="false" style="font-family:ui-monospace,monospace;font-size:11px;width:100%"></textarea>
          <div><button data-save="1">save</button> <button data-cancel="1">cancel</button></div>
        </div>` : ''}
      </div>`;
      if (editing != null) {
        const rec = editing ? mine.find((s) => s.name === editing) : null;
        body.querySelector('#mod-src').value = rec?.source ?? TEMPLATE;
      }
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const d = b.dataset;
        // The built-in toggles answer BEFORE any await. listScripts() touches
        // storage and the network, and this is an async handler with no catch:
        // one rejection there killed every button in the panel silently,
        // including the two that need nothing from it. The body-engine toggle
        // then read as permanently stuck — the engine never changed because
        // the click never arrived, not because the switch was wrong.
        if (d.bodyeng) {
          const names = listBodyEngines();
          setBodyEngine(names[(names.indexOf(currentBodyEngine()) + 1) % names.length]);
          flashHint(`body engine: ${bodyEngine()} — takes effect on your next fall`);
          return render();
        }
        if (d.corephys) {
          setPhysicsEnabled(!physicsEnabled());
          flashHint(physicsEnabled() ? 'object physics on — you simulate again'
            : 'object physics off — held objects handed off; others simulate for you');
          return render();
        }
        let mine2 = [];
        try { mine2 = await listScripts(); }
        catch (err) { report('mods: listScripts', err); }
        if (d.new) { editing = ''; return render(); }
        if (d.cancel) { editing = null; return render(); }
        if (d.save) {
          const name = (body.querySelector('#mod-name').value || '').trim().replace(/[^\w-]/g, '').slice(0, 32);
          const source = body.querySelector('#mod-src').value;
          if (!name) return toast('a mod needs a name', 'warn');
          await putScript({ name, source, auto: mine2.find((s) => s.name === name)?.auto ?? false });
          editing = null;
          return render();
        }
        if (d.edit != null) { editing = d.edit; return render(); }
        if (d.del != null) { stopMod(d.del); await delScript(d.del); return render(); }
        if (d.auto != null) {
          const rec = mine2.find((s) => s.name === d.auto);
          if (rec) await putScript({ ...rec, auto: !rec.auto });
          return render();
        }
        if (d.run != null) {
          if (running.has(d.run)) stopMod(d.run);
          else { const rec = mine2.find((s) => s.name === d.run); if (rec) await runSource(d.run, rec.source); }
          return render();
        }
        if (d.promote != null) {
          const rec = mine2.find((s) => s.name === d.promote);
          if (!rec) return;
          try {
            const up = await fetch(`/upload?as=script&token=${encodeURIComponent(CONFIG.token ?? '')}`, {
              method: 'POST', body: rec.source,
            }).then((r) => r.json());
            if (!up.path) throw new Error(up.error ?? 'upload refused');
            sendVerb('behavior', { id: `mod-${rec.name}`, src: up.path, runtime: 'client' });
            toast(`offered "${rec.name}" to this world — visitors choose to run it`, 'info');
          } catch (err) { toast(`promote failed: ${err.message}`, 'err'); }
          return;
        }
        if (d.orun != null) {
          const runName = `world:${d.orun}`;
          if (running.has(runName)) stopMod(runName);
          else { const bb = behaviors.get(d.orun); if (bb) await runOffer(d.orun, bb); }
          return render();
        }
        if (d.oalways != null) {
          const bb = behaviors.get(d.oalways);
          if (!bb) return;
          const key = scriptKey(d.oalways, bb.src);
          if (grants()[key]) ungrant(key); else { grant(key); await runOffer(d.oalways, bb); }
          return render();
        }
        if (d.osrc != null) {
          const bb = behaviors.get(d.osrc);
          if (bb) window.open(`/library/${bb.src}`, '_blank');
          return;
        }
        if (d.wworld) {
          if (grants()[worldKey()]) ungrant(worldKey()); else { grant(worldKey()); reconcileOffers(); }
          return render();
        }
      };
    };
    paint = render;
    await render();
  });

  // autoruns: local mods marked auto, and consented world offers
  bus.on('hydrated', async () => {
    for (const s of await listScripts()) if (s.auto && !running.has(s.name)) runSource(s.name, s.source);
    reconcileOffers();
  });
  bus.on('behavior-roster', ({ live }) => reconcileOffers({ live }));
}
