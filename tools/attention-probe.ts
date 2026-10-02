// bun run tools/attention-probe.ts
// Real browser chat + shared AudioContext + owned scratch sequencer. Counts
// actual oscillator starts, not a mock "play" callback; no audio device needed.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CHROME, scratchSequencer, mkCheck, sleep } from './harness.ts';
const { check, tally } = mkCheck();
const data = mkdtempSync(join(tmpdir(), 'attention-data-'));
const h = await scratchSequencer('attention', { serverEnv: {
  SKIP_OPT_SWEEP: '1', JOIN_TOKEN: 'test-door', EIDO_WHISPERS_ENABLED: '1',
  OPT_DIR: join(data, 'opt'), STORE_DIR: join(data, 'store'), EIDOVERSE_DIR: join(data, 'library'),
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let sender: WebSocket | undefined;
let completed = false;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const g = globalThis as any;
    g.__tones = 0; g.__sent = []; g.__received = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function(...args) { g.__tones++; return start.apply(this, args); };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { g.__sent.push(String(data)); return send.call(this, data); };
    const WS = WebSocket;
    g.WebSocket = new Proxy(WS, { construct(t, args) {
      const s = new t(...args as [string]);
      s.addEventListener('message', m => { try { g.__received.push(JSON.parse(String(m.data))); } catch {} });
      return s;
    } });
  });
  const packets: any[] = [];
  async function joinSpeaker() {
    const ws = new WebSocket(h.BASE.replace('http', 'ws') + '/ws');
    const own: any[] = [];
    ws.onmessage = e => { const m = JSON.parse(String(e.data)); packets.push(m); own.push(m); };
    await until(() => ws.readyState === 1);
    ws.send(JSON.stringify({ type: 'join', token: 'test-door', world: 'attention', id: 'speaker' }));
    await until(() => own.some(m => m.type === 'snapshot'));
    return ws;
  }
  sender = await joinSpeaker();
  const send = (msg: any) => sender!.send(JSON.stringify(msg));
  const say = (text: string, extra = {}) => send({ type: 'verb', verb: 'say', args: { text, ...extra } });
  // Both kinds of backlog exist BEFORE the receiver arrives.
  say('@listener from before arrival');
  send({ type: 'whisper', to: 'listener', text: 'held before arrival' });
  await until(() => packets.some(m => m.type === 'whisper' && m.echo));
  await page.goto(h.BASE + '/?world=attention&name=listener&key=test-door&lite=1');
  await page.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone'), { timeout: 25000 });
  const tones = () => page.evaluate(() => (globalThis as any).__tones);
  const seen = (text: string) => page.waitForFunction(t => document.getElementById('chatlog')?.textContent?.includes(t), text);
  await seen('held before arrival');
  check('initial backlog renders with zero tones', await tones() === 0);
  check('held whisper carries explicit replay metadata', await page.evaluate(() =>
    (globalThis as any).__received.some((m: any) => m.type === 'whisper' && m.text === 'held before arrival' && m.replay === true)));
  const beforeControls = packets.filter(m => m.type === 'log').length;
  await page.locator('.chat-gear').click();
  // Every control must remain hittable within the supported minimum frame.
  const oldSize = await page.evaluate(async () => {
    const f = (await import('/lib/chat.js')).chat.frame();
    const old = { w: f._state.w, h: f._state.h };
    Object.assign(f._state, { w: 240, h: 100 }); f._paint(); return old;
  });
  check('minimum popup is bounded and user-scrollable', await page.locator('.chat-gearpop').evaluate(e => {
    const r = e.getBoundingClientRect(), f = e.closest('.frame').getBoundingClientRect();
    return r.top >= f.top && r.bottom <= f.bottom && r.left >= f.left && r.right <= f.right
      && getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight;
  }));
  const popBox = await page.locator('.chat-gearpop').boundingBox();
  await page.mouse.move(popBox.x + popBox.width - 10, popBox.y + 10);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.chat-gearpop').scrollTop > 0);
  check('user wheel scrolls the popup at minimum height', await page.locator('.chat-gearpop').evaluate(e => e.scrollTop > 0));
  for (const control of ['enabled', 'preview', 'volume', 'sound']) {
    const el = page.locator('[data-attention="' + control + '"]');
    await el.scrollIntoViewIfNeeded();
    check('minimum chat frame exposes ' + control, await el.evaluate(e => {
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === e || e.contains(hit);
    }));
  }
  await page.locator('[data-attention="enabled"]').check();
  check('enabling alone unlocks context before any preview or live notice', await page.evaluate(async () =>
    (await import('/lib/audioctx.js')).audioContextState() === 'running'));
  await page.locator('[data-attention="volume"]').press('Home');
  await page.locator('[data-attention="volume"]').press('ArrowRight');
  check('minimum-frame volume is keyboard operable', await page.locator('[data-attention="volume"]').inputValue() === '1');
  for (let i = 0; i < 19; i++) await page.locator('[data-attention="volume"]').press('ArrowRight');
  await page.locator('[data-attention="preview"]').click();
  await page.waitForFunction(() => (globalThis as any).__tones === 1);
  await page.evaluate(async size => {
    const f = (await import('/lib/chat.js')).chat.frame();
    Object.assign(f._state, size); f._paint();
  }, oldSize);
  await page.locator('[data-attention="enabled"]').check();
  check('preview uses the real AudioContext', await page.evaluate(async () =>
    (await import('/lib/audioctx.js')).audioContext().state === 'running'));
  check('local controls and preview append no world log entries', packets.filter(m => m.type === 'log').length === beforeControls);
  const changedFrames = await page.evaluate(() => (globalThis as any).__sent.filter((s: string) => s.includes('attention') && !s.includes('"join"')));
  check('attention choices send no wire messages', changedFrames.length === 0, JSON.stringify(changedFrames));
  say('ordinary ambient speech');
  await seen('ordinary ambient speech');
  check('ambient speech stays silent', await tones() === 1);
  say('@listener direct live');
  await seen('direct live');
  check('live mention starts exactly one tone', await tones() === 2);
  check('live mention retains a visual highlight', await page.locator('#chatlog .line.ping').count() >= 1);
  say('@listener burst');
  await seen('burst');
  check('burst coalesces without a deferred sound', await tones() === 2);
  await sleep(3100);
  send({ type: 'caption', text: '@listener caption' });
  await page.waitForFunction(() => (globalThis as any).__received.some((m: any) => m.type === 'caption' && m.text === '@listener caption'));
  check('caption performance stays visual-only', await tones() === 2);
  say('@listener spoken first', { spoken: true, utt: 9001, t0: Date.now() });
  await seen('spoken first');
  check('caption plus durable utterance chimes once', await tones() === 3);
  await sleep(3100);
  say('@listener spoken continuation', { spoken: true, utt: 9001 });
  await seen('spoken continuation');
  check('later flush of same utterance stays silent', await tones() === 3);
  send({ type: 'whisper', to: 'listener', text: 'direct private' });
  await seen('direct private');
  check('live addressed whisper chimes', await tones() === 4);

  // Keep an unlocked context across reconnect. A reload alone could pass
  // accidentally because autoplay was locked, even if history tried to chime.
  await sleep(3100);
  await page.evaluate(async () => { (await import('/lib/net.js')).net.ws.close(); });
  await until(() => packets.some(m => m.type === 'leave' && m.id === 'listener'));
  send({ type: 'whisper', to: 'listener', text: 'held during reconnect' });
  say('@listener missed during reconnect');
  await seen('held during reconnect');
  await seen('missed during reconnect');
  check('unlocked reconnect backlog stays silent', await tones() === 4);
  check('reconnect held whisper is marked as replay', await page.evaluate(() =>
    (globalThis as any).__received.some((m: any) => m.type === 'whisper' && m.text === 'held during reconnect' && m.replay === true)));
  say('@listener same speaker after listener reconnect', { spoken: true, utt: 9001 });
  await seen('same speaker after listener reconnect');
  check('listener reconnect preserves unchanged speaker utterance dedup', await tones() === 4);
  say('@listener fresh after reconnect', { spoken: true, utt: 9002 });
  await seen('fresh after reconnect');
  check('fresh speech after reconnect still chimes', await tones() === 5);
  // A fresh sender page starts its counter again; the listener keeps running.
  await sleep(3100);
  const oldSession = await page.evaluate(() => (globalThis as any).__received
    .filter((m: any) => m.type === 'snapshot').at(-1).present.find((p: any) => p.id === 'speaker').session);
  sender.close();
  sender = await joinSpeaker();
  await page.waitForFunction(old => (globalThis as any).__received.some((m: any) =>
    m.type === 'arrive' && m.id === 'speaker' && m.session && m.session !== old), oldSession);
  check('sender rejoin projects a distinct opaque session', typeof oldSession === 'string' && oldSession.length > 0);
  say('@listener sender restarted counter', { spoken: true, utt: 9001 });
  await seen('sender restarted counter');
  check('rejoined sender reused utt chimes as a fresh utterance', await tones() === 6);
  await sleep(3100);
  say('@listener new-session continuation', { spoken: true, utt: 9001 });
  await seen('new-session continuation');
  check('same-session repeated flush still stays silent', await tones() === 6);
  // If the listener missed the sender's arrival, the snapshot still carries
  // the new lifetime rather than inheriting this actor's old utterance cache.
  const packetCut = packets.length;
  const snapshotCount = await page.evaluate(() => (globalThis as any).__received.filter((m: any) => m.type === 'snapshot').length);
  await page.evaluate(async () => { (await import('/lib/net.js')).net.ws.close(); });
  await until(() => packets.slice(packetCut).some(m => m.type === 'leave' && m.id === 'listener'));
  sender.close();
  sender = await joinSpeaker();
  await page.waitForFunction(n => (globalThis as any).__received.filter((m: any) => m.type === 'snapshot').length > n, snapshotCount);
  say('@listener sender restarted while you were away', { spoken: true, utt: 9001 });
  await seen('sender restarted while you were away');
  check('snapshot observes sender rejoin missed during listener absence', await tones() === 7);
  const unrelated = await page.evaluate(async () => JSON.stringify((await import('/lib/voiceconsent.js')).audioPrefs()));
  if (!await page.locator('[data-attention="enabled"]').isVisible()) await page.locator('.chat-gear').click();
  await page.locator('[data-attention="enabled"]').uncheck();
  await sleep(3100);
  say('@listener now muted');
  await seen('now muted');
  check('attention mute suppresses only its own tones', await tones() === 7);
  check('world/voice/TTS settings stay unchanged', unrelated === await page.evaluate(async () =>
    JSON.stringify((await import('/lib/voiceconsent.js')).audioPrefs())));
  check('muted mention remains visibly highlighted', await page.locator('#chatlog .line.ping').filter({ hasText: 'now muted' }).count() === 1);
  check('browser path has no page errors', errors.length === 0, errors.join('; '));
  await autoplayPolicyProbe(browser, h.BASE, say, check);
  completed = true;
} finally {
  sender?.close();
  await browser?.close();
  await h.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(data, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);

async function until(test: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting for wire event');
    await sleep(25);
  }
}

