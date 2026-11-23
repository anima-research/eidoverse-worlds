// xr-confirm-probe — a question asked in a headset is answered in the headset. The client's yes/no asks went to the
// browser's confirm() (speech-to-text consent, log out, closing the door) or to the DOM centre card, neither of which an
// immersive session draws: the action blocked or quietly said no. Real client + IWER; the answers go through
// domQuadsPick, the same laser path the trigger uses, on the `ask` quad (xr/xrask.js).
//   bun test/client/xr-confirm-probe.mjs
// Mutation (must go red): in client/lib/edit/confirmcenter.js confirmCenter, drop the `headset?.active()` branch.
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg);
const errs = [], dialogs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
// a native dialog in a headset is the bug: record it and dismiss it so the page doesn't hang on it
pg.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message().slice(0, 60)}`); d.dismiss().catch(() => {}); });
try {
  await pg.goto(`${world.origin}/?world=staging&name=askprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await enterVR(pg);
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const dq = await import('./lib/xr/domquad.js'); const THREE = await import('three');
    const ask = await import('./lib/xr/xrask.js');
    // no domQuadsSetShown(true): every panel at once covers the keyboard; the ask quad and the keyboard show themselves
    // aim a laser at a DOM point inside quad `id`, pull the trigger: the real pick → mousedown/up/click path
    const meshOf = (id) => dq.domQuadMesh(id);
    const pull = (id, el) => {
      const mesh = meshOf(id), dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect(), er = el.getBoundingClientRect();
      const u = (er.left + er.width / 2 - fr.left) / fr.width, v = (er.top + er.height / 2 - fr.top) / fr.height;
      const { width: W, height: H } = mesh.geometry.parameters;
      mesh.updateMatrixWorld(true);
      const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
      const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const ray = { matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) };
      return dq.domQuadsPick(ray, true);
    };
    const askBtn = (re) => [...(dq.domQuadTexture('ask')?.dom?.querySelectorAll('button') ?? [])].find((b) => re.test(b.textContent) && b.getBoundingClientRect().height > 0);
    const out = {};
    // C: the guarded action — turning on speech-to-text asks for consent first (audio/voiceconsent.js)
    const vc = await import('./lib/audio/voiceconsent.js');
    let settled = null; const p = vc.ensureSttConsent().then((v) => { settled = v; });
    await sleep(600);
    out.state = ask.xrAskState();
    out.quadOpen = dq.domQuadOpen('ask');
    out.settledEarly = settled;   // on main the native confirm() was dismissed: a silent "no"
    const yes = askBtn(/turn on/i);
    out.yesBtn = yes?.textContent ?? null;
    out.hit = yes ? pull('ask', yes) != null : false;
    await Promise.race([p, sleep(1500)]);
    out.settled = settled; out.consented = vc.sttConsented?.() ?? null;
    out.after = ask.xrAskState(); out.quadAfter = dq.domQuadOpen('ask');
    // A: a few words asked in a headset (askCenter: the speech-server address, a blueprint's name) — typed on the VR keyboard
    const cc = await import('./lib/edit/confirmcenter.js');
    let words; const pa = cc.askCenter({ title: 'Name it', value: '', ok: 'Save' }).then((v) => { words = v; });
    await sleep(600);
    out.askState = ask.xrAskState();
    const inp = dq.domQuadTexture('ask')?.dom?.querySelector('input');
    out.input = !!inp;
    if (inp) {
      pull('ask', inp); await sleep(300);
      out.kbOpen = dq.domQuadOpen('keyboard');
      // where the two quads sit (they overlapped on the arc, and the question covered ⌫ and ⏎)
      out.layout = Object.fromEntries(['ask', 'keyboard'].map((id) => { const m = dq.domQuadMesh(id); if (!m) return [id, null]; m.updateMatrixWorld(true); const p = new THREE.Vector3(); m.getWorldPosition(p); return [id, { p: p.toArray().map((x) => +x.toFixed(3)), w: +m.geometry.parameters.width.toFixed(3), h: +m.geometry.parameters.height.toFixed(3) }]; }));
      const kb = dq.domQuadTexture('keyboard')?.dom;
      out.keys = [];
      for (const k of ['h', 'i', '⏎']) { const b = kb?.querySelector(`button[data-k="${k}"]`); out.keys.push(b ? pull('keyboard', b) : 'none'); out.typed = inp.value; await sleep(150); }
    }
    await Promise.race([pa, sleep(1500)]);
    out.words = words === undefined ? 'unsettled' : words;
    out.askAfter = ask.xrAskState();
    out.card = !!document.querySelector('#confirm-center');
    return out;
  });
  console.log('  ·', JSON.stringify(r));
  check('C1 in a headset, the speech-to-text consent question rides the ask quad', r.state && /speech-to-text/i.test(r.state.title) && r.quadOpen, JSON.stringify(r.state));
  check('C2 …and waits for an answer (no native dialog quietly answering it)', r.settledEarly === null && !dialogs.some((d) => /^confirm/.test(d)), dialogs.join(' | '));
  check('C3 the trigger on its yes button answers yes, and the consent is recorded', r.hit && r.settled === true && r.consented === true, JSON.stringify({ hit: r.hit, settled: r.settled, consented: r.consented, yes: r.yesBtn }));
  check('C4 …and the quad goes away', r.after === null && !r.quadAfter);
  check('A1 a few words asked in a headset show a text field on the ask quad', r.input && r.askState && /Name it/.test(r.askState.title), JSON.stringify(r.askState));
  check('A2 …the trigger on it opens the VR keyboard, and its keys and ⏎ answer it', r.kbOpen && r.words === 'hi', JSON.stringify({ kb: r.kbOpen, words: r.words, keys: r.keys, typed: r.typed }));
  check('A3 …and nothing was left on the desk card nobody could see', !r.card && r.askAfter === null);
  check('no native dialogs at all', dialogs.length === 0, dialogs.join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
