// cdp-pw: the slice of playwright's Page the browser probes use, over raw CDP on the runtime's own WebSocket (chrome.ts
// says why the gate never runs playwright). One Chromium per launch; each page() is its own browser context.
// gate: launches a browser
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { findChrome, chromeArgs } from '../gate/chrome.ts';
import { killChild } from '../gate/procgroup.ts';
import { until, tryUntil, pause, WAIT_SCALE } from '../gate/wait.ts';

const KEYS = {
  Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  Space: [32, 'Space', ' '], ' ': [32, 'Space', ' '], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'],
  ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  Shift: [16, 'ShiftLeft'], Control: [17, 'ControlLeft'], Alt: [18, 'AltLeft'], Meta: [91, 'MetaLeft'],
};
const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
function keyDef(k) {
  if (KEYS[k]) { const [code, c, text] = KEYS[k]; return { key: k === 'Space' ? ' ' : k, code: c, vk: code, text }; }
  if (/^F\d+$/.test(k)) return { key: k, code: k, vk: 111 + Number(k.slice(1)) };
  if (k.length === 1) {
    const up = k.toUpperCase();
    const code = /[a-z]/i.test(k) ? `Key${up}` : /\d/.test(k) ? `Digit${k}` : '';
    return { key: k, code, vk: /[a-z\d]/i.test(k) ? up.charCodeAt(0) : k.charCodeAt(0), text: k };
  }
  // playwright's code names: KeyA-KeyZ and Digit0-Digit9 type their character, as a press of 'a' or '7' does
  const named = /^Key([A-Z])$/.exec(k) ?? /^Digit(\d)$/.exec(k);
  if (named) return { key: named[1].toLowerCase(), code: k, vk: named[1].charCodeAt(0), text: named[1].toLowerCase() };
  return { key: k, code: k, vk: 0 };
}
// playwright's console text (crExecutionContext renderPreview): an object or array prints its preview, null and undefined their names
const renderArg = (o) => o.type === 'undefined' ? 'undefined' : 'value' in o ? String(o.value) : o.unserializableValue ? String(o.unserializableValue)
  : o.description === 'Object' && o.preview ? `{${o.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}`
  : o.subtype === 'array' && o.preview ? `[${o.preview.properties.filter((p) => +p.name >= 0).map((p) => p.value).join(', ')}]` : o.description;
