# Local conversation spaces — protocol & state-machine proposal (issue #67, design only)

*Design pass requested by Mica 2026-08-08 (#eidoverse_dev), authored by the bounded
worker `eido-local-chat-design`. No code. Grounded against current main (`16e6b5b`);
every mechanism claim below carries a file:line anchor from that tree. Composes with
the #55 intake contract as settled by Mica + Cairn (2026-08-08) and defers all
summarization to Tuneout (af#77). Locality is not privacy: a café lane is locally
audible while the durable record stays under the world's ordinary record policy
("the log is public" — spectators may read `history`, server.ts:2365); sealed rooms
are explicitly later work.*

*Rev 2, same day — addresses the independent architecture review of `732abbf`
(both blockers verified against the tree before revising): membership teardown
relocated to all three client-removal sites and re-keyed on the live `Client`
(review B1); the join payload named as the second push path and filtered by the
same membership predicate as live broadcast, with the `skipChatFromSeq` cursor
consistency requirement (review B2); "single choke point / structurally
impossible" overclaims removed; the folded-component invisibility finding split
out as current-main bug **#71** (canonical tracker; #72 was this worker's
duplicate filing, superseded); bounded/indexed `history {space}` requirement
added; §10 updated with the review's audit results.*

*Rev 3, same day — final pass per the second review of `d5cbba5`: the `caption`
stream added to the §4.2 inventory as the seventh push path (it carries verbatim
speech world-wide before the durable say; it now takes an explicit `space?` bound
by the same predicate), `typing` added as an explicit no-body row, and the two
rev-2 open questions resolved per the reviewer's recommendations (honest takeover
leave with no wire compaction; bounded scan for slice 1, any future index derived
and rebuildable, never authoritative).*

---

## 0. Shape of the proposal in one paragraph

A builder authors a `conversation-space` **component** on an anchor entity (the café
counter). The **sequencer** derives per-person membership from the same authoritative
`lastPose` it already consults for `punt` reach (server.ts:2182) and lease-take
(server.ts:2516), through a small hysteresis state machine evaluated on the existing
66 ms frame flush. A `say` may carry `space: <id>`; the server binds the lane **at
verb receipt** against current membership and refuses non-members. The entry lands in
the **single world log** (one seq space, self-describing via `args.space`). The
sequencer pushes bodies to clients on exactly two paths — live `World.broadcast`
(server.ts:1087) and the join payload (server.ts:1060) — and **one membership
predicate filters both** (§4). Everything any consumer learns about membership comes
from the server; agents and humans share the same truth because the WorldAgent is
just another client behind the same two filtered paths. Non-members get headers
(existence, occupancy, counters) and bounded chosen pull, never pushed bodies.
Catchup is headers, tagged, never replayed as live.

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

## 2. Membership: server-owned, derived, per-(session, space) state machine

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
membership:  Map<Client, Map<spaceId, FSM>>       // keyed on the LIVE Client object
counters:    per-space {chatTotal, lastSeq}       // maintained in fold state (§4.3)
```

**Keying is on the live `Client` object (the session), never the identity string.**
The identity survives session takeover; the FSM must not. With object keying, a
successor session starts with an empty FSM map *by construction* — there is nothing
addressed by its identity to inherit — and every teardown question reduces to "when
does this `Client` object leave the maps," which §2.5 answers site by site. (Rev 2:
the rev-1 sketch keyed on `clientId`, which would have handed the predecessor's IN
state to a reconnecting session that had never posed — a locality bypass through the
exact mechanism claimed to prevent it. Review B1.)

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

   (any state) ── client removed from world (§2.5) ──▶ OUT, leave event w/ reason
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
  "state": "enter" | "leave",
  // on leave, reason is always present:
  //   "walked" | "disconnect" | "takeover" | "expelled" | "dissolved"
  "occupants": ["antra", "mica", "sill"] }
```

