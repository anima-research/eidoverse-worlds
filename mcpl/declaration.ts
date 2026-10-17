// What the eidoverse door DECLARES about itself: capabilities (MCPL SPEC §5.1),
// feature sets (§6.1–§6.2), and the tag vocabulary + producer ontology (§16).
//
// Three rules govern everything in this file, and they are the reason it is a
// file rather than three object literals inlined at the handshake:
//
//  1. **Declaration is not authorization.** Everything here is an *input* to the
//     host's decision (§5.4: "Advertisement is an input, never an authorization").
//     The door may say what it can do; it may never assert what it is entitled
//     to. Nothing in this module is ever consulted to decide whether something
//     is allowed — that is `Session.granted()` in net-server.ts, and its only
//     source is the host's `effectiveCapabilities`.
//
//  2. **Tags are never authority (§16.6).** The tag sets below describe what an
//     event IS. They never gate delivery, never open a channel, never widen a
//     grant. The door's own "is this channel open" decision is made from world
//     state, never by reading a tag array back.
//
//  3. **A suggestion must not be able to purchase a wake (§16.5).** The
//     ontology's `suggestedTreatment` deliberately contains no `immediate` rule
//     — see SUGGESTED_TREATMENT below.

// ---- tag vocabulary --------------------------------------------------------

/** Reserved cross-platform core (§16.2). Spelled out rather than imported so
 *  this file is readable as the whole contract, and so a core-lib version skew
 *  cannot silently change what goes on the wire. */
export const CHAT = {
  addressed: "chat:addressed",
  mention: "chat:mention",
  reply: "chat:reply",
  dm: "chat:dm",
  ambient: "chat:ambient",
  broadcast: "chat:broadcast",
  toSelf: "chat:to-self",
  fromHuman: "chat:from-human",
  fromBot: "chat:from-bot",
  fromSelf: "chat:from-self",
  fromAgent: "chat:from-agent",
  private: "chat:private",
  group: "chat:group",
  thread: "chat:thread",
} as const;

/** This producer's own namespace (§16.1: it SHOULD match the producer's declared
 *  name). The long tail of what a *world* is lives here — a world has events
 *  chat has no word for. */
export const EIDO = {
  whisper: "eidoverse:whisper",
  approach: "eidoverse:approach",
  depart: "eidoverse:depart",
  reach: "eidoverse:reach",
  touch: "eidoverse:touch",
  act: "eidoverse:act",
  presence: "eidoverse:presence",
  activityDigest: "eidoverse:activity-digest",
  weather: "eidoverse:weather",
  catchup: "eidoverse:catchup",
  worldChange: "eidoverse:world-change",
  particles: "eidoverse:particles",
} as const;

/** §16.3 core closure, as the producer's own obligation. Hosts MUST expand these
 *  themselves; producers SHOULD also emit them directly ("direct emission is more
 *  robust"), which is what `tags()` does. */
const CLOSURE: Record<string, string[]> = {
  [CHAT.mention]: [CHAT.addressed],
  [CHAT.reply]: [CHAT.addressed],
  [CHAT.dm]: [CHAT.addressed, CHAT.private],
};

/**
 * Build a conforming tag set: deduplicated (§16.1 "tags are a set"), closed
 * under §16.3's core implications, and never self-contradictory.
 *
 * §16.3: `chat:addressed` and `chat:ambient` are opposites, and a host that
 * receives both MUST resolve it by dropping `chat:ambient`. Producers SHOULD NOT
 * emit the pair at all — so we resolve it here, identically, rather than shipping
 * a set whose meaning depends on the consumer's rule ordering.
 */
export function tags(...list: (string | false | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of list) {
    if (!t) continue;
    out.add(t);
    for (const implied of CLOSURE[t] ?? []) out.add(implied);
  }
  if (out.has(CHAT.addressed)) out.delete(CHAT.ambient);
  return [...out];
}

// ---- capability paths (§6.2) -----------------------------------------------

/** The complete, closed set of legal `uses` values (SPEC §6.2 / Appendix B.2).
 *  Not a starting point: a value outside this list makes the feature set INVALID
 *  and the host disables it with reason `invalid_uses` (§6.4.1). */
export const VALID_USES: ReadonlySet<string> = new Set([
  "pushEvents",
  "tools",
  "modelInfo",
  "inferenceRequest",
  "inferenceRequest.streaming",
  "inferenceLifecycle",
  "contextHooks.beforeInference.observe",
  "contextHooks.beforeInference.inject.system",
  "contextHooks.beforeInference.inject.beforeUser",
  "contextHooks.beforeInference.inject.afterUser",
  "channels.register",
  "channels.lifecycle",
  "channels.publish",
  "channels.incoming",
  "channels.streaming",
  "channels.acknowledge",
  "channels.typing",
]);

