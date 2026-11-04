# Log vocabulary: the term table, before any code

2026-11-04 · read-only against `wt-13teach` at 2a852459f. Answers the reviewer's (Mica's) request: one row per term with the exact referent, a real example, every surface, the hash/world-id effect, what the v1 translator would emit, and whether an old reader fails loud or misreads; the four contested referents settled; a six-entry story in the proposed words. Inputs: `RULING-act-change-2026-11-04.md` (act → request) and `REVIEW-log-vocabulary-2026-11-04.md`.

Examples are quoted from `spec/conformance/` and `spec/fixtures/` or lifted from the code that writes the entry; anything I assembled myself is marked **constructed**. No private world data is quoted.

## 0. Three facts every row depends on

**Three hashes, and what each one reads** (`shared/protocol/fold.js`, `spec/conformance/chain.py`, `server/custody.ts`):

| hash | input | changed by |
|---|---|---|
| **world id** | `sha256(JCS(genesis entry))` — the *whole* entry 0, envelope included (`fold.js:167 worldIdOf`) | any byte of genesis: its `verb: "genesis"`, its `minor`, a genesis body field's spelling |
| **chain head** | `head(i) = sha256(head(i-1) ‖ sha256(JCS(skeleton(i))))`; skeleton = entry minus `head`/`sig`, each set's `value`+`salt` → `commit`, an `act`/`say`/`sim` body → `{commit}` (`chain.py:79`) | any envelope key or value (`kind`, `verb`), any body key that survives into the skeleton (`ops`, `followUps`, `commit`, `id`, `comp`), and the chain rule's own list of "body-purgeable kinds" |
| **state digest** | `sha256(JCS(view))`, view = `{id: {comp: {"v": value} | {"purged": true}}}` (`fold.js:168–178`) | only the view: the marker key `purged`, and nothing else in this proposal |

Signatures are Ed25519 over `"eidoverse-head:<world id>:<seq>:<head hex>"` by the sequencer key named in genesis — the host's custody key (`server/custody.ts:74`). The reference server writes chain points on every entry (the physics fixtures carry `head`/`sig` on every line), so **every rename below that touches the skeleton re-hashes and re-signs every entry of every world**. That is exactly the act §12's reserved client head check exists to detect ("a sequencer rewriting its own history"), which is why the migration needs a published receipt (§6).

**How today's readers meet a word they don't know.** `fold.js checkEntry` (line 181–191) makes the *entry* malformed (`malformed:kind`, `malformed:unknown-field`, `malformed:envelope`, `malformed:batch-field`, `malformed:op-field`): it "shapes nothing and the reader reports it in diagnostics, never in the world" (§1). The fold's **status stays `ok`**. So a renamed entry is loud in diagnostics and silent in state; whether that is a misread depends on whether the entry ever shaped state (a `change` does; `act`/`sim`/`purge`/`sequencer` don't, but the readers that *do* read them — the sim layer, the governance refusal in `server/livehost.ts:87`, `replica.js:141`'s resync trigger — go quiet). `chain.py skeleton()` has no unknown-kind branch: it hashes the raw body, so a chain check on a renamed log reports `broken` at the first renamed line (loud). `reader.py` raises `Malformed("kind")` per entry, same as the JS fold.

The one thing that makes **every** old reader fail loud on the whole world is a `minor` the reader doesn't know (`fold.js:266 → status unknown-version, no world`). `minor` lives in the genesis body, so **bumping it changes every world's id**. §10 says a kernel change *is* a new minor "from release on" and allowed `followUps` at minor 0 only because it was fold-neutral. These renames are not fold-neutral for an old reader. This is the first decision the PR has to make, and it isn't a vocabulary question — see §6.

## 1. The table

Each row: **old → new** · referent · example · surfaces (wire / log / state / UI / code-only) · hash & world-id effect · v1 translator output · old reader. Surface counts are `grep` of kind-discriminator sites across `shared/ server/ client/ mcpl/ tools/ spec/conformance/` (comments and prose excluded where I could).

### 1.1 `act` → `request` (strong KEEP)

- **Referent.** A request as the authority admitted it, or as it refused it: the entry kind whose body is `{request: <args>, …}` when admitted (`authority/writes.js:60 actOf`) and `{args: [<arg names>], refused: {code}}` when refused (`authority.js:265`). Never read by the fold; read back by the authority for nine named fields (`spec/readback.json`).
- **Example** (`spec/conformance/physics/arc-onto-table.jsonl` line 3; chain fields elided):
  `{"kind":"act","actor":"rowan","verb":"set","body":{"request":{"id":"@world","component":"physics-engine","value":{"engine":"eidosim@1.0.0"}},"salt":"UUPZ_XwQSbZtpmdmt87bSQ"},"ts":1800000000200}`
  Refused shape, **constructed** from `authority.js:265`: `{"kind":"act","actor":"bob","verb":"delete","body":{"args":["id"],"refused":{"code":"locked"}},"ts":…}` (no public fixture holds a refused act).
