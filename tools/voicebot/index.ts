// Show voice bot: gives the world's agent performers audible voices.
//
//   world WS (spectator "voice") ── say verbs by configured speakers ──▶
//   ElevenLabs streaming TTS ──▶ Discord voice channel (@discordjs/voice)
//
// Humans in the channel just talk; this bot only voices the models.
// Captions need nothing extra — every say is already in-world chat + log.
//
// Env:
//   WORLD_URL      ws(s)://host/ws          (default ws://127.0.0.1:8940/ws)
//   WORLD_TOKEN    door key                  (if the sequencer has one)
//   WORLD_NAME     world to watch            (default commons)
//   SPEAKERS       comma list of actor ids to voice, or "*" for all agents
//   VOICES_FILE    actor→voiceId map         (default ./voices.json)
//   ELEVEN_KEY     ElevenLabs API key
//   ELEVEN_MODEL   default eleven_turbo_v2_5
//   DISCORD_TOKEN  bot token                 (omit with DRY_RUN=1)
//   GUILD_ID / CHANNEL_ID  the show voice channel
//   DRY_RUN=1      synthesize to /tmp/voicebot-*.mp3 instead of Discord —
//                  lets the TTS half be rehearsed before bot credentials exist
//
// Queue policy: lines play sequentially; if the backlog exceeds MAX_BACKLOG
// the oldest unplayed lines are dropped with a log — the show must never run
// minutes behind the stage. A hard per-line cap guards runaway synthesis.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORLD_URL = process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws";
const WORLD_TOKEN = process.env.WORLD_TOKEN ?? "";
const WORLD_NAME = process.env.WORLD_NAME ?? "commons";
const SPEAKERS = (process.env.SPEAKERS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
const VOICES_FILE = process.env.VOICES_FILE ?? fileURLToPath(new URL("./voices.json", import.meta.url));
const ELEVEN_KEY = process.env.ELEVEN_KEY ?? "";
const ELEVEN_MODEL = process.env.ELEVEN_MODEL ?? "eleven_turbo_v2_5";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_BACKLOG = 6;      // lines; beyond this the oldest are dropped
const MAX_LINE_CHARS = 800; // ElevenLabs cost + pacing guard

const voices: Record<string, string> = existsSync(VOICES_FILE)
  ? JSON.parse(readFileSync(VOICES_FILE, "utf8"))
  : {};
if (!Object.keys(voices).length) console.warn(`⚠ no ${VOICES_FILE} — every speaker needs a voice id (see voices.example.json)`);
if (!ELEVEN_KEY) console.warn("⚠ no ELEVEN_KEY — synthesis will fail");

const log = (m: string) => console.log(`[voicebot ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------- synthesis

async function synth(actor: string, text: string): Promise<ArrayBuffer | null> {
  const voice = voices[actor] ?? voices["*"];
  if (!voice || voice.startsWith("REPLACE")) { log(`no voice for "${actor}" — skipped`); return null; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, MAX_LINE_CHARS), model_id: ELEVEN_MODEL }),
  });
  if (!r.ok) { log(`TTS ${r.status} for "${actor}": ${(await r.text()).slice(0, 200)}`); return null; }
  return await r.arrayBuffer();
}

// ---------------------------------------------------------------- playback

type Line = { actor: string; text: string; at: number };
const queue: Line[] = [];
let playing = false;
let player: any = null; // AudioPlayer when Discord is up

async function playDiscord(mp3: ArrayBuffer) {
  const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = await import("@discordjs/voice");
  const { Readable } = await import("node:stream");
  const resource = createAudioResource(Readable.from(Buffer.from(mp3)), { inputType: StreamType.Arbitrary });
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 10_000);
  await entersState(player, AudioPlayerStatus.Idle, 120_000);
}

let dryN = 0;
async function pump() {
  if (playing) return;
  playing = true;
  while (queue.length) {
    while (queue.length > MAX_BACKLOG) {
      const dropped = queue.shift()!;
      log(`⏭ backlog — dropped "${dropped.actor}: ${dropped.text.slice(0, 40)}…"`);
    }
    const line = queue.shift()!;
    const t0 = Date.now();
    const mp3 = await synth(line.actor, line.text).catch((e) => { log(`synth error: ${e.message}`); return null; });
    if (!mp3) continue;
    log(`🗣 ${line.actor} (${((mp3.byteLength / 1024) | 0)}KB, synth ${Date.now() - t0}ms, queued ${Date.now() - line.at}ms): ${line.text.slice(0, 60)}`);
    if (DRY_RUN) {
      const p = `/tmp/voicebot-${++dryN}-${line.actor}.mp3`;
      writeFileSync(p, Buffer.from(mp3));
      log(`   dry-run → ${p}`);
    } else {
      await playDiscord(mp3).catch((e) => log(`playback error: ${e.message}`));
    }
  }
  playing = false;
}

// ---------------------------------------------------------------- discord

async function connectDiscord() {
  if (DRY_RUN) { log("DRY_RUN — skipping Discord"); return; }
  const TOKEN = process.env.DISCORD_TOKEN ?? "";
  const GUILD_ID = process.env.GUILD_ID ?? "";
  const CHANNEL_ID = process.env.CHANNEL_ID ?? "";
  if (!TOKEN || !GUILD_ID || !CHANNEL_ID) throw new Error("DISCORD_TOKEN, GUILD_ID, CHANNEL_ID required (or DRY_RUN=1)");
  const { Client, GatewayIntentBits } = await import("discord.js");
  const { joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior } = await import("@discordjs/voice");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await client.login(TOKEN);
  await new Promise<void>((res) => client.once("ready", () => res()));
  const guild = await client.guilds.fetch(GUILD_ID);
  const conn = joinVoiceChannel({
    channelId: CHANNEL_ID, guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator, selfDeaf: false,
  });
  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  conn.subscribe(player);
  log(`voice: joined channel ${CHANNEL_ID} in ${guild.name}`);
}

// ---------------------------------------------------------------- world

function connectWorld() {
  const ws = new WebSocket(WORLD_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: WORLD_NAME, id: "voice", avatar: "", spectate: true, token: WORLD_TOKEN }));
  ws.onclose = () => { log("world socket closed — reconnecting"); setTimeout(connectWorld, 1500); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "snapshot") log(`watching world "${WORLD_NAME}" as spectator (${msg.entries?.length ?? 0} log entries skipped — live lines only)`);
    if (msg.type !== "log" || msg.entry?.verb !== "say") return;
    const { actor, args } = msg.entry;
    if (!SPEAKERS.includes("*") && !SPEAKERS.includes(actor)) return;
    const text = String(args?.text ?? "").trim();
    if (!text) return;
    queue.push({ actor, text, at: Date.now() });
    pump().catch((e) => log(`pump error: ${e.message}`));
  };
}

await connectDiscord();
connectWorld();
log(`voicing ${SPEAKERS.join(", ") || "(nobody)"} from ${WORLD_URL} — ${DRY_RUN ? "DRY RUN" : "live"}`);