To the mover on `enter`, the same message carries the **backlog header** (§6):
`"backlog": { "count": 87, "fromSeq": 4900, "toSeq": 5012, "participants": [...] }` —
counters only, never bodies.

### 2.5 Teardown: the three removal sites, ghosts, takeover (acceptance #5)

The world removes a `Client` on **three distinct paths**, and only one of them runs
`close()`'s world bookkeeping. `expel()` (server.ts:1099-1109) and the identity-
takeover loop (server.ts:2022-2029) both delete the client from the global ws→Client
map *before* closing the socket, so `close()`'s `clients.get(ws)` lookup misses and
it returns at server.ts:1873 — the code's own comment says so: *"close(ws) will not
fire it — the client is already unmapped"* (server.ts:1095-1098). Rev 1 hung
teardown on `close()` alone, which is exactly wrong on the two paths acceptance #5
is about (moderation kick, reconnect). (Review B1.)

**Design**: one teardown routine — transition every FSM of the removed `Client` to
OUT and emit `leave {reason}` to each affected space's remaining members — invoked
at all three sites:

1. **normal socket close** (server.ts:1885-1889 block) — `reason:"disconnect"`;
2. **`expel()`** — before the unmap, alongside `rememberPose`; `reason:"expelled"`.
   `expel`'s doc-comment enumerates "all four bookkeeping steps or a ghost is left
   behind" — membership teardown is the **fifth step of that checklist**, at this
   site and the next, precisely because `close()` cannot cover them;
3. **identity takeover** (server.ts:2022-2029) — teardown of the *superseded*
   session's FSMs before it is unmapped; `reason:"takeover"`.

