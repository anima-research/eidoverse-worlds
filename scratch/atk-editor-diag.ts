// @ts-nocheck diagnostics: why didn't Create ▸ Empty place, and why did undo hang
import fs from "node:fs"; import path from "node:path";
import { CHROME, cdpOn, freePort, sleep } from "../tools/harness.ts";
const BASE = "http://127.0.0.1:8985", NAME = "atk-ed-1"; const OUT = "/home/claude/eido/logs/atk-editor-shots";
const PROFILE = fs.mkdtempSync("/tmp/atk-ed-profile-"); const DP = freePort(9600);
const browser = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${DP}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", "--mute-audio", "--window-size=1600,1000", "--enable-unsafe-webgpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let target = null; for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); target = l.find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
const cws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
const cdp = cdpOn(cws); await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable")]);
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
const evalJson = async (expr) => { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const page = (js) => evalJson(`(async () => { ${js} })()`);
const T = (k, v) => console.log(k, String(JSON.stringify(v)).slice(0, 600));
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${NAME}&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return 1;`); await sleep(1500);
  T("stacks", await page(`return (await import('/lib/editwrites.js')).stacks();`));
  T("rights", await page(`return (await import('/lib/net.js')).myRights;`));
  T("menu Empty", await page(`const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); await new Promise((z) => setTimeout(z, 300)); const it = [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === 'Empty'); it?.click(); await new Promise((z) => setTimeout(z, 600)); return { it: !!it, ghost: (await import('/lib/build.js')).hasGhost() };`));
  const c = await evalJson(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height * 0.72; const e = document.elementFromPoint(x, y); return [x, y, e?.tagName + '.' + e?.className]; })()`); T("under click", c);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(c[0]), y: Math.round(c[1]), button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  await sleep(2500);
  T("after click", await page(`const s = (await import('/lib/state.js')).state.st.entities; return { ghost: (await import('/lib/build.js')).hasGhost(), empties: Object.keys(s).filter((k) => s[k]?.comp?.label === 'empty' && s[k].lib == null), stacks: (await import('/lib/editwrites.js')).stacks(), hint: document.querySelector('.hint, .ew-hint, [class*=hint]')?.textContent.slice(0, 120) };`));
  const r = await page(`const ew = await import('/lib/editwrites.js'); const st = ew.stacks(); const act = st.undo.at(-1); const t0 = performance.now(); const r = await Promise.race([ew.send({ verb: 'undo', args: { act } }, { what: 'undo', record: false }), new Promise((z) => setTimeout(() => z({ timeout: true }), 8000))]); return { act, r: JSON.stringify(r).slice(0, 300), ms: Math.round(performance.now() - t0) };`); T("undo direct", r);
  const s = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, "diag.png"), Buffer.from(s.data, "base64"));
} catch (e) { T("ERR", String(e).slice(0, 300)); } finally { try { browser.kill(); } catch {} await sleep(300); fs.rmSync(PROFILE, { recursive: true, force: true }); }
process.exit(0);
