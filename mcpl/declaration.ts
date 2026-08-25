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