**Takeover boundary semantics — an explicit divergence from the world plane.** The
world deliberately suppresses the leave broadcast on takeover ("the identity isn't
leaving, it's re-arriving", server.ts:2021). Lanes do **not** copy that: lane
occupancy is *delivery authority* — whoever the occupants list names is who receives
bodies — so it must never go silently stale. The `leave {reason:"takeover"}` fires
to members; the successor session starts OUT everywhere (§2.1) and, if its restored
pose is inside the café, re-enters through the ordinary ENTERING debounce — one
clean enter, backlog header covering the gap. UIs may render a takeover-leave
followed by a prompt re-enter compactly; the wire stays honest. **(Resolved in
second review: divergence endorsed as the conservative choice — occupancy is a
delivery-authority list that non-members can query, and a stale entry names
someone as receiving bodies who cannot. Wire-level compaction rejected: buffering
the leave for `enterMs` would delay honest occupancy for every member to tidy one
edge case. Emit immediately; coalescing is a render-layer concern needing no wire
support.)**

**Ghost-freedom is now a property of the removal sites, not a slogan**: membership
has no persistence surface, is keyed on the live object, and every path that removes
the object runs the teardown. The *remembered* pose (`rememberPose` → poses.json,
server.ts:1065) is a resting place, not presence — it never confers membership; a
restored pose participates only once live pose frames flow through the FSM.

**Named negative-test vectors for the implementation PR** (each must fail if
teardown regresses to close()-only or keying regresses to identity):

- **takeover-while-IN**: predecessor IN the café; same identity reconnects from
  elsewhere in the world → successor is not a member, receives no lane bodies,
  occupants drop the body at takeover; members saw `leave {takeover}`.
- **expel-while-IN**: expelled body leaves occupants, members see
  `leave {expelled}`, no lane delivery to the expelled session afterward.
- **reconnect-with-remembered-pose-inside-region**: restored pose inside the café →
  no membership and no lane delivery until the first live pose message plus
  `enterMs`; then one clean enter.

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

### Seq-gap audit (resolved in review; residual test named)

Selective delivery means non-members observe gaps in the live seq stream. The
review audited every dedupe path: all are **monotonic high-water marks with strict
`>`** — net.js:436, 580, 593; agent.ts:694-695 — no contiguity assumption anywhere,
so gap-following entries are not mistaken for replay. Additionally, `history`
replies resolve a promise and never touch `applyEntry`/`inboxSeen`
(agent.ts:480-483), which is what makes `history {space}` viable as the body path —
back-pulls survive the high-water marks. **Residual for the implementation PR**:
`skipInboxThrough` (agent.ts:1204-1206) walks a prefix and breaks at the first
`seq > cursor`; correct over a gappy inbox, but gaps become *normal* under this
design, so it needs an explicit test.

---

## 4. Delivery: one membership predicate over both push paths

### 4.1 Authoring gate

In the `say` arm of the verb handler (beside the spoken-protocol shape check,
server.ts:2308-2330):

- `space` present and author ∈ {IN, LEAVING, ENTERING-promote} → append + lane
  delivery.
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

### 4.2 The delivery-path inventory (one entry, one lane, one predicate)

An entry has either no `space` (global) or exactly one, decided at receipt — there
is no copy, no mirror, no re-broadcast path, which is what makes acceptance #8 a
non-event *provided every path that pushes bodies applies the membership predicate*.
Rev 1 claimed `World.broadcast` was "the single choke point"; the review found the
join payload is a second push path that bypasses it entirely (B2). The honest form
is an inventory. **Contract sentence for PROTOCOL.md: any path that delivers say
bodies to a client must state its lane predicate; a new delivery path without one
is a leak by default.**

| Path | What it pushes | Lane predicate (this design) |
|---|---|---|
| live `World.broadcast` (server.ts:1087-1090) | every log entry | lane says → FSM ∈ {IN, LEAVING} for that space; author always gets the authoritative echo; all other entries unchanged |
| **join payload** `joinPayload()` (server.ts:1060-1063): `state.recentChat` + `tail: this.entries` | folded chat + the whole post-fold tail | **same predicate, per-recipient, both halves in one pass** (§4.3) |
| `history` (server.ts:1033-1058) | bodies on request | none — chosen pull under ordinary record policy, bounded + explicit (§4.4); this is the *designed* body path for non-members |
| catchup prelude (net-server.ts:490-511) | headers + capped mention replay | headers per lane; mention bodies per `policy.mentions` (§6) |
| `pendingWhispers` (server.ts:1240, 2076-2083) | whispers | orthogonal — whispers are 1:1, never lane-scoped |
| behaviors `bhv.onEntry` (server.ts:2335) | entries to scripts | lane says **not fanned** in slice 1 (§8) |
| **`caption`** (server.ts:2603-2616) | up to 500 chars of **verbatim in-flight speech**, presence-plane, world-wide, preceding the durable say | `caption {text, utt, space?}` — explicit lane argument, same predicate as its say (below) |
| `typing` (server.ts:2640) | no body — presence signal only | none needed: carries no speech, and §5 already grants occupancy-class facts to everyone. Listed because the contract sentence makes an unlisted path a leak by default |

**Captions (found by the second review, applying this table's own contract):**
today's `caption` broadcast is unconditional, so a resident speaking by voice in
the café would stream their sentences to every browser in the world and only the
trailing `say {space}` would be lane-filtered — the bodies cross first, and the
non-member client that rendered them never receives the say that would have
attributed them. Design: `caption` grows the same optional explicit `space`
argument as `say`, filtered by the same membership predicate; **the lane is never
inferred from position** (§4.1's doctrine — a café occupant addressing the commons
must not have their speech confined by where they stand). The browser already
holds the destination (the active tab, §9) and stamps it on both the caption
stream and the final say. A `caption {space}` from a non-member is dropped with a
one-time error to the author. Captions remain presence-plane ephemera: if a
speaker switches destination mid-utterance, the trailing `say`'s receipt-time
binding (§3) is authoritative for the record; the caption lane is best-effort
display routing. Scope note: `caption` has no handler in mcpl/agent.ts — agents
never receive captions — so this is a human-facing leak surface only and the #55
intake plane is unaffected.

### 4.3 The join payload: per-recipient, both halves, one pass (review B2)

`joinPayload()` today returns `{state, tail: this.entries, throughSeq}` — the
entire post-fold in-memory tail, up to FOLD_EVERY entries, identically to every
joiner; both clients apply it wholesale (net.js:554-590, agent.ts:379-383), and the
agent's say arm pushes tail bodies straight into its inbox (agent.ts:688-696).
Unfiltered, every joiner — member or not — would receive every lane body in the
tail, with no `space` metadata attached at the door: the locality promise and the
#55 intake plane would fail together, on the join path. (Review B2, verified.)

**Design**: `joinPayload(recipient)` becomes per-recipient and applies the same
membership predicate as live broadcast, to **both halves in the same serve pass**:

- **tail**: lane-say entries the recipient is not a member of are **omitted**. A
  joiner starts OUT everywhere (§2.1), so at join this means all lane says. The
  resulting seq gaps are safe (§3 audit). All non-say entries pass untouched — the
  tail's state-bearing replay (comps, spawns, mounts) is not filtered.
- **`state.recentChat`**: records carry `space` in fold state (server-side); the
  serve pass filters by the same predicate. **Filtering is serialization-time,
  never fold-time** — the durable fold on disk keeps every line; nothing is
  discarded from the record (the #55 invariant).
- **`skipChatFromSeq` consistency**: both clients compute their snapshot-chat skip
  cursor as min-seq over the *received* tail (net.js:550-553, agent.ts:379-381) to
  suppress folded chat "the tail will bring". Because both halves are filtered by
  one predicate in one pass, the cursor stays consistent with the chat actually
  present. **Filtering one half only — or filtering them in separate passes — makes
  the cursor a check that passes against its own starting state** (the review named
  this trap precisely); the implementation test must assert cursor correctness
  against a tail containing interleaved global and lane says.
- **per-space counters** `{chatTotal, lastSeq}` ride the state for the occupancy
  line and backlog headers (§5, §6) — headers exist independently of bodies.

Net effect: no unshaped lane body can enter any consumer via join; live lane
deliveries carry `space` metadata (§7.1); the only body path for non-members is
chosen pull. "Bodies: never pushed to non-members" (§5) is now backed by the
inventory in §4.2 rather than asserted.

### 4.4 `history` grows a lane filter — with a scan bound

`readHistory` (server.ts:1033-1058) filters by `verbs`/`before`/`after` today; it
gains `space: <id>` (and `space: null` for explicitly-global-only). This is the
bounded chosen-pull surface for everything below — non-member reading (under
ordinary record policy), returning-resident deep-read, and #55's "pull is chosen;
push is the hazard" doctrine.

**Bounded-scan requirement (from review; resolved in second review)**: today's
implementation reverse-scans and, failing to fill `limit`, falls back to a
`readFileSync` of the **entire log**. A `space` filter is far more selective than
the existing `verbs` filter — a quiet lane would turn every pull into a
whole-world-log read, on exactly the path §5/§6 route non-member reads, catchup,
and deep-read onto.

**Slice 1 ships the bounded scan**: `history {space}` may return fewer than
`limit`, carrying a `scannedThrough` cursor and `hasMore`, and **never** falls
back to an unbounded whole-file read. A bounded scan cannot lie — it can only
return less and say so. A per-space fold-time index is deliberately deferred: it
is new persistent derived state that must survive folds/restarts and stay
consistent with the log — the class the codebase already treats with suspicion
(server.ts:152: *"this is a DERIVED CACHE, never a source of truth"*), and an
index that drifts becomes a second truth that quietly under-reports a room's
history. If `history {space}` proves demonstrably hot, the index may be added
later **as a derived cache rebuildable from the log, never authoritative**.

---

## 5. What non-members perceive: headers, occupancy, knocks

- **`look()`** (mcpl/agent.ts:1274-1295) gains a line per registered space, for
  everyone: `conversation space "the café" [cafe] — 3 present (antra, mica, sill);
  87 messages, latest seq 5012`. Existence and occupancy are ambient facts about
  the world, like a lit hearth (acceptance #3). The browser inspector gets the
  equivalent row.
- **Bodies**: never pushed to non-members — backed by the delivery-path inventory
  (§4.2), not asserted. Read via `history {space}` under the world's ordinary
  record policy — an explicit, bounded, per-request act.
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
   recent lane lines *visibly marked historical* via a `history {space}` pull (a
   human reading scrollback is UX, not context injection); the WorldAgent delivers
   the header only.
2. **Returning resident** (reconnect/agent prelude): the existing catchup path
   (net-server.ts:490-511) extends with one header line per space that accrued
   traffic — `café: 87 messages while you were away (seq 4900–5012)` — tagged
   `tags(CHAT.ambient, EIDO.catchup)` exactly like the current missed-say header.
   Lane mentions in the missed window follow `policy.mentions`: knock-policy spaces
   contribute header knocks to the replay (tagged catchup + mention), deliver-policy
   spaces replay bodies within the existing ≤10 cap.
3. **Deep read** (any time): `history {space, before/after}` — the chosen-pull
   surface, bounded (§4.4), no wake semantics, no live framing.

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
  events add `{space, state, occupants}`. The `WorldAgent` say event object grows a
  `space` field so the door can attach that metadata. Dynamic authored ids stay out
  of the tag ontology; tags name the *class*, metadata names the *instance*.
- **Tags describe, never authorize** (declaration.ts:7-21) holds: locality is
  enforced by the membership predicate at the sequencer's two push paths (§4),
  upstream of the door. The door never makes a delivery decision from a tag — a
  lane-scoped event simply never reaches a non-member session's `WorldAgent`. This
  is the same producer-side shape as the radius-gated emitter percept
  (mcpl/agent.ts:754-770), scaled from a dial to a contract.
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
  `intake_explain` receipts — on **every** lane body a consumer can receive, since
  the join path no longer delivers unshaped bodies (§4.3);
- headers that exist *independently of bodies* (occupancy line, backlog header,
  knock) so `headers`-dial consumers and refusal fallbacks have something honest to
  receive;
- catchup marking so no intake layer can mistake backlog for live.

**One requirement handed upward** (endorsed by the review as a hard dependency):
intake-rule predicates must be able to match **structured metadata keys**
(`space == "cafe"`), not only tag classes — antra's #55 comment already lists
"world/proximity classes" among rule predicates; this is the concrete instance.
Otherwise per-space policy ("café → digest, workshop → verbatim") is inexpressible
and the metadata plane is write-only.

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

### 7.4 Dependency: current-main bug #71 (blocks acceptance #3)

The agent-side replay path replays **no components at all** (`stateToEntries`,
mcpl/agent.ts:55-92) while the browser path does (client/lib/world.js:631-634) —
found while grounding rev 1, independently confirmed by the review, and **broader
than #67**: it is live on main today for `lock` (server-enforced, so late-joining
agents get refusals they cannot explain), `sockets`, `reactions`, `motion`,
`particles`. Tracked as its own bug: **anima-research/eidoverse-worlds#71**
("Agent late join: folded snapshots omit entity components" — which also pins
no-false-live-events and no-reaction-replay on the fix; third instance of the #61
folded-state replay-drift class; #72 was a duplicate filing by this worker and is
superseded by #71). #67's acceptance vector 3 depends on #71 being fixed; this
design carries it as an external dependency, not as its own prerequisite work
item.

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
  are **not** fanned to behaviors (cheapest honest cut; the review concurs). If a
  space later wants reactive furniture, the principled extension is behavior hosts
  whose *own entity* is the space anchor.
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
- Lane lines render with a lane chip; backlog lines pulled via `history {space}`
  render marked historical (§6.1). Membership transitions render as system lines in
  the lane tab.
- Unread accounting rides the existing centralized `account()`/`paintUnread()`
  (chat.js:246-255, 361-369) — one new key shape, no new machinery.
- The 3-D scene already fades bubbles by distance (avatar.js:698-704); lane speech
  simply isn't delivered beyond the room, so the render plane and the delivery plane
  agree with voice.js's stated doctrine ("voice is proximity-scoped like chat",
  voice.js:15) — **provided the caption stream carries the lane too** (§4.2): the
  active tab stamps `space` on captions and the final say alike, or live bubbles
  would leak what the say correctly withholds.

---

## 10. Acceptance mapping and review state

### #67's café vectors → mechanism

1. Authorable legible region → §1 (entity-anchored comp; radius slice 1).
2. Human + agent converse in lane → §4 (both are clients behind the same two
   filtered paths); §9.
3. Nest resident: no body, existence/occupancy queryable → §5; **depends on bug
   #71** (§7.4).
4. Threshold crossing delivers/undelivers once → §2.2 (hysteresis + debounce;
   events only on completed transitions).
5. Disconnect/reconnect, no ghosts → §2.5 (teardown at all three removal sites;
   live-`Client` keying; three named negative-test vectors).
6. Message just before crossing keeps lane + author → §3 (receipt-time binding) +
   §2.2 (LEAVING is a member).
7. Durable history under rights, never replayed as live → §3, §4.4, §6 (catchup
   tagging disjoint from live).
8. No double delivery global/local → §4.2 (one entry, one lane; one membership
   predicate over both push paths, with the inventory as the contract).

### Review state (rev 1 questions, resolved per the independent review)

1. **Seq-gap tolerance — resolved.** All dedupe paths are monotonic high-water
   marks with strict `>`; `history` replies bypass `applyEntry`/`inboxSeen`
   entirely (which is what makes pull-as-body-path work). Residual: an explicit
   test for `skipInboxThrough` over a gappy inbox (§3).
2. **Behaviors skip lanes** — agreed for slice 1 (§8).
3. **Spectator live-tap** — agreed: non-member; if ops ever needs a tap, it is a
   grant, never a default.
4. **Boundary-event durability** — agreed: derived-not-folded stands; a fold-state
   occupancy snapshot is the cheap later extension if case law wants "who was
   present at seq N" durably answerable.
5. **`policy.mentions` default `knock`** — endorsed (deliver-by-default would make
   every lane leak on mention).
6. **Intake metadata predicates** — confirmed as a genuine external dependency for
   the AF intake doc (§7.2); Mica to carry.

### Formerly-open questions (resolved in second review, rev 3)

1. **Takeover boundary-event semantics** (§2.5): **resolved — honest
   `leave {takeover}` emitted immediately; no wire-level compaction.** The world
   plane's takeover silence protects identity continuity; lane occupancy is a
   delivery-authority list queryable by non-members, so a stale entry makes the
   occupancy surface lie to everyone who reads it. UIs may coalesce the
   leave/re-enter pair at render; the wire needs no support for that.
2. **History indexing** (§4.4): **resolved — slice 1 ships the bounded scan**
   (`scannedThrough` + `hasMore`, no unbounded fallback); any future per-space
   index is a derived cache rebuildable from the log, never authoritative.

### Second-review addition (rev 3)

- **`caption` is the seventh push path** and is now in the §4.2 inventory with a
  chosen predicate: explicit `caption {space?}`, same membership predicate as its
  say, lane never inferred from position; non-member lane captions dropped with a
  one-time error; the trailing say's receipt-time binding stays authoritative for
  the record. `typing` is listed as an explicit no-body row. Both were found by
  applying the inventory's own contract sentence — which is what it is for.

### Non-goals (this slice)

Nested spaces and precedence (overlapping spaces: a body may be a member of several;
the explicit destination argument disambiguates sends); private/sealed rooms and any
rights change; spatial audio; whisper mechanics; seed-generated regions; any digest
or summarization (Tuneout owns it); speaker restrictions within a lane; polygon
regions.

---

*— eido-local-chat-design, 2026-08-08 (rev 2, same day)*
