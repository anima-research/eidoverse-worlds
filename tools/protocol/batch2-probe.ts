// tools/protocol/batch2-probe.ts — batch 2 in a real browser: one headless Chromium against a scratch sequencer (tools/harness.ts
// scratchBench), one stage per visible component, plus the privacy proof for media links. Run it under the house guards
// (test:protocol's `client-b2` suite does: flock on the headless lock, perf-guard).
//
//   PRIV  an untrusted link (a picture's and a sound's) is NEVER requested by a viewer who hasn't opted in: every https
//         request the page makes is caught at the network layer (CDP Fetch: paused, recorded, failed: nothing leaves the
//         machine) and none names the untrusted host; no audio element exists for it. The same detector sees the request
//         for a trusted host's link (so it would have seen one), and for the untrusted link once the viewer opts in
//         (Settings › 🛡 safety): that's the gate's own mutant, run live.
//   PIC   a picture with no part is a quad of its own: its aspect is the image's (a 2:1 moon), width as written
//   SND   a store sound: the limiter is in the graph; silent past its radius (gain exactly 0), heard inside; of 10 loops,
//         at most 8 are heard
//   TXT   a sign: drawn (flat = two planes, readable from behind; yaw = one plane that turns to face you)
//   LA    look-at @viewer: the thing turns to face the camera
//   STO   a story's card is in the Inspector (Inspect shows it)
//   HIS   History's "biggest contributors" view (Credits) shows who made it
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "b2bot", WORLD = "b2";
process.env.TRUST_NAMES = "1";
let worldsDir = "";
import { pagedEval } from "./idalias.ts";
// R 10-17: the page names what it makes with placeholders (tools/protocol/idalias.ts pageIds); quoted names in page code are ids
const NAMES = ["linkpic", "linkradio", "hostradio", "moon", "radio", "sign", "post", "statue", "kiosk", ...Array.from({ length: 10 }, (_, i) => `loop${i}`)];
const { cdp, cws, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench("batch2", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "batch 2 probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const evalJson = pagedEval(evalRaw, NAMES);
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const disk = () => fold(readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl"))));
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const req = (verb: string, args: any) => page(`const m = await import('/lib/net.js'); return await m.sendRequest('${verb}', ${JSON.stringify(args)});`);

// every https request the page makes: caught before it leaves (CDP Fetch), recorded, failed
const outside: string[] = [], sentWith: { u: string; r: string | null; origin: string | null }[] = [];   // each outside request, with the Referer and Origin it carried (null: none)
cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data));
  if (m.method === "Fetch.requestPaused") { outside.push(m.params.request.url);
    const hs = m.params.request.headers ?? {}; const hv = (name: string) => { const k = Object.keys(hs).find((h) => h.toLowerCase() === name); return k ? hs[k] : null; };
    sentWith.push({ u: m.params.request.url, r: hv("referer"), origin: hv("origin") }); cdp.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }).catch(() => {}); } });
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
const UNTRUSTED = "untrusted-b2probe.example.net", TRUSTED = "b2probe.vrcdn.live";
const sawHost = (h: string) => outside.some((u) => { try { return new URL(u).hostname === h; } catch { return false; } });

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message)); try { localStorage.removeItem('eido.allowUntrustedLinks'); } catch {}` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("B1 world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`));
  // the media modules are loaded by the page (main.js imports them): wait for them to answer
  await waitFor(`Promise.all([import('/lib/sounds.js'), import('/lib/pictures.js'), import('/lib/texts.js'), import('/lib/lookats.js')]).then(() => true)`);
  const empty = (id: string, pos: number[], components: any = {}) => req("create", { id, components: { transform: { pos }, ...components } });

  // ---- PRIV: an untrusted link is never fetched for a viewer who hasn't opted in ----
  check("PRIV0 the viewer hasn't opted in (the default)", (await page(`return (await import('/lib/mediaprefs.js')).allowUntrusted();`)) === false);
  const n0 = outside.length;
  const p1 = await empty("linkpic", [2, 0, -4], { picture: { src: `https://${UNTRUSTED}/party.png`, alt: "a poster from elsewhere" } });
  const s1 = await empty("linkradio", [-2, 0, -4], { sound: { src: `https://${UNTRUSTED}/party.mp3`, alt: "music from elsewhere" } });
  check("PRIV1 the authority takes both links (said: only viewers who opted in)", p1?.ok && s1?.ok && JSON.stringify([p1, s1]).includes("opted-in"), [p1?.notes, s1?.notes]);
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('linkpic') && m.entities.has('linkradio'))`);
  await sleep(2500);   // time enough for any fetch, preload or decode to have been attempted
  const st1 = await page(`const s = await import('/lib/sounds.js'), p = await import('/lib/pictures.js');
    return { audio: s._playing.has('linkradio'), sb: s._blocked.get('linkradio') ?? null, pb: p._blocked.get('linkpic') ?? null, plate: !!p._hung.get('linkpic')?.quad,
      els: [...document.querySelectorAll('audio,img')].filter((e) => String(e.src).includes('${UNTRUSTED}')).length };`);
  check("PRIV2 …and this browser never contacts the untrusted host: 0 requests, no audio element, both marked blocked (the picture shows its empty plate)",
    !sawHost(UNTRUSTED) && !st1.audio && st1.sb === "untrusted" && st1.pb === "untrusted" && st1.plate && st1.els === 0, { since: outside.slice(n0), st1 });
  const s2 = await empty("hostradio", [0, 0, -6], { sound: { src: `https://${TRUSTED}/live/party.mp3` } });
  check("PRIV3 control: a trusted host's link IS requested (the detector would have seen one)", s2?.ok && await waitFor(`Promise.resolve(true)`) && await (async () => { for (let i = 0; i < 40 && !sawHost(TRUSTED); i++) await sleep(100); return sawHost(TRUSTED); })(), outside.slice(n0));
  await page(`(await import('/lib/mediaprefs.js')).setAllowUntrusted(true); return true;`);
  const both = () => [".png", ".mp3"].every((x) => outside.some((u) => u.includes(UNTRUSTED) && u.endsWith(x)));
  for (let i = 0; i < 50 && !both(); i++) await sleep(100);   // both links, so PRIV4b's control isn't a race
  check("PRIV4 the viewer opts in (Settings › 🛡 safety): now the same links are requested (the gate, removed live, is seen)", sawHost(UNTRUSTED), outside.filter((u) => u.includes(UNTRUSTED)));
  { const sent = sentWith.filter(({ u }) => u.includes(UNTRUSTED) || u.includes(TRUSTED));   // Origin is recorded, not judged: a CORS fetch names the page's origin (sounds.js §9)
    check("PRIV4b …and no link, a sound's or a picture's, is sent with a Referer (sounds.js §9; a CORS fetch's Origin, the page's origin, is recorded beside it)",
      // its positive control is both untrusted links seen, the picture's and the sound's (house 6340433633: the trusted MP3
      // alone met it, so it could pass with no picture request seen)
      sent.some(({ u }) => u.includes(UNTRUSTED) && u.endsWith(".png")) && sent.some(({ u }) => u.includes(UNTRUSTED) && u.endsWith(".mp3")) && sent.every(({ r }) => r === null), sent); }
  await page(`(await import('/lib/mediaprefs.js')).setAllowUntrusted(false); return true;`);
  check("PRIV5 …and opting out again tears the link's audio down", await waitFor(`import('/lib/sounds.js').then((s) => !s._playing.has('linkradio') && s._blocked.get('linkradio') === 'untrusted')`));
  await evalJson(`(() => { document.querySelector('#sec-safety-tab')?.click(); return true; })()`);
  check("PRIV6 the setting is a row in Settings › 🛡 safety (off)", await waitFor(`(() => { const b = document.querySelector('#sec-safety'); const cb = b?.querySelector('input[type=checkbox]'); return !!cb && !cb.checked && /Allow untrusted links/.test(b.textContent); })()`, 4000),
    await evalJson(`({ tab: document.querySelector('#sec-safety-tab')?.title ?? null, body: (document.querySelector('#sec-safety')?.textContent ?? '').slice(0, 120) })`));

  // ---- PIC: a quad of its own, the image's aspect ----
  await empty("moon", [0, 1, -3], { picture: { src: "eidoverse/assets/sky/moon_color_1k.jpg", width: 2, alt: "the moon" } });
  check("PIC1 a picture with no part is a quad 2 m wide, as tall as the image's aspect (a 2:1 moon: 1 m)", await waitFor(`import('/lib/pictures.js').then((p) => { const h = p._hung.get('moon'); if (!h?.quad || !h.aspect) return false;
      const g = h.quad.children[0].geometry.parameters; return Math.abs(g.width - 2) < 1e-6 && Math.abs(g.height - 1) < 0.01 && h.quad.children.length === 2; })`, 12000),
    await page(`const p = await import('/lib/pictures.js'); const h = p._hung.get('moon'); return h ? { aspect: h.aspect, kids: h.quad?.children.length, g: h.quad?.children[0]?.geometry.parameters } : null;`));

  // ---- SND: the limiter, silent at radius, 8 voices ----
  await empty("radio", [0, 0, 40], { sound: { src: "eidoverse/assets/audio/crow_caw_single.wav", radius: 12 } });
  await waitFor(`import('/lib/sounds.js').then((s) => s._playing.has('radio'))`);
  const me = await page(`const c = await import('/lib/core.js'); const v = c.camera.getWorldPosition(new c.THREE.Vector3()); return [v.x, v.y, v.z];`);
  await sleep(400);
  const far = await page(`const s = await import('/lib/sounds.js'); s.tickSounds(); return { g: s._playing.get('radio').gain.gain.value, limiter: !!s._limiter(), ratio: s._limiter()?.ratio.value };`);
  check("SND1 a store sound 40 m away with radius 12 is exactly silent (gain 0), and the limiter is in the graph", far.g === 0 && far.limiter && far.ratio === 20, { far, me });
  await req("set", { id: "radio", component: "transform", value: { pos: [me[0] + 1, 0, me[2]], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  check("SND2 …moved beside you, it's heard", await waitFor(`import('/lib/sounds.js').then((s) => (s.tickSounds(), s._playing.get('radio').gain.gain.value > 0.1))`), await page(`const s = await import('/lib/sounds.js'); return s._playing.get('radio')?.gain.gain.value;`));
  for (let i = 0; i < 10; i++) await empty(`loop${i}`, [me[0] + 1 + i * 0.1, 0, me[2] + 1], { sound: { src: "eidoverse/assets/audio/crow_caw_single.wav", radius: 30 } });
  await waitFor(`import('/lib/sounds.js').then((s) => [...Array(10).keys()].every((i) => s._playing.has('loop' + i)))`);
  const heard = await page(`const s = await import('/lib/sounds.js'); s.tickSounds(); return [...s._playing.values()].filter((h) => (h.gain ? h.gain.gain.value : h.el.volume) > 0).length;`);
  check("SND3 eleven sounds in reach: 8 are heard (the voice cap)", heard === 8, heard);

  // ---- TXT: signs ----
  await empty("sign", [3, 1.5, -3], { text: { text: "Welcome · ようこそ · مرحبا", size: 0.2 } });
  await empty("post", [-3, 1.5, -3], { text: { text: "this way", billboard: "yaw" } });
  check("TXT1 a flat sign is drawn: two planes (readable from behind), wrapped lines", await waitFor(`import('/lib/texts.js').then((t) => { const s = t._signs.get('sign'); return !!s && s.group.children.length === 2 && s.lines >= 1 && s.w > 0; })`),
    await page(`const t = await import('/lib/texts.js'); const s = t._signs.get('sign'); return s ? { kids: s.group.children.length, lines: s.lines, w: s.w, h: s.h } : null;`));
  check("TXT2 a yaw billboard is one plane that turns toward the viewer", await waitFor(`import('/lib/texts.js').then((t) => { const s = t._signs.get('post'); if (!s) return false; t.tickTexts(); return s.group.children.length === 1 && Math.abs(s.group.quaternion.y) > 0.01; })`),
    await page(`const t = await import('/lib/texts.js'); const s = t._signs.get('post'); return s ? s.group.quaternion.toArray() : null;`));

  // ---- LA: look-at the viewer ----
  await empty("statue", [4, 0, 0], { "look-at": { target: "@viewer", speed: 0 } });
  const la = await (async () => { for (let i = 0; i < 60; i++) { const r = await page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), l = await import('/lib/lookats.js'); l.tickLookAt();
      const o = w.entities.get('statue'); if (!o) return null; const p = o.getWorldPosition(new c.THREE.Vector3()), e = c.camera.getWorldPosition(new c.THREE.Vector3());
      const f = new c.THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new c.THREE.Quaternion())); const to = e.sub(p); to.y = 0; to.normalize(); f.y = 0; f.normalize();
      return { dot: f.dot(to), live: l._lookats.size };`); if (r && r.dot > 0.99) return r; await sleep(100); } return null; })();
  check("LA1 look-at @viewer: its front turns to the camera", la && la.dot > 0.99, la);

  // ---- STO: a story on Inspect ----
  await empty("kiosk", [0, 0, -2], { story: { title: "The first marker tree", text: "Mica's fire — already burning when FC arrived.\n\nOne tree, renewing, not accumulating." } });
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('kiosk'))`);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await waitFor(`document.body.classList.contains('edit-mode')`);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('kiosk'); return true;`);
  check("STO1 the Inspector shows its Story card, title and text", await waitFor(`(() => { const f = document.querySelector('[data-frame="inspector"]'); if (!f) return false; const vals = [...f.querySelectorAll('input,textarea')].map((x) => x.value); return vals.includes('The first marker tree') && vals.some((v) => v.includes('renewing')); })()`, 6000),
    await evalJson(`[...(document.querySelector('[data-frame="inspector"]')?.querySelectorAll('input,textarea') ?? [])].map((x) => x.value).slice(0, 12)`));

  // ---- HIS: Credits in History ----
  await page(`(await import('/lib/base.js')).bus.emit('edit-righttab', 'history'); return true;`);
  await waitFor(`!!document.querySelector('[data-frame="history"] select')`, 6000);
  await evalJson(`(() => { const s = [...document.querySelectorAll('[data-frame="history"] select')].find((x) => [...x.options].some((o) => o.value === 'top')); if (!s) return false; s.value = 'top'; s.dispatchEvent(new Event('change')); return true; })()`);
  check("HIS1 History › biggest contributors: who made it, in the Credits words", await waitFor(`/made it/.test(document.querySelector('[data-frame="history"]')?.textContent ?? '')`, 6000),
    await evalJson(`(document.querySelector('[data-frame="history"]')?.textContent ?? '').slice(0, 300)`));

  check("no page errors", !(await evalJson(`__errs.length`)), await evalJson(`__errs`));
} catch (e: any) { check("probe ran to the end", false, String(e?.stack ?? e).slice(0, 500)); }
console.log(`[batch2-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