// Headless Chromium's autoplay setting is not a policy oracle. Use real Web
// Audio nodes behind a simulated gate, and read with CDP userGesture:false:
// Playwright evaluate would itself grant the activation this case measures.
async function autoplayPolicyProbe(browser, origin, say, check) {
  for (const enabled of [false, true]) {
    const context = await browser.newContext();
    const name = enabled ? 'saved-audio' : 'first-audio';
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    try {
      await page.addInitScript(({ enabled }) => {
        const g = globalThis as any;
        localStorage.setItem('ew-attention', JSON.stringify({ enabled, volume: 0.2, sound: 'soft' }));
        g.__policy = { contexts: 0, tones: 0, attempts: [], errors: [] };
        const NativeContext = window.AudioContext;
        class PolicyContext extends NativeContext {
          unlocked = false;
          constructor() {
            super();
            g.__policy.contexts++;
            g.__policyContext = this;
            // Native headless output is often running from construction. Hold
            // it too, while the state getter enforces the simulated policy.
            super.suspend();
          }
          get state() { return this.unlocked ? super.state : 'suspended'; }
          resume() {
            const active = navigator.userActivation.isActive;
            g.__policy.attempts.push(active);
            if (!active) return Promise.reject(new DOMException('simulated autoplay block', 'NotAllowedError'));
            this.unlocked = true;
            return super.resume();
          }
        }
        window.AudioContext = PolicyContext;
        const start = OscillatorNode.prototype.start;
        OscillatorNode.prototype.start = function(...args) {
          g.__policy.tones++;
          return start.apply(this, args);
        };
        addEventListener('error', e => g.__policy.errors.push(e.message));
      }, { enabled });

      const read = async () => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify({
            ...globalThis.__policy,
            state: globalThis.__policyContext?.state ?? 'none',
            active: navigator.userActivation.isActive,
            ready: document.getElementById('splash')?.classList.contains('gone') === true,
            text: document.getElementById('chatlog')?.textContent ?? ''
          })`,
          userGesture: false, returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return JSON.parse(r.result.value);
      };
      const wait = async (pred, label) => {
        const end = Date.now() + 15000;
        let r;
        do {
          r = await read();
          if (pred(r)) return r;
          await sleep(25);
        } while (Date.now() < end);
        throw new Error(label + ': ' + JSON.stringify(r));
      };
      await page.goto(origin + '/?world=attention&name=' + name + '&key=test-door&lite=1');
      const initial = await wait(r => r.ready && !r.active, 'cold policy page');
      check(name + ': non-gesture observation supplies no activation or context', !initial.active && initial.contexts === 0);

      if (enabled) {
        say('@' + name + ' locked utterance', { spoken: true, utt: 700 });
        const locked = await wait(r => r.text.includes('locked utterance'), 'locked live delivery');
        check('saved setting: live notice actually meets a suspended context', locked.state === 'suspended' && locked.attempts.length > 0 && locked.attempts.every(a => a === false));
        check('saved setting: blocked notice schedules zero oscillators', locked.tones === 0);
        // This is the one intended gesture; no programmatic audio resume.
        await page.locator('.chat-gear').click();
        const unlocked = await wait(r => r.state === 'running', 'gesture unlock');
        check('saved setting: gesture unlock never performs the missed notice', unlocked.tones === 0 && unlocked.attempts.includes(true));
        say('@' + name + ' same utterance after unlock', { spoken: true, utt: 700 });
        const repeat = await wait(r => r.text.includes('same utterance after unlock'), 'repeat delivery');
        check('saved setting: locked utterance remains consumed after unlock', repeat.tones === 0);
        say('@' + name + ' fresh after unlock', { spoken: true, utt: 701 });
        const fresh = await wait(r => r.text.includes('fresh after unlock'), 'fresh delivery');
        check('saved setting: fresh notice immediately chimes without silent cooldown', fresh.tones === 1 && fresh.errors.length === 0);
      } else {
        await page.locator('.chat-gear').click();
        await page.locator('[data-attention="enabled"]').check();
        const afterEnable = await read();
        check('first use: Enable itself constructs and resumes under activation',
          afterEnable.contexts === 1 && afterEnable.attempts.includes(true));
        // Wait out transient activation: a later live event must not gain an
        // accidental unlock just because it followed the test's click quickly.
        await wait(r => !r.active, 'enable activation expiry');
        const idle = await read();
        check('first use: context remains running without any further gesture', idle.state === 'running' && idle.tones === 0);
        say('@' + name + ' first notice after enable');
        const fresh = await wait(r => r.text.includes('first notice after enable'), 'first enabled delivery');
        check('first use: later live notice chimes after activation has expired', !fresh.active && fresh.tones === 1 && fresh.errors.length === 0);
      }
    } finally {
      await cdp.detach();
      await context.close();
    }
  }
}
