// The command registry — a PURE table. It imports NOTHING, and must stay
// that way: chat.js derives its autocomplete from this table, and the moment
// this file grows a dependency the cycle chat → commands → net → chat closes
// (§14.2). Handlers live in handlers.js and register themselves here at boot;
// this file only holds the names, the help lines, and the dispatch map.
//
// The table below is the WHOLE command surface now (§24l R1, survey §1):
// names, aliases, help — the one source chat.js resolves dispatch through
// AND derives autocomplete from. The first extraction moved only
// autocomplete, which left chat.js's switch as a second, drifting alias
// table (each copy carried aliases the other lacked). `listed: false`
// keeps a command dispatchable but out of autocomplete (listing is
// presentation, registration is behavior — unchanged doctrine);
// `aliasAsAction` is /use's trick: typing the alias IS the action
// (/pull lever1 → use "lever1 pull").

export const COMMANDS = [
  // whisper was removed (R 10-18): kept unlisted so a typed /w (or /r) is told why instead of "unknown command"
  { name: 'w', aliases: ['whisper', 'r', 'reply'], listed: false, help: 'whisper was removed — world chat is public' },
  { name: 'name', aliases: ['rename'], help: 'what the world calls you (choose it at the authority: renaming mid-visit isn\'t supported yet)' },
  { name: 'me', help: 'describe an action — "/me waves"' },
  { name: 'anim', help: '/anim <name> — play one of the action bar\'s anims once (🎭, or number keys)' },
  { name: 'sit', help: '/sit [thing] [slot] — sit down, on a seat if one is near (or the one you name)' },
  { name: 'push', aliases: ['shove'], help: '/push [name] [power] — shove someone within reach (their client decides); /push <thing> works the thing' },
  { name: 'touch', help: '/touch [name] [point] [left|right] — reach out and rest a hand on someone (nearest person, their shoulder, your right hand by default); the hand tracks them until /letgo' },
  { name: 'letgo', aliases: ['release'], help: 'let go — lower your reaching hand (or just one: /letgo left|right)' },
  { name: 'eyes', help: '/eyes close|open — hold your eyes shut, if your rig has eyelid bones' },
  { name: 'pushable', help: '/pushable on|off — whether anyone’s shove can knock you over (your table’s shove for everyone; off by default; Settings ▸ body has the whole table)' },
  { name: 'kick', help: '/kick <name> [reason] — moderation: remove someone from this world (owner). Objects fly with /punt' },
  { name: 'punt', aliases: ['boot'], help: '/punt [thing|person] [power] — kick a thing at your feet into flight (C); a person\'s name is the ragdoll shove (their client decides)' },
  { name: 'grab', aliases: ['pickup', 'take'], help: '/grab [thing] — pick up the nearest thing you can carry, or the one named (T)' },
  { name: 'put', help: '/put — set down what you hold, straight down from your hand (T)' },
  { name: 'drop', help: '/drop — let go of what you hold: it falls' },
  { name: 'throw', aliases: ['toss'], help: '/throw [speed] — throw what you hold where you look (C)' },
  { name: 'epoch', aliases: ['physics'], help: '/epoch [tickMs] | off — owner: run physics in this world (throws and punts fly; the log records where they rest)' },
  { name: 'who', help: 'list everyone present' },
  { name: 'panels', help: '/panels <0.3–1> — desktop panel opacity, for when glass fails over a bright scene' },
  // Registered so it is DISCOVERABLE. It was added on 2026-08-16 to debug voice
  // on a phone with no console, and stayed unregistered for the rest of that
  // session — a diagnostic nobody can find is one nobody uses, and the next
  // person with a silent mic is exactly who needs it.
  { name: 'audio', help: '/audio [stt|say] — why voice or captions are not working; `say` posts it to the room' },
  { name: 'role', help: 'what you may do here (or /role <name>: anyone this world has seen)' },
  { name: 'grant', help: '/grant <name> <role> [for 2h|forever] — owner (or grantRoles, below your rank); /grant * builder|visitor sets it for everyone signed in' },
  { name: 'revoke', help: '/revoke <name> — take back a role; they hold this world\'s default again (in a world for people listed only, they must leave)' },
  { name: 'access', help: '/access members|watch|visitors|open — who may come into this world (owner); /access alone shows it. World Settings › Access does this with buttons' },
  { name: 'members', help: 'who can come into this world, and until when' },
  { name: 'ban', help: '/ban <name> [reason] — ban someone from this world, here or not (owner)' },
  { name: 'unban', help: '/unban <name> — lift a ban here (owner)' },
  { name: 'bans', help: 'who is banned or muted here right now (moderators)' },
  // the moderation handlers (handlers.js moderate) were registered with no row here, so chat answered "unknown command"
  // (audit 10-07): a handler with no row is unreachable — the table is the dispatch
  { name: 'mute', help: '/mute <name> [minutes, default 60] [voice|chat] [reason] — quiet someone ranked below you' },
  { name: 'unmute', help: '/unmute <name> — lift a mute' },
  { name: 'warn', help: '/warn <name> <reason> — a warning they see, kept in the moderation log' },
  { name: 'gban', help: '/gban <name> [reason] — ban from ALL worlds (operator)' },
  { name: 'gunban', help: '/gunban <name> — lift a global ban (operator)' },
  { name: 'gbans', help: 'list global bans (operator)' },
  { name: 'fork', aliases: ['copy'], help: '/fork <new-name> — copy this world as it stands into a new one (its chat stays here) (owner)' },
  { name: 'newworld', aliases: ['found'], help: '/newworld <name> [title] — found a new, empty world that you own (signed in)' },
  { name: 'reset', aliases: ['erase'], help: 'erase this world back to zero, archived not destroyed (owner)' },
  { name: 'goto', help: '/goto <name> — walk to someone' },
  { name: 'clear', help: 'clear your chat log' },
  { name: 'flight', help: 'why flight is (or is not) doing that — rig, capability, phase' },
  { name: 'help', help: 'open the help sheet' },
  // dispatchable but unlisted — reachable, just not autocomplete noise
  { name: 'use', aliases: ['pull', 'ring', 'open'], aliasAsAction: true, listed: false,
    help: '/use <thing> [action] — the universal interact' },
  { name: 'mount', aliases: ['attach'], listed: false, help: '/mount <thing> <onto> [slot]' },
  { name: 'dismount', aliases: ['detach'], listed: false, help: '/dismount <thing>' },
  { name: 'debug', listed: false, help: '/debug [n] — the world\'s flight recorder' },
];

/** Resolve a typed word (name or alias) to its row — the ONE alias truth.
 *  Lazy map, rebuilt never: the table is a module-load constant. */
const byWord = new Map();
for (const row of COMMANDS) {
  byWord.set(row.name, row);
  for (const a of row.aliases ?? []) byWord.set(a, row);
}
export const resolveCommand = (word) => byWord.get(word) ?? null;

const handlers = new Map();

/** Register the behavior behind a command name. Last registration wins —
 *  there is exactly one boot pass, so a collision is a bug, not a feature. */
export function register(name, fn) { handlers.set(name, fn); }

/** Run a command. Returns false for an unknown name — the caller decides
 *  whether silence or a complaint is the right answer (the bus path stays
 *  silent, exactly as the old if-chain's fall-through did). */
export function dispatch(cmd, arg) {
  const fn = handlers.get(cmd);
  if (!fn) return false;
  fn(arg);
  return true;
}