const fnSource = (fn, arg) => typeof fn === 'function' ? `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn);

/** A browser-level CDP connection with flat sessions: send(method, params, sessionId), on(event, fn). */
function cdpClient(ws) {
  let id = 0; const waiting = new Map(), listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(`${w.method}: ${m.error.message}`)) : w.res(m.result); return; }
    for (const f of listeners) f(m);
  });
  ws.addEventListener('close', () => { for (const w of waiting.values()) w.rej(new Error(`${w.method}: browser connection closed`)); waiting.clear(); });
  return {
    send(method, params = {}, sessionId) {
      const myId = ++id;
      return new Promise((res, rej) => { waiting.set(myId, { res, rej, method }); ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) })); });
    },
    listen(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}

/** Launch one Chromium (`exe`, else findChrome). `page({ initScripts, permissions, viewport })` opens a page in a fresh browser context. */
export async function launchCdp({ args = [], exe = findChrome() } = {}) {
  if (!exe) throw new Error("no Chromium to launch: set CHROME, or install playwright's (bun node_modules/playwright/cli.js install chromium)");
  const port = await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-pw-'));
  const child = spawn(exe, [...chromeArgs({ port, profile, extra: args }), 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const info = await until('Chromium answers /json/version', async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; }
  }, { ms: 60_000 });
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error("the browser's debugging socket didn't open"))); });
  const C = cdpClient(ws);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    C.send('Browser.close').catch(() => { /* it closes the socket as it goes */ });
    await until('Chrome exits', () => child.exitCode !== null || child.signalCode !== null, { ms: 5000 }).catch(() => {});
    killChild(child); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked: goes with the scratch dir */ }
  };
  const page = async ({ initScripts = [], permissions = [], viewport = null, touch = false, mobile = false, deviceScaleFactor = 1, userAgent = null } = {}) => {
    const { browserContextId } = await C.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await C.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await C.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = makePage(C, sessionId, { targetId, browserContextId, metrics: { mobile, deviceScaleFactor } });
    await pg._init({ initScripts, permissions, viewport, touch, userAgent });
    return pg;
  };
  // playwright's context: init scripts collected, then applied to each page it opens
  const newContext = async ({ viewport = null, permissions = [], hasTouch = false, isMobile = false, deviceScaleFactor = 1, userAgent = null } = {}) => {
    // …and its routes, on each page it has opened and will open (a page's own route still added after them)
    const inits = [], pages = [], routes = [];
    return {
      addInitScript: async (fn, arg) => { inits.push([fn, arg]); },
      route: async (pattern, handler) => { routes.push([pattern, handler]); for (const p of pages) await p.route(pattern, handler); },
      unroute: async (pattern, handler) => { for (let i = routes.length - 1; i >= 0; i--) if (routes[i][0] === pattern && (!handler || routes[i][1] === handler)) routes.splice(i, 1); for (const p of pages) await p.unroute(pattern, handler); },
      newPage: async () => { const p = await page({ viewport, permissions, touch: hasTouch, mobile: isMobile, deviceScaleFactor, userAgent, initScripts: inits }); for (const [pt, h] of routes) await p.route(pt, h); pages.push(p); return p; },
      close: async () => { for (const p of pages) await p.close(); },
    };
  };
  return { page, newContext, newPage: () => page(), close, port };
}

function makePage(C, S, { targetId, browserContextId, metrics }) {
  const send = (m, p) => C.send(m, p, S);
  const handlers = { console: new Set(), pageerror: new Set(), dialog: new Set(), request: new Set(), requestfinished: new Set(), requestfailed: new Set(), framenavigated: new Set() };
  const routes = [], reqs = new Map();
  let size = { width: 1280, height: 720 };
  C.listen((m) => {
    if (m.sessionId !== S) return;
    const p = m.params;
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = p.args.map(renderArg).join(' '); const type = p.type === 'warning' ? 'warning' : p.type;
      // playwright's ConsoleMessage has location() too: a probe that reads it on an error crashed here (xr-lifecycle, CI 42190828916)
      const at = p.stackTrace?.callFrames?.[0], location = { url: at?.url ?? '', lineNumber: at?.lineNumber ?? 0, columnNumber: at?.columnNumber ?? 0 };
      for (const f of handlers.console) f({ type: () => type, text: () => text, location: () => location });
    }
    else if (m.method === 'Runtime.exceptionThrown') { const d = p.exceptionDetails; const e = new Error(d?.exception?.description ?? d?.text ?? 'page error'); for (const f of handlers.pageerror) f(e); }
    else if (m.method === 'Page.javascriptDialogOpening') {
      const dialog = { message: () => p.message, type: () => p.type, accept: (t) => send('Page.handleJavaScriptDialog', { accept: true, ...(t !== undefined ? { promptText: t } : {}) }), dismiss: () => send('Page.handleJavaScriptDialog', { accept: false }) };
      if (handlers.dialog.size) for (const f of handlers.dialog) f(dialog); else void dialog.dismiss();
    }
    else if (m.method === 'Network.requestWillBeSent') { const r = { url: () => p.request.url, method: () => p.request.method, postData: () => p.request.postData ?? null, headers: () => Object.fromEntries(Object.entries(p.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), resourceType: () => String(p.type ?? 'other').toLowerCase(), failure: () => null }; const prev = p.redirectResponse ? reqs.get(p.requestId) : null; if (prev) for (const f of handlers.requestfinished) f(prev); reqs.set(p.requestId, r); for (const f of handlers.request) f(r); }   // a redirect finishes its hop (playwright's shape)
    // the same request object the 'request' handlers saw (playwright's identity: a probe's Map/Set of requests matches it)
    else if (m.method === 'Network.loadingFinished') { const r = reqs.get(p.requestId) ?? { url: () => '', resourceType: () => 'other', failure: () => null }; reqs.delete(p.requestId); for (const f of handlers.requestfinished) f(r); }
    else if (m.method === 'Network.loadingFailed') { const r = reqs.get(p.requestId) ?? { url: () => '', resourceType: () => 'other', failure: () => null }; reqs.delete(p.requestId); r.failure = () => ({ errorText: p.errorText }); for (const f of handlers.requestfailed) f(r); }
    else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) { for (const f of handlers.framenavigated) f({ url: () => p.frame.url }); }
    else if (m.method === 'Fetch.requestPaused') {
      const url = p.request.url, done = { v: false };
      const route = {
        request: () => ({ url: () => url, method: () => p.request.method }),
        fulfill: ({ status = 200, body = '', contentType = 'text/plain', headers = {} } = {}) => { done.v = true; const b = Buffer.isBuffer(body) ? body : Buffer.from(body); return send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: contentType }, ...Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))], body: b.toString('base64') }); },
        continue: () => { done.v = true; return send('Fetch.continueRequest', { requestId: p.requestId }); },
        abort: () => { done.v = true; return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }); },
      };
      const h = routes.find((r) => r.test(url));
      if (h) Promise.resolve(h.handler(route)).catch(() => {}); else void route.continue();
    }
  });
  // as playwright does: an evaluation cut off by a navigation (the client reloading itself) runs again in the new document
  const LOST = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context/;
  const evaluateOnce = async (fn, arg, byValue = true) => {
    const r = await send('Runtime.evaluate', { expression: fnSource(fn, arg), awaitPromise: true, returnByValue: byValue, userGesture: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return byValue ? r.result.value : r.result;
  };
  const evaluate = async (fn, arg, byValue = true) => {
    let out, err = null, lost = null;
    const done = await tryUntil('an evaluation outlives a navigation', async () => {
      try { out = await evaluateOnce(fn, arg, byValue); return true; } catch (e) { if (LOST.test(String(e?.message))) { lost = e; return false; } err = e; return true; }
    }, { ms: 30_000, step: 100 });
    if (err) throw err;
    if (!done) throw lost;
    return out;
  };
  const center = async (sel, timeout = 30_000) => {
    // …and takes the pointer at its centre (playwright's hit-target check): an overlay over it, a splash, is waited out
    await until(`${sel} is on the page, visible and not covered`, () => evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r0 = e.getBoundingClientRect(); if (!(r0.width > 0 && r0.height > 0 && getComputedStyle(e).visibility !== 'hidden')) return false;
      e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && e.contains(h); }, sel), { ms: timeout });
    return evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  };
  let mods = 0, mx = 0, my = 0, buttons = 0;
  const mouse = {
    move: async (x, y) => { mx = x; my = y; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods, buttons }); },
    down: async ({ button = 'left' } = {}) => { buttons = 1; await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button, clickCount: 1, modifiers: mods, buttons }); },
    up: async ({ button = 'left' } = {}) => { buttons = 0; await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx, y: my, button, clickCount: 1, modifiers: mods, buttons }); },
    click: async (x, y, { button = 'left' } = {}) => { await mouse.move(x, y); await mouse.down({ button }); await mouse.up({ button }); },
    wheel: async (dx, dy) => { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: dx, deltaY: dy, modifiers: mods }); },
  };
  // Shift held turns a letter's key and text upper case, as playwright's keyboard does
  const shifted = (d) => (mods & MOD.Shift) && /^[a-z]$/.test(d.key) ? { ...d, key: d.key.toUpperCase(), text: d.text && d.text.toUpperCase() } : d;
  const keyEvent = async (type, d0) => { const d = shifted(d0); return send('Input.dispatchKeyEvent', { type, key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: mods, ...(type === 'keyDown' && d.text && !(mods & ~MOD.Shift) ? { text: d.text } : {}) }); };
  const keyboard = {
    down: async (k) => { if (MOD[k]) mods |= MOD[k]; await keyEvent('keyDown', keyDef(k)); },
    up: async (k) => { await keyEvent('keyUp', keyDef(k)); if (MOD[k]) mods &= ~MOD[k]; },
    press: async (combo) => {
      const parts = combo.split('+').filter(Boolean), key = parts.pop() ?? '+';
      for (const m of parts) await keyboard.down(m);
      await keyboard.down(key); await keyboard.up(key);
      for (const m of parts.reverse()) await keyboard.up(m);
    },
    type: async (text) => { for (const ch of text) await keyboard.press(ch); },
    insertText: (text) => send('Input.insertText', { text }),
  };
  // playwright's JSHandle / ElementHandle over a CDP object id: an element's methods run on it (callFunctionOn), not on a selector
  const callOn = async (objectId, fn, args = [], byValue = true) => {
    const r = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: String(fn), arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: byValue, userGesture: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return byValue ? r.result.value : r.result;
  };
  const handleOf = (ro) => {
    const id = ro.objectId, on = (fn, args, byValue) => callOn(id, fn, args, byValue);
    const h = { jsonValue: async () => id ? on(function () { return this; }) : ro.value, dispose: async () => { if (id) await send('Runtime.releaseObject', { objectId: id }).catch(() => {}); }, asElement: () => null };
    if (ro.subtype !== 'node') return h;
    const el = Object.assign(h, { asElement: () => el,
      evaluate: (fn, a) => on(`function (a) { return (${fn})(this, a); }`, [a]),
      evaluateHandle: async (fn, a) => handleOf(await on(`function (a) { return (${fn})(this, a); }`, [a], false)),
      $: async (s) => { const r = await on(function (s) { return this.querySelector(s); }, [s], false); return r.subtype === 'null' ? null : handleOf(r); },
      click: async ({ button = 'left' } = {}) => { const { x, y } = await on(function () { this.scrollIntoView({ block: 'center', inline: 'center' }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await mouse.click(x, y, { button }); },
      focus: () => on(function () { this.focus(); }),
      press: async (k) => { await el.focus(); await keyboard.press(k); },
      getAttribute: (n) => on(function (n) { return this.getAttribute(n); }, [n]),
      textContent: () => on(function () { return this.textContent; }),
    });
    return el;
  };
  const touchscreen = { tap: async (x, y) => { await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); } };
  const pg = {
    _init: async ({ initScripts, permissions, viewport, touch, userAgent }) => {
      await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
      if (userAgent) await send('Emulation.setUserAgentOverride', { userAgent });   // navigator.userAgent and the request header
      if (permissions.length) await C.send('Browser.grantPermissions', { permissions: permissions.map((p) => p === 'microphone' ? 'audioCapture' : p), browserContextId });
      await pg.setViewportSize(viewport ?? size);
      if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      for (const [fn, arg] of initScripts) await pg.addInitScript(fn, arg);
    },
    evaluate,
    waitForTimeout: (ms) => pause("Playwright's waitForTimeout (the bare wait is counted at its caller)", ms),
    evaluateHandle: async (fn, arg) => handleOf(await evaluate(fn, arg, false)),
    waitForFunction: async (fn, arg, { timeout = 30_000, polling = 100 } = {}) => {
      // each poll is raced against what is left of the timeout: an evaluation that never settles (a hung import) ends the wait
      const end = performance.now() + timeout * WAIT_SCALE;   // until's own deadline, scaled the same
      const poll = () => { let t; return Promise.race([evaluate(fn, arg), new Promise((res) => { t = setTimeout(() => res(false), Math.max(0, end - performance.now())); })]).finally(() => clearTimeout(t)); };
      const v = await until(`page condition ${String(fn).slice(0, 80)}`, poll, { ms: timeout, step: typeof polling === 'number' ? polling : 100 });
      return { jsonValue: async () => v };
    },
    waitForSelector: async (sel, { state = 'visible', timeout = 30_000 } = {}) => until(`${sel} ${state}`, () => evaluate(([s, st]) => {
      const e = document.querySelector(s);
      if (st === 'detached') return !e; if (st === 'attached') return !!e;
      const vis = !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
      return st === 'hidden' ? !vis : vis;
    }, [sel, state]), { ms: timeout }),
    addInitScript: async (fn, arg) => { await send('Page.addScriptToEvaluateOnNewDocument', { source: typeof fn === 'function' ? fnSource(fn, arg) : String(fn) }); },
    goto: async (url, { waitUntil = 'load', timeout = 30_000 } = {}) => {
      const nav = await send('Page.navigate', { url });
      if (nav?.errorText) throw new Error(`goto ${url}: ${nav.errorText}`);
      await until(`the page loaded ${url}`, () => evaluate((w) => w === 'domcontentloaded' ? document.readyState !== 'loading' : document.readyState === 'complete', waitUntil).catch(() => false), { ms: timeout });
    },
    reload: async (o = {}) => pg.goto(await evaluate(() => location.href), o),
    url: () => pg._url,
    on: (ev, f) => { (handlers[ev] ?? new Set()).add(f); },
    off: (ev, f) => { handlers[ev]?.delete(f); },
    waitForEvent: (ev, { timeout = 30_000 } = {}) => new Promise((res, rej) => {
      const f = (x) => { handlers[ev].delete(f); res(x); }; handlers[ev].add(f);
      until(`a ${ev}`, () => !handlers[ev].has(f), { ms: timeout }).catch((e) => { handlers[ev].delete(f); rej(e); });
    }),
    route: async (pattern, handler) => {
      const test = typeof pattern === 'function' ? (u) => pattern(new URL(u)) : typeof pattern === 'string' ? ((re) => (u) => re.test(u))(new RegExp('^' + pattern.split('**').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')).join('.*') + '$')) : (u) => pattern.test(u);
      routes.push({ pattern, test, handler });
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    },
    // playwright's: the routes with this pattern (and this handler, if given) stop; with none left, requests go straight through
    unroute: async (pattern, handler) => {
      for (let i = routes.length - 1; i >= 0; i--) if (routes[i].pattern === pattern && (!handler || routes[i].handler === handler)) routes.splice(i, 1);
      if (!routes.length) await send('Fetch.disable');
    },
    click: async (sel, { button = 'left', timeout } = {}) => { const { x, y } = await center(sel, timeout); await mouse.click(x, y, { button }); },
    hover: async (sel) => { const { x, y } = await center(sel); await mouse.move(x, y); },
    tap: async (sel) => { const { x, y } = await center(sel); await touchscreen.tap(x, y); },
    focus: async (sel) => { await center(sel); await evaluate((s) => document.querySelector(s).focus(), sel); },
    press: async (sel, key) => { await pg.focus(sel); await keyboard.press(key); },
    type: async (sel, text) => { await pg.focus(sel); await keyboard.type(text); },
    fill: async (sel, value) => { await pg.focus(sel); await evaluate(([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, value]); },
    selectOption: async (sel, value) => { await evaluate(([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, value]); return [value]; },
    dispatchEvent: async (sel, type) => { await evaluate(([s, t]) => document.querySelector(s).dispatchEvent(new Event(t, { bubbles: true })), [sel, type]); },
    setInputFiles: async (sel, files) => {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      await send('DOM.setFileInputFiles', { nodeId, files: [].concat(files).map((f) => path.resolve(typeof f === 'string' ? f : f.name)) });
    },
    getAttribute: async (sel, name) => evaluate(([s, n]) => document.querySelector(s)?.getAttribute(n) ?? null, [sel, name]),
    isVisible: async (sel) => evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; }, sel),
    $: async (sel) => (await evaluate((s) => !!document.querySelector(s), sel)) ? { click: () => pg.click(sel), getAttribute: (n) => pg.getAttribute(sel, n), isVisible: () => pg.isVisible(sel), textContent: () => evaluate((s) => document.querySelector(s)?.textContent ?? null, sel), boundingBox: () => evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, sel),
      // playwright's element shot: the page's, clipped to the element's box
      screenshot: async (o = {}) => { const clip = await evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, sel); return pg.screenshot({ ...o, clip }); } } : null,
    locator: (sel) => ({ click: (o) => pg.click(sel, o), pressSequentially: (t) => pg.type(sel, t),
      evaluate: async (fn, arg) => { await pg.waitForSelector(sel, { state: 'attached' }); return evaluate(`(${fn})(document.querySelector(${JSON.stringify(sel)}), ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`); }, hover: () => pg.hover(sel), isVisible: () => pg.isVisible(sel), fill: (v) => pg.fill(sel, v), press: (k) => pg.press(sel, k), getAttribute: (n) => pg.getAttribute(sel, n), count: () => evaluate((s) => document.querySelectorAll(s).length, sel), textContent: () => evaluate((s) => document.querySelector(s)?.textContent ?? null, sel), waitFor: (o) => pg.waitForSelector(sel, o) }),
    setViewportSize: async ({ width, height }) => { size = { width, height }; await send('Emulation.setDeviceMetricsOverride', { width, height, ...metrics }); },
    viewportSize: () => size,
    screenshot: async ({ path: out, fullPage = false, clip } = {}) => { const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip: { scale: 1, ...clip } } : {}) }); const b = Buffer.from(data, 'base64'); if (out) fs.writeFileSync(out, b); return b; },
    mouse, keyboard, touchscreen,
    cdp: send,
    // the page's own session: send, and playwright's on/once for its events (a probe written for a CDPSession listens)
    context: () => ({ newCDPSession: async () => {
      const listen = (ev, fn, one) => { const off = C.listen((m) => { if (m.sessionId === S && m.method === ev) { if (one) off(); fn(m.params); } }); return off; };
      return { send, on: (ev, fn) => { listen(ev, fn, false); }, once: (ev, fn) => { listen(ev, fn, true); } }; } }),
    bringToFront: () => send('Page.bringToFront'),
    close: async () => { try { await C.send('Target.closeTarget', { targetId }); } catch { /* gone */ } },
  };
  C.listen((m) => { if (m.sessionId === S && m.method === 'Page.frameNavigated' && !m.params.frame.parentId) pg._url = m.params.frame.url; });
  pg._url = 'about:blank';
  return pg;
}
