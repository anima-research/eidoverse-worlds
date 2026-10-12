// @ts-nocheck Create ▸ Empty via the DOM menu: is the page pinned afterwards, and where? (Debugger.pause → call stack)
import fs from "node:fs"; import path from "node:path";
import { CHROME, cdpOn, freePort, sleep } from "../tools/harness.ts";
const BASE = "http://127.0.0.1:8985", NAME = "atk-ed-1";
const PROFILE = fs.mkdtempSync("/tmp/atk-ed-profile-"); const DP = freePort(9600);
const browser = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${DP}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", "--mute-audio", "--window-size=1600,1000", "--enable-unsafe-webgpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let target = null; for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); target = l.find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
const cws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
const exc = []; let paused = null;
cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.method === "Runtime.exceptionThrown") exc.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 200));
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) exc.push("console." + m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200));
  if (m.method === "Debugger.paused") paused = m.params.callFrames.slice(0, 12).map((f) => `${f.functionName || "?"} @ ${f.url.split("/").slice(-2).join("/")}:${f.location.lineNumber + 1}`); });
const cdp = cdpOn(cws); await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable")]);
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
const ev = async (expr, timeout = 8000) => { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const T = (k, v) => { console.log(k, String(JSON.stringify(v)).slice(0, 700)); };
const pulse = async () => { const t0 = Date.now(); const r = await ev(`1+1`, 4000).then(() => "ok").catch(() => "TIMEOUT"); return `${r}@${Date.now() - t0}`; };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${NAME}&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await ev(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await ev(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000); await ev(`import('/lib/build.js').then((b) => b.setEditMode(true))`); await sleep(1500);
  T("before", [await pulse(), await pulse()]);
  T("open Create", await ev(`(() => { const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); return !!b; })()`, 5000).catch((e) => "TIMEOUT"));
  await sleep(400); T("pulse after open", await pulse());
  T("items", await ev(`[...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].map((x) => x.textContent.trim())`, 5000).catch(() => "TIMEOUT"));
  T("click Empty", await ev(`(() => { const it = [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === 'Empty'); it?.click(); return !!it; })()`, 5000).catch((e) => "TIMEOUT"));
  const ps = []; let pinned = 0; for (let i = 0; i < 20; i++) { const p = await pulse(); ps.push(p); if (p.startsWith("TIMEOUT")) pinned++; if (pinned >= 3) break; await sleep(1000); } T("pulses after Create ▸ Empty", ps); T("exc", exc.splice(0));
  if (pinned >= 3) { await cdp.send("Debugger.enable"); await cdp.send("Debugger.pause").catch(() => {}); for (let i = 0; i < 40 && !paused; i++) await sleep(250); T("STACK while pinned", paused); await cdp.send("Debugger.resume").catch(() => {}); await sleep(3000); paused = null; await cdp.send("Debugger.pause").catch(() => {}); for (let i = 0; i < 40 && !paused; i++) await sleep(250); T("STACK again", paused); await cdp.send("Debugger.resume").catch(() => {}); }
  else { T("ghost?", await ev(`import('/lib/build.js').then((b) => b.hasGhost())`, 5000).catch(() => "TIMEOUT"));
    const c = await ev(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.7]; })()`, 5000);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(c[0]), y: Math.round(c[1]), button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
    const ps2 = []; pinned = 0; for (let i = 0; i < 20; i++) { const p = await pulse(); ps2.push(p); if (p.startsWith("TIMEOUT")) pinned++; if (pinned >= 3) break; await sleep(1000); } T("pulses after the placing click", ps2); T("exc", exc.splice(0));
    if (pinned >= 3) { await cdp.send("Debugger.enable"); await cdp.send("Debugger.pause").catch(() => {}); for (let i = 0; i < 40 && !paused; i++) await sleep(250); T("STACK while pinned", paused); await cdp.send("Debugger.resume").catch(() => {}); }
    else { T("made", await ev(`import('/lib/state.js').then((m) => Object.keys(m.state.st.entities).filter((k) => k.startsWith('empty-')))`, 5000).catch(() => "TIMEOUT"));
      T("undo (20 s cap)", await ev(`import('/lib/editwrites.js').then((ew) => Promise.race([ew.undo(), new Promise((z) => setTimeout(() => z({ raceTimeout: true }), 15000))]))`, 20000).catch((e) => "TIMEOUT " + e.message));
      const ps3 = []; for (let i = 0; i < 5; i++) { ps3.push(await pulse()); await sleep(800); } T("pulses after undo", ps3); T("exc", exc.splice(0));
      T("made now", await ev(`import('/lib/state.js').then((m) => Object.keys(m.state.st.entities).filter((k) => k.startsWith('empty-')))`, 5000).catch(() => "TIMEOUT")); } }
} catch (e) { T("ERR", String(e).slice(0, 300)); } finally { try { browser.kill(); } catch {} await sleep(300); fs.rmSync(PROFILE, { recursive: true, force: true }); }
process.exit(0);