- **Surfaces.** Wire: `log` entries carry it; the request message is already `request` (`docs/WIRE.md` §3). Log: `KINDS` (`fold.js:22`, `reader.py:39`), `chain.py:81` (body-purgeable kinds), `readback.json` keys `act:*` (8 rows → `request:*`: an acknowledged re-pin), `READBACK` in `verbclasses.js:28`. State: none (the fold never reads it). UI: `client/lib/historyrows.js:6` filters `kind === 'act'`; `mcpl/tools.ts historyLine`. Code-only: ~126 kind-discriminator sites, ~900 uses of the word `act`/`acts` in prose, comments and identifiers (`actOf`, `actEntry`, `actsOf`, `rollback.acts`, `rateCheck(w, actor, "act", …)`); `mcpl/agent.ts` has its *own* inbox `kind: "act"` (an agent event, not a log entry) at ~8 sites — a collision that outlives the rename unless the agent's word moves too.
- **Hash / world id.** Chain: every `act` skeleton changes (`kind` is in it) → every head after the first act, every signature. Digest: none. World id: none.
- **v1 translator.** `translate-v1.js:1070–1075, 1157` writes `kind: "act"` with verbs `translated`, `repair-shapes`, `translation-approved`, `imported {verb, args, from}` → each becomes `kind: "request"`. Note the imported body keeps v1's verb as provenance (`body.verb: "grant"`, `"ban"`, `"punt"` …).
- **Old reader.** JS fold / `reader.py`: `malformed:kind` per entry, status `ok`, state unchanged (correct by accident: acts never fold). `chain.py`: `broken`. Authority readback (`storage.js readback`): finds no `act:*` row → undo chains, sponsors, capability rights read as **unknown** → a silent misread of authorship and undo. `historyrows.js`: an empty History panel (silent).
- **Weakens it:** after the rename the admitted body reads `{"kind":"request", …, "body":{"request":{…}}}` — request-in-request. See §4.1.

### 1.2 `sim` (kind) → `physics` (strong KEEP); `sim` (actor) stays

- **Referent.** The authority's own record of a physics boundary: verbs `launch` (7 writers), `lift`, `catch`, `digest`, `checkpoint` (`grep kind: "sim"` in `authority/`). Written by the authority, never by a client, never refused; `actor` is the thrower/lifter for launch/lift/catch (`manipulate.js:281`, `bodyverbs.js:209`) and `sim` for digest/checkpoint (`physics.js:71`, `scriptrun.js:212`); `cause` is a request or, for a wake, the change that removed a support (`writes.js:114`). Read only by the sim layer (`simlayer.js:216–355`) and three readback rows.
- **Example** (`arc-onto-table.jsonl`, chain fields elided):
  `{"kind":"sim","actor":"rowan","cause":14,"verb":"launch","body":{"id":"ball","p":[0,1.1,-0.5],"yaw":0,"q":[0,0,0,1],"v":[0,2,3],"handled":["rowan"],"salt":"Gz4fypccq-7GOARwIgA8Vw"},"ts":1800000000800}`
  Checkpoint shape (`scriptrun.js:212`): `body {at, engine: {engine}, tick, clock, sim: <digest>, state: <blob>}` — note the body field named `sim` (the sim-layer digest) and `at` (a seq).