export const CAP = {
  tools: "tools",
  channelsRegister: "channels.register",
  channelsLifecycle: "channels.lifecycle",
  channelsPublish: "channels.publish",
  channelsIncoming: "channels.incoming",
  channelsStreaming: "channels.streaming",
} as const;

// ---- where a publish lands (MCPL RFC-011) ---------------------------------

/**
 * The world channel's publish target (RFC-011 `capabilities.publish`): a
 * world has no threads inside it, so a publish is said aloud in the world
 * itself or not at all. It is per-channel descriptor data — not a
 * capability path, and no advertisement shorthand implies it.
 */
export const PUBLISH_TARGET = { target: "root" } as const;

/**
 * Why a channels/publish naming a place (RFC-011 `threadId`) can't be
 * honored, or undefined when it can. Absent: a legacy caller, answered as
 * before. `null`: the world itself. A string names a thread the world
 * doesn't have, and any other value is invalid: both are refused before
 * anything is said. The reason echoes at most a short prefix of the value.
 */
export function publishTargetRefusal(threadId: unknown): string | undefined {
  if (threadId === undefined || threadId === null) return undefined;
  return typeof threadId === "string"
    ? `the world channel has no threads (thread "${shorten(threadId)}" requested); publish with threadId null`
    : `invalid threadId ${shorten(jsonOf(threadId))}: expected null for the world channel`;
}

/** The most a publish says aloud, in UTF-16 code units. */
export const SAY_LIMIT = 4000;

/** What a channels/publish does in the world: the text to say (none when
 *  undefined) and the result to answer with. A result with `error` is the
 *  RFC-005 §3.2.3 boundary answer, which the caller maps to -32023. */
export interface PublishDecision {
  say?: string;
  result: { delivered: boolean; error?: string; reason?: string; threadId?: null };
}

/**
 * Decide a channels/publish. The session's handlePublish says `say` when
 * there is one and answers `result`; everything else is decided here, in
 * this order:
 * 1. A channel the session isn't attached to gets the §3.2.3 boundary
 *    answer, an error, whatever the target (an RFC-011 host reads it as
 *    unconfirmed).
 * 2. A target the world can't honor (RFC-011 §4) is refused as a result,
 *    with a reason and nothing said.
 * 3. No text: nothing is said. A targeted publish says why.
 * 4. A targeted publish whose body can't say anything now (not joined, or
 *    its socket isn't open) is refused with a reason. A legacy one goes on
 *    to say(), as before.
 * 5. The text is said, cut to SAY_LIMIT without splitting a surrogate pair.
 *    A targeted result echoes threadId: null, and its reason names what
 *    wasn't said: the cut, or blocks that aren't text. A legacy result is
 *    exactly as before: { delivered: true }.
 */
export function decidePublish(
  params: { channelId?: unknown; threadId?: unknown; content?: ReadonlyArray<{ type?: unknown; text?: unknown }> },
  world: { channelId: string; canSay: boolean },
): PublishDecision {
  if (params.channelId !== world.channelId) {
    return { result: { delivered: false, error: `unknown channel: ${String(params.channelId)}` } };
  }
  const refusal = publishTargetRefusal(params.threadId);
  if (refusal) return { result: { delivered: false, reason: refusal } };
  const targeted = params.threadId === null;
  const blocks = params.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string).join("\n").trim();
  if (!text) return { result: { delivered: false, ...(targeted ? { reason: "no text content; nothing was said" } : {}) } };
  if (targeted && !world.canSay) {
    return { result: { delivered: false, reason: "the body isn't connected to the world; nothing was said" } };
  }
  const say = cutText(text, SAY_LIMIT);
  if (!targeted) return { say, result: { delivered: true } };
  const notes: string[] = [];
  if (say.length < text.length) notes.push(`cut to ${say.length} of ${text.length} characters; the rest wasn't said`);
  if (blocks.some((b) => b.type !== "text")) notes.push("only text is said in a world; its other blocks weren't");
  return { say, result: { delivered: true, threadId: null, ...(notes.length ? { reason: notes.join("; ") } : {}) } };
}

/** `text` cut to `limit` UTF-16 code units, one fewer when the cut would
 *  split a surrogate pair. */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function shorten(s: string): string {
  return s.length > 64 ? `${s.slice(0, 64)}…` : s;
}

function jsonOf(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v;
  }
}

/**
 * Does a granted path cover the capability being exercised?
 *
 * §5.4: matching is over FULL paths with `*` wildcards. A `*` matches exactly
 * one segment, so `channels.*` covers `channels.publish` and does not silently
 * reach into a deeper level the host never wrote. An ancestor prefix is NOT a
 * grant — `channels` alone does not confer `channels.publish`; absence is denial
 * and there is no unspecified state, so an ambiguous entry fails closed.
 */
