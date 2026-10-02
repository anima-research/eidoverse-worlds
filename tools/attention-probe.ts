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
  sender = new WebSocket(h.BASE.replace('http', 'ws') + '/ws');
  sender.onmessage = e => packets.push(JSON.parse(String(e.data)));
  await until(() => sender!.readyState === 1);
  sender.send(JSON.stringify({ type: 'join', token: 'test-door', world: 'attention', id: 'speaker' }));
  await until(() => packets.some(m => m.type === 'snapshot'));
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
  await page.locator('[data-attention="enabled"]').check();
  await page.locator('[data-attention="preview"]').click();
  await page.waitForFunction(() => (globalThis as any).__tones === 1);
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
  say('@listener fresh after reconnect');
  await seen('fresh after reconnect');
  check('fresh speech after reconnect still chimes', await tones() === 5);
  const unrelated = await page.evaluate(async () => JSON.stringify((await import('/lib/voiceconsent.js')).audioPrefs()));
  if (!await page.locator('[data-attention="enabled"]').isVisible()) await page.locator('.chat-gear').click();
  await page.locator('[data-attention="enabled"]').uncheck();
  await sleep(3100);
  say('@listener now muted');
  await seen('now muted');
  check('attention mute suppresses only its own tones', await tones() === 5);
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
