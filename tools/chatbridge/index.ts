// Chat bridge: mirrors a world's spoken chat into one Discord text channel,
// and carries that channel's messages back in as speech.
//
//   world WS (embodied "discord") ── say verbs ──▶ Discord channel
//   Discord channel ── messages ──▶ say {text: "author: …"} in the world
//
// The bridge joins EMBODIED, not as a spectator, because authoring (even
// `say`, rank 0) needs a body — and that is honest UX anyway: the world
// shows a presence named "discord" standing where the channel is listening.
// Everything it relays is attributed inside the say text ("author: …"), so
// provenance survives in the log verbatim.
//
// Loop safety (both directions, both by identity):
//   world → Discord: entries whose actor is the bridge's own id are skipped —
//     that covers the echo of every line it just spoke.
//   Discord → world: messages from bots/webhooks are skipped — that covers
//     the bridge's own posts (and any other bot; humans only by default).
//
// Env:
//   WORLD_URL      ws(s)://host/ws            (default ws://127.0.0.1:8940/ws)
//   WORLD_TOKEN    door key                    (JOIN_TOKEN accepted too — the
//                                              one-secret-two-names footgun,
//                                              issue #41, answered by taking both)
//   WORLD_NAME     world to mirror             (default commons)
//   BRIDGE_ID      in-world identity           (default "discord")
//   DISCORD_TOKEN  bot token                   (omit with DRY_RUN=1)
//   CHANNEL_ID     the mirrored text channel
//   ALLOW_BOTS=1   relay other bots' Discord messages too (default: humans only)
//   DRY_RUN=1      no Discord: world lines print to stdout, stdin lines of the
//                  form "Name: text" play the part of Discord messages — lets
//                  the world half be rehearsed before bot credentials exist
//
// The Discord application needs the MESSAGE CONTENT privileged intent enabled
// (dev portal → Bot → Message Content Intent), or every message arrives empty.
//
// Queue policy, both directions: bounded, oldest dropped with a log line — a
// mirror that runs minutes behind is worse than one with a hole it admits to.

const WORLD_URL = process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws";
const WORLD_TOKEN = process.env.WORLD_TOKEN ?? process.env.JOIN_TOKEN ?? "";
const WORLD_NAME = process.env.WORLD_NAME ?? "commons";
const BRIDGE_ID = process.env.BRIDGE_ID ?? "discord";
const CHANNEL_ID = process.env.CHANNEL_ID ?? "";
const ALLOW_BOTS = process.env.ALLOW_BOTS === "1";
const DRY_RUN = process.env.DRY_RUN === "1";

const MAX_BACKLOG = 50;        // per direction; beyond this the oldest drop
const MAX_LINE_CHARS = 1500;   // Discord → world cap (with honest ellipsis)
const DISCORD_CHUNK = 1900;    // world → Discord split point (limit is 2000)
const SEND_GAP_MS = 350;       // world verb pacing; VERB_RATE default is 12/4s

