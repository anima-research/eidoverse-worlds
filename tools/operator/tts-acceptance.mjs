// tts-acceptance — real Piper, real browser, real RTP (#91). Not CI and not part of the merge receipt: the travelling
// regressions are test/client/tts-test.ts and tts-fault-test.ts (fake engine). This is the one-time dev/staging acceptance: Piper +
// worker + ORT + a local voice producing audible media through the production path (say → speech bus → speakOwnSays
// → engine → generator → sender), received by an independent listener. Own spawned server, throwaway world dir.
//   VOICE_TRANSPORT=sfu VOICE_ONNX=/path/voice.onnx VOICE_CFG=/path/voice.onnx.json bun tools/operator/tts-acceptance.mjs
//   (the spawned server inherits this env; voice is off without VOICE_TRANSPORT=sfu)
// Needs playwright + chromium installed in the repo (static ESM imports resolve from this file).
// Emits a provenance-bound receipt (JSON) on stdout: model/config sha256, browser+OS, cold and warm load ms, voice
// identity, the listener's RTP count and level, and each check. The receiving side reads client/lib/audio/voicesfu.js.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE_ONNX = process.env.VOICE_ONNX;
const VOICE_CFG = process.env.VOICE_CFG;
if (!VOICE_ONNX || !VOICE_CFG) { console.error('VOICE_ONNX and VOICE_CFG required'); process.exit(2); }

const receipt = { kind: 'tts-acceptance', at: new Date().toISOString(), checks: [] };
let failed = 0;
const check = (name, ok, detail = '') => {
  receipt.checks.push({ name, ok, detail: String(detail).slice(0, 200) });
  console.error(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
receipt.model = { path: VOICE_ONNX, sha256: sha256(VOICE_ONNX) };
receipt.config = { path: VOICE_CFG, sha256: sha256(VOICE_CFG) };
receipt.host = { os: `${os.type()} ${os.release()}`, node: process.version };

// ── own server on a verified-free port, nonce-owned (the B2 doctrine) ──────
const PORT = 20000 + Math.floor(Math.random() * 20000);
try { await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(300) });
  console.error(`port ${PORT} occupied — rerun`); process.exit(2); } catch { /* free */ }
const NONCE = `accept-${randomUUID().slice(0, 8)}`;
// the voice pair is served by OUR child from the client tree, under the nonce
copyFileSync(VOICE_ONNX, join(REPO, 'client', `${NONCE}.onnx`));
copyFileSync(VOICE_CFG, join(REPO, 'client', `${NONCE}.onnx.json`));
const worldDir = mkdtempSync(join(os.tmpdir(), 'tts-accept-'));
// joining never founds a world: found 'accept' first (the operator's door)
{ const f = spawnSync('bun', [join(REPO, 'tools', 'world.ts'), 'found', 'accept', '--owner', 'owner'], { env: { ...process.env, WORLDS_DIR: worldDir }, encoding: 'utf8' });
  if (f.status !== 0) { console.error(`founding the world failed: ${f.stdout}${f.stderr}`); process.exit(2); } }
const server = spawn('bun', [join(REPO, 'server', 'server.ts')],
  { env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldDir }, stdio: 'ignore' });
const cleanup = () => {
  try { server.kill(); } catch { /* gone */ }
  for (const f of [`${NONCE}.onnx`, `${NONCE}.onnx.json`]) { try { rmSync(join(REPO, 'client', f)); } catch { /* ok */ } }
  try { rmSync(worldDir, { recursive: true }); } catch { /* ok */ }
};
process.on('exit', cleanup);
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
{ const own = await fetch(`http://127.0.0.1:${PORT}/${NONCE}.onnx.json`).then(r => r.ok).catch(() => false);
  check('spawned server owns the port (nonce voice served)', own); if (!own) process.exit(1); }

const browser = await chromium.launch({ args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader',
] });
receipt.browser = browser.version();
const ctx = await browser.newContext();   // ONE context: the warm pass reuses its caches
const mk = async (name) => {
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`http://127.0.0.1:${PORT}/?name=${name}&world=accept`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const net = await import('/lib/net.js');
    for (let i = 0; i < 60 && !net.net?.joined; i++) await new Promise(r => setTimeout(r, 250));
  });
  return page;
};

