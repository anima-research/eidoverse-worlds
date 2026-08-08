# Local conversation spaces — protocol & state-machine proposal (issue #67, design only)

*Design pass requested by Mica 2026-08-08 (#eidoverse_dev), authored by the bounded
worker `eido-local-chat-design`. No code. Grounded against current main (`16e6b5b`);
every mechanism claim below carries a file:line anchor from that tree. Composes with
the #55 intake contract as settled by Mica + Cairn (2026-08-08) and defers all
summarization to Tuneout (af#77). Locality is not privacy: a café lane is locally
audible while the durable record stays under the world's ordinary record policy
("the log is public" — spectators may read `history`, server.ts:2365); sealed rooms
are explicitly later work.*

---

## 0. Shape of the proposal in one paragraph

A builder authors a `conversation-space` **component** on an anchor entity (the café
counter). The **sequencer** derives per-person membership from the same authoritative
`lastPose` it already consults for `punt` reach (server.ts:2182) and lease-take
(server.ts:2516), through a small hysteresis state machine evaluated on the existing
66 ms frame flush. A `say` may carry `space: <id>`; the server binds the lane **at
verb receipt** against current membership and refuses non-members. The entry lands in
the **single world log** (one seq space, self-describing via `args.space`), but
`World.broadcast` — today unconditional (server.ts:1087) and the single choke point —
delivers lane-scoped `log` entries **only to current members**. Everything any
consumer learns about membership comes from the server; agents and humans share the
same truth structurally, because the WorldAgent is just another client behind the
same broadcast filter. Non-members get headers (existence, occupancy, counters) and
bounded chosen pull, never pushed bodies. Catchup is headers, tagged, never replayed
as live.

---

## 1. Data model: the `conversation-space` component

Rides the existing comp lane unchanged: `comp {id: <anchorEntity>, type:
"conversation-space", data: {...}}` — builder rank (VERB_NEEDS server.ts:730),
≤ 8 KB data / 32-char type (server.ts:2193-2210), wholesale-replace fold
(server.ts:401-410), lockable via the existing `lock` comp to protect the anchor.

```jsonc
{
  "space": "cafe",              // spaceId: [a-z0-9-]{1,32}, unique per world
  "label": "the café",          // prose name for look()/UI
  "region": { "kind": "radius", "r": 6 },
                                // slice 1: radius around anchor origin (entity-local,
                                // rides `place` — a moved café takes its room along).
                                // { kind:"box", min:[...], max:[...] } (entity-local)
                                // reserved for slice 2; polygon deferred.
  "hysteresis": { "exitPad": 1.5 },   // exit boundary = region inflated by exitPad m
  "debounce": { "enterMs": 1500, "leaveMs": 4000 },
  "policy": {
    "mentions": "knock",        // "knock" | "deliver" | "local"  (see §5)
    "export": false             // acoustic leak / bridging is AUTHORED, default deny (§8)
  }
}
```

Validation follows the two existing precedents at once:

- **Advisory lint** (the `lintMotion`/`lintParticles` pattern, server.ts:527-588):
  malformed data folds anyway (comp contract) but emits a `world_debug`
  `conversation-space-lint` line; an unusable space is simply **inert** — it never
  registers with the membership engine, it never gates anything.
- **Server-meaningful** (the `lock` precedent, server.ts:772-780): a *valid* space is
  the third component the sequencer itself acts on.

**Duplicate `space` ids**: the fold is blind and must stay blind, so the derived
space registry (§2) resolves collisions **first-folded-wins**; the loser gets a lint
line and stays inert. Deleting the comp (`data:null`) or removing the anchor entity
**dissolves** the space: members get a `leave` boundary event with
`reason:"dissolved"`, and subsequent `say {space}` refuses like any unknown lane.

Nothing here needs a world-scope singleton (none exists in the fold —
server.ts:337-343); spaces are entity-anchored by design, which also gives them a
legible physical referent ("the open side and doorway are legible", acceptance #1).

---

## 2. Membership: server-owned, derived, per-(person, space) state machine

### 2.1 Where it lives

Membership is **derived presence-plane state, not log entries**. The pose stream is
already presence-plane and never persisted as world state (poses batch through
`World.dirty` into 66 ms frames, server.ts:2655-2661, 2831-2850); membership is a
pure function of that stream plus the folded space registry, so folding membership
transitions into the log would add an unbounded entry class that says nothing the
pose history doesn't already say — and would collide with FOLD_EVERY churn. "Visible
and queryable" (#67) is satisfied instead by: boundary **wire events** to the
affected parties (§2.4), an **occupancy query surface** open to everyone (§5), and
flight-recorder receipts (`world.debug`, the refusal convention at server.ts:2104).

Per world, the sequencer keeps:

```
spaces:      Map<spaceId, {anchor, cfg}>          // recomputed on comp fold
membership:  Map<clientId, Map<spaceId, FSM>>     // live connections only
counters:    per-space {chatTotal, lastSeq}       // maintained in fold state (§4.3)
```

### 2.2 The FSM

```
            pose inside enter boundary                enterMs elapsed
   OUT ───────────────────────────────▶ ENTERING ───────────────────▶ IN
    ▲                                      │                          │
    │             pose outside             │ pose outside             │ pose outside
    │             (any boundary)           │ enter boundary           │ EXIT boundary
    │                                      ▼                          ▼
    └◀────────────────────────────── (back to OUT)              LEAVING
    ▲                                                                 │
    │                 leaveMs elapsed                                 │
    └─────────────────────────────────────────────────────────────────┘
                     pose back inside exit boundary ──▶ IN (timer cancelled)
```

- **Hysteresis**: the *enter* test uses the authored region; the *stay* test uses the
  region inflated by `exitPad`. One step at a doorway oscillates inside the pad and
  never leaves IN.
- **Debounce**: ENTERING→IN requires `enterMs` continuously inside; IN→OUT requires
  `leaveMs` continuously outside the exit boundary. A doorway pause re-enters IN
  silently (no boundary event fired until a transition *completes*).
- **Members = {IN, LEAVING}.** LEAVING is still a member — this is what makes
  acceptance #6 fall out of the machine rather than needing a special case: a `say`
  authored mid-crossing binds to the lane because the author is still LEAVING.
- **Speaking is entering**: a `say {space}` received while the author is ENTERING
  (physically inside the enter boundary, waiting out the debounce) promotes
  ENTERING→IN immediately. Debounce exists to suppress *flap*; an explicit authored
  utterance is intent, not flap. This keeps the refusal path (§4.1) for genuine
  non-members only.

### 2.3 Evaluation

On the existing frame flush (FRAME_MS = 66, server.ts:2824): for each client whose
pose moved this frame × each registered space, one XZ `Math.hypot` against the
anchor — the exact shape of the two existing server-side reach checks. Timers
(`enterMs`/`leaveMs`) resolve on the same tick. With realistic counts (tens of
bodies, single-digit spaces) this is noise; if it ever isn't, the standard
spatial-hash escape hatch exists and changes nothing observable.

Clients that have never posed (see the chatbridge, §8) have no position and are
never members. Spectators are never members: they cannot pose (server.ts:2655
guards `c.spectator`), cannot author (server.ts:2091), and are absent from
`present[]` (server.ts:2065) — consistent with the existing doctrine that they
watch the world and read the public log rather than inhabit it.

### 2.4 Boundary events (wire, not log)

On a *completed* transition the server emits a new presence-plane message:

```jsonc
// to current members of the space (including the mover):
{ "type": "space", "space": "cafe", "id": "antra",
  "state": "enter" | "leave",           // + "reason": "dissolved" | "disconnect" on teardown
  "occupants": ["antra", "mica", "sill"] }
```

To the mover on `enter`, the same message carries the **backlog header** (§6):
`"backlog": { "count": 87, "fromSeq": 4900, "toSeq": 5012, "participants": [...] }` —
counters only, never bodies.

### 2.5 Ghosts, reconnects, takeover (acceptance #5)

- Membership is keyed on the **live `Client`**; `close()` (server.ts:1871-1892)
  tears down that client's FSMs and emits `leave {reason:"disconnect"}` to remaining
  members. The *remembered* pose (`rememberPose` → poses.json, server.ts:1065) is
  a resting place, not presence — it never confers membership.
- **Identity takeover** (server.ts:2018-2032, close 4002, deliberately no leave
  broadcast): the superseded session's FSMs die with it; the new session starts OUT
  and re-derives from its own live poses. If the restored pose is inside the café,
  the body re-enters through the ordinary ENTERING debounce — one clean enter, no
  ghost, and the backlog header covers what was missed.
- There is no path by which a disconnected, stopped, or absent body remains
  subscribed: membership has no persistence surface at all.

---

## 3. The lane on the log plane: one log, self-describing entries

`say` gains one optional argument: `say {text, space?: "cafe"}`.

- **No second sequencer, no second seq space.** The entry is an ordinary `LogEntry`
  (server.ts:137-143) in the world's single history; `args.space` makes it
  self-describing. Canonical sequence, durable record, fold, and `history` paging
  all come for free — and "durable history remains available under rights"
  (acceptance #7) is simply the existing public-log doctrine applied to entries that
  happen to carry a lane.
- **Lane binding happens at server receipt** of the verb, against the author's FSM
  state at that instant. Receipt order is already the canonical order (append is the
  seq authority, server.ts:1073-1085), so the binding is unambiguous even for a
  message racing a boundary crossing (acceptance #6, via LEAVING-is-member).

### Seq-gap note for reviewers (implementation checkpoint, not a design choice)

Selective delivery (§4) means non-members observe gaps in the live seq stream.
Nothing in the protocol promises contiguity — `history` pages by exclusive
`before`/`after` (server.ts:1033-1058) — but any client-side high-water logic must
tolerate gaps rather than treat gap-following entries as replay. The known trap is
the inverse (seed logs must start at seq 0 or echoes drop as replay); the
implementation PR must verify both `client/lib/net.js` and `WorldAgent.inboxSeen`
(mcpl/agent.ts:139) dedupe by *seen-set/monotonic-per-entry*, not by contiguity.

---

## 4. Delivery: membership-gated at the single choke point

### 4.1 Authoring gate

In the `say` arm of the verb handler (beside the spoken-protocol shape check,
server.ts:2308-2330):

- `space` present and author ∈ {IN, LEAVING, ENTERING-promote} → append + lane
  broadcast.
- `space` present, author not a member → `{type:"error"}` refusal naming the space
  and the reason ("you're not in the café — step inside to join its conversation"),
  plus a `world.debug("denied", ...)` receipt per the flight-recorder convention.
  Nothing is appended: a refused say is not history.
- `space` present but unknown/inert → same refusal shape ("no such conversation
  space").
- No `space` → global say, byte-for-byte today's path. **The lane is chosen only by
  explicit argument; nothing infers it from position.** A body standing in the café
  can still address the commons — locality is an affordance, not a trap.

Speaking in a lane stays rank 0 (`say`, server.ts:723). Restricting *who may speak*
in a space is not in this slice; the membership gate is spatial, not social.

### 4.2 One message, exactly one lane (acceptance #8)

`World.broadcast` (server.ts:1087-1090) grows its first and only filter: a `log`
message whose entry is `verb === "say" && args.space` goes **only to clients whose
FSM for that space is IN/LEAVING** (plus the author, who gets the authoritative echo
as today). Every other entry type broadcasts unchanged.

Double-delivery is structurally impossible rather than filtered-out: an entry has
either no `space` (global lane) or exactly one (that lane), decided at receipt.
There is no copy, no mirror, no re-broadcast path. The browser and the WorldAgent
are both just clients behind this filter, so "agents and browser humans use the same
server membership truth" (#67) is not a synchronization property — it's the absence
of a second implementation.

### 4.3 Fold and late joiners (the snapshot leak, decided)

`recentChat` records (server.ts:349-353) gain the `space` field. The join snapshot
therefore *contains* recent lane lines — deliberately: the fold is the durable
record's index, and locality is not privacy. But **presentation filters**: the
browser renders snapshot chat lines only for global + spaces the client is currently
a member of (it starts OUT everywhere, so effectively global-only at join), and the
agent's `stateToEntries` (mcpl/agent.ts:86-90) marks non-member lane lines as
headers, not inbox bodies. The full record stays one `history {space}` pull away.
Per-space counters (`chatTotal`, `lastSeq`) are maintained in the same fold arm to
back the occupancy/backlog surfaces (§5, §6) without scanning.

`trimRecentChat`'s fairness trim (server.ts:237-249) applies to the merged list
unchanged; per-space recency beyond the merged window is what `history {space}` is
for.

### 4.4 `history` grows a lane filter

`readHistory` (server.ts:1033-1058) filters by `verbs`/`before`/`after` today; it
gains `space: <id>` (and `space: null` for explicitly-global-only). This is the
bounded chosen-pull surface for everything below — non-member reading (under
ordinary record policy), returning-resident deep-read, and #55's "pull is chosen;
push is the hazard" doctrine.

---

## 5. What non-members perceive: headers, occupancy, knocks

- **`look()`** (mcpl/agent.ts:1274-1295) gains a line per registered space, for
  everyone: `conversation space "the café" [cafe] — 3 present (antra, mica, sill);
  87 messages, latest seq 5012`. Existence and occupancy are ambient facts about
  the world, like a lit hearth (acceptance #3). The browser inspector gets the
  equivalent row.
- **Bodies**: never pushed to non-members, on any plane. Read via `history {space}`
  under the world's ordinary record policy — an explicit, bounded, per-request act.
- **Mentions across the boundary** follow the authored `policy.mentions`:
  - `"knock"` (default): the mentioned non-member receives a **header-only** knock —
    `you were mentioned in the café [cafe] (seq 5013)` — tagged
    `chat:mention` + `eidoverse:local-chat`, `mentioned: true`, no body. The
    never-gated-knock doctrine (denoise.ts:28-29, #55 "addressed speech is
    preserved") is honored while the *body* still respects locality; the body is one
    chosen `history` pull away.
  - `"deliver"`: the full mention body crosses (today's mention semantics, plus lane
    provenance in metadata). For spaces that want reachability over locality.
  - `"local"`: nothing leaves; the mention renders inside the lane only. For spaces
    whose point is that the outside stays quiet.

---

## 6. Catchup and backlog: headers, tagged, never live (acceptance #7)

Three distinct moments, one rule — **bodies move only by chosen pull; catchup is
tagged and can never be mistaken for live speech** (the fabricated-approach /
`backlog ≠ live` boundary from the #55 case law):

1. **Crossing into a space** (live): the `enter` boundary event carries the backlog
   header (count, seq range, participants — §2.4). The browser MAY then render
   recent lane lines *visibly marked historical* (a human reading scrollback is UX,
   not context injection); the WorldAgent delivers the header only.
2. **Returning resident** (reconnect/agent prelude): the existing catchup path
   (net-server.ts:490-511) extends with one header line per space that accrued
   traffic — `café: 87 messages while you were away (seq 4900–5012)` — tagged
   `tags(CHAT.ambient, EIDO.catchup)` exactly like the current missed-say header.
   Lane mentions in the missed window follow `policy.mentions`: knock-policy spaces
   contribute header knocks to the replay (tagged catchup + mention), deliver-policy
   spaces replay bodies within the existing ≤10 cap.
3. **Deep read** (any time): `history {space, before/after}` — the chosen-pull
   surface, bounded, no wake semantics, no live framing.

---

## 7. Agent-facing wire and the #55/#77 composition

### 7.1 Producer contract (this repo's half)

- **Channel**: local says ride the existing single `world:<world>` channel
  (net-server.ts:233). We do **not** mint a channel per space in this slice — see
  §7.3 for the honest trade.
- **Tags** (declaration.ts additions, with `suggestedTreatment` rows per §16.5 —
  neither may suggest a wake):
  - `eidoverse:local-chat` — lane-scoped speech; ambient default treatment
    `debounce 180s` (same row as ambient chat).
  - `eidoverse:space-boundary` — enter/leave events; treatment `mute` (presence
    class).
  - Both are **observed-emitted from day one** with test coverage, honoring the
    `tag-declared ≠ tag-emitted` boundary (the eidoverse:catchup lesson).
- **spaceId is metadata, never a tag** (#67's own requirement; antra's #55 review
  point 2 on ontology hygiene): `deliver()` already carries a metadata bag
  (net-server.ts:335-347) — lane says add `metadata: {space: "cafe"}`; boundary
  events add `{space, state, occupants}`. Dynamic authored ids stay out of the tag
  ontology; tags name the *class*, metadata names the *instance*.
- **Tags describe, never authorize** (declaration.ts:7-21) holds: locality is
  enforced by membership-gated broadcast at the sequencer (§4.2), upstream of the
  door. The door never makes a delivery decision from a tag — the lane-scoped event
  simply never reaches a non-member session's `WorldAgent`. This is the same
  producer-side shape as the radius-gated emitter percept (mcpl/agent.ts:754-770),
  scaled from a dial to a contract.
- **Live vs catchup**: live lane speech is tagged `chat:ambient|chat:mention` +
  `eidoverse:local-chat`; anything replayed carries `eidoverse:catchup` in addition.
  The pair is disjoint by construction.

### 7.2 Consumer composition (hand-off to the AF intake doc, not designed here)

Per the settled contract (Mica + Cairn, 2026-08-08): AF ingestion stores losslessly
with metadata; intake is per-consumer-slot selection at compile; the wake gate reads
the surviving header independently; digest belongs to Tuneout (af#77) and its
refusal fallback is headers, never silent raw. This design adds **no digest, no
summarizer, no new consumer dial** — it guarantees the producer-side facts those
layers need:

- a stable class tag (`eidoverse:local-chat`) for coarse intake rules;
- `space` in the metadata plane for fine rules and for `message_meta` /
  `intake_explain` receipts;
- headers that exist *independently of bodies* (occupancy line, backlog header,
  knock) so `headers`-dial consumers and refusal fallbacks have something honest to
  receive;
- catchup marking so no intake layer can mistake backlog for live.

**One requirement handed upward**: intake-rule predicates must be able to match
**structured metadata keys** (`space == "cafe"`), not only tag classes — antra's
#55 comment already lists "world/proximity classes" among rule predicates; this is
the concrete instance. Otherwise per-space policy ("café → digest, workshop →
verbatim") is inexpressible and the metadata plane is write-only.

### 7.3 The channel-granularity trade (flagged for review, recommendation given)

Tuneout (af#77) is per-*channel*; with lanes as metadata on `world:<world>`, a
resident can tune out the world but not just the café. The alternative — dynamic
sub-channels (`world:commons#cafe`) — buys per-lane tuneout and per-lane
`channel_missed` for free, but breaks the door's deep one-channel-per-session
assumptions (`channelOpen` boolean, `handlePublish` id-equality, net-server.ts:190,
700-708), turns authored dynamic spaces into channel-registry churn, and pushes
spaceId back toward being an ontology. **Recommendation: metadata on the single
channel for this slice**; if per-lane tuneout becomes a real resident need, the
clean escalation is intake/tuneout growing metadata-scoped selection (§7.2's
requirement, which is needed anyway), not the world minting channels per room.

### 7.4 Required repair discovered during grounding (blocks acceptance #3)

The agent-side replay path **does not replay components at all**:
`stateToEntries` in mcpl/agent.ts:55-92 emits terrain/grass/sky/assets/spawn/
light/mounts/recentChat only, while the browser path replays comps
(client/lib/world.js:631-634). Any agent joining after a `conversation-space` comp
folds into the snapshot would not know the space exists — `look()` couldn't list it,
acceptance #3 fails. This is the same class as the folded-mounts bug (#61). The
implementation plan must include comp replay in the agent's `stateToEntries` (at
minimum for server-meaningful comps), kept in step with the browser per the standing
comment (mcpl/agent.ts:53-54).

---

## 8. Leak surfaces: bridge, behaviors, export policy

- **Chatbridge** (tools/chatbridge/index.ts): embodied but never poses → placeless →
  never a member → **hears no lane, by default, with no new code**. Mirroring a
  space to Discord is an authored act twice over: the space must set
  `policy.export: true` *and* the bridge instance must be explicitly configured with
  a lane binding (server honors the subscription only when both hold). An exported
  lane is an authored acoustic leak — exactly #67's "open-wall behavior is authored,
  not inferred". Default is deny; the failure mode of forgetting configuration is
  silence, not leakage. (A lane-scoped bridge also needs lane attribution in its
  relay text and its own rate budget — noted for that PR, not this design.)
- **Behaviors**: `bhv.onEntry` fans every entry to every instance
  (server.ts:2335, behaviors.ts:391-395), so scripts anywhere would hear lane says —
  scripted eavesdropping that bypasses membership. Slice-1 rule: lane-scoped says
  are **not** fanned to behaviors (cheapest honest cut). If a space later wants
  reactive furniture, the principled extension is behavior hosts whose *own entity*
  is the space anchor. Flagged as an explicit review question (§10).
- **Voice** stays proximity-rolled client-side (voice.js:26) and untouched; the
  spatial-audio marriage is #67's own "later work".

---

## 9. Client UI (browser)

Extends the existing tab-filter affordance rather than inventing one — the chat pane
already makes *the active tab the send destination* (a plain Enter in a `w:<name>`
tab whispers, chat.js:710):

- New filter value `lane:<spaceId>` beside `all | mentions | system | w:<name>`
  (chat.js:28). A lane tab appears on membership `enter` (badge-quiet until
  traffic), greys out on `leave` (readable scrollback, dead composer), and closes
  like a whisper tab.
- **Explicit destination, visibly**: in a lane tab the composer placeholder reads
  `say in the café…` (the `setFilter` placeholder pattern, chat.js:773-781) and
  Enter sends `say {text, space}`. In `all`, Enter is global — standing in the café
  never silently redirects a send.
- Lane lines render with a lane chip; snapshot/backlog lines render marked
  historical (§6.1). Membership transitions render as system lines in the lane tab.
- Unread accounting rides the existing centralized `account()`/`paintUnread()`
  (chat.js:246-255, 361-369) — one new key shape, no new machinery.
- The 3-D scene already fades bubbles by distance (avatar.js:698-704); lane speech
  simply isn't delivered beyond the room, so the render plane and the delivery plane
  finally agree with voice.js's stated doctrine ("voice is proximity-scoped like
  chat", voice.js:15).

---

## 10. Acceptance mapping and review questions

### #67's café vectors → mechanism

1. Authorable legible region → §1 (entity-anchored comp; radius slice 1).
2. Human + agent converse in lane → §4 (both are clients behind one filter); §9.
3. Nest resident: no body, existence/occupancy queryable → §5; **requires §7.4
   repair**.
4. Threshold crossing delivers/undelivers once → §2.2 (hysteresis + debounce;
   events only on completed transitions).
5. Disconnect/reconnect, no ghosts → §2.5 (live-client-keyed FSMs; takeover
   re-derives; remembered pose confers nothing).
6. Message just before crossing keeps lane + author → §3 (receipt-time binding) +
   §2.2 (LEAVING is a member).
7. Durable history under rights, never replayed as live → §3, §4.4, §6 (catchup
   tagging disjoint from live).
8. No double delivery global/local → §4.2 (structural: one entry, one lane).

### Open questions for architecture review

1. **Seq-gap tolerance** (§3): audit both clients' replay/dedupe logic before any
   selective broadcast lands — this is the one place the design touches a live
   invariant.
2. **Behaviors and lanes** (§8): is "lane says skip behaviors" acceptable for slice
   1, or does the café need reactive furniture on day one?
3. **Spectator live view**: spectators are non-members (§2.3) and read via history.
   Is there a moderation/ops case for a spectator live-tap, and if so is it a right
   (grant) rather than a default?
4. **Boundary-event durability**: derived-not-folded (§2.1) trades replayable
   membership history for log hygiene; occupancy is reconstructible from pose
   frames only ephemerally. If case law later wants "who was present at seq N"
   answerable from the durable record, that's a fold-state snapshot extension —
   cheap later, noted now.
5. **`policy.mentions` default**: `"knock"` is proposed as the default (preserves
   reachability without moving bodies). If the field's absence should instead mean
   `"deliver"` until residents opt in, that's a one-line change with consent
   implications worth an explicit call.
6. **Intake metadata predicates** (§7.2): confirmation from the AF intake doc that
   rules can match `space` metadata; otherwise per-space consumer policy has no
   expression surface.

### Non-goals (this slice)

Nested spaces and precedence (overlapping spaces: a body may be a member of several;
the explicit destination argument disambiguates sends); private/sealed rooms and any
rights change; spatial audio; whisper mechanics; seed-generated regions; any digest
or summarization (Tuneout owns it); speaker restrictions within a lane; polygon
regions.

---

*— eido-local-chat-design, 2026-08-08*
