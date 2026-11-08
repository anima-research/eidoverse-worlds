# Log vocabulary: the decided contract

The words the protocol log, the wire snapshot and the hello use, what each one means, and why. This dialect is `{dialect: "eidoverse-log", v: 4}`. Section numbers (§0, §1.x, §2.x, §3, §5, §F, §P) and the ids D1–D13, F1–F31 and M1–M2 are cited from code comments and stay stable. An F id names a fixture, not a receipt: §5's table is the proven set; F21 and F25 are deferred (§5, Deferred) and F11, F13, F15–F18 are retired.

Examples are quoted from `spec/conformance/` or from the code that writes the entry. Review history lives in git and PR #23, not here.

## D. Decisions

| # | call | decision | where |
|---|---|---|---|
| D1 | versioning | The version is `{dialect, v}`. **There is no `minor`**: a genesis or hello carrying one is malformed, and the snapshot carries none. `dialect` names the protocol family; `v` is a hard semantic or wire break; `requires` (§F F-1) is the monotonic, additive, opt-in feature gate. New op, kind or component semantics declared before first use → `requires`. A changed meaning of existing bytes, of the envelope or genesis skeleton, or anything that can't be predeclared → bump `v`. A reader given an unknown `v` returns `unknown-version`: no world, no entry folded or cached (F20). An unknown `requires` id → `unsupported-feature`. An unknown `v` at the hello → `update-required` (F22). v1 worlds translate directly to this vocabulary; no intermediate dialect is ever stored (F10). The kernel is pinned once, by the first-deploy ceremony (`spec/kernel-vectors/first-deploy`, kernel-check K3) | §0, §5 |
| D2 | `request` body | admitted `{args: {…}, salt}`; refused `{argNames: [names], refused: {code}, salt}`, plus the writer's optional `unknownArgs`, `unrecorded`, `operator`. `cause` is an envelope field, not a body field. Matches the wire's `{verb, args}`, keeps refused values out of the log, ends request-in-request. Readback rows read `args.*` | §1.1 |
| D3 | genesis + field spellings | genesis has no `verb`; `rewindWindow`; position `seq`, hash `head`; `op` on changes and batch items; `cascade`; `redaction`/`redacted`; redaction target `{seq, index?}`; `commitment`; kind `physics` (actor `sim` and the checkpoint body's `sim` keep their meanings); kind `governance` (the signing role stays `sequencer`); envelope `by` retired; actor `world` dropped (`system` covers authority-authored entries) | §1.2–1.7, 1.9, 1.12, 1.13, 1.15, §2.2, §2.3 |
| D4 | `grant` / `for` | both are **out of the envelope**; either is `malformed:unknown-field`. Delegation returns as a feature or a new `v` once it has keys, signatures and semantics. The spec may reserve the concept in prose, never a field name | §1.11, §2.1 |
| D5 | `cut` → snapshot | the `snapshot` wire message is flat (no `snapshot.cut`). It repeats the authoritative `{dialect, v, requires}`; `replica.adopt` refuses an unknown `{dialect, v}` whole with a visible `unknown-version` state (F7). On the wire `world` is the world id, as in the log; the directory name travels as `name`. Checkpoint blobs are written and read as `snapshotJson`; a blob keyed `cutJson` is skipped (F12) | §1.8 |
| D6 | agent inbox `kind: "act"` | **kept**: a volatile event in `mcpl/agent.ts`'s in-memory inbox `{ts, kind, who, text}`, never logged, never on the protocol wire. `spec/PROTOCOL.md` says so beside the kind table. With `act` gone from the log, the word has one meaning in protocol code | §1.1 |
| D7 | the story | a real causal order (refusal; request → change → physics; redaction of the admitted request; governance last); the handoff shows the old key signing a distinct new key; the story is an executable fixture (`spec/conformance/logs/25-story.jsonl`) | §3, §5 |
| D8 | migration receipt | **none**: no earlier version of this dialect was ever deployed, so nothing migrates within it | — |
| D9 | fork parents | **none**: no migration, so no fork-parent remap | — |
| D10 | conformance + mutations | the fixtures and mutation rules in §5 ship with the implementation | §5 |
| D11 | governance freezes the id | a genesis-changing rewrite is possible only while a world holds no governance entry; after the first one the world id is frozen for good (`spec/PROTOCOL.md` §13) | §F F-5 |
| D12 | migration authority | **none**: no migration | — |
| D13 | `physics.kind` | **kept**: a scoped component field with conventional rigid-body values (`dynamic\|static\|kinematic\|none`), not the entry discriminator. Renaming it would rewrite state and churn digests for little cold-reading benefit. A future `bodyType` would be a component-version change, never vocabulary cleanup | §1.15 |

Term set: `genesis · change · request · physics · say · redaction · governance`, with `change.op`, `request.verb`, `physics.verb`, `body.args` / `body.argNames`, `body.cascade`, `body.commitment`, `snapshot.seq`, redaction target `{seq, index?}`.

## 0. Three facts every row depends on

**Three hashes, and what each one reads** (`shared/protocol/fold.js`, `spec/conformance/chain.py`, `server/custody.ts`):

| hash | input | changed by |
|---|---|---|
| **world id** | `sha256(JCS(genesis entry))`: the whole entry 0, envelope included (`worldIdOf`) | any byte of genesis, including a genesis body field's spelling |
| **chain head** | `head(i) = sha256(head(i-1) ‖ sha256(JCS(skeleton(i))))`; skeleton = entry minus `head`/`sig`, each set's `value`+`salt` → `commitment`, a `request`/`say`/`physics` body → `{commitment}` | any envelope key or value, any body key that survives into the skeleton (`ops`, `cascade`, `commitment`, `id`, `comp`), and the chain rule's list of body-purgeable kinds |
| **state digest** | `sha256(JCS(view))`, view = `{id: {comp: {"v": value} \| {"redacted": true}}}` | only the view, including the marker key `redacted` |

Signatures are Ed25519 over `"eidoverse-head:<world id>:<seq>:<head hex>"` by the sequencer key named in genesis, the host's custody key. The reference server writes chain points on every entry. So any spelling inside the skeleton is frozen once a world is written: changing it later re-hashes and re-signs every entry, which is exactly what the client head check exists to detect.

**How a reader meets a word it doesn't know.** Per entry, `fold.js checkEntry` makes the entry malformed (`malformed:kind`, `malformed:unknown-field`, `malformed:envelope`, `malformed:batch-field`, `malformed:op-field`). It shapes nothing and is reported in diagnostics; the fold's status stays `ok`. That is why per-entry malformation is never enough to keep a reader honest across a vocabulary change: a dropped `change` leaves a wrong digest with status `ok`. Whole-world refusal comes only from the version (D1): an unknown `v` is `unknown-version`, a stray `minor` or other unknown genesis field is `no-world`, an unknown feature is `unsupported-feature`. Each refuses before any entry is folded.

**One vocabulary.** The reader accepts only this vocabulary's spellings. A reader that quietly accepted both old and new would pass every positive fixture; F14 exists to catch it.

## 1. The table

Each row: the decision, the referent, the surfaces, and the hash effect.

### 1.1 `act` → `request`

- **Referent.** A request as the authority admitted or refused it. Admitted: `{args: {…}, salt}`; refused: `{argNames: [names], refused: {code}, salt}` (D2). The fold never reads it; the authority reads it back for the rows in `spec/readback.json` (`request:*`, `args.*`).
- **Example** (`spec/conformance/logs/25-story.jsonl` line 1, chain fields elided): `{"kind":"request","ts":1001,"actor":"bob","verb":"delete","body":{"argNames":["id"],"refused":{"code":"locked"},"salt":"UWGy2eg11rNn2Sl6urvUTg"}}`.
- **Surfaces.** Wire: `log` entries; the request message is already `request`. Log: `KINDS`, the chain's body-purgeable kinds, `readback.json`, `verbclasses.js`. UI: the History panel and `mcpl/tools.ts historyLine` filter on `kind === "request"`.
- **Hash.** Every request skeleton (the kind is in it). Digest, world id: none.
- **v1 translator.** Writes `kind: "request"` with verbs `translated`, `imported`, `lift-sockets`, `translation-approved`. An `imported` body keeps v1's verb and args as provenance (`body.verb: "grant"`, `"ban"`, …). The v1 `sockets` map is no registry name: only the v1 translator knows it, and it lifts it into socket children with its own `lift-sockets` requests.
- `set`, `delete` and `batch` are spellings shared by a request's `verb` and a change's `op`. Read the kind first.

### 1.2 `sim` (kind) → `physics`; `sim` (actor) stays

- **Referent.** The authority's own record of a physics boundary: verbs `launch`, `lift`, `catch`, `digest`, `checkpoint`. Written by the authority, never by a client, never refused. `actor` is the thrower or lifter for `launch`/`lift`/`catch` and `sim` for `digest`/`checkpoint`.
- **`cause` is always the request.** For a wake it is the request whose change removed the support, not the change: `writes.js` sets `cause` to the seq the request entry takes, and every `launch` in `spec/conformance/physics/arc-onto-table.jsonl` carries its request's seq. Request → change → physics is the reading order, not a `cause` chain.
- **Checkpoint body.** `{seq, engine, tick, clock, sim: <digest>, state: <blob>}`. `seq` is a position (§1.4). The body field `sim` names the sim layer, which keeps its name.
- **Hash.** Every physics skeleton. Digest, world id: none.
- **v1 translator.** Never emits `physics`: each rest is a plain change by actor `sim`, caused by the imported request.

### 1.3 `purge` → `redaction`; view marker `purged` → `redacted`

- **Referent.** Kind `redaction`, body `{values: [{seq, index?}, …]}`: the operator's instruction, outside the request path, that named values fold as absent. Each target's stored line is rewritten with `value`+`salt` → `commitment`, so its skeleton and every head are unchanged (spec §12). `index` is an index into `ops`; `op` is an operation word and nowhere a number.
- **Surfaces.** Wire: snapshot state cells are `{v}` or `{redacted: true}`; a `redaction` in the `log` stream makes a live client resync (`replica.js`, F5). Log: `KINDS`, diagnostics `redaction`, `redaction-ignored`, `redaction-target-bad/-range/-not-a-value/-governance`, `redaction-of-redaction-refused`, `commitment-unredacted`. State: the `REDACTED` sentinel; **the digest hashes the key `redacted`**.
- **Hash.** The redaction entry's own skeleton; the digest of every world with a redacted value.

### 1.4 `head` (position) → `seq`; `head` (hash) stays

- **Referent.** `head` is the chain hash only: on the envelope and in `parent {world, seq, head}`. A position is `seq`: the snapshot's `seq`, the checkpoint body's `seq`, the script request's body position. `worldlog.ts`: `get seq()` is a position, `headAt(seq)` returns the hash at one.
- **Rule.** `seq` is never an envelope field (`checkEntry` refuses it); in a body it names a position. A checkpoint carrying the old `at` is skipped as malformed (F4).
- **Hash.** Through the checkpoint and script request bodies only.

### 1.5 `verb` → `op` on `change`; `verb` only on `request` and `physics`; neither on `say` / `genesis` / `redaction` / `governance`

- **Referent.** On a change, `op` is one of the four storage operations (`create/set/delete/batch`, `OP_FIELDS`); each batch item carries `op` too. On a request, `verb` is the request word; on a physics entry, the physics event. On `say`, `genesis`, `redaction` and `governance` the word only repeated the kind, so it is gone.
- **Example** (`25-story.jsonl` line 3): `{"kind":"change","actor":"alice","cause":2,"op":"batch","body":{"ops":[{"op":"delete","id":"shelf"},{"op":"set","id":"vase","comp":"transform","value":{"pos":[0,0.9,0]},"salt":"…"}],"cascade":[1]}}`.
- **Envelope rule.** `ENVELOPE = {world, kind, ts, actor, cause, op, verb, body, head, sig}`; `op` on change only, `verb` on request/physics only, neither elsewhere; anything else is malformed.
- **Hash.** Every change skeleton. **World id: genesis has no `verb`**, so the genesis spelling is part of every world id. That is why this was settled before any world in this dialect was stored.
- **Why it matters.** A change that a reader drops as malformed leaves a wrong digest with status `ok`: the quietest failure in the set. F14 pins the refusal of every old spelling.

### 1.6 `followUps` → `cascade`

- **Referent.** On a batch body: a non-empty, strictly ascending list of indices into `ops` naming the ops the authority derived from the asker's own (a deletion's reference clears and set-downs, an undo's restores), admitted without the asker's rights or locks. Readers deriving authorship skip them. The referent is SQL's `ON DELETE CASCADE`.
- **Surfaces.** `BATCH_FIELDS = ["ops", "cascade"]`, diagnostic `batch-cascade`, `authority/followups.js`, `gate.js`, `rights.js`, `undo.js`.
- **Hash.** Every batch carrying it.

### 1.7 `by` (envelope) retired

A legacy alias of `actor` the lab wrote. It is not in `ENVELOPE`; a line carrying it is `malformed:unknown-field`. Presence's `drag.by`, `holds.by`, `moderated.by` are a different plane (never logged) and stay.

### 1.8 `cut` → `snapshot` (wire)

- **Referent.** The fold handed to a joiner at seq N; never logged, verified by folding forward.
- **Shape.** Flat: `{dialect, v, requires, world, name, you, actor, gen, seq, state, physics, names, holds, mine, chat, …}`. `world` is the world id; `name` the directory name. `actor` is the joiner's log id (the one entries carry); `you` is the connection's id. `chat` is `{recentChat, chatTotal}`. `physics` was `cut.sim`; `seq` was `cut.head`.
- **Version gate.** `replica.adopt` checks `{dialect, v}` first and refuses an unknown pair whole: status `unknown-version`, no state, nothing folded (F7). Without it a client would adopt a foreign snapshot and drop every following `log` entry as malformed with status `ok`.
- **Checkpoint blobs.** The one writer (`scriptrun.js`) writes `snapshotJson`; the readers (`livehost.ts`, `tools/protocol/simckpt-check.ts`) read `snapshotJson` only. A blob keyed `cutJson` is skipped and the boot falls back to an earlier checkpoint or genesis (F12).
- **Hash.** None: nothing logged.

### 1.9 `rewind_window` → `rewindWindow`

An optional genesis-body field: the governance rewind window, a non-negative integer (`GENESIS_FIELDS`, `gov.py`). It is in the world id of any genesis carrying it, so the spelling was settled before first deploy.

### 1.10 The four-line glossary: `authority` / `sequencer` / `operator` / `host`

Prose only (spec §7a "The parties"). Nothing hashed.

- `authority`: the gate that admits or refuses (`shared/protocol/authority.js`).
- `sequencer`: the chain-writer role whose key genesis names (`body.sequencer`, `custody.ts sign`).
- `operator`: the human in custody of the host (the operator key, `operator-repair`, the redaction decider).
- `host`: the machine or service (`livehost.ts`, "a host's custody keys").

### 1.11 `grant` (envelope) and `for`: not in the envelope (D4)

Both were reserved, never written, never checked. Neither is in `ENVELOPE`; `for` is `malformed:unknown-field` like any stranger. The role grant (`roles:<id>` components, the gate's `grant` need-class) is a different thing and unaffected. v1's `grant` verb survives only as `body.verb` inside `imported` requests.

### 1.12 `commit` → `commitment` — see §2.2

- **Referent.** On a `set` op, `hex sha256(UTF-8(salt) ‖ UTF-8(JCS(value)))`, standing in for `value`+`salt` after a redaction; on a request/say/physics body, the same over the body. The chain computes it for **every** set and purgeable body whether or not anything was redacted; it is stored only after a redaction.
- **Stub rule.** A redacted body is `{commitment}` exactly, in `storage.js isCommitStub`, `bodyCommit` and `chain.py body_commit`. A stub carrying `salt` is not a stub.
- **Hash.** Every chain head: the key is in every skeleton, redacted or not.
- Diagnostic: `commitment-unredacted` (a stored line carries a commitment no redaction names).

### 1.13 `sequencer` (kind) → `governance` — see §2.3; `sequencer` (role, genesis field) stays

- **Referent.** The entry kind whose body is a handoff `{key, sigs}`, an owners override `{owners, sigs}`, a reclaim `{key, sigs}` by a higher tier, a rewind `{fork: {seq, head}, sigs}`, or a feature activation `{requiresAdd, sigs}` (§F F-1); `checkpoint` is reserved. The reference server never writes one and refuses to serve past one it can't check (`livehost.ts`).
- **Hash.** Its own skeleton. The genesis field `sequencer` is untouched.

### 1.14 Entity classifier

Gone. `kind.js` (`kindOf`, and the proposed `formOf`/`form`) is deleted; the renderer, labels, capacity and the gate read component presence directly.

### 1.15 Smaller rows

| term | decision | note |
|---|---|---|
| request-batch `ops` → `requests`; refusal `op: i` → `index: i` | renamed | a batch request's children `{verb, args}` and the reply's index of the refused child |
| actor `world` | dropped | a v1 actor; `system` covers authority-authored entries |
| `salt` | kept | glossed |
| `digest` | kept | glossed "the physics digest" |
| component `physics` and its field `physics.kind` (D13); the directory's identity kind (`account\|anon\|imported`) | kept | deliberate survivors. Three `kind`s remain: the entry kind, the component field, the directory field. None is on the envelope besides the first |

## 2. The four contested referents

### 2.1 `grant` (envelope) → `delegation`, when the object exists

The envelope slot was for the proof by which `actor` acts for someone else: per-entry, presented with the write, checked at admission. The durable role grant is state (`roles:<id>` on `@world`). The two never meet. When delegation returns (D4) its word is `delegation`, matching UCAN's referent (a signed, chained capability presented with a call). Not `capability` (already a readback field), not `token` (the wire's auth word), and not `grant` (it would sit beside `body.verb: "grant"` in every translated world). Spec sentence: "`for` names whom the actor acts for; `delegation` is the credential by which they may. A role someone holds is a `roles:<id>` component, never a delegation."

### 2.2 `commit` (§12) → `commitment`

The object is a salted hash of one value: binding (the hash fixes the value) and hiding (the salt stops a dictionary guess). That is a cryptographer's commitment. It is not a checkpoint, not a decision (the operator's decision is the `redaction` entry), and not a transaction commit (`txn: committed`, §7). `digest` and `hash` were taken or too generic; `seal` has no industry referent.

