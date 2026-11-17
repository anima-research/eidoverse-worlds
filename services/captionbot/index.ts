// The projector's captioner — voicebot run backwards.
//
//   mediamtx (RTSP audio) ──▶ ffmpeg ──▶ AudioTap ──▶ Captioner (VAD + STT)
//        ──▶ the world's door: caption {id: <screen>, session, n, t0, t1, text, speaker?}
//
// One door `caption` per final line (resent until a receipt comes; the door dedupes); the door folds the current
// line on the screen (shared/captions.js; history is the log). Captions are durable world
// testimony like `say`; `end` clears current perception, not history.
// The bot needs to be one of its screen's captioners — whoever may edit the
// screen sets `captioners {ids: [<the bot's identity>]}` on it (the bot logs
// its identity when it joins) — and nothing more: it joins as a visitor.
//
// Env:
//   STREAM_URL     rtsp://127.0.0.1:8554/screen   (deploy/projector; or FILE=path.wav, 16 kHz mono PCM16, to rehearse,
//                  or FILE=path.jsonl to replay a saved TRANSCRIPT's lines with no audio and no STT)
//   WORLD_URL      ws(s)://host/ws               (default ws://127.0.0.1:8940/ws)
//   WORLD_TOKEN    the door's join key, if it has one
//   AGENT_TOKEN    the bot's own token (mcpl/tokens.json): its reserved name, its identity
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
//                  re-queues what the world never confirmed, except lines it
//                  dropped as overflow or refused. Append-only:
//                  rotate it between events. Fails closed: an unwritable row
//                  refuses the line and halts intake until a restart (see world.ts).
//   SPOOL_BEST_EFFORT=1  queue the line anyway on a spool failure (a restart may miss it)
//   MAX_PENDING    queue bound in lines (default 600); past it the oldest are
//                  dropped into the spool as overflow
//   DRY_RUN=1      no world: print each line as it would be sent
//   TRANSCRIPT     optional local JSONL copy of every final line (the world log is the record)
//   A FILE run exits non-zero when the spool's promise was not kept or lines were dropped.
import { appendFileSync, readFileSync } from 'node:fs';
import { ScribeSttProvider, AssemblyAiSttProvider } from '@animalabs/voice-kit';
import { AudioTap } from './tap.ts';
import { ffmpegSource, fileSource } from './sources.ts';
import { Captioner, type Caption } from './captioner.ts';
import { WorldClient } from './world.ts';
import { normalizeCaption } from '../../shared/captions.js';

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
  url: env('WORLD_URL', 'ws://127.0.0.1:8940/ws'), token: env('WORLD_TOKEN'), agentToken: env('AGENT_TOKEN') || undefined, world: env('WORLD_NAME', 'commons'),
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
// one path for every final line, wherever it came from: the live captioner,
// a rehearsed audio file, or a replayed transcript
const onLine = (c: Caption) => {
  lines++;
  log(`📝 [${c.t0.toFixed(1)}–${c.t1.toFixed(1)}] ${c.speaker ? c.speaker + ': ' : ''}${c.text}`);
  if (env('TRANSCRIPT')) appendFileSync(env('TRANSCRIPT'), JSON.stringify({ ...c, session: world?.session, at: Date.now() }) + '\n');
  if (world) world.caption(c); else log(`   would send caption n=${lines}`);
};
captioner.onCaption(onLine);
tap.attach(captioner);

const file = env('FILE');
if (file) {
  if (file.endsWith('.jsonl')) {
    // a saved TRANSCRIPT ({t0, t1, text, speaker?} per line): the lines go
    // through the same door as live ones, with no audio and no STT
    log(`replaying lines from ${file}`);
    // every row is checked before any is sent: a bad row fails the run with its line number
    const replay: Caption[] = [];
    const refuse: (n: number, why: string) => never = (n, why) => { log(`⛔ ${file}:${n}: ${why}; nothing was sent`); world?.close(); process.exit(1); };
    readFileSync(file, 'utf8').split('\n').forEach((row, i) => {
      if (!row.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(row); } catch (e) { refuse(i + 1, `not JSON (${(e as Error).message})`); }
      const line = normalizeCaption(parsed) as Caption | null;
      if (!line) refuse(i + 1, 'not a caption line: it needs finite times with 0 ≤ t0 ≤ t1, and non-empty text');
      replay.push(line);
    });
    for (const c of replay) onLine(c);
  } else {
    log(`rehearsing from ${file}`);
    await fileSource(file, tap);
  }
  await new Promise((r) => setTimeout(r, 2000)); // let the last final settle
  world?.end();
  await new Promise((r) => setTimeout(r, 1500)); // and the receipts land
  // where the unconfirmed entries are: the spool, memory only, or partly
  // memory only, by which entries
  const missing = world ? [world.spoolMissed ? `${world.spoolMissed} of this run's lines` : '', world.endMissed ? 'its end' : ''].filter(Boolean) : [];
  const where = !spool ? ' (in memory only: there is no spool)'
    : missing.length ? ` (${missing.join(' and ')} ${missing.length > 1 || (world?.spoolMissed ?? 0) > 1 ? 'are' : 'is'} NOT in the spool: ${world?.spoolFailed})`
    : ' (in the spool)';
  log(`done — ${lines} lines, ${captioner.lateRevisions} late revisions dropped${world ? `; ${world.acked} confirmed, ${world.pendingCount} unconfirmed${where}${world.spoolRefused ? `, ${world.spoolRefused} REFUSED (spool unwritable: ${world.spoolFailed})` : ''}${world.overflow ? `, ${world.overflow} DROPPED for overflow` : ''}` : ''}`);
  world?.close();
  // exit non-zero when the spool's promise was not kept or lines were dropped for overflow
  process.exit(world && (world.spoolLost || world.overflow) ? 1 : 0);
} else {
  const url = env('STREAM_URL', 'rtsp://127.0.0.1:8554/screen');
  log(`listening to ${url}`);
  // a reattach is a new time origin: the session rotates so no two lines
  // share a clock they do not share
  const src = ffmpegSource(url, tap, log, { onReattach: () => world?.rotateSession() });
  process.on('SIGINT', () => { src.close(); world?.end(); setTimeout(() => process.exit(0), 1500); });
}
