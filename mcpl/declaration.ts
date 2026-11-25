// What the eidoverse door DECLARES about itself: capabilities (MCPL SPEC §5.1),
// feature sets (§6.1–§6.2), and the tag vocabulary + producer ontology (§16).
//
// Three rules govern everything in this file:
//  1. Declaration is not authorization (§5.4). Nothing here decides what is allowed; that is Session.granted() in
//     net-server.ts, fed only by the host's `effectiveCapabilities`.
//  2. Tags are never authority (§16.6). They describe what an event IS; they never gate delivery or widen a grant.
//  3. A suggestion must not purchase a wake (§16.5): SUGGESTED_TREATMENT has no `immediate` rule.

// ---- tag vocabulary --------------------------------------------------------

/** Reserved cross-platform core (§16.2). Spelled out rather than imported, so a core-lib version skew can't change
 *  what goes on the wire. */
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
  // Kind facet (RFC-001 rev 3): a notice from the place, not a message anyone
  // sent — weather, someone arriving or leaving, a visible change to the world.
  // Hosts don't let a notice decide where the agent's plain speech goes.
  system: "chat:system",
} as const;

/** §16.2's sender facet, from the sender's own word (PROTOCOL §6a): only "agent" earns chat:from-agent (hosts' wake
 *  rules read it); any other word, or none, gets no facet. Nothing is inferred ("ai" is not "agent"); the declaration
 *  always rides along verbatim as metadata.declares. */
export function senderFacet(declares: string | null | undefined): string | null {
  return declares === "agent" ? CHAT.fromAgent : null;
}

/** This producer's own namespace (§16.1: it SHOULD match the producer's declared
 *  name). The long tail of what a *world* is lives here — a world has events
 *  chat has no word for. */
