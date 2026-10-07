# Eidoverse Worlds — Scaling, Snapshot, and Performance Plan

Status: proposed (2026-07); predates protocol v4  
Date: 2026-07-25  

*Read this as the July plan it was. Protocol v4 (spec/PROTOCOL.md) has since
settled some of it: the log is door requests (acts) and their results
(state entries of `create` / `set` / `delete`), a joiner adopts a cut of the
fold instead of replaying, and a checkpoint is a view whose digest the log
records. The planes, the performance targets and the storage and loading
work below are unchanged by that.*  
Rollback checkpoint: `a99adaa` (`checkpoint current eidoverse world prototype`)

Implementation is paused pending review of this plan. The checkpoint working
tree was clean before this document was added.

## 1. Production target

The initial supported configuration is:

- Up to 200 connected clients.
- A maximum of 24 embodied performers.
- Remaining clients are high-fidelity spectators.
- Every spectator receives complete performer data; no proximity filtering is
  assumed.
- Spectators receive chat, show state, captions, cameras, and current world
  state without loading a personal avatar.
- Extremely long world logs must not affect client join time or server startup
  time beyond a fixed, bounded recovery window.

The important performance invariants are:

- Client bootstrap cost depends on current world size, not historical log
  length.
- Server startup cost depends on snapshot size plus one bounded log segment.
- Event lookup by sequence has O(1) addressing.
- A query returning `k` records is O(k) after the initial lookup; returning the
  records cannot literally be O(1).
- Arbitrary filtered searches use secondary indexes and will generally be
  O(log n + k), but never scan the entire log.

## 2. Separate the four data planes

The current protocol mixes workloads with different consistency and
performance requirements. They should become four distinct streams.

### 2.1 World state

Durable authored state:

- Entities and their current transforms.
- Terrain, sky, grass, lighting, and environment.
- Published assets and scripts.
- Ownership and permissions.
- Stage configuration and persistent props.

This is represented by the semantic snapshot.

### 2.2 Event history

The complete append-only record:

- Spawns, moves, removals, and environment changes.
- Chat, if permanent chat retention is desired.
- Administrative changes and performance cues.
- Historical operations needed for audit, forks, and replay.

Clients do not replay this history during normal joining.

### 2.3 Performance presence

Lossy, high-frequency state:

- Performer root transforms.
- Head and hand targets.
- Gaze, expressions, visemes, and gesture state.
- Current animation and synchronized start time.

This is batched into stage frames and is not part of ordinary world snapshots.

### 2.4 Chat and audience presence

- Connected spectators and performers.
- Join, leave, and activity state.
- Recent chat bootstrap.
- Paginated historical chat.
- Moderation and slow-mode state.

Chat is not allowed to invalidate or enlarge the world snapshot on every
message.

## 3. Semantic snapshot

The snapshot is current materialized state, not a bundle of events.

Proposed shape:

```ts
type AuthoredValue = {
  args: Record<string, unknown>;
  actor: string;
  seq: number;
  ts: number;
};

type WorldSnapshot = {
  schemaVersion: 1;
  world: string;
  snapshotId: string;
  stateSeq: number;
  createdAt: number;

  environment: {
    terrain?: AuthoredValue;
    grass?: AuthoredValue;
    sky?: AuthoredValue;
  };

  entities: Array<{
    id: string;
    lib: string;
    pos: [number, number, number];
    yaw: number;
    owner?: string;
    actor: string;
    updatedSeq: number;
  }>;

  assets: Array<{
    name: string;
    path: string;
    contentHash?: string;
    version?: string;
  }>;

  stage?: {
    performerLimit: number;
    configuration: Record<string, unknown>;
  };
};
```

Removed entities, superseded placements, old skies, and historical chat do not
appear.

The server maintains this state incrementally:

- `create` inserts an entity.
- `set` replaces one component (a move is a new `transform`).
- `delete` removes a component or the entity.
- The world's sky, ground and grass are components on `@world`, replaced
  the same way.