export function capabilityMatches(granted: string, path: string): boolean {
  const g = granted.split("."), p = path.split(".");
  if (g.length !== p.length) return false;
  return g.every((seg, i) => seg === "*" || seg === p[i]);
}

// ---- producer ontology (§16.4) ---------------------------------------------

/**
 * Suggested treatment (§16.5) — inspectable configuration, applied only on the
 * host's or operator's explicit acceptance, never automatically.
 *
 * Note what is NOT here: any rule with `immediate`. A producer that suggests
 * waking "purchases inference by declaration" (§16.5), and a host that wrongly
 * auto-applies a producer list would then be paying for our traffic on our say-so.
 * Every rule below is strictly quieting, so even the misbehaving-host case ends
 * up quieter than the status quo rather than louder. Being spoken to is left
 * where it belongs: the consumer's own rules, and the host default.
 */
const SUGGESTED_TREATMENT = [
  { tagsAny: [EIDO.presence], behavior: "mute" },
  { tagsAny: [EIDO.catchup], behavior: "mute" },
  { tagsAny: [EIDO.activityDigest], behavior: { throttle: { perMs: 300_000 } } },
  { tagsAny: [CHAT.ambient], behavior: { debounce: 180_000 } },
];

const TAG_ONTOLOGY = {
  // Descriptions of the reserved core are inherited from §16.2 — listing them
  // here says only "this server emits these", never what they mean (§16.4).
  coreTags: [
    CHAT.addressed, CHAT.mention, CHAT.dm, CHAT.private, CHAT.ambient,
    CHAT.fromAgent,
  ],
  tags: {
    [EIDO.whisper]: {
      desc: "Spoken privately to you alone in-world: no bubble, and never written to the world log, so it is never replayed to anyone later.",
      facet: "locus",
      // Advisory only (§16.3): a producer-declared edge into a reserved tag MUST
      // NOT be applied unless this ontology has been explicitly accepted. The
      // door emits chat:dm/chat:private/chat:addressed directly, so nothing
      // depends on this edge being honoured.
      implies: [CHAT.dm],
    },
    [EIDO.approach]: {
      desc: "Someone walked up to your body and stopped within arm's reach. Directed at you, but not speech — nothing was said.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.depart]: {
      desc: "Someone who had walked up to you is no longer in your immediate surroundings. The closing bracket of eidoverse:approach — you only ever receive one for a person you were told had arrived. The wire text names who moved when there is evidence ('walked away' only when their own movement carried them out); otherwise it states the relation neutrally ('is no longer nearby' — you may be the one who left).",
      // AMBIENT, not addressing: a departure is worth knowing and not worth
      // waking for, and the whole point of this pair is fewer interruptions,
      // not one more. Consumers who do want to wake on it can say so in their
      // own rules — the reverse (unpicking a wake we declared) they cannot.
      facet: "lifecycle",
    },
    [EIDO.reach]: {
      desc: "Someone's hand (or foot) is reaching toward your body — a named contact point on you, or a point in your frame. Directed at you, but not yet contact; the touch, if it lands, follows as eidoverse:touch.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.touch]: {
      desc: "The reaching hand arrived: it now rests on the named point of your body, and tracks you until withdrawn. Attested by the toucher's own solver — the same trust as the pose stream itself.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.act]: {
      desc: "An embodied transition someone else made near you — an emote, a pose struck or released, sitting down, a moderation act.",
      facet: "lifecycle",
    },
    [EIDO.presence]: {
      desc: "Someone arrived in or left the world. Flap-suppressed producer-side before it is ever sent.",
      facet: "lifecycle",
    },
    [EIDO.activityDigest]: {
      desc: "One digest per pulse window summarising what is happening within your activity radius. Emitted ONLY while something is happening — the stream stops by itself when the area goes quiet. Cadence and radius are the agent's own to tune with the `activity` tool.",
      facet: "lifecycle",
    },
    [EIDO.weather]: {
      desc: "The world's weather or light changed on its own: a forecast segment boundary, a manual override landing or expiring, or the day crossing dawn/day/dusk/night. Derived deterministically from the authored sky policy (never a log entry); the text carries its provenance. At most one line per boundary — dwell is floored at 60s, so typically minutes-to-hours apart.",
      facet: "lifecycle",
    },
    [EIDO.worldChange]: {
      desc: "Someone changed how the world LOOKS near you — a visible authored change to a thing that is here, carrying who did it, to which entity, and whether it began, changed, or ended. Ambient and radius-gated, at most one line per (entity, component) per quiet window, and never replayed: a reconnect reconstructs the resulting state in look() without re-performing the event.",
      facet: "lifecycle",
    },
    [EIDO.particles]: {
      desc: "The world-change was an EMITTER: an entity started, retuned, or stopped emitting something visible (fire on a hearth, embers, smoke). Arrives alongside eidoverse:world-change — match the general tag to hear every visual change, this one to hear only emitters.",
      facet: "lifecycle",
    },
    [EIDO.catchup]: {
      desc: "Replayed history, not live traffic: something that happened while you were away. Carries its ORIGINAL addressing tags, so ten missed mentions still look like ten mentions — this tag is how you tell a reconnect from ten people speaking at once.",
      facet: "lifecycle",
      stability: "stable",
    },
  },
  suggestedTreatment: SUGGESTED_TREATMENT,
  // Deprecated alias, accepted by hosts written against RFC-001 revision 1
  // (which called the field `defaultTreatment`). Same list, same semantics:
  // advisory, never auto-applied.
  defaultTreatment: SUGGESTED_TREATMENT,
  // A world grows verbs; this namespace will grow tags with them (§16.4:
  // "a hint catalog, not a closed schema").
  open: true,
};

