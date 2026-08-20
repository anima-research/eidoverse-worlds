// The command registry — a PURE table. It imports NOTHING, and must stay
// that way: chat.js derives its autocomplete from this table, and the moment
// this file grows a dependency the cycle chat → commands → net → chat closes
// (§14.2). Handlers live in handlers.js and register themselves here at boot;
// this file only holds the names, the help lines, and the dispatch map.
//
// The metadata below is the user-facing command surface (what autocomplete
// shows), in display order. It replaced a hand-kept copy in chat.js that had
// drifted — a duplicate /kick row (chat.js:406/411) died in the move. Not
// every dispatchable command is listed (/use, /mount, /dismount, /debug,
// /rename ride their chat aliases or the help sheet), exactly as before:
// listing is presentation, registration is behavior.

export const COMMANDS = [
  { name: 'w', aliases: ['whisper'], help: '/w <name> <message> — whisper, privately' },
  { name: 'r', aliases: ['reply'], help: 'reply to the last whisper you got' },
  { name: 'name', aliases: ['rename'], help: '/name <new name> — change what the world calls you' },
  { name: 'me', help: 'describe an action — "/me waves"' },
  { name: 'emote', help: '/emote dance · wave cheer dance point salute clap' },
  { name: 'sit', help: 'sit down, on a seat if one is near' },
  { name: 'push', aliases: ['shove'], help: '/push [name] [power] — shove someone within reach (their client decides); /push <thing> works the thing' },
  { name: 'eyes', help: '/eyes close|open — hold your eyes shut, if your rig has eyelid bones' },
  { name: 'pushable', help: '/pushable on|off — whether shoves and blasts can knock you over (on by default)' },
  { name: 'boom', aliases: ['blast'], help: '/boom [power] [radius] — a blast where you stand, you included (builder)' },
  { name: 'kick', help: '/kick [thing] [power] — send an object flying (a person\'s name = moderation)' },
  { name: 'punt', aliases: ['boot'], help: '/punt [thing] [power] — the unambiguous physics kick' },
  { name: 'who', help: 'list everyone present' },
  { name: 'role', help: 'what you may do here (or /role <name>)' },
  { name: 'grant', help: '/grant <name> owner|builder|visitor [+gen|-gen] — owner only' },
  { name: 'ban', help: '/ban <name> [reason] — ban someone from this world (owner)' },
  { name: 'unban', help: '/unban <name> — lift a ban here (owner)' },
  { name: 'bans', help: 'who is banned from this world' },
  { name: 'gban', help: '/gban <name> [reason] — ban from ALL worlds (operator)' },
  { name: 'gunban', help: '/gunban <name> — lift a global ban (operator)' },
  { name: 'gbans', help: 'list global bans (operator)' },
  { name: 'fork', aliases: ['copy'], help: '/fork <new-name> — copy this world, history and all (owner)' },
  { name: 'reset', aliases: ['erase'], help: 'erase this world back to zero, archived not destroyed (owner)' },
  { name: 'goto', help: '/goto <name> — walk to someone' },
  { name: 'clear', help: 'clear your chat log' },
  { name: 'help', help: 'open the help sheet' },
];

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