const log = (m: string) => console.log(`[chatbridge ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------- world → discord

type Out = { actor: string; text: string; at: number };
const toDiscord: Out[] = [];
let postChannel: { send: (o: unknown) => Promise<unknown> } | null = null;
let postHook: { send: (o: unknown) => Promise<unknown> } | null = null;
let posting = false;

// Webhook usernames may not contain "discord" or "clyde" (API rule), and cap
// at 80 chars. World actor names are already control-char-clean.
const hookName = (actor: string) =>
  (actor.replace(/discord/gi, "disc0rd").replace(/clyde/gi, "clyd3").trim() || "someone").slice(0, 80);

// Discord rejects content that RENDERS empty (API 50006) even when JS trim()
// keeps it — zero-width and other invisible code points survive .trim().
// 2026-08-15 incident: one such say tripped the webhook error path, which
// (being meant for deleted webhooks) stuck the mirror in plain-post mode
// for 12 hours. Filter these before they ever reach the API.
const INVISIBLE =
  /[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;
const sendable = (s: string) => s.replace(INVISIBLE, "").length > 0;

async function postOnce(actor: string, chunk: string) {
  // never ping: a world line containing @everyone must stay ink, not a bell
  const quiet = { allowedMentions: { parse: [] } };
  if (postHook) {
    try {
      // webhook = per-speaker username, so the channel reads as a conversation
      await postHook.send({ content: chunk, username: hookName(actor), ...quiet });
      return;
    } catch (e) {
      // Only a webhook that is actually GONE justifies the (sticky) fallback:
      // 10015 Unknown Webhook / 10003 Unknown Channel. Anything else — content
      // errors (50006 empty, 50035 invalid form body), rate limits, hiccups —
      // is about THIS send; the retry in pumpDiscord gets one more shot at it,
      // and per-speaker names stay on. (2026-08-15: a content error here cost
      // the mirror 12 hours of nameless posts.)
      const code = (e as any)?.code;
      if (code !== 10015 && code !== 10003) throw e;
      log(`webhook gone (${(e as Error).message}) — falling back to plain posts`);
      postHook = null;
      chunk = `**${actor}** — ${chunk}`;
    }
  }
  await postChannel?.send({ content: chunk, ...quiet });
}

async function pumpDiscord() {
  if (posting) return;
  posting = true;
  while (toDiscord.length) {
    while (toDiscord.length > MAX_BACKLOG) {
      const d = toDiscord.shift()!;
      log(`⏭ discord backlog — dropped "${d.actor}: ${d.text.slice(0, 40)}…"`);
    }
    const line = toDiscord.shift()!;
    // with a webhook the name rides the message header; without, it's inline ink
    const body = postHook || DRY_RUN ? line.text : `**${line.actor}** — ${line.text}`;
    for (let i = 0; i < body.length; i += DISCORD_CHUNK) {
      const chunk = body.slice(i, i + DISCORD_CHUNK);
      if (!sendable(chunk)) {
        log(`⏭ unsendable chunk from ${line.actor} (renders empty on Discord) — skipped`);
        continue;
      }
      if (DRY_RUN) { log(`→ discord [${line.actor}]: ${chunk}`); continue; }
      try {
        await postOnce(line.actor, chunk);
      } catch (e) {
        log(`discord send failed: ${(e as Error).message} — retrying once in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        await postOnce(line.actor, chunk).catch((e2) =>
          log(`dropped after retry: ${(e2 as Error).message}`));
      }
    }
  }
  posting = false;
}

// ---------------------------------------------------------------- discord → world

type In = { author: string; text: string; at: number };
const toWorld: In[] = [];
let worldWs: WebSocket | null = null;
let joined = false;
let speaking = false;