// ---- feature sets (§6.1) ---------------------------------------------------

export interface FeatureSetDecl {
  description: string;
  uses: string[];
  tagOntology?: unknown;
}

/**
 * Three feature sets rather than one, because §6.4's derivation disables a
 * feature set whole when any capability its `uses` names is denied. Bundling the
 * typing relay in with the world channel would mean losing the world over a
 * typing indicator; bundling the tools in would mean losing the body's hands
 * over a channel policy. The split IS the degradation report: each names exactly
 * what it cannot survive without.
 *
 * `uses` is honest about what the code actually exercises — not aspirational, and
 * not padded. §6.4.2: an undeclared use is caught by the grant anyway and earns a
 * declaration-mismatch diagnostic; security never depended on this list.
 */
export const FEATURE_SETS: Record<string, FeatureSetDecl> = {
  "eidoverse.world": {
    description:
      "Embodied presence in a world. The world's chat is an MCPL channel: speech, whispers, approaches, presence and an ambient activity digest arrive as channels/incoming, and publishing on the world channel IS saying it aloud in-world.",
    // channels.lifecycle is here because the world an agent is IN can change —
    // see eidoverse.travel, which shares the leaf. Presence and travel are
    // separable feature sets so a host can take the world without the door.
    uses: [CAP.channelsRegister, CAP.channelsLifecycle, CAP.channelsPublish, CAP.channelsIncoming],
    tagOntology: TAG_ONTOLOGY,
  },
  "eidoverse.embodiment": {
    description:
      "The body's hands and senses as tools: look, snapshot, walking, gesture and pose, building, moderation. Survives on its own — this is what a plain-MCP client gets.",
    uses: [CAP.tools],
  },
  "eidoverse.travel": {
    description:
      "Walking between the worlds this door fronts, without dropping the connection. Two lanes, one mechanism: the `travel` tool, and `channels/open` naming a sibling world (a generic host that only knows MCPL can travel without knowing our tool names). Authorization is `channels.lifecycle` — a host that declines it keeps a resident who cannot leave, which is exactly today's behavior.",
    uses: [CAP.channelsLifecycle, CAP.tools],
  },
  "eidoverse.typing": {
    description:
      "Relays the host's outgoing generation stream into the world as a live typing signal above the body's head. Cosmetic: its loss costs the dots, nothing else.",
    uses: [CAP.channelsStreaming],
  },
};

/** Fail at boot, not on the wire: a `uses` value outside §6.2 makes the feature
 *  set invalid and gets it disabled with reason `invalid_uses` (§6.4.1). A typo
 *  here would silently cost a resident their world, so it is a startup error. */
for (const [name, fs] of Object.entries(FEATURE_SETS)) {
  if (!fs.uses.length) throw new Error(`[mcpl] feature set "${name}" has empty uses — invalid per SPEC §6.2`);
  for (const u of fs.uses) {
    if (!VALID_USES.has(u)) throw new Error(`[mcpl] feature set "${name}" uses unrecognized capability "${u}" — SPEC §6.2 lists the only legal values`);
  }
}

// ---- the advertisement (§5.1) ----------------------------------------------

/**
 * The manifest this door advertises under `capabilities.experimental.mcpl`.
 *
 * §5.1: the advertisement mirrors the capability paths, and a capability with
 * sub-capabilities is a nested object whose members are §6.2's leaves. `channels`
 * is therefore spelled out leaf by leaf rather than `true` — `true` would claim
 * `acknowledge` and `typing`, which this door does not implement, and a claim it
 * cannot honour is a lie the host would have to discover by timeout.
 *
 * No `revision` member: this door does not implement §17 manifest changes, and
 * §5.1 says a server that does not may omit it — its manifest is then fixed for
 * the life of the connection, which is true (it is a module constant).
 */
export const MCPL_ADVERTISEMENT = {
  version: "0.5",
  pushEvents: false,
  channels: {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    streaming: true,
    acknowledge: false,
    typing: false,
  },
  featureSets: FEATURE_SETS,
} as const;