- Asset publication updates the current vocabulary.
- Chat and ephemeral presence do not alter the world-state structure.

Reducer operations should be O(1) per affected entity using maps.

## 4. Client bootstrap protocol

A join becomes a cutover protocol rather than log replay.

1. The client opens an authenticated connection.
2. The server captures a bootstrap sequence boundary.
3. The server sends personalized session information:
   - Identity and role.
   - Performer or spectator status.
   - Restored pose if embodied.
   - Show clock and active performance.
4. The server sends or references the latest semantic snapshot.
5. The server sends bounded recent chat separately.
6. The server sends current performer stage state.
7. Live events after the bootstrap boundary are delivered normally.

The client never receives the historical event tail merely to build the scene.

Events arriving while snapshot assets load are buffered by sequence number.
Once semantic state is installed:

- Discard events at or before the bootstrap cut.
- Sort and apply newer reliable events.
- Deduplicate by sequence or event ID.
- Treat stage frames as latest-value-wins rather than ordered durable events.

Late-join cost therefore depends only on the current scene and the assets
visible from the initial camera.

## 5. Snapshot persistence

The server holds live materialized state in memory and periodically persists it
atomically.

Proposed policy:

- Persist after 256 authored mutations or 30 seconds, whichever comes first.
- Persist during graceful shutdown.
- Write a temporary file, flush it, then rename atomically.
- Store schema version, snapshot sequence, hash, and creation time.
- Retain several previous snapshots for rollback and verification.
- Optionally copy older snapshots to object storage.

The in-memory state is always current. A client joining between disk
checkpoints still receives a current semantic snapshot. The disk checkpoint
only controls restart recovery.

On restart:

1. Read `meta.json`.
2. Load the latest verified snapshot.
3. Open the segment containing `snapshotSeq + 1`.
4. Replay at most the bounded remainder of that segment and the current open
   segment.
5. Resume appending.

Server startup no longer reads the complete historical log.

## 6. Extremely long event-log storage

Use immutable fixed-size segments with byte-offset indexes.

Suggested layout:

```text
worlds/commons/store/
  meta.json
  snapshots/
    current.json
    snapshot-0000000000123456.json
  segments/
    0000000000000000.events
    0000000000000000.idx
    0000000000004096.events
    0000000000004096.idx
```

The proposed default segment size is 4,096 events.

Each `.events` file contains serialized event records. Its `.idx` file contains
fixed-width 64-bit byte offsets, one per event.

Given a sequence number:

```text
segment = floor(seq / 4096)
slot    = seq % 4096
```

The server can:

1. Compute the segment filename directly.
2. Read the byte offset at `slot * 8`.
3. Read the following offset or segment length.
4. Fetch the exact event bytes.

This provides actual O(1) addressing by sequence, independent of total log
length.

Range queries locate the first record in O(1), then stream records
sequentially:

```http
GET /api/worlds/commons/events?from=120000000&limit=500
```

Response metadata includes:

- `from`
- `nextSeq`
- `latestSeq`
- `hasMore`
- The snapshot covering the requested period, if applicable.

Limits are bounded to prevent giant responses.

### 6.1 Query complexity guarantees

Primary guarantees:

- Latest sequence: O(1).
- Latest snapshot: O(1).
- Exact event by sequence: O(1).
- Range start by sequence: O(1).
- Range output: O(k).

Additional indexes can support:

- Exact actor.
- Verb type.
- Entity ID.
- Performance ID.
- Time buckets.

Those indexes prevent full scans, but complex filters should be described
honestly as indexed O(log n + k), or bucket lookup plus O(k), rather than
universally O(1).

## 7. Append and crash consistency

Append order:

1. Serialize and validate the event.
2. Append event bytes.
3. Flush according to the durability policy.
4. Append its byte offset to the index.
5. Update in-memory semantic state.
6. Update `meta.json` periodically and atomically.
7. Broadcast the authoritative event.

The index defines committed readable records. On an unclean restart, the
server examines only the current bounded segment:

- Remove or ignore an incomplete final JSON record.
- Rebuild missing final index offsets.
- Verify monotonic sequence numbers.
- Compare the final sequence with metadata.
- Never scan old sealed segments.

Sealed segments are immutable and may be copied to object storage. If they are
compressed later, compression must use independently compressed blocks with a
block index so random access remains bounded.

## 8. Legacy migration

Existing `worlds/<name>/log.jsonl` files are migrated once.

Migration procedure:

1. Detect that no v2 store exists.
2. Stream the legacy JSONL rather than reading it all into memory.
3. Validate sequence continuity and record shape.
4. Write new event and index segments.
5. Feed every event through the semantic reducer.
6. Produce the first snapshot.
7. Verify record count, first and last sequence, and semantic state.
8. Atomically publish `meta.json` as the migration completion marker.
9. Keep the original JSONL intact for rollback.

Rollout should initially support shadow comparison:

- The legacy log and v2 store receive the same events.
- Sequence and reduced-state hashes are compared periodically.
- Client bootstrap switches to v2 only after comparison passes.
- Legacy writes stop only after a soak period.

A feature flag should allow temporary return to legacy serving without
deleting v2 data.

## 9. Client snapshot hydration

Snapshot hydration must not become another serial loader.

### 9.1 Immediate state installation

- Create entity records and lightweight placeholders synchronously.
- Apply transforms and stage layout immediately.
- Install environment parameters.
- Populate the asset vocabulary.
- Show recent chat and live performer points before heavy assets finish.

### 9.2 Priority loading

Load in this order:

1. UI, chat, show clock, and audio.
2. Stage shell and initial camera.
3. Performer silhouettes.
4. Visible performer medium LODs.
5. Nearby or selected high LODs.
6. Visible props.
7. Distant scenery and effects.
8. Optional high-resolution replacements.

Use a bounded concurrency pool rather than serial
`for (...) await loadAsset()` behavior.

Cancellation is required when:

- The camera changes.
- A performer leaves.
- A newer entity version replaces the pending one.
- The user changes worlds.
- The client drops to a lower quality tier.

## 10. Asset identity and stage packages

All production assets should resolve to immutable hashes.

Mutable names such as `sydney.vrm` become aliases:

```text
sydney -> avatar descriptor hash
descriptor -> high/medium/silhouette asset hashes
```

A performance pins exact descriptor hashes at curtain time. Updating an avatar
during a show does not silently alter active spectators.

The snapshot itself supplies the live asset dependency graph, preserving the
project's no-static-manifest philosophy. The server derives a transient stage
preload plan from that graph.

Each uploaded avatar goes through processing:

- High, medium, and silhouette LOD generation.
- Geometry compression.
- KTX2/Basis texture conversion.
- Texture-resolution caps.
- Material and draw-call reduction.
- Skeleton and expression validation.
- Spring-bone limits.
- Thumbnail and metadata generation.
- License metadata validation.
- Complexity scoring and rejection thresholds.

There must be both per-avatar and whole-stage budgets.

## 11. Browser caching

Use layered, explicitly bounded caching.

### 11.1 Edge cache

Immutable assets live in object storage or a CDN with:

```http
Cache-Control: public, max-age=31536000, immutable
```

The realtime sequencer should not serve large production VRMs to 200
simultaneous spectators.

### 11.2 Browser persistent cache

A service worker and Cache Storage layer:

- Prefetches the current stage package.
- Retains immutable assets across visits.
- Reports cold and warm cache progress.
- Uses content hashes as keys.
- Supports controlled LRU eviction.

IndexedDB stores metadata:

- Asset size.
- Last access.
- Stage references.
- Version aliases.
- Validation and decode status.

### 11.3 Session CPU cache

Decoded geometry, animation templates, and texture sources are:

- Size-bounded.
- Reference-counted.
- Shared among identical performers and assets.
- Released when no scene references remain.

The current unbounded byte cache must not retain compressed source bytes after
decoded assets and GPU resources are resident unless explicitly beneficial.