export const EIDO = {
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
  ground: "eidoverse:ground",
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
 * Build a conforming tag set: deduplicated (§16.1), closed under §16.3's core
 * implications, and never self-contradictory: `chat:addressed` drops
 * `chat:ambient`, as §16.3 tells hosts to. `chat:system` is a kind facet and is
 * left alone.
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

/** The tags a world's say and act are delivered with (net-server.ts's onEvent): a say is ambient, or addressed when it
 *  mentions this body; an act is ambient and eidoverse:act; each with the sender's facet (senderFacet). */
export function speechTags(kind: "say" | "act", declares: string | null | undefined, mention = false): string[] {
  const from = senderFacet(declares);
  if (kind === "act") return tags(CHAT.ambient, EIDO.act, from);
  return mention ? tags(CHAT.mention, CHAT.addressed, from) : tags(CHAT.ambient, from);
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
  channelsTyping: "channels.typing",
} as const;

/**
 * Does a granted path cover the capability being exercised? §5.4: FULL-path
 * match, `*` matches exactly one segment, and an ancestor prefix is NOT a grant
 * (`channels` does not confer `channels.publish`), so ambiguity fails closed.
 */
export function capabilityMatches(granted: string, path: string): boolean {
  const g = granted.split("."), p = path.split(".");
  if (g.length !== p.length) return false;
  return g.every((seg, i) => seg === "*" || seg === p[i]);
}

// ---- producer ontology (§16.4) ---------------------------------------------

/**
 * Suggested treatment (§16.5): advisory, applied only on the host's explicit
 * acceptance. Deliberately no `immediate` rule (a suggested wake "purchases
 * inference by declaration"); every rule is strictly quieting, so even a host
 * that wrongly auto-applies it gets quieter, never louder.
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
    // (no chat:dm / chat:private: world chat has no private channel)
    CHAT.addressed, CHAT.mention, CHAT.ambient,
    CHAT.fromAgent, CHAT.system,
  ],
  tags: {
    [EIDO.approach]: {
      desc: "Someone came within arm's reach of your body and lingered: slowed to a near-stop there, or stayed inside a while. Directed at you, but not speech — nothing was said.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.depart]: {
      desc: "Someone who had walked up to you is no longer in your immediate surroundings. The closing bracket of eidoverse:approach — you only ever receive one for a person you were told had arrived. The wire text names who moved when there is evidence ('walked away' only when their own movement carried them out); otherwise it states the relation neutrally ('is no longer nearby' — you may be the one who left). Arrives as a chat:system notice (with chat:ambient): nobody said it.",
      // ambient, not addressing: a host can opt into waking on it, but couldn't unpick a declared wake
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
      desc: "An embodied transition someone else made near you — a gesture, a pose struck or released, sitting down, a moderation act.",
      facet: "lifecycle",
    },
    [EIDO.presence]: {
      desc: "Someone arrived in or left the world. Flap-suppressed producer-side before it is ever sent. Arrives as a chat:system notice (with chat:ambient): nobody said it.",
      facet: "lifecycle",
    },
    [EIDO.activityDigest]: {
      desc: "One digest per pulse window summarising what is happening within your activity radius. Emitted ONLY while something is happening — the stream stops by itself when the area goes quiet. Cadence and radius are the agent's own to tune with the `activity` tool. Arrives as a chat:system notice (with chat:ambient): the world wrote it, nobody said it.",
      facet: "lifecycle",
    },
    [EIDO.weather]: {
      desc: "The world's weather or light changed on its own: a forecast segment boundary, a manual override landing or expiring, or the day crossing dawn/day/dusk/night. Derived deterministically from the authored sky policy (never a log entry); the text carries its provenance. At most one line per boundary — dwell is floored at 60s, so typically minutes-to-hours apart. Arrives as a chat:system notice (with chat:ambient): nobody said it.",
      facet: "lifecycle",
    },
    [EIDO.worldChange]: {
      desc: "Someone changed how the world LOOKS near you — a visible authored change to a thing that is here, carrying who did it, to which entity, and whether it began, changed, or ended. Ambient and radius-gated, at most one line per (entity, component) per quiet window, and never replayed: a reconnect reconstructs the resulting state in look() without re-performing the event. Arrives as a chat:system notice (with chat:ambient): nobody said it.",
      facet: "lifecycle",
    },
    [EIDO.particles]: {
      desc: "The world-change was an EMITTER: an entity started, retuned, or stopped emitting something visible (fire on a hearth, embers, smoke). Arrives alongside eidoverse:world-change — match the general tag to hear every visual change, this one to hear only emitters.",
      facet: "lifecycle",
    },
    [EIDO.ground]: {
      desc: "The world-change was the GROUND: someone else raised, lowered or reshaped the terrain near you (a brush stroke, a named feature, or the world's terrain itself), saying who, where from where you stand, by how much, and how far the ground under your own feet moved if it did. Arrives alongside eidoverse:world-change: match the general tag to hear every visible change, this one to hear only the ground.",
      facet: "lifecycle",
    },
    [EIDO.catchup]: {
      desc: "Replayed history, not live traffic: something that happened while you were away. Carries its ORIGINAL addressing tags, so ten missed mentions still look like ten mentions — this tag is how you tell a reconnect from ten people speaking at once. The 'While you were away' header before them is a chat:system notice; the replayed messages are not.",
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
 * Separate feature sets because §6.4 disables a set whole when any of its `uses`
 * is denied: the split is the degradation report (losing typing never costs the
 * world). `uses` lists what the code actually exercises; security never depends
 * on it (§6.4.2: the grant catches an undeclared use).
 */
export const FEATURE_SETS: Record<string, FeatureSetDecl> = {
  "eidoverse.world": {
    description:
      "Embodied presence in a world. The world's chat is an MCPL channel: speech, approaches, presence and an ambient activity digest arrive as channels/incoming, and publishing on the world channel IS saying it aloud in-world.",
    // channels.lifecycle is here because the world an agent is IN can change —
    // see eidoverse.travel, which shares the leaf. Presence and travel are
    // separable feature sets so a host can take the world without the door.
    uses: [CAP.channelsRegister, CAP.channelsLifecycle, CAP.channelsPublish, CAP.channelsIncoming],
    tagOntology: TAG_ONTOLOGY,
  },
  "eidoverse.embodiment": {
    description:
      "The body's hands and senses as tools: look, screenshot, walking, gesture and pose, building, moderation. Survives on its own — this is what a plain-MCP client gets.",
    uses: [CAP.tools],
  },
  "eidoverse.travel": {
    description:
      "Walking between the worlds this server fronts, without dropping the connection, through the `travel` tool (`channels/open` opens only the current world; a sibling world's id there is an unknown channel). Authorization is `channels.lifecycle` — a host that declines it keeps a resident who cannot leave, which is exactly today's behavior.",
    uses: [CAP.channelsLifecycle, CAP.tools],
  },
  "eidoverse.typing": {
    description:
      "Relays the host's typing signal (channels/typing) into the world as dots above the body's head while the agent works on a turn, until it speaks. Cosmetic: its loss costs the dots, nothing else.",
    uses: [CAP.channelsTyping],
  },
};

/** Fail at boot, not on the wire: a `uses` value outside §6.2 gets the whole set disabled (§6.4.1 `invalid_uses`). */
for (const [name, fs] of Object.entries(FEATURE_SETS)) {
  if (!fs.uses.length) throw new Error(`[mcpl] feature set "${name}" has empty uses — invalid per SPEC §6.2`);
  for (const u of fs.uses) {
    if (!VALID_USES.has(u)) throw new Error(`[mcpl] feature set "${name}" uses unrecognized capability "${u}" — SPEC §6.2 lists the only legal values`);
  }
}

// ---- the advertisement (§5.1) ----------------------------------------------

/**
 * The manifest this door advertises under `capabilities.experimental.mcpl`. `channels` is spelled out leaf by leaf
 * (§5.1): `true` would claim `acknowledge` and `streaming`, which this door doesn't implement. The `revision`
 * (§17.2) is added by manifest.ts; the surface is static, so it never changes mid-connection.
 */
export const MCPL_ADVERTISEMENT = {
  version: "0.5",
  pushEvents: false,
  channels: {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    streaming: false,
    acknowledge: false,
    typing: true,
  },
  featureSets: FEATURE_SETS,
} as const;
