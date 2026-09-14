// The projector's captioner — voicebot run backwards.
//
//   mediamtx (RTSP audio) ──▶ ffmpeg ──▶ AudioTap ──▶ Captioner (VAD + STT)
//        ──▶ CaptionWindow ──▶ world WS: comp {id: <screen>, type: "captions", data}
//
// Env:
//   STREAM_URL     rtsp://127.0.0.1:8554/screen   (deploy/projector; or FILE=path.wav to rehearse)
//   WORLD_URL      ws(s)://host/ws               (default ws://127.0.0.1:8940/ws)
//   WORLD_TOKEN    the bot's bearer token          (its actor id is reserved in mcpl/tokens.json)
//   WORLD_NAME     world                           (default commons)
//   ACTOR          the bot's actor id              (default captioner)
//   SCREEN_ID      the entity that owns the screen (required)
//   TITLE          what is showing, for look()     (optional)
//   STT            scribe | assemblyai             (default scribe)
//   ELEVEN_KEY / ASSEMBLYAI_KEY                    the provider's key
//   LANGUAGE       BCP-47 hint                     (optional)
//   VAD_DB         voiced threshold dBFS           (default -45; raise for noisy feeds)
//   DRY_RUN=1      no world: print captions and the payload it would send
//   TRANSCRIPT     path to append every final caption as JSONL (the full
//                  record, which the world's rolling window is not)
import { appendFileSync } from 'node:fs';
import { ScribeSttProvider, AssemblyAiSttProvider } from '@animalabs/voice-kit';
import { AudioTap } from './tap.ts';
import { ffmpegSource, fileSource } from './sources.ts';
import { Captioner } from './captioner.ts';
import { CaptionWindow } from './window.ts';
import { WorldClient } from './world.ts';

const env = (k: string, d = '') => process.env[k] ?? d;
const RATE = 16_000;
const DRY_RUN = env('DRY_RUN') === '1';
const SCREEN_ID = env('SCREEN_ID');
if (!SCREEN_ID && !DRY_RUN) { console.error('SCREEN_ID required (the entity that owns the screen)'); process.exit(2); }
const log = (m: string) => console.log(`[captionbot ${new Date().toISOString().slice(11, 19)}] ${m}`);

const provider = env('STT', 'scribe') === 'assemblyai'
  ? new AssemblyAiSttProvider(env('ASSEMBLYAI_KEY'))
  : new ScribeSttProvider(env('ELEVEN_KEY'));
if (!env('ELEVEN_KEY') && !env('ASSEMBLYAI_KEY')) log('⚠ no STT key — sessions will fail');

const world = DRY_RUN ? null : new WorldClient({
  url: env('WORLD_URL', 'ws://127.0.0.1:8940/ws'), token: env('WORLD_TOKEN'), world: env('WORLD_NAME', 'commons'),
  actor: env('ACTOR', 'captioner'), screenId: SCREEN_ID, log,
});
world?.connect();

const tap = new AudioTap(RATE);
const window = new CaptionWindow({ title: env('TITLE') || undefined });
const captioner = new Captioner({
  rateHz: RATE, provider, language: env('LANGUAGE') || undefined,
  thresholdDb: Number(env('VAD_DB', '-45')), speaker: () => world?.speaker(), log,
});
captioner.onCaption((c) => {
  window.push(c);
  log(`📝 [${c.t0.toFixed(1)}–${c.t1.toFixed(1)}] ${c.speaker ? c.speaker + ': ' : ''}${c.text}`);
  if (env('TRANSCRIPT')) appendFileSync(env('TRANSCRIPT'), JSON.stringify({ ...c, at: Date.now() }) + '\n');
  const data = window.payload(world?.speaker());
  if (world) world.update(data); else log(`   would send comp captions (${JSON.stringify(data).length} bytes, ${window.length} lines)`);
});
tap.attach(captioner);
tap.attach({ onPcm: (_f, t) => window.tick(t) });

const file = env('FILE');
if (file) {
  log(`rehearsing from ${file}`);
  await fileSource(file, tap);
  await new Promise((r) => setTimeout(r, 2000)); // let the last final settle
  log(`done — ${window.length} lines in the window, ${captioner.lateRevisions} late revisions dropped`);
  world?.close();
  process.exit(0);
} else {
  const url = env('STREAM_URL', 'rtsp://127.0.0.1:8554/screen');
  log(`listening to ${url}`);
  const src = ffmpegSource(url, tap, log);
  process.on('SIGINT', () => { src.close(); world?.clear(); setTimeout(() => process.exit(0), 300); });
}