### 2.3 `sequencer` (kind) → `governance`

Every valid entry of the kind is a decision about who writes the world or what its trusted history is: handoff, reclaim, owners, rewind, and the reserved trusted checkpoint (`gov.py`: `GOV_FIELDS`). **An entry that changes nothing is invalid**; so is an empty `requiresAdd` (`requiresAdd-empty`, `features.js`). Nothing administrative lives there: maintenance and the translator's own acts are `request`s by actor `system`, and the engine's checkpoint is a `physics` verb. The role keeps the word `sequencer` (genesis field, signing key); the kind had to move so one word stops being a kind, a role and a genesis field at once.

### 2.4 Entity classifier

Gone with §1.14: readers read components.

## 3. The six-entry story

`spec/conformance/logs/25-story.jsonl`, run by `spec/conformance/test_story.py` (F1 + F2 + F6 + F8 + F9). Chain fields `head`/`sig` are elided here; the fixture carries them. Line 2 is shown as stored, after line 5 redacted it. World id `sha256:4416ed919cbd56aa164ca6d4a54323d7d00c2dde60994dc9c95cb6a02556f2cc`, shortened below.

```jsonl
{"kind":"genesis","actor":"system","body":{"dialect":"eidoverse-log","v":4,"nonce":"XWVu1u7BpaZTDFSETYiphg","owners":[["ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0"]],"sequencer":"ed25519:9prLVyWUYAOt0-PHqJMvRi6S1MsIrtAkadAuWsfDcJc"}}
{"world":"sha256:4416ed91…","kind":"request","ts":1001,"actor":"bob","verb":"delete","body":{"argNames":["id"],"refused":{"code":"locked"},"salt":"UWGy2eg11rNn2Sl6urvUTg"}}
{"world":"sha256:4416ed91…","kind":"request","ts":1002,"actor":"alice","verb":"delete","body":{"commitment":"7ae472db599f3797e22b852f246c73b3221e4ea75b69b3e57d8189250e867f70"}}
{"world":"sha256:4416ed91…","kind":"change","ts":1002,"actor":"alice","cause":2,"op":"batch","body":{"ops":[{"op":"delete","id":"shelf"},{"op":"set","id":"vase","comp":"transform","value":{"pos":[0,0.9,0]},"salt":"5hGJikDRuwCGCS7slx6mug"}],"cascade":[1]}}
{"world":"sha256:4416ed91…","kind":"physics","ts":1002,"actor":"alice","cause":2,"verb":"launch","body":{"id":"vase","p":[0,0.9,0],"yaw":0,"q":[0,0,0,1],"v":[0,0,0],"handled":["alice"],"salt":"Gz4fypccq-7GOARwIgA8Vw"}}
{"world":"sha256:4416ed91…","kind":"redaction","ts":1003,"actor":"system","body":{"values":[{"seq":2}]}}
{"world":"sha256:4416ed91…","kind":"governance","ts":1004,"actor":"system","body":{"key":"ed25519:7vY8rgwiep8OmNeVW8VrGtplQW9LlPf8cmOx9Npkvxg","sigs":[{"key":"ed25519:9prLVyWUYAOt0-PHqJMvRi6S1MsIrtAkadAuWsfDcJc","v":"0EY8W4FmYTIcG2D8DnkTubTINSyEzQ5uqFXW_ogHxXg5UONg5aaKkpHfRMtkC3fSfwtWkPz3LAuU1b0lhjhTAQ"}]}}
```

