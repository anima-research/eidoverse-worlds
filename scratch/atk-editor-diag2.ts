// @ts-nocheck does Create ▸ Empty pin the main thread in the gym? three variants, each on a fresh page load
import fs from "node:fs"; import path from "node:path";
import { CHROME, cdpOn, freePort, sleep } from "../tools/harness.ts";
const BASE = "http://127.0.0.1:8985", NAME = "atk-ed-1"; const OUT = "/home/claude/eido/logs/atk-editor-shots";
const PROFILE = fs.mkdtempSync("/tmp/atk-ed-profile-"); const DP = freePort(9600);
const browser = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${DP}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", "--mute-audio", "--window-size=1600,1000", "--enable-unsafe-webgpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let target = null; for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); target = l.find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
const cws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
const exc = []; cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.method === "Runtime.exceptionThrown") exc.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 300)); });
const cdp = cdpOn(cws); await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable")]);
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
const ev = async (expr, timeout = 60000) => { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const T = (k, v) => { console.log(k, String(JSON.stringify(v)).slice(0, 600)); };
const boot = async () => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${NAME}&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await ev(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await ev(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000); await ev(`import('/lib/build.js').then((b) => b.setEditMode(true))`); await sleep(1500); };
const alive = async (label) => { const out = []; for (let i = 0; i < 6; i++) { const t0 = Date.now(); const r = await ev(`1+1`, 3000).then(() => "ok").catch((e) => "TIMEOUT"); out.push(`${r}@${Date.now() - t0}ms`); await sleep(1500); } T(label, { pulse: out, exc: exc.splice(0) }); };
try {
  for (const [label, fire] of [
    ["V1 holdGhost('@empty') direct", `import('/lib/build.js').then((b) => b.holdGhost('@empty', 'empty'))`],
    ["V2 holdGhost('@light') direct", `import('/lib/build.js').then((b) => b.holdGhost('@light', 'light'))`],
    ["V3 Create menu ▸ Empty via DOM", `(() => { const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); setTimeout(() => [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === 'Empty')?.click(), 300); })()`],
  ]) { await boot(); await alive("   before " + label); await ev(`setTimeout(() => { ${fire} }, 0); 1`, 3000).catch((e) => T("fire", String(e))); await alive(label);
    const g = await ev(`import('/lib/build.js').then((b) => b.hasGhost())`, 3000).catch((e) => "TIMEOUT"); T("   ghost?", g); }
} catch (e) { T("ERR", String(e).slice(0, 300)); } finally { try { browser.kill(); } catch {} await sleep(300); fs.rmSync(PROFILE, { recursive: true, force: true }); }
process.exit(0);
