// The projector's captioner — voicebot run backwards.
//
//   mediamtx (RTSP audio) ──▶ ffmpeg ──▶ AudioTap ──▶ Captioner (VAD + STT)
//        ──▶ world WS: caption {id: <screen>, session, n, t0, t1, text, speaker?}
//
// One `caption` verb per final line, once; the sequencer folds the bounded
// window on the screen entity (shared/captions.js). Captions are durable
// world testimony like `say`; `end` clears current perception, not history.
// The bot needs the CAPTION DEED for its screen, granted once by the world's
// owner — `grant {id: <ACTOR>, caption: "<SCREEN_ID>"}` — and nothing more:
// it joins as a visitor and keeps a visitor's verbs.
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
//   SPOOL          JSONL path of every line tried and every receipt (default
//                  ./captionbot.spool.jsonl; SPOOL= empty for none). A restart
//                  re-queues whatever the world never confirmed. Append-only:
//                  rotate it between events. The spool is a promise, so it
//                  fails closed: if a line's row cannot be written the line is
//                  refused and intake halts, out loud, until a restart.
//   SPOOL_BEST_EFFORT=1  the weaker promise: spool failures log and the line
//                  queues anyway (a restart may then miss it)
//   MAX_PENDING    queue bound in lines (default 600); past it the oldest
//                  queued lines are dropped, out loud, into the spool
//   DRY_RUN=1      no world: print each line as it would be sent
//   TRANSCRIPT     optional local JSONL copy of every final line — a
//                  convenience for the operator, not the record: the world
//                  log is the record
import { appendFileSync } from 'node:fs';
import { ScribeSttProvider, AssemblyAiSttProvider } from '@animalabs/voice-kit';
import { AudioTap } from './tap.ts';
import { ffmpegSource, fileSource } from './sources.ts';
import { Captioner } from './captioner.ts';
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

const spool = env('SPOOL', './captionbot.spool.jsonl');
const world = DRY_RUN ? null : new WorldClient({
  url: env('WORLD_URL', 'ws://127.0.0.1:8940/ws'), token: env('WORLD_TOKEN'), world: env('WORLD_NAME', 'commons'),
  actor: env('ACTOR', 'captioner'), screenId: SCREEN_ID, title: env('TITLE') || undefined,
  spool: spool || undefined, spoolBestEffort: env('SPOOL_BEST_EFFORT') === '1',
  maxPending: Number(env('MAX_PENDING', '600')), log,
});
world?.connect();
if (world) log(`session ${world.session}; spool ${spool ? `${spool} (${env('SPOOL_BEST_EFFORT') === '1' ? 'best effort' : 'fail-closed'})` : '(none)'}`);

const tap = new AudioTap(RATE);
const captioner = new Captioner({
  rateHz: RATE, provider, language: env('LANGUAGE') || undefined,
  thresholdDb: Number(env('VAD_DB', '-45')), speaker: () => world?.speaker(), log,
});
let lines = 0;
captioner.onCaption((c) => {
  lines++;
  log(`📝 [${c.t0.toFixed(1)}–${c.t1.toFixed(1)}] ${c.speaker ? c.speaker + ': ' : ''}${c.text}`);
  if (env('TRANSCRIPT')) appendFileSync(env('TRANSCRIPT'), JSON.stringify({ ...c, session: world?.session, at: Date.now() }) + '\n');
  if (world) world.caption(c); else log(`   would send caption n=${lines}`);
});
tap.attach(captioner);

const file = env('FILE');
if (file) {
  log(`rehearsing from ${file}`);
  await fileSource(file, tap);
  await new Promise((r) => setTimeout(r, 2000)); // let the last final settle
  world?.end();
  await new Promise((r) => setTimeout(r, 1500)); // and the receipts land
  log(`done — ${lines} lines, ${captioner.lateRevisions} late revisions dropped${world ? `; ${world.acked} confirmed, ${world.pendingCount} unconfirmed (in the spool)${world.spoolRefused ? `, ${world.spoolRefused} REFUSED (spool unwritable: ${world.spoolFailed})` : ''}` : ''}`);
  world?.close();
  process.exit(0);
} else {
  const url = env('STREAM_URL', 'rtsp://127.0.0.1:8554/screen');
  log(`listening to ${url}`);
  // a reattach is a new time origin: the session rotates so no two lines
  // share a clock they do not share
  const src = ffmpegSource(url, tap, log, { onReattach: () => world?.rotateSession() });
  process.on('SIGINT', () => { src.close(); world?.end(); setTimeout(() => process.exit(0), 1500); });
}