### 11.4 GPU cache

GPU resources require:

- Reference counts.
- Camera-aware residency.
- Explicit disposal.
- LOD promotion and demotion.
- Pressure-triggered eviction.
- No duplicate texture uploads for shared assets.

## 12. Spectator renderer

The audience client is separate from the current renderer/retina spectator
role.

It receives:

- All 24 performers.
- Complete stage frames.
- Chat and audience roster.
- Captions and audio state.
- Selectable cameras.
- Current world snapshot.
- No personal avatar or locomotion animation bundle.

Rendering tiers are camera-dependent:

- Close-up selected performers use full VRMs, face animation, spring bones, and
  high-resolution textures.
- Medium shots use reduced models and animation rates.
- Wide shots use medium or silhouette LODs.
- Offscreen performers retain synchronized state without rendering.
- Shadows are limited to selected performers.
- Facial and viseme work is concentrated on visible speakers.

The renderer adapts:

- Internal render resolution.
- Shadow quality.
- Effect quality.
- Animation update frequency.
- Spring-bone frequency.
- Avatar LOD.
- Texture residency.

## 13. Stage-frame protocol

Twenty-four performers send state at approximately 20 Hz.

The server produces one stage frame per tick:

```ts
type StageFrame = {
  showId: string;
  frameSeq: number;
  showTime: number;
  performers: Array<CompactPerformerState>;
};
```

Every spectator receives the complete frame.

Required properties:

- Compact binary encoding.
- Shared server or show timestamp.
- Sequence number.
- Latest-value-wins queue.
- Stale frames dropped under backpressure.
- Approximately 100–150 ms interpolation buffer.
- Reliable show cues transported separately.
- Reconnect requests the latest full keyframe, not old presence frames.

High-quality state should replicate animation intent, head and hand targets,
gaze, expressions, and visemes—not every skeleton bone.

## 14. Performance recording

Ordinary presence can remain ephemeral, but scheduled performances need an
explicit recording plane.

A recording contains:

- Periodic performer keyframes.
- Delta stage frames.
- Reliable show cues.
- World snapshot ID.
- Exact asset descriptor hashes.
- Audio track or stream references.
- Show-clock metadata.

Recording is segmented and indexed similarly to the event log. It must have
visible consent and recording state plus a retention policy.

This enables replay and cinematic rendering without putting high-frequency
presence into the permanent world-construction log.

## 15. Audio

If shows include voice or music:

- Use WebRTC/SFU or a produced program mix.
- Do not carry audio through the world WebSocket.
- Prefer a single audience program mix plus optional spatial or performer
  stems.
- Synchronize audio to show time.
- Carry captions and viseme envelopes separately.
- Support mute, captions, audio-device selection, and reconnect
  resynchronization.

## 16. Security and roles

Before public performances:

- Authenticated sessions and invites.
- Explicit spectator, performer, host, moderator, renderer, and agent roles.
- Server-assigned identity; clients cannot impersonate names.
- Server-checked settlement of anything a body holds (v4: the door's
  grab/put/throw).
- Schema validation for every message.
- Message and upload limits.
- Per-role rate limits.
- Origin checks.
- Signed upload flow.
- Renderer registration and authorization.
- World and entity permissions.
- Chat moderation and slow mode.
- Rotation and removal of tracked MCPL credentials.

## 17. Observability

### 17.1 Server metrics

- Connections by role and world.
- Stage-frame receive and fanout rate.
- Backpressure and dropped stale frames.
- Snapshot generation duration and size.
- Snapshot age.
- Segment append and query latency.
- Recovery operations.
- Asset or CDN throughput.
- Join milestone latency.
- Chat and authored-event rate.

### 17.2 Client metrics

- Snapshot download and parse time.
- Asset cache hit rate.
- Download, decode, compile, and GPU-upload time.
- Time to shell, silhouettes, medium stage, and full quality.
- Frame-time percentiles.
- Draw calls and visible triangles.
- Active skeletons and spring-bone systems.
- Dropped stage frames and interpolation delay.
- Memory and cache pressure.
- Quality-tier changes.

