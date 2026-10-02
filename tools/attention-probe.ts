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
