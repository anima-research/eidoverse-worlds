// tts-acceptance — REAL Piper, real browser, real RTP (#91 r3 B4).
//
// HONESTY CONTRACT (same as voice-matrix.mjs): NOT part of the merge receipt
// and not CI — the traveling regressions are tts-test.ts / tts-fault-test.ts
// (fake engine, run with bun anywhere). This harness is the one-time
// dev/staging acceptance the r3 review asked for: actual Piper + worker +
// ORT + a selected local voice producing OUTBOUND AUDIBLE MEDIA, received by
// an independent listener, through the exact production paths (world `say`
// verb → speech bus → speakOwnSays → engine → generator → sender), plus the
// mic-priority transitions on real tracks. It mutates nothing: own spawned
// server, throwaway world dir, models fetched from disk.
//
//   Requirements: playwright + chromium (run from a dir that has them, e.g.
//   `cd ~/lab && node <repo>/tools/tts-acceptance.mjs`), a piper voice pair:
//     VOICE_ONNX=/path/voice.onnx VOICE_CFG=/path/voice.onnx.json
//
// Emits a provenance-bound receipt (JSON) on stdout: model/config sha256,
// browser+OS versions, cold and warm load ms, voice identity, RTP counts on
// both ends, and each acceptance check.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = join('/tmp/wn-91');
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
const ctx = await browser.newContext();   // ONE context: OPFS persists for the warm pass
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
  await import('/lib/engine-piper.js');   // registers itself (lazy in prod UI)
  const ve = await import('/lib/voiceengines.js');
  const store = await import('/lib/voicestore.js');
  const tts = await import('/lib/tts.js');
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
await listener.evaluate(async () => (await import('/lib/voiceconsent.js')).setReceiveVoice(true));
await new Promise(r => setTimeout(r, 2000));
// Start the audibility sampler BEFORE the say: the first run sampled AFTER
// the utterance finished and read peak 0.000 against 350 delivered packets —
// a harness lie, not a product one. Sample through the whole window.
const levelP = listener.evaluate(async () => {
  const v = await import('/lib/voice.js');
  let level = 0;
  for (let i = 0; i < 240; i++) {                // 12s of 50ms samples
    for (const [, l] of v.peerLevels()) level = Math.max(level, l);
    await new Promise(r => setTimeout(r, 50));
  }
  return level;
});
// the SAY goes through the production door: the world verb, not a test hook
await speaker.evaluate(async () => {
  const net = await import('/lib/net.js');
  net.sendVerb('say', { text: 'Acceptance: this voice is synthesized locally and carried on the human speech lane.' });
});
await new Promise(r => setTimeout(r, 9000));   // synth (first utterance warms phonemizer) + travel
const sTx = await speaker.evaluate(async () => {
  const v = await import('/lib/voice.js');
  const tts = await import('/lib/tts.js');
  let out = 0;
  for (const pc of (v.voicePcs?.() ?? [])) {
    const st = await pc.getStats();
    st.forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'audio') out += s.packetsSent ?? 0; });
  }
  return { outbound: out, mouth: tts.mouthInfo(), sender: v.senderTrackInfo() };
});
const lRx = await listener.evaluate(async () => {
  const v = await import('/lib/voice.js');
  const per = await v.voiceStats();
  const inbound = Object.values(per).reduce((n, s) => n + (s.inboundAudioPackets ?? 0), 0);
  return { inbound };
});
lRx.level = await levelP;
receipt.rtp = { speakerOutbound: sTx.outbound, listenerInbound: lRx.inbound, listenerPeakLevel: lRx.level };
check('speaker sent RTP audio (synth on the sender)', sTx.outbound > 50, `${sTx.outbound} pkts`);
check('independent listener RECEIVED it', lRx.inbound > 50, `${lRx.inbound} pkts`);
check('and it is AUDIBLE (nonzero level at the listener)', lRx.level > 0.005, `peak ${lRx.level.toFixed(3)}`);
check('speaker pacer active while TTS is the producer', sTx.mouth.pacing === true);

console.error('\n— mic priority transitions on real tracks —');
const trans = await speaker.evaluate(async (name) => {
  const v = await import('/lib/voice.js');
  const tts = await import('/lib/tts.js');
  const before = v.micDiag();
  await v.toggleMic(name);                       // mic ON: fake device, real track
  await new Promise(r => setTimeout(r, 1500));
  const during = { mic: v.micDiag(), pacing: tts.mouthInfo().pacing };
  await v.toggleMic(name);                       // mic OFF: TTS takes the lane back
  await new Promise(r => setTimeout(r, 1500));
  const after = { mic: v.micDiag(), pacing: tts.mouthInfo().pacing,
    // the pair that should match, from both ends (reporter doctrine):
    senders: v.senderTrackInfo().senders.map((x) => x.track?.id),
    gen: tts.genTrackInfo?.() ?? null };
  return { before, during, after };
}, 'accept-speaker');
check('mic ON: a real microphone becomes the source', /microphone/.test(trans.during.mic.rawSource), trans.during.mic.rawSource);
check('mic ON stopped the pacer (no dual producer)', trans.during.pacing === false);
check('mic OFF: TTS re-engaged (pacer running again)', trans.after.pacing === true);
check('mic OFF: sent track is the synthetic generator again', /synthetic|graph/.test(trans.after.mic.sentToPeers), trans.after.mic.sentToPeers);
receipt.transitions = trans;

// free the two live-media pages first: OPFS is origin-scoped and survives;
// two ORT sessions + a mesh under swiftshader is real memory pressure.
await speaker.close(); await listener.close();
console.error('\n— warm load (OPFS cache hit, same context) —');
const wdt = setTimeout(() => { console.error('WATCHDOG: warm phase exceeded 180s'); process.exit(3); }, 180000);
const speaker2 = await ctx.newPage();
speaker2.on('pageerror', () => {});
await speaker2.goto(`http://127.0.0.1:${PORT}/?name=accept-warm&world=accept`, { waitUntil: 'load' });
await speaker2.evaluate(async () => { const net = await import('/lib/net.js');
  for (let i = 0; i < 60 && !net.net?.joined; i++) await new Promise(r => setTimeout(r, 250)); });
const warm = await loadVoice(speaker2, NONCE);
receipt.warmLoadMs = warm.ms;
check('warm load completes (OPFS-cached bytes)', warm.ms > 0, `${warm.ms}ms (cold was ${cold.ms}ms)`);
check('warm identity is byte-stable', warm.identity.id === cold.identity.id);

clearTimeout(wdt);
await browser.close();
receipt.pass = receipt.checks.filter(c => c.ok).length;
receipt.fail = failed;
console.log(JSON.stringify(receipt, null, 2));
process.exit(failed ? 1 : 0);