**Envelope rules it exercises** (`fold.js checkEntry`, `reader.py`, spec §1):

| rule | lines |
|---|---|
| `world` on every entry after genesis, equal to the genesis id; none on genesis | 1–6 carry it; 0 doesn't |
| `ts` integer ms, required after genesis, never decreasing | 1001, 1002, 1002, 1002, 1003, 1004 |
| `cause` required on `change`, `0 ≤ cause < seq`; optional elsewhere | 3 and 4: `cause: 2`; 1, 5, 6: none |
| `verb` only on `request`/`physics`; `op` only on `change` and its items; neither on `genesis`/`redaction`/`governance` | 1, 2, 4 `verb`; 3 `op`; 0, 5, 6 neither |
| no `seq` field, no unknown envelope field (`for`, `grant`, `by`) | none present |
| `cascade` non-empty, strictly ascending indices into `ops` | `[1]` into two ops |
| a batch never contains a batch; each item has an `op` and that op's exact fields | `delete {id}`; `set {id, comp, value, salt}` |
| redaction targets `{seq}` or `{seq, index}`, `0 < seq <` this seq, never a redaction, never a `roles:` set | `{seq: 2}`: a request, whose whole body is purgeable |
| governance body ⊆ `{key, owners, fork, requiresAdd, sigs}`; a handoff is `key` alone, signed by the current sequencer | line 6: `key` ≠ `sigs[0].key`, which is the genesis sequencer |
| genesis: exact fields, no `minor`, no `verb`; `nonce` ≥ 16 bytes; `owners` tiers of registrable keys; `sequencer` registrable | `rewindWindow`, `parent`, `requires`, `provenance` absent (optional) |