- **Surfaces.** Wire: `snapshot.cut.sim` (`WIRE.md:121, 223`). Log: `KINDS`, `chain.py:81`, `readback.json` `sim:launch/lift/catch` (re-pin), `READBACK`. State: none in the fold; the sim layer's state. UI: none in `client/lib` (zero `kind === 'sim'` sites — the client never branches on it). Code-only: ~104 kind sites; `simlayer.js`, `livehost.ts:135` (checkpoint scan), `undo.js`, `scriptaudit.js`; `spec/PHYSICS.md` names "`sim` entries" ~6 times.
- **Hash / world id.** Chain: every sim skeleton → every head after. Digest, world id: none.
- **v1 translator.** Never emits `sim`: since @11 "each rest is a plain change by `sim` caused by [the imported act]" (`import-v1/README.md`). Output unchanged except that the `actor: "sim"` on those changes stays `sim`.
- **Old reader.** Fold: `malformed:kind`, status `ok`. **Old sim layer never sees a launch** (`simlayer.js:216,295,351`) → it flies nothing, compares no digest, reports no disagreement: a silent misread of the physics plane (rest changes still fold, so the *state* is right; the engine's provenance is gone). Old `livehost.ts:135` finds no checkpoint → boots from genesis (slow, not wrong). `chain.py`: `broken`.
- **Note.** The checkpoint body keeps a field called `sim` (the sim-layer digest) and `at` (a seq). Under `kind: "physics"` the `sim` field is fine (it names the sim layer); `at` → `seq` goes with row 1.4.

### 1.3 `purge` → `redaction`; view marker `purged` → `redacted` (strong KEEP)

- **Referent.** Kind `purge`, body `{values: [{seq, op?}, …]}`: the operator's instruction, outside the request path, that named values fold as *absent(purged)*; the stored line of each target is rewritten with `value`+`salt` → `commit` so the skeleton (and every head) is unchanged (§12, `fold.js:347–365 purgesOf`).
- **Example** (`spec/conformance/logs/09-purge.jsonl` line 9): `{"ts":1,"world":"sha256:f39d7e…","kind":"purge","actor":"system","verb":"purge","body":{"values":[{"seq":3},{"seq":4,"op":1},{"seq":5},{"seq":6},{"seq":2}]}}` and the view it yields: `{"a":{"note":{"purged":true},…}}` (digest `7b42865a…`, `expected.json`).
- **Surfaces.** Wire: `snapshot.cut.state` wraps components `{v}` or `{purged: true}` (`WIRE.md:124`); a `purge` in the `log` stream forces a client resync (`replica.js:141`). Log: `KINDS`, `purgesOf`, diagnostics `purge`, `purge-ignored`, `purge-target-bad/-range/-not-a-value/-governance`, `purge-of-purge-refused`, `commit-unpurged`; `expected.json` code lists for logs 09, 20, 20b, 22. State: `PURGED` sentinel, `isPurged`, `canonicalView` (`fold.js:168–178`) — **the digest hashes the key `purged`**. UI: `editwrites.js:222` reads `v.purged === true`; `mcpl/tools.ts:410` prints "say (purged)". Code-only: ~56 kind sites, ~263 uses of `purged`, ~19 of `commit-unpurged`; `livehost.ts:133` (checkpoint candidates stop at the last purge), `scriptaudit.js`, `undo.js` (`purged`, `purgedOps`).
- **Hash / world id.** Chain: the purge entry's own skeleton (`kind`) → heads after it. **Digest: changes for every world that has a purged value** (`{"purged":true}` → `{"redacted":true}`); conformance logs 09, 20, 20b, 22 re-pinned. World id: none.
- **v1 translator.** Never emits a purge. No change.
- **Old reader.** Fold: `malformed:kind` on the redaction entry, status `ok` — but every target's stored line already carries `commit`, so `unnamedStubs` folds it *absent(purged)* anyway and diagnoses **`commit-unpurged`**: the state is right, the diagnosis says "the log was changed outside its purge rule", and `worldlog.ts:146` prints that as an operator warning. Loud, and wrong about why. Old client: no resync on the entry (`replica.js:141` lists `purge`), so a live client keeps the value in memory until it rejoins — a silent misread of a redaction, which is the one case where that matters. Digest comparison: loud.

### 1.4 `head` (seq sense) → `seq`; `head` (hash) stays (strong KEEP)

- **Referent.** Two things wear the word. (a) The chain hash on the envelope and in `parent {world, seq, head}` — kept. (b) A *position*: `cut.head` ("the fold at `head` … folds on from `head + 1`", `WIRE.md:124–126`), `worldlog.ts:184 get head(): number { return this.live.entries.length - 1 }`, `replica.js:110 v.head = snap.head`, the checkpoint body's `at` (`scriptrun.js:212`, checked `b.at !== s - 1` at `livehost.ts:136`), §5's "the log head at its join".
- **Example** (`worldlog.ts:434`, the join cut): `{ ...clientCutOf(this.live), head: this.head, mine, you: actor, names, holds }` — `head` here is an integer.
- **Surfaces.** Wire: `snapshot.cut.head` → `snapshot.seq`. Log: the checkpoint body `at` → `seq` (a physics body: purgeable, so it is hashed as `{commit}` — a chain change). State: none. UI: none. Code-only: `worldlog.ts:184,434`, `replica.js:5,110,117,138–140` (`v.head`), `livehost.ts:136`, `foldparity-check.ts`.
- **Hash / world id.** Chain: only via the checkpoint body rename. Digest, world id: none.
- **v1 translator.** Not involved (no wire, no checkpoints).
- **Old reader.** Old client `adopt(snap)`: `snap.head` undefined → `v.head = -1` → the first streamed entry's seq ≠ 0 → `resync` on every `log` message (`replica.js:138`): a loud resync loop. Old server reading a new checkpoint (`seq` not `at`): "checkpoint at N malformed; skipped" → boots from genesis (loud in the log, not wrong).

### 1.5 `verb` → `op` on `change`; `verb` only on `request` and `physics`; neither on `say` / `genesis` / `redaction` / `governance` (strong KEEP, **one trap**)

- **Referent.** `verb` on a change is one of the four storage operations (`OP_FIELDS` keys: `create/set/delete/batch`, `fold.js:193`); inside a batch each op item carries `verb` too (`shapeOne`, `opsOf`). On an act it is the request word; on a sim entry the physics event. On `say` and `genesis` it is the kind's name again (`verbs.js:51,93`; every fixture: `"kind": "genesis", … "verb": "genesis"`; `"kind": "purge", … "verb": "purge"`; `test_gov.py:30` `"kind": "sequencer", … "verb": "sequencer"`).
- **Example** (`EXAMPLE-01.jsonl` line 5): `{"kind":"change","ts":1,"actor":"system","cause":1,"verb":"batch","body":{"ops":[{"verb":"create","id":"chair"},{"verb":"set","id":"chair","comp":"example.com/seat@2","value":[1,2]},…]}}` → `"op":"batch","body":{"ops":[{"op":"create",…},{"op":"set",…}]}`.
- **Surfaces.** Wire: every `log` entry. Log: `ENVELOPE` gains `op` and a per-kind rule (`checkEntry:186` requires `verb` as a string on every entry today — the rule becomes "`op` on change, `verb` on request/physics, neither elsewhere, anything else malformed"); `OP_FIELDS`/`shapeOne` keyed by `op`; `reader.py:419`; `chain.py:85–88` reads `e["verb"]` and `o.get("verb")`; `kernelspec.js` envelope pin. State: none (the view doesn't carry the op). UI: `historyrows.js` reads `e.verb` on acts only — unchanged. Code-only: every `e.verb === "batch"` / `op.verb` reader in `fold.js`, `replica.js`, `simlayer.js:218+`, `scriptaudit.js`, `undo.js`, `followups.js`, `writes.js`, `livehost.ts`; `governanceTarget` (`fold.js:310`).
- **Hash / world id.** Chain: every change skeleton (`verb` → `op`, item keys) → every head. Digest: none. **World id: dropping `verb: "genesis"` from entry 0 changes every world's id** (`worldIdOf` hashes the whole genesis entry). That is the trap: the "no tautological verb" rule, applied to genesis, costs every link, every fork's `parent.world`, every bookmark — the same cost the review reserved for `rewind_window`. Options in §4.5.
- **v1 translator.** Emits changes via `changeBody(ops)` (`translate-v1.js:1136,1145,1170`) and `verb: "say"` on says, `verb: "genesis"` on genesis (`:1064`) → `op`, and no verb on says; genesis per the decision.
- **Old reader.** A change with `op` and no `verb`: `malformed:envelope "verb missing or not a string"` → **the change is dropped, status stays `ok`, the digest is wrong**: the quietest misread in the set. A genesis without `verb`: the same check → `no-genesis` → status `no-world` (loud). `chain.py`: `KeyError` on `e["verb"]` for a change → crash (loud, ugly).

### 1.6 `followUps` → `cascade` (strong KEEP)

- **Referent.** On a batch body: a non-empty strictly ascending list of indices into `ops` naming the ops the authority derived from the asker's own (a deletion's reference clears and set-downs; an undo's restores), admitted without the asker's rights or locks; readers deriving authorship skip them (§3, `followUpsCheck`, `followUpsOf`).
- **Example** (`spec/conformance/logs/06b-followups.jsonl` line 3): `{"kind":"change","ts":1,"actor":"system","cause":1,"verb":"batch","body":{"ops":[{"verb":"create","id":"a"},{"verb":"set","id":"a","comp":"label","value":"x"}],"followUps":[1]}}`.
- **Surfaces.** Wire: in `log` entries. Log: `BATCH_FIELDS`, `followUpsCheck`, diagnostic `batch-followups` (logs 06b–06g in `expected.json`), `reader.py`. State: none (the fold applies marked ops like any). UI: none directly; Credits ranks by authorship, which skips marked ops (`historyrows.js` via `rights.js`). Code-only: ~59 sites; `authority/followups.js` (file name), `gate.js`, `rights.js`, `undo.js`, `writes.js`, `scriptaudit.js`; §3, §7's table column "marked", §10's history line.
- **Hash / world id.** Chain: every batch carrying it → heads after. Digest, world id: none.
- **v1 translator.** Never writes `followUps` (no occurrence in `translate-v1.js`): its system changes carry no marked ops. No change to its output.
- **Old reader.** `malformed:batch-field "cascade"` → **whole entry dropped, status `ok`, digest wrong**: silent misread.

### 1.7 `by` (envelope) retired (strong KEEP)

- **Referent.** A legacy alias of `actor` the lab wrote; "every reader MUST ignore it. Writers MUST NOT write it" (§1). In `ENVELOPE` (`fold.js:21`, `reader.py:40`) only so an old lab log isn't malformed. Presence's `drag.by`, `holds.by`, `moderated.by`, `vacated.by` are a different plane (never logged) and stay.
- **Example.** No public fixture carries it.
- **Surfaces.** Log: `ENVELOPE`, `reader.py`, §1 table, kernel pin. Nothing else.
- **Hash.** None unless a stored line carries it (then its skeleton changes when the translator strips it). World id: none.
- **v1 translator.** Never emits it; a translator step strips it from any lab log.
- **Old reader.** Ignores it; a new reader on an old line with `by`: `malformed:unknown-field`. Fails loud in the right direction.

### 1.8 `cut` → `snapshot` (wire) (strong KEEP)

- **Referent.** The fold handed to a joiner at seq N: wire message `snapshot` with payload `cut: {dialect, v, head, worldId, verbs, state, sim, names, holds, mine, you}` (`WIRE.md:120–126`, `worldlog.ts:429–434 clientCut`, `replica.js:5 adopt(snap)`); never logged, verified by folding forward. Also "epoch cut" in `simlayer.js` prose (an epoch boundary).
- **Surfaces.** Wire only: the `snapshot` message's `cut` key (flatten: `{world, you, gen, seq, state, physics, names, holds, mine, …}`), `cut.sim` → `physics` (row 1.2), `cut.head` → `seq` (row 1.4). Code-only: `clientCutOf`, `clientCut`, `cutNow`, `simCutOf`, `cutJson` in the checkpoint blob (`scriptrun.js:211` — a *blob* key: renaming it changes nothing hashed, but old blobs keep `cutJson`, so the reader keeps both spellings or re-blobs), `refusalcodes.js` wording for `legacy`/`busy`; ~240 `cut` sites, many unrelated English.
- **Hash / world id.** None (nothing logged). The checkpoint blob's `cutJson` key is referenced by hash from a physics body: leave the stored key, or re-blob.
- **v1 translator.** Not involved.
- **Old reader.** Old client: `msg.cut` undefined → `adopt(undefined)` throws → loud.

### 1.9 `rewind_window` → `rewindWindow` (strong KEEP, conditional)

- **Referent.** A reserved, optional genesis-body field: the draft governance rewind window, a non-negative integer (`GENESIS_FIELDS`, `fold.js:275`, `gov.py DEFAULT_WINDOW`).
- **Example** (`19o-genesis-full.jsonl` line 1): `… "quorum": [1, 2], "rewind_window": 500, "parent": {"world": "sha256:abab…", "seq": 12, "head": "cdcd…"} …`.
- **Surfaces.** Log: `GENESIS_FIELDS`, `checkGenesis`, `reader.py:215`, `gov.py`, §13; ~11 sites. Conformance logs 19m, 19o re-pinned (their world ids change: 19o's `sha256:5a948c38…` is hashed from that genesis).
- **Hash / world id.** **World id of any genesis carrying it.** On this host no stored genesis carries it (0 of 6 genesis files, counted, not read). So it is free today *if minor stays 0*, and moot if minor bumps (every id changes then anyway).
- **Old reader.** `malformed:genesis-field "rewindWindow"` → `no-world`. Loud.

### 1.10 The four-line glossary: `authority` / `sequencer` / `operator` / `host` (strong KEEP)

No referent change; prose only (§7a "The parties"). Today: `authority` = the gate that admits or refuses (`shared/protocol/authority.js`); `sequencer` = the chain-writer role whose key genesis names (`body.sequencer`, `custody.ts sign`); `operator` = the human in custody of the host (the operator key, `operator-repair`, the purge decider); `host` = the machine/service (`livehost.ts`, "a host's custody keys"). All four are used consistently in code. Nothing hashed.

### 1.11 `grant` (envelope) → `delegation` (contested) — see §2.1

- **Referent.** A reserved, never-written, never-checked envelope field paired with `for`: "reserved for acting on someone's behalf; until identities have keys, an entry carrying `for` is malformed (`grant` is reserved and not yet checked)" (§1). `checkEntry:189` refuses `for`; nothing reads `grant`.
- **Example.** None exists in any log or fixture; the field has never been written.
- **Surfaces.** Log: `ENVELOPE` (`fold.js:21`), `reader.py:40`, kernel pin `envelope.fields`, §1 table — 7 sites. Nothing else. The *other* `grant` — a role grant — lives in `roles:<id>` components, `gate.js:238 needOf → "grant"`, `access.js` "timed grant", the `grantRoles` permission, `verbspec.js:163`'s retired v1 verb `grant`, and ~40 prose sites; none of those is the envelope field.
- **Hash / world id.** None (never written). Kernel pin: an envelope-field rename is a kernel change (K2) even unwritten.
- **v1 translator.** v1 logs have a `grant` *verb* (`mainknew.ts:38`, `PERSON_REQUESTS` in `translate-v1.js:709`); it is carried as `body.verb: "grant"` inside an `imported` request forever. The envelope field never appears in translator output.
- **Old reader.** A new line carrying `delegation`: `malformed:unknown-field` (loud) — but no line will carry it until keys exist.

### 1.12 `commit` (§12 field) → `commitment` (contested) — see §2.2

- **Referent.** On a `set` op (or batch item), the hex `sha256(UTF-8(salt) ‖ UTF-8(JCS(value)))` that stands in for `value`+`salt` after a redaction; on an `act`/`say`/`sim` body, the same over the body. Computed for **every** set and every body in the chain skeleton whether or not anything was redacted (`chain.py:56–77`); stored only after a redaction. The fold ignores it except to mark a stripped op (`shapeOne:232`, `unnamedStubs`).
- **Example** (`20b-commit-unpurged.jsonl` line 4): `{"kind":"change","ts":1,"actor":"system","cause":1,"verb":"set","body":{"id":"@world","comp":"roles:u-bbbb…","commit":"0000…0000"}}`.
- **Surfaces.** Wire: a redacted line in the `log` stream and in `history` reads carries it; `mcpl/tools.ts:410` prints "say (purged)" when `b.commit !== undefined`; `worldlog.ts:380` reads `e.body?.commit` on says. Log: `OP_FIELDS.set`, `BATCH_FIELDS` comment, `chain.py` (`commit_of`, `skel_op`, `body_commit`), diagnostic `commit-unpurged` (log 20b), §12. State: none. UI: none. Code-only: ~19 `commit-unpurged` sites; `txn: committed` (§7) is a different word and stays.
- **Hash / world id.** **Chain: every head** — the key name `commit` is inside every skeleton's set op and purgeable body, redacted or not. Digest, world id: none.
- **v1 translator.** Never writes a redacted line.
- **Old reader.** A redacted line with `commitment`: `malformed:op-field` → **the change dropped, status `ok`**, and since the value is gone anyway the state is the same (*absent*) — but the diagnostic is wrong and `unnamedStubs` no longer sees a stub. Silent-ish. `chain.py`: hashes `commitment` as an ordinary key → `broken`.

### 1.13 `sequencer` (kind) → `governance` (contested) — see §2.3; `sequencer` (role, genesis field) stays

- **Referent.** The entry kind whose body is one of: a handoff `{key, sigs}`; an owners override `{owners, sigs}`; a reclaim `{key, sigs}` by a higher tier; a rewind `{fork: {seq, head}, sigs}`; plus the reserved `checkpoint` (a trusted fold) — exactly `GOV_FIELDS = {key, owners, fork, sigs}` and `RESERVED_GOV = {checkpoint}` (`gov.py:17–20, 95–180`). The reference server never writes one and refuses to serve a log that holds one (`livehost.ts:87`).
- **Example** (**constructed** by `test_gov.py:30`, the only writer in the repository): `{"world": wid, "kind": "sequencer", "ts": 1, "actor": "system", "verb": "sequencer", "body": {"key": "ed25519:…", "sigs": [{"key": "ed25519:…", "v": "<base64url sig>"}]}}`.
- **Surfaces.** Wire: `replica.js:141` resyncs on it. Log: `KINDS`, `gov.py`, `livehost.ts:87`, `foldparity-check.ts:177`, `gov-reserved-check.ts:20`, §1, §2 ("a governance entry (`kind: "sequencer"`)"), §13 — 5 code sites. State: none (the fold never reads it). UI: none.
- **Hash / world id.** Chain: its own skeleton → heads after. Digest, world id: none. The genesis field `sequencer` is untouched (so no world-id effect).
- **v1 translator.** Never emits one.
- **Old reader.** Fold: `malformed:kind`, status `ok`. **Old server: the `livehost.ts:87` refusal doesn't fire, so an old server serves and writes past a governance entry it can't check** — precisely the hazard §13 wrote the refusal for. Silent, and the worst misread in the table. (A minor bump closes it.)

### 1.14 `kind.js` entity kind → `form` (contested, code-only) — see §2.4

- **Referent.** `kindOf(record) → 'socket' | 'model' | 'mesh' | 'light' | 'empty'` (`shared/protocol/kind.js`): a *derived* classification with a precedence rule (socket first; model over mesh over light; else empty), never stored, never on the wire ("a view record never carries `kind`", `kind.js:11`). Used for drawing (`client/lib/world.js`, `realize/models.js`, `inspect.js`), capacity counting (`authority/capacity.js`), gating (`gate.js`), storage and routes (16 files, ~125 call sites). Exported as `KINDS`, the same name as `fold.js`'s entry-kind set.
- **Example.** `kindOf({c: {model: "lib/lamp.glb", light: {…}}}) === "model"` (the lamp case the file's header describes).
- **Surfaces.** Code-only. Not wire, not log, not state, not digest.
- **Old reader.** Not applicable.

### 1.15 Smaller rows the review added

| old → new | referent | surfaces | hash | old reader |
|---|---|---|---|---|
| request-batch `ops` → `requests`; refusal `op: i` → `index: i` | a batch *request*'s children `{verb, args}` (`verbs.js:128–138`, checked "exactly as it would be alone"); the reply's index of the refused child (the `{op: i}` fourth arg to `refuse`) | wire (`request` message body, `reply.refused`), `verbs.js`, `requests.js`, agent tool schemas, `refusalcodes.js` prose | none: a request body is purgeable and hashed as `{commit}`, so the *admitted* act's chain skeleton changes only through the body commit — which changes, since `body.request.ops` → `body.request.requests` | an old authority refuses the new shape (`shape` code) — loud at the door |
| actor `world` | listed in §6, never written by this protocol; it is a **v1 actor** (`mainknew.ts:41` lists v1's `door`, `world`, `sim`) | §6 only | none | — |
| `salt` | keep, gloss | — | — | — |
| `digest` | keep, gloss "the physics digest" | — | — | — |

## 2. The four contested referents

### 2.1 `grant` (envelope) → `delegation`. Recommend **`delegation`**; it is never the role grant.

What the field is: a reserved slot on the *entry* that, once identities have keys, will carry the proof by which `actor` acts `for` someone else. It is per-entry, travels with the write, and is checked (eventually) at admission. The durable role grant is a different object entirely: a `roles:<id>` component on `@world` with `{role, until?}`, written by a `set` through the gate's `grant` need-class (`gate.js:238`), expired by `expire-roles`, read by `access.js`. One is a credential presented with a request; the other is state. They never meet: `needOf` returns `"grant"` for a roles write and nothing about the envelope; the envelope field is read by nothing.

Can `delegation` ever drift into meaning the durable grant? Only if someone later stores a delegation *as* a component, and the registry (§4) would have to name that component — at which point it would be `delegation:<id>` and the collision would be visible on the page. The word's referent in UCAN (a signed, chained capability token presented with a call) is exactly the per-entry object here. The alternatives: `capability` is already a readback field (`act:use` → `capability.author`, "the system's capability" in §7's table) and would make three meanings; `warrant`/`proxy` are plain but have no industry referent; `token` is the wire's auth word (`join {token}`). One more reason to move off `grant`: every translated world carries `body.verb: "grant"` inside its `imported` requests forever (row 1.11), so `grant` on the envelope would sit two keys away from `grant` meaning v1's role verb.

Spec sentence to pin it: "`for` names whom the actor acts for; `delegation` is the credential by which they may. A role someone *holds* is a `roles:<id>` component, never a delegation."

### 2.2 `commit` (§12) → `commitment`. Recommend **`commitment`**, with `seal` as the honest runner-up.

The exact object (`chain.py:56–77`, §12): `hex sha256(UTF-8(salt) ‖ UTF-8(JCS(value)))` — a *salted hash of one value*. It is computed for every set op and every purgeable body when the chain is verified, and stored only once a redaction has stripped the value. Its two properties are a cryptographer's **commitment**: binding (the hash fixes the value) and hiding (the salt stops a dictionary guess). It is not a checkpoint (that is a whole folded view or engine state written into the log — §2, `scriptrun.js:212`), not a decision (nothing is decided; the operator's decision is the `redaction` entry), not a transaction commit (`txn: committed`, §7). Against the candidates:

- `commitment` — the exact term; §12 already says "replaces `value` + `salt` with `commit`" and could say "with its commitment". The promise/vow sense is real in this community, but the field holds 64 hex characters next to `id` and `comp`; nobody reads a vow into `"commitment":"3f9a…"`, and the gloss "a commitment to the value: its salted hash" settles it in one clause.
- `seal` — short, a noun, plain English ("a sealed value"), no git/txn/vow sense, and "the seal still verifies" reads well. Its cost: no industry referent (a verifier reading "seal" doesn't know it means H(salt‖value) until told), and "seal" also suggests the operator *sealed* it, which is the redaction, not the hash.
- `checkpoint`, `decision` — wrong referent (above). `digest` — already the state digest and a physics verb. `hash` — too generic; scripts and blobs have hashes. `hidden`/`redactedValue` — describes the stored case only, but the chain computes it for every value.

Diagnostic: `commit-unpurged` → `commitment-unredacted` (one word, one meaning).

### 2.3 `sequencer` (kind) → `governance`. Recommend **`governance`**; the kind holds nothing but governance.

What every valid entry of the kind contains, from the only reader (`gov.py`): `GOV_FIELDS = {key, owners, fork, sigs}`; an entry naming none of `key`/`owners`/`fork` is "changes nothing" and invalid. The four acts it classifies: **handoff** (`key` signed by the outgoing sequencer), **reclaim** (`key` by a higher tier), **owners** (an `owners` tiers override), **rewind** (`fork {seq, head}`, orphaning a branch). The reserved fifth, `checkpoint`, is "a folded view readers may *trust*" — an attestation signed by governance keys, refused by name today. Every one of these is a decision about who writes the world or what its trusted history is. **Nothing administrative lives there**: maintenance (`repair`, `lift-sockets`, `rename-components`, `expire-roles`, `restamp-engine`) is written as `act` by actor `system` (§7's table), and the engine's own checkpoint is a `sim` verb. So the name does not overstate; it says what the four bodies are and what `sequencer` (the role) only named by its author. The role keeps its word (genesis `sequencer`, the signing key, §12 "the sequencer's chain fields"), which is also why the kind must move: today one word is a kind, a role and a genesis field (`fold.js:22,240,272`).

### 2.4 `kind.js` → `form`. Recommend **`form`** (`formOf`, `FORMS`); not `entityType`, not `archetype`.

The values: `socket`, `model`, `mesh`, `light`, `empty`, chosen by precedence from the components a record carries. Against the candidates, on those values:

- `entityType` reads as a *stored* field on the entity. `kind.js:11–13` exists to warn that it is not one ("readers that branch on `ent.kind === 'light'` are reading a field that is never there"); `entityType` rebuilds the trap under a name that promises a field even more strongly. It also suggests a type system (TS `type`), and `type` is Matrix's word for the entry discriminator.
- `archetype` is Bevy/DOTS vocabulary for the *exact component set* of an entity. A lamp with `model` + `light` is one archetype there and the value `model` here; a `socket` with a `light` is `socket` here. The precedence rule means these five values are not archetypes, and an ECS reader would expect them to be.
- `shape` (taken: `mesh.shape`, `physics.shape`), `body` (taken), `drawAs` (honest for four values, wrong for `socket`, which is an attachment point and draws nothing; and `capacity.js`/`gate.js` use the value for counting and gating, not drawing).
- `form` — "what form the thing takes": derived, five-valued, not a field, and free in the protocol (the only nearby use is "spoken form" in a test name). Short enough that `formOf(x) === "light"` reads as it should.

## 3. The six-entry story

World id `W` = `sha256:f39d7e442c2b3ef3be1cd02b04550c07f584bc903ade4afa1ea8d19389907ce1` (the conformance genesis; its genesis line is unchanged and omitted). **Constructed** from the writers cited in §1; `head`/`sig` elided as the wire elides them; salts shortened. Alice deletes a shelf a vase rested on; Bob tries to delete a locked lamp; the deletion cascades the vase's set-down and wakes it into the engine; the operator redacts Alice's request body; the sequencer hands the writer role on.

```jsonl
{"world":"W","kind":"request","ts":1001,"actor":"alice","verb":"delete","body":{"request":{"id":"shelf"},"salt":"g1ZD…"}}
{"world":"W","kind":"request","ts":1002,"actor":"bob","verb":"delete","body":{"args":["id"],"refused":{"code":"locked"},"salt":"ZYAb…"}}
{"world":"W","kind":"change","ts":1001,"actor":"alice","cause":1,"op":"batch","body":{"ops":[{"op":"delete","id":"shelf"},{"op":"set","id":"vase","comp":"transform","value":{"p":[0,0.9,0]},"salt":"5hGJ…"}],"cascade":[1]}}
{"world":"W","kind":"physics","ts":1001,"actor":"alice","cause":3,"verb":"launch","body":{"id":"vase","p":[0,0.9,0],"yaw":0,"v":[0,0,0],"handled":["alice"],"salt":"Gz4f…"}}
{"world":"W","kind":"redaction","ts":1003,"actor":"system","body":{"values":[{"seq":1}]}}
{"world":"W","kind":"governance","ts":1004,"actor":"system","body":{"key":"ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic","sigs":[{"key":"ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic","v":"<base64url>"}]}}
```

After the redaction, line 1 as stored becomes `{"world":"W","kind":"request","ts":1001,"actor":"alice","verb":"delete","body":{"commitment":"<hex sha256(salt‖JCS(body))>"}}` — same skeleton, same head.

(Line 3's `ts` equals line 1's because a request and its change share the admission time, as in the fixtures; line 2 was admitted between them in the story only to put the refusal second — in a real log it would carry the later ts and sit after line 4. The order Mica asked for is the point; the ts rule is unaffected.)

**Read back as prose.** 1: Alice *requested* `delete shelf`. 2: Bob *requested* `delete` and was *refused*, `locked` — the record keeps that he tried, the name of the one argument he sent, and nothing he typed. 3: the world *changed* because of 1: a batch of two ops, the shelf deleted and the vase set down, the second op a *cascade* of the first (not Alice's authorship). 4: a *physics* entry, caused by that change: the vase was *launched* at rest where it was set down, Alice handling it. 5: a *redaction* by the system of what line 1 said; its *commitment* still hashes. 6: a *governance* entry: the writer role handed to a key, signed by the outgoing sequencer.

**Honest reading of the nouns.** Five of six read cleanly cold. The ones that make a stranger pause:

- `"kind":"request"` with `"body":{"request":…}` (line 1): a stutter. "The request's request" is the admitted-args key, and it stands beside the refused line's `"args":[…]` — two spellings for "what was asked", one an object and one a list of names. The rename exposes it; it didn't create it. §4.1.
- `"kind":"physics","actor":"alice"` (line 4): a reader asks why Alice is the actor of a physics entry. She is the handler (the thrower, here the deleter who woke it), as today under `sim`; the kind is now honest about what the entry is, and `actor` is honest about whose doing it was. It reads better than `kind: "sim", actor: "alice"`, which read as a contradiction.
- `"op":"batch"` whose body holds `"ops":[{"op":…}]` (line 3): "an op of ops" is a little recursive but it is what Automerge and the oplog say, and `batch` is the one op that contains ops. Fine.
- `redaction` and `governance` with no `verb` and actor `system`: both read as nouns for what the entry *is*, and the missing verb is not missed. `cascade: [1]` reads as "op 1 cascaded from op 0", which is the truth.

Nothing reads badly enough to re-pick a noun. The request/request stutter is the one thing I'd fix in the same PR rather than leave for a stranger to find.

## 4. What surprised me, and what weakens a strong KEEP

### 4.1 The admitted body's `request` key stutters under the new kind
`writes.js:60` writes an admitted act's body as `{request: args, …}`; the refused record (`authority.js:265`) writes `{args: [names], refused: {code}}`. Under `kind: "request"` the first becomes request-in-request, and the two spellings of "what was asked" were already inconsistent (object vs name-list under different keys). Options: (a) admitted `{args: {…}}`, refused `{argNames: […], refused}` — the wire already says `{verb, args}` (`WIRE.md` §3), so `args` on the log matches the wire; the four readback rows that read `request.id/.label/.component/.brush` are re-pinned to `args.*`. (b) Leave it and gloss. I'd do (a) in the same PR: it is one more skeleton change on entries that are all re-hashed anyway, and it is the one place the six-entry story reads badly. It is not in Mica's list, so it is a decision to put to her, not to slip in.

### 4.2 Dropping `verb: "genesis"` changes every world id
`worldIdOf = sha256(JCS(genesis))` over the whole entry. "Verb only on requests and physics" applied to entry 0 costs every world's id — the same cost the review reserved for `rewind_window` and the reason it said "do it now or never". The review's list of what the verb-drop carries (`verbs.js:51,93` stop writing it) missed this. Choices in §4.5.

### 4.3 `commit` is in every skeleton, not only redacted lines
`chain.py skel_op` puts `commit` into the skeleton of **every** set op and every purgeable body whether or not a redaction happened. The review said the field "appears only in redacted lines and skeletons, so length is free" — true, but "and skeletons" means every chain head of every world changes with the rename, not only purged ones. Since the kind renames already re-hash everything, this adds no cost; it does mean `commitment` can't be done *later* on its own cheaply.

### 4.4 Old readers mostly misread quietly; only a minor bump makes them fail loud
Per-entry `malformed:*` diagnostics leave status `ok`. For `change` (`verb` → `op`, `cascade`, `commitment`) the dropped entry means a **wrong digest with status `ok`**; for `governance` the old server's reserved-governance refusal **doesn't fire** and it writes past an entry it can't check; for `redaction` an old live client keeps the value until rejoin. `chain.py` is loud (`broken` or a `KeyError`). The kernel gate's vector verdict (`kernel-check.ts:41–43`) counts any diagnostic as a refusal, so the gate will accept vectors that an old *fold* in fact reads to a wrong-but-`ok` world. If the PR wants "old reader fails loud" to be true of the world and not just the line, it bumps `minor` — and `minor` is in genesis.

### 4.5 So the real decision is `minor` 1 (every world id changes, every old reader refuses cleanly) vs minor 0 (ids stable, old readers misread)
§10's own rule is minor 1 "from release on"; the kernel pin still says `trial-kernel` and `history/PRE-RELEASE-RENAMES.md` says "before release", so minor 0 is *allowed* by the letter — but §10 allowed it for `followUps` because every reader folded to the same digest with or without it, and that is false here (4.4). If minor bumps: `rewindWindow` is free, the genesis verb can go (the id changes anyway), and 4.2 stops being a separate cost; every `world` field on every line, every `parent.world` in forks, every bookmark and link is rewritten by the translator, and the receipt must map old id → new id. If minor stays 0: keep `verb: "genesis"` as the one tautology the world id freezes (say so in §13), keep `rewind_window` only if a reader insists on never changing an id, and accept that old readers read a wrong-but-`ok` world. I'd bump: the whole point of the exercise is that a 2035 reader meets one vocabulary, and a world that an old reader folds to a different digest with status `ok` is the failure mode §10 was written to forbid.

### 4.6 The hash migration receipt, as the facts above shape it
Per world: `{oldWorldId, newWorldId?, translator: "eidoverse/translate-v1@N+1", entries: n, heads: [{seq, old, new}] or a Merkle root over them, oldLastHead, newLastHead, sequencerKey, signature over (oldWorldId ‖ newWorldId ‖ oldLastHead ‖ newLastHead)}` plus the digest before and after (equal unless the world had a redaction, in which case the `purged`→`redacted` key change explains the difference). Published beside the log, because re-chaining and re-signing is byte-for-byte what §12's reserved head check exists to catch; the receipt is how a later verifier tells the migration from the attack.

### 4.7 Smaller surprises
- Actor `world` is a **v1 actor** (`mainknew.ts:41` lists v1's `door`, `world`, `sim`); §6 inherited it. Drop it from the actor set; `system` covers the authority's writes.
- `mcpl/agent.ts` has an inbox event `kind: "act"` (~8 sites) that is not a log entry. After the log says `request`, the agent's `act` stops colliding with the log's — and starts meaning something the log no longer has a word for. Either is fine; say which.
- The physics checkpoint body (`scriptrun.js:212`) carries both `at` (a seq → `seq`, row 1.4) and a field named `sim` (the sim-layer digest). Under `kind: "physics"` the body field `sim` is the one place the old kind's word survives in a body; it names the sim layer, which keeps its name, so it can stay.
- The checkpoint blob's `cutJson` key is behind a blob hash in a physics body: `cut` → `snapshot` can't rename a stored blob's key without re-blobbing; the reader accepts both or the translator re-blobs.
- No public fixture holds a refused act, a `say`, a `digest` entry or a `sequencer` entry; the conformance suite tests their *absence* well and their presence not at all. The mutation suite Mica asked for is where those shapes get their first vectors.
- `kind.js` and `fold.js` both export `KINDS` — the review's finding, confirmed; 16 importing files.