async function pumpWorld() {
  if (speaking) return;
  speaking = true;
  while (toWorld.length) {
    if (!joined || worldWs?.readyState !== WebSocket.OPEN) break; // flushed on rejoin
    while (toWorld.length > MAX_BACKLOG) {
      const d = toWorld.shift()!;
      log(`⏭ world backlog — dropped "${d.author}: ${d.text.slice(0, 40)}…"`);
    }
    const m = toWorld.shift()!;
    let text = `${m.author}: ${m.text}`;
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}…`;
    worldWs.send(JSON.stringify({ type: "verb", verb: "say", args: { text } }));
    await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
  speaking = false;
}

// ---------------------------------------------------------------- world socket

let lastSeq = -Infinity; // dedupe guard across reconnects (tail replay overlaps live)

function connectWorld() {
  const ws = new WebSocket(WORLD_URL);
  worldWs = ws;
  ws.onopen = () =>
    ws.send(JSON.stringify({ type: "join", world: WORLD_NAME, id: BRIDGE_ID, token: WORLD_TOKEN }));
  ws.onclose = () => {
    joined = false;
    log("world socket closed — reconnecting in 1.5s");
    setTimeout(connectWorld, 1500);
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.type === "error") { log(`world says: ${msg.error}`); return; }
    if (msg.type === "snapshot") {
      joined = true;
      // live lines only: the channel is a window, not an archive — but keep
      // the tail's high-water seq so a reconnect can't replay it at us
      for (const e of msg.entries ?? []) if (typeof e.seq === "number") lastSeq = Math.max(lastSeq, e.seq);
      log(`joined "${msg.world}" as ${msg.you} (${msg.entries?.length ?? 0} tail entries skipped — live lines only)`);
      pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
      return;
    }
    if (msg.type !== "log" || msg.entry?.verb !== "say") return;
    const { actor, seq, args } = msg.entry;
    if (typeof seq === "number") { if (seq <= lastSeq) return; lastSeq = seq; }
    if (actor === BRIDGE_ID) return; // our own speech echoing back
    const text = String(args?.text ?? "").trim();
    if (!text) return;
    toDiscord.push({ actor, text, at: Date.now() });
    pumpDiscord().catch((e) => log(`discord pump error: ${e.message}`));
  };
}

// ---------------------------------------------------------------- discord

async function connectDiscord() {
  if (DRY_RUN) {
    log("DRY_RUN — stdin plays Discord: type lines like  Name: hello world");
    (async () => {
      for await (const chunk of process.stdin) {
        for (const raw of String(chunk).split("\n")) {
          const m = raw.match(/^([^:]{1,64}):\s*(.+)$/);
          if (!m) continue;
          toWorld.push({ author: m[1].trim(), text: m[2], at: Date.now() });
          pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
        }
      }
    })();
    return;
  }
  const TOKEN = process.env.DISCORD_TOKEN ?? "";
  if (!TOKEN || !CHANNEL_ID) throw new Error("DISCORD_TOKEN and CHANNEL_ID required (or DRY_RUN=1)");
  const { Client, GatewayIntentBits, Events } = await import("discord.js");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(TOKEN);
  // Events.ClientReady tracks the v14→v15 "ready"→"clientReady" rename
  await new Promise<void>((res) => client.once((Events?.ClientReady ?? "ready") as any, () => res()));
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch || !("send" in ch)) throw new Error(`channel ${CHANNEL_ID} is not a sendable text channel`);
  postChannel = ch as unknown as { send: (o: unknown) => Promise<unknown> };
  log(`discord: mirroring #${(ch as any).name ?? CHANNEL_ID} as ${client.user?.tag}`);
  // Per-speaker names ride a webhook (execute takes a username per message).
  // Reuse ours if a restart left one behind, else create; needs the Manage
  // Webhooks permission — without it the mirror still works, names inline.
  try {
    const hooks = await (ch as any).fetchWebhooks();
    postHook = hooks.find((h: any) => h.token && h.owner?.id === client.user?.id)
      ?? await (ch as any).createWebhook({ name: "eidoverse" });
    log("webhook: per-speaker names on");
  } catch (e) {
    log(`no webhook (${(e as Error).message}) — posting as the bot with inline names`);
  }

  client.on("messageCreate", (m: any) => {
    if (m.channelId !== CHANNEL_ID) return;
    if (m.webhookId && m.webhookId === (postHook as any)?.id) return; // our own mirror, always
    if ((m.author?.bot || m.webhookId) && !ALLOW_BOTS) return; // loop gate + bot hygiene
    let text = String(m.content ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    const files = [...(m.attachments?.values?.() ?? [])].map((a: any) => a.url).filter(Boolean);
    if (files.length) text = [text, ...files].filter(Boolean).join(" ");
    if (!text) return;
    const author = String(m.member?.displayName ?? m.author?.username ?? "someone").slice(0, 64);
    toWorld.push({ author, text, at: Date.now() });
    pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
  });
}

await connectDiscord();
connectWorld();
log(`bridging world "${WORLD_NAME}" (${WORLD_URL}) as "${BRIDGE_ID}" — ${DRY_RUN ? "DRY RUN" : `channel ${CHANNEL_ID}`}`);