**Read as prose.** 1: Bob requested `delete` and was refused, `locked`; the record keeps the name of the one argument he sent and nothing he typed. 2: Alice requested `delete shelf`; its body is now only a commitment. 3: the world changed because of 2: the shelf deleted and the vase set down, the second op a cascade of the first (not Alice's authorship). 4: a physics entry caused by the same request: the vase launched at rest, Alice handling it. 5: the system redacted line 2; its commitment still hashes, so the head is unchanged. 6: governance: the writer role handed to a new key, signed by the outgoing sequencer.

`"kind":"physics","actor":"alice"` is deliberate: the kind says what the entry is, `actor` whose doing it was. Two requests with the same `verb` differ by `refused` and by `args` vs `argNames`; a reader may key on either.

## 5. Conformance fixtures and mutations (D10)

Each fixture is guarded by a mutation that proves it exercises what it names. Where the test lives: F1–F3, F8, F14 in `spec/conformance/test_reader.py`; F6, F9 in `test_story.py`; F4, F5, F7, F10, F12, F20 in `tools/protocol/vocab-fixtures-check.ts`; F19 in `tools/protocol/importer-check.ts`; F22–F31 in `tools/protocol/freeze-check.ts` (F23 also across the access, setup, upgrade and join checks). F11, F13 and F15–F18 were migration fixtures and are retired with it; their ids are not reused.

| # | fixture | proves | mutation that must go red |
|---|---|---|---|
| F1 | admitted request | `kind: "request"`, `verb`, `body.args` object, readback `args.*` resolves | readback keyed on `request.*` → the row reads unknown |
| F2 | refused request | `body.argNames` is a list of names, no values anywhere in the line; `refused.code` | a refused line carrying `args` → malformed |
| F3 | say | `kind: "say"`, no `verb`, body hashed as `{commitment}` | `verb` present on a say → malformed |
| F4 | physics checkpoint | checkpoint body `seq`; body field `sim` kept; a boot resumes from it | a checkpoint carrying `at` → "checkpoint malformed; skipped" |
| F5 | redaction + live-client resync | wire marker `{redacted: true}`; the client folds back to the same digest; `replica` resyncs on the kind | an old `{purged: true}` cell → digest never agrees; an entry of kind `purge` → folded past, no resync |
| F6 | governance handoff (§3 line 6) | `kind: "governance"`, no `verb`, `key` ≠ the signing key, signed by the current sequencer | signed by the new key alone → "not a handoff by the outgoing sequencer" |
| F7 | the wire's version gate | `replica.adopt` given a snapshot with an unknown `{dialect, v}` refuses whole: `unknown-version`, no state, nothing folded; a snapshot with this reader's pair is adopted (control); the snapshot's version has no `minor` and the fold exports no `MINORS` | `adopt` without the gate → the client adopts and drops every following `log` entry with status `ok` |
| F8 | cascade authorship | `body.cascade` indices are skipped by authorship; `batch-cascade` on a bad list | a reader keyed on `followUps` → entry malformed, digest wrong, status `ok` |
| F9 | commitment skeleton before/after redaction | the head at the redacted seq is identical before and after the line is rewritten to `commitment` | key `commit` in the skeleton → `broken` at that seq |
| F10 | v1 straight to this vocabulary | the translator writes the new kinds, `op`/`verb` per kind, no `verb` on genesis or says, no `minor`, no `by`/`for`/`grant`, no actor `world`; the v1 verb rides in the `imported` body; the reader folds it clean | a translator writing a `minor` → the reader returns no world |
| F12 | checkpoint blob key | a blob written as `snapshotJson` boots the physics layer; one keyed `cutJson` is skipped; new writes carry `snapshotJson` only | a writer of `cutJson`, or a reader of it → red |
| F14 | the reader refuses every old spelling | one negative log per old spelling: a `change` with `verb`; a `request` with `op`; a `genesis`/`say`/`redaction`/`governance` with `verb`; a batch with `followUps`; a set with `commit`; a redaction target with `op`; an envelope with `for`, `grant` or `by`; a kind `act`/`sim`/`purge`/`sequencer`. Each: its `malformed:*` code, status `ok`, the rest folded (a genesis with `verb`: no world) | a reader that accepts both spellings passes every positive fixture; only F14 catches it |
| F19 | `u-` + 24 entity-id collision is loud (P3) | the v1 translator refuses any entity id in the reserved person shape `u-[a-z2-7]{24}`, naming the id; person-shape checks accept exactly `{20}` and `{24}` | an entity of the 24 shape passing through silently → red |
| F20 | version refusal before any state | a reader given a log at the next `v`: `unknown-version`, no world, no entry folded, nothing accepted to cache; a genesis carrying `minor` is `malformed:genesis-field`, no world; every conformance log folds to its pinned status and digest | a reader that folds one entry before reporting the version → red |
| F22 | hello version | an unknown `{dialect, v}` gets `update-required` before any world lookup; no world name or existence in the reply | — |
| F23 | no existence oracle | `unsupported-feature` only after access is granted; a refused principal can't tell a missing world from a closed one | — |
| F24 | genesis provenance | present, schema-valid, non-redactable; `dirty: true` without `sourceTreeSha256` is invalid | — |
| F26 | self-minted identity | a key-only identity may be a tier-0 owner, yet gets no create quota or admission without a host-issued capability | — |
| F27 | custody | a missing or mismatched sequencer key → read-only at startup; no key is minted; a backup manifest without fingerprints and custody hash fails the check | — |
| F28–F31 | feature declarations (§F F-1) | unknown id in genesis; unknown `requiresAdd`; use before declaration; a `requiresAdd` that removes or reorders is invalid | — |

### Deferred (not part of the proven set)

- **F21 — historical identity-key verification is offline-stable (P4/P6).** A governance entry signed by an identity-tier owner verifies from the identity document version (or op-log CID) and proof history bound at the entry's `ts`, with the home node unreachable or rotated; a verifier that resolves the signer's current document must go red. Governance does not verify identity-tier signatures yet, so nothing implements or tests it today. It lands with that governance support.
- **F25 — repair-body provenance.** After a redaction only the commitment of a repair request's body remains, and the reader reports "provenance unavailable", never a guess. No writer puts provenance in a repair body yet, so nothing tests it today. It lands with the first repair writer.

### Mutation rules

- **M1 — every rename is load-bearing.** Removing any one rename or reader branch (`op`, `cascade`, `commitment`, `redacted`, each kind, `seq` in the checkpoint, `rewindWindow`, `snapshotJson`, the `for`/`grant` drop) makes its own fixture red, not merely some fixture. The mutation column above is that rule per row.
- **M2 — no old reader to run against.** Removed with the first-deploy ceremony. No kernel before this one was deployed, so no old reader is snapshotted. `spec/kernel-vectors/first-deploy/vectors.json` holds hand-written logs and the verdict the deployed reader gives each (control, stray `minor`, unknown envelope field, `v` 3, `v` 5, another dialect, kind `act`, unknown feature); kernel-check K3 runs them at every gate. A later kernel change brings its own vectors, red on this reader (snapshotted at re-pin as `old-fold.js`) and green on the new.

## §P Portable identity: what this freeze decides

Portable identity (one person, one identity across worlds and servers) is later work. Its research is in `docs/research/portable-identity.md` (research, not protocol law). The direction: a did:plc-shaped self-certifying id with ordered rotation keys and a recovery window, resolved through a home node the person chooses, bound to the log's opaque `u-` actor by a signed claim held outside the log. Only the items below touch this freeze; body signatures, the claim verb, delegation in request bodies, identity documents and pairwise ids are additive later.

- **P1** `actor` is an opaque `u-` id: never a DID string, a key, or `name@host`. By default it is a world-visible alias whose binding lives outside the log. A resident may elect one spelling across worlds, even the portable id itself, as an explicit choice; the host never does so by default, because that would make portability into global correlation by default.
- **P2** The envelope never carries an identity field (no `for`/`grant`/`proof`). Signatures, delegation and claims live in bodies, which hash as `{commitment}` and cost nothing later. A new envelope field would be a new `v`.
- **P3** Person ids are `u-` + lowercase base32 at **exactly two lengths**: `u-[a-z2-7]{20}` (today's mint) and `u-[a-z2-7]{24}` (reserved for a portable id). Not 20–32: reserving every length would reclassify legal entity ids as people. The shape checks (`ids.js PERSON_ID`, `componentspec.js`, `directory.ts isMinted`, `presencewire.js`, `names.js ACTOR_ID`) accept `{20}` or `{24}`. The v1 translator refuses an entity id already wearing the 24 shape (F19); the collision is resolved by hand. A future length is added before anyone mints entities in it.
- **P4** Genesis `owners` tiers may hold an identity as well as an `ed25519:` key, so a founder's lost key need not lose the world's governance. Genesis is in the world id, so this is reserved now.
- **P5** A claim (a stand-in becoming a real person) is a request verb plus system changes, never a new kind.
- **P6** Governance signatures are checked against the signer's identity as of `ts`, offline-stable: never against a key frozen in genesis, never against the home node's current document. The governance design binds the identity id, the identity document or op-log version (or CID), the key valid at `ts`, and the proof history needed offline (F21, deferred: no verifier exists yet).
- **P7** Actor history is never redactable. Revoking a local binding tombstones the directory relation, not the person and not their authored entries. Request and say bodies may be redacted as today; `actor` ids and commitments stay.

## §F Freeze contract

Fixtures F22–F31 in §5, except F25 (deferred, §5).

- **F-1 Feature declarations (kernel reservation).** Contract:
  ```text
  genesis.body.requires?: sorted, unique feature ids (absent = [])
  later activation: governance.body.requiresAdd only — signed/authorized
                    exactly like every other governance decision; no
                    system actor and no change/request may activate law
  semantics: monotonic union; never removed; must precede first use
  empty requiresAdd → invalid (requiresAdd-empty): a decision that changes nothing
  unknown id → the whole world is unsupported-feature at the declaring
               seq; no later entry is applied (no partial fold)
  feature id grammar (known to this reader from day one):
    ^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,47}@[1-9][0-9]{0,3}$
    i.e. namespace:name@major, ≤ 88 chars; ≤ 64 ids per world
    a new major is a new id; no ranges, no wildcards
  ```
  This reader implements no feature ids yet (`features.js KNOWN_FEATURES`, `reader.py KNOWN_FEATURES`).
- **F-2 Writer provenance.** Exact object (`shared/protocol/provenance.js`):
  ```json
  "provenance": {
    "registry": {"id": "registry-pin", "sha256": "<64 hex>"},
    "writer":   {"name": "<id: ^[a-z][a-z0-9-]{0,47}$>", "version": "<semver>",
                 "sourceRevision": "git:sha1:<40 hex>" | "git:sha256:<64 hex>",
                 "sourceTreeSha256": "<64 hex: the exact built/source tree>",
                 "dirty": false}
  }
  ```
  Every field is required; `sourceTreeSha256` is always written. `name` is a bounded identifier, so a new writer needs no protocol change. A world's founding provenance lives in `genesis.body.provenance`: genesis is in the world id and never redactable, so it stays readable. The v1 translator writes it there as writer `eidoverse-translate-v1` at version `<translator number>.0.0`. The `translated` request after genesis repeats it in its body, and the in-place translation's rollback manifest repeats it (`tools/protocol/world.ts`). `translated.body.from` names the parent and the v1 fold build, never the translator. Provenance in a repair request body is deferred (F25).
- **F-3 Join contract.** Internal order:
  ```text
  1. authenticate the principal
  2. validate the global hello {dialect, v, features}, exactly; no world lookup
     unknown dialect/v, a stray key (minor included), or a missing hello →
       {type:"refused", code:"update-required", need:{dialect, v}}
  3. authorize the requested world with no existence oracle: one discoverability
     predicate (server/access.ts discoverable) across /worlds, the join, /access and
     redial. Not discoverable → byte-equivalent to missing: same status / close code,
     body, wording, no exists field, no hint that tells them apart:
     {"code":"world-unavailable","message":"No accessible world named X."}
     Specific words only once the world is discoverable to that principal (public or
     listed to them, granted, or a bypass). The unauthenticated stay classified apart
     (sign in) from the signed-but-unentitled (world-unavailable).
     A world that can't open (an in-place conversion interrupted mid-swap, a world
     saved in an older format) is an unavailable state too: its diagnosis goes only
     to the operator and, for an old world, its recognised owner (server/access.ts
     toldOf, the same predicate, also behind the reads and the upgrade requests);
     to anyone else it is world-unavailable.
  4. only after access is granted, compare world.requires to client.features
     missing → {type:"refused", code:"unsupported-feature", need:[ids]}
  5. else the snapshot, repeating the authoritative {dialect, v, requires}
  ```
  `update-required` may precede world authorization; the world-specific `unsupported-feature` never may. Caveat: whoever may create a world can learn that a name is taken; the collision refusal stays generic (`"X" isn't available`), never whose or what kind. The hello is always required: there is no legacy default. Every client says a hello refusal in words (`shared/protocol/hello.js refusalWords`); an agent's join rejects with them instead of timing out. The same contract holds for browser, native, MCPL and agent joins.
- **F-4 Self-minted identity.** A key-only identity may be an owner, including tier 0. Identity is not admission: quota, rate and create-standing attach to a host-issued admission capability, never to the cheap key or id. A key proves continuity and authorship, not entitlement to resources.
- **F-5 Custody.** Invariant:
  ```text
  a genesis-changing rewrite (the v1 translation) precedes the first governance entry (D11)
  each backup manifest records the sequencer/operator public fingerprints + the custody-file hash
  an encrypted, offline custody backup exists and is restore-tested
  startup verifies the live custody keys against genesis / the latest governance
  missing or mismatched authority → read-only, never a replacement mint
  a translation's rollback manifest and the v1 and translated logs travel together
  ```
  Implemented today (`server/custodycheck.ts`): the startup check without minting, read-only on mismatch, and the backup manifest's fingerprints and custody hash, checked from its written bytes. No restore path reads the manifest yet, so restoration is not verified by code.