const loadVoice = (page, nonce) => page.evaluate(async (NONCE) => {
  const [mB, cB] = await Promise.all([
    fetch(`/${NONCE}.onnx`).then(r => r.arrayBuffer()),
    fetch(`/${NONCE}.onnx.json`).then(r => r.arrayBuffer()),
  ]);
  const files = [new File([mB], `${NONCE}.onnx`), new File([cB], `${NONCE}.onnx.json`)];
  await import('/lib/audio/engine-piper.js');   // registers itself (lazy in prod UI)
  const ve = await import('/lib/audio/voiceengines.js');
  const store = await import('/lib/audio/voicestore.js');
  const tts = await import('/lib/audio/tts.js');
  const t0 = performance.now();
  await ve.loadFromFiles(files, () => {});
  const ms = Math.round(performance.now() - t0);
  const identity = await store.voiceIdentity(files[0], files[1]);
  tts.setTtsEnabled(true);
  return { ms, identity };
}, nonce);

console.error('\n— cold load (real ORT session build + OPFS seed) —');
const speaker = await mk('accept-speaker');
const cold = await loadVoice(speaker, NONCE);
receipt.coldLoadMs = cold.ms; receipt.identity = cold.identity;
check('cold load completes with a real session', cold.ms > 0, `${cold.ms}ms`);
check('in-browser identity matches disk digests',
  cold.identity.modelSha256 === receipt.model.sha256 && cold.identity.configSha256 === receipt.config.sha256,
  cold.identity.id);

console.error('\n— an independent listener, and one real say —');
const listener = await mk('accept-listener');
await listener.evaluate(async () => (await import('/lib/audio/voiceconsent.js')).setReceiveVoice(true));
await new Promise(r => setTimeout(r, 2000));
// sample audibility through the whole window, not after the utterance (that read peak 0.000 against 350 packets)
const levelP = listener.evaluate(async () => {
  const v = await import('/lib/audio/voicesfu.js');
  let level = 0;
  for (let i = 0; i < 240; i++) {                // 12s of 50ms samples
    for (const [, l] of v.sfuPeerLevels()) level = Math.max(level, l);
    await new Promise(r => setTimeout(r, 50));
  }
  return level;
});
// the SAY goes through the production door: the client's own say (a door say request), not a test hook
await speaker.evaluate(async () => {
  const net = await import('/lib/net.js');
  net.say('Acceptance: this voice is synthesized locally and carried on the human speech lane.');
});
await new Promise(r => setTimeout(r, 9000));   // synth (first utterance warms phonemizer) + travel
const sTx = await speaker.evaluate(async () => {
  const tts = await import('/lib/audio/tts.js');
  return { mouth: tts.mouthInfo() };
});
const lRx = await listener.evaluate(async () => {
  const v = await import('/lib/audio/voicesfu.js');
  const inbound = (await v.sfuInboundStats()).reduce((n, s) => n + (s.packetsReceived ?? 0), 0);
  return { inbound };
});
lRx.level = await levelP;
receipt.rtp = { listenerInbound: lRx.inbound, listenerPeakLevel: lRx.level };
check('independent listener RECEIVED it', lRx.inbound > 50, `${lRx.inbound} pkts`);
check('and it is AUDIBLE (nonzero level at the listener)', lRx.level > 0.005, `peak ${lRx.level.toFixed(3)}`);
check('speaker pacer active while TTS is the producer', sTx.mouth.pacing === true);

// free the two live-media pages first (the context's caches survive);
// two ORT sessions + a mesh under swiftshader is real memory pressure.
await speaker.close(); await listener.close();
console.error('\n— warm load (second load, same context; loadVoice re-supplies and re-copies the files: not an OPFS read) —');
const wdt = setTimeout(() => { console.error('WATCHDOG: warm phase exceeded 180s'); process.exit(3); }, 180000);
const speaker2 = await ctx.newPage();
speaker2.on('pageerror', () => {});
await speaker2.goto(`http://127.0.0.1:${PORT}/?name=accept-warm&world=accept`, { waitUntil: 'load' });
await speaker2.evaluate(async () => { const net = await import('/lib/net.js');
  for (let i = 0; i < 60 && !net.net?.joined; i++) await new Promise(r => setTimeout(r, 250)); });
const warm = await loadVoice(speaker2, NONCE);
receipt.warmLoadMs = warm.ms;
check('warm load completes (second load, same context)', warm.ms > 0, `${warm.ms}ms (cold was ${cold.ms}ms)`);
check('warm identity is byte-stable', warm.identity.id === cold.identity.id);

clearTimeout(wdt);
await browser.close();
receipt.pass = receipt.checks.filter(c => c.ok).length;
receipt.fail = failed;
console.log(JSON.stringify(receipt, null, 2));
process.exit(failed ? 1 : 0);