## 18. Verification strategy

### 18.1 Storage correctness

- Reducer golden tests for every state operation.
- Create, set, and delete collapse correctness.
- Environment last-value correctness.
- Legacy migration verification.
- Segment-boundary range queries.
- Exact random sequence lookups.
- Crash after data append but before index append.
- Crash after index append but before metadata update.
- Corrupt final record recovery.
- Snapshot schema migration.
- State-hash equality between full replay and snapshot plus bounded tail.

### 18.2 Long-log performance

Generate logs with millions of synthetic events and verify:

- Startup reads only the snapshot plus a bounded current segment.
- Exact event lookup touches one index and segment pair.
- Range-query work depends on requested result count, not total history.
- Join payload size is identical for worlds with the same current state but
  radically different history lengths.
- Memory does not scale with historical event count.

Prefer operation-count assertions and instrumented reads over fragile
microbenchmark thresholds.

### 18.3 Client correctness

- The snapshot contains no historical `entries`.
- Live events racing snapshot hydration are ordered and deduplicated.
- Entity assets load concurrently within configured limits.
- Removed or superseded assets cancel correctly.
- Warm-cache rejoin uses persistent assets.
- Cache eviction does not dispose live resources.
- World switching fully releases prior GPU resources.

### 18.4 Performance test

Run a 30–60 minute show with:

- 24 moving and speaking performers.
- 176 connected spectators.
- Complete stage frames sent to every spectator.
- Production-size world and processed avatars.
- Simultaneous pre-show arrival.
- Cold-cache and warm-cache cohorts.
- Burst chat.
- Late joins and reconnects.
- 150–250 ms latency and packet loss.
- At least one agreed midrange reference laptop rendering the complete
  spectator client.

## 19. Proposed launch gates

- Server startup is independent of total log length.
- Exact event seek is independent of total log length.
- No historical event array appears in normal join payloads.
- Interactive spectator shell and audio are available in 2–3 seconds.
- A recognizable stage with silhouettes appears within 5 seconds.
- Warm-cache rejoin completes within 2–3 seconds.
- The agreed midrange reference hardware sustains at least 30 fps at 1080p.
- Memory remains stable over a 60-minute performance.
- Server and client queues remain bounded.
- Reconnect resumes the current show without historical replay.
- Snapshot and reducer state match a full replay exactly.
- Simultaneous audience arrival does not saturate the realtime sequencer.

## 20. Implementation sequence

1. Define shared event and snapshot schemas.
2. Extract and thoroughly test the semantic reducer.
3. Implement segmented event and index files plus metadata.
4. Implement legacy migration and state-hash verification.
5. Add snapshot checkpoints and bounded restart recovery.
6. Add exact and range query APIs.
7. Change join protocol to session, snapshot, recent chat, and current stage.
8. Change client hydration and live-event race handling.
9. Add bounded parallel asset loading and placeholders.
10. Add immutable asset descriptors and the processing pipeline.
11. Add persistent browser caching and bounded CPU/GPU caches.
12. Build the dedicated spectator renderer and camera-aware LOD.
13. Add batched binary stage frames.
14. Add audio/show-clock integration and optional recording.
15. Add authentication, role enforcement, and moderation.
16. Run shadow storage comparison.
17. Run long-log and 24-performer plus 176-spectator performance tests.
18. Enable snapshot bootstrap behind a feature flag.
19. Soak, verify, and then retire legacy writes.

## 21. Parallel implementation ownership

After this plan is approved, parallel work can resume with non-overlapping file
ownership:

- Storage format, reducer, migration, snapshots, and query API.
- Client bootstrap, snapshot hydration, and event-race handling.
- Asset processing, persistent caching, and bounded resource caches.
- Spectator renderer, LOD, and stage-frame consumption.
- Correctness, long-log, browser, and 24+176 performance verification.

