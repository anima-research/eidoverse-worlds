# DESIGN: transaction outcomes + one immutable request capability (2026-10-18)

Written against commit a732d74e, answering the reviewer's two pre-re-review requirements (transaction outcomes, one request capability). Line references are to that commit; the shipped code moved some (see `server/reqcap.ts`, `shared/protocol/authority/storage.js` txnOutcome, `server/worldlog.ts` request).

## 1. How a request flows now

1. `server/server.ts:1238-1239` — the ws envelope dispatches `request` to `REQUEST_MESSAGES.request` (`server/requestwire.ts:112`); any throw is caught at :1242-1244 and answered with a bare `{type:"error"}` (no request id).
2. `requestwire.ts:119` spectator check, :130 caption gen stamp, :134-136 `still()` closure (captures `gen`; compares `c.world===w`, `!c.superseded`, `w.clients.has(c)`, `c.gen===gen`).
3. **Await #1** — `inOrder` (`requestwire.ts:100-107`): the per-connection promise chain; `still()` re-run at :138 when the turn comes.
4. **Await #2** — `WorldLog.request` (`server/worldlog.ts:156-161`): `await warm(modelsIn(args))` (`server/modelcatalogue.ts:75`), then `still()` (B4), then `requestSync`.
5. `requestSync` (`worldlog.ts:162-171`) → `authorityRequest` (`shared/protocol/authority.js:111-169`), fully synchronous ("nothing in the authority awaits", `authority/ctx.js:5`). Rights are read there, live, against `w.state()`: ban/kick/none/ghost at `authority.js:131-140`; `admit(w, st, {actor, cap}, ops)` in `gate.js:88` for every change; `commit` in `writes.js:60-110`.
6. Writes: `w.append` (`storage.js:114-122`) renders, `durably("log", () => io.writeLine(line))` (:118), then pushes to `entries` (:119). `io.writeLine` = `appendDurable` (`server/durable.ts:23-27`: open/append, `writeSync`, `fsyncSync`, close). B1's wedge (`storage.js:62-65`) refuses all later writes to that file after any throw.
7. Publish: `requestSync` :167 `afterWrite(from)` broadcasts `{type:"log", entries}` (`worldlog.ts:266-284`), then `reply(r)` at `requestwire.ts:144`.

Rights *inside* the authority are therefore never stale: they are read in the same synchronous call that commits. The stale-capability risk lives entirely in the server layer, between step 2 and step 5: what `still()` does **not** cover.

### What B1/B4 already give
- B1: a line is durable before the live chain sees it; a failed write wedges the file.
- B4: liveness of the *connection* (world, superseded, membership, gen) is rechecked after await #2.

## 2. Violations / gaps found

| # | file:line | problem |
|---|---|---|
| X1 | `writes.js:83-87`, `followups.js:93-95` | One request appends 2..N lines, each its own durable write. If `changeEntry` (:84) throws after `w.append(actE)` (:83) landed, the act is durable and in `entries` without its change; `w.fits` (:80) checks shape, not write success. There is no multi-entry transaction. |
| X2 | `worldlog.ts:166-167` | `afterWrite` is not in `finally`: when the authority throws mid-commit, lines already appended (X1's act, or sim lines from `settleSim`/`returnDue` at `authority.js:145`) are durable + live on the server but **never published**; every client's chain is now behind the server's and the next broadcast's `from` skips them. (`tickScripts`/`settle` :234/:251 do use `finally`.) |
| X3 | `storage.js:65`, `durable.ts:26`, `requestwire.ts:102-103` | An fsync/close throw after `writeSync` is **ambiguous** (bytes may be on disk). It is reported as a generic failure with no request id. On reopen the line may be found and folded: the asker was told "failed", the world says "happened". Not fail-closed in the stated sense (unknown ≠ failure). |
| X4 | `durable.ts:26` | `fs.writeSync` return value ignored: a short write is treated as a full write (torn line in `entries`, trimmed only at next reopen). |
| V5 | `requestwire.ts:142,163-164` | `actorOf(c)` is read **after** both awaits, from the mutable `c.actorId` (reset at `server.ts:414`, reassigned at :563 on a re-join over the same socket). `gen` catches a *completed* re-join; a re-join in flight yields `undefined` → throw → X3's path. The identity should be captured once. |
| V6 | `requestwire.ts:119`, `:206-210` | `c.spectator`, `c.account`/`isOperator` are checked before the queue only; the post-await recheck (:210) doesn't repeat them. |
| V7 | `requestwire.ts:135` vs `server/access.ts:109-140` | Door entry (members mode, `nativeWorld` narrowing, account age, global bans) is decided at join only; a later `@world.access` change is enforced by `sweepAccess` (1 s cadence). A queued request from a now-unentitled connection can commit in that window: the authority checks role, not the door. |

## 3. Design (smallest honest change)

### 3a. Request capability — `server/reqcap.ts` (new, ~40 lines)

```ts
export type ReqCap = Readonly<{ c: Client; w: World; gen: number; actorId: string; account: string|null;
  spectator: boolean; operator: boolean; nativeWorld: string|null; addr: string|null; role: string }>;
export function capture(c: Client, w: World): ReqCap          // Object.freeze; actorOf(c) throws if no id
export function recheck(cap: ReqCap, now = Date.now()): string | null   // null = may proceed, else refusal words
```
`recheck` compares the frozen snapshot against the live connection and world, and fails if any differs:
- liveness (today's `still`): `cap.c.world===cap.w && !cap.c.superseded && cap.w.clients.has(cap.c) && cap.c.gen===cap.gen`;
- identity: `cap.c.actorId===cap.actorId && cap.c.account===cap.account && cap.c.spectator===cap.spectator`;
- operator (for operator-repair): `isOperator(cap.account)===cap.operator`;
- door: `entryFor(doorOf(cap.w), {account, actorId, addr, nativeWorld}, cap.spectator?"watch":"embody", {now}) === null` — the same decision the join made (V7), now re-asked with the captured who;
- `cap.w.log.roleOf(cap.actorId) === cap.role` (a role change mid-request is a refusal, code `superseded`, not a silent commit under the new role: the asker was admitted under the old role; refusing is the conservative choice).

`captureCap` happens once at `requestwire.ts:134` (replacing `gen`/`still`) and once at :208. The authority then receives `cap.actorId` (never `actorOf(c)` again: fixes V5). Seams rechecked: (1) `requestwire.ts:138` (after await #1), (2) `worldlog.ts:158` (after await #2, before `requestSync`) — `request()` keeps its `still?: () => string|null` signature and is passed `() => recheck(cap)`. There are no other awaits between admission and `w.append`; `ctx.js:5` documents that invariant and the test row T7 pins it.

### 3b. Transaction outcome — in `storage.js` + `worldlog.ts`

Outcome type (exported from `storage.js`):
```js
// {outcome: "committed", from, to}      every line of this request is durable and in entries
// {outcome: "rolled-back"}              nothing of it reached disk or entries (refusal, or a pre-write throw)
// {outcome: "ambiguous", from, wedged}   a write threw; bytes may be on disk; the file is wedged (B1)
```
Changes:
1. `storage.js` `durably` (:63-65): distinguish *before-write* failure (none possible today: `writeLine` is the write) from *during-write*; any throw from `io.writeLine` is ambiguous by definition (open/write/fsync aren't one step). Keep the wedge; additionally record `w.wedgedAt = entries.length` (the seq whose disk state is unknown).
2. `durable.ts:26`: loop `writeSync` until all bytes written; a short write at EOF after retries throws (closes X4).
3. `worldlog.ts requestSync` (:162-171): wrap the authority call in `try/finally`; in `finally` run `afterWrite(from)` when `entries.length > from` (closes X2). Compute the outcome: refusal or `entries.length===from` → `rolled-back`; normal return with new lines → `committed`; a thrown error with `live.wedged.log` set → `ambiguous`. Return the outcome on the reply object (`r.outcome`), and for `ambiguous` return `{ok:false, refused:{code:"ambiguous", reason:"the write's result is unknown (storage failed mid-write); the world refuses writes until reopened", fix:"reload after the operator reopens the world; check history for seq ≥ from"}, outcome:"ambiguous", from}` — a registered code (`refusalcodes.js`), replied with the request id (closes X3's lost-id).
4. X1 (multi-line atomicity): the smallest honest fix is *not* a group fsync rewrite but a declared property: a request's lines are durable in order; if line k fails, lines < k are committed and published (X2 fix), line k is ambiguous and the file is wedged, so no later line can chain onto it. The reply says `outcome:"ambiguous"` with `from` so the client knows which prefix stands. Reopen trims a torn tail (`durable.ts:12-20`); a whole act without its change survives reopen — the fold already tolerates an orphan act (acts carry no ops), and `PROTOCOL §7` should say so explicitly. (True all-or-nothing needs one multi-line write + one fsync, `io.writeLines(lines[])`: a follow-up.)
5. `requestwire.ts:101-103` `inOrder` catch: reply with `{type:"reply", id: rid, ok:false, refused:{code:"ambiguous"|"server-error"}}` instead of an id-less `error` so a client never leaves a request pending.

`PROTOCOL.md §7` ("Durable before live", :816) gains two sentences: the three outcomes, and that `ambiguous` is never reported as `ok`.

## 4. Test rows (authority-check / server tests) and their mutations

| row | proves | red when |
|---|---|---|
| T1 | `io.writeLine` throws on the 2nd line of a commit → reply `ok:false, outcome:"ambiguous", from`; the act line (1st) is broadcast | remove the `finally` in requestSync (X2) or report `rolled-back` |
| T2 | fsync throws after bytes written (stub writeLine that appends then throws) → `ambiguous`, world wedged, reopen shows the line, and no client ever got `ok:true` | treat throw as `rolled-back` |
| T3 | refusal → `rolled-back`, `entries.length` unchanged, nothing broadcast | mutate to broadcast before `w.append` |
| T4 | capability: ban the actor during `warm()` (stub warm to yield) → `superseded`, nothing appended | drop the role/door compare in `recheck` |
| T5 | `@world.access` set to `members` while queued, actor unlisted → refused | drop `entryFor` from `recheck` |
| T6 | re-join on the same socket during await → request uses captured actorId or refuses; never the new identity | read `actorOf(c)` after the await again |
| T7 | static: no `await` in `shared/protocol/authority/**` between `enter()` and `w.append` (`grep -c await` = 0) | add an await in `commit` |
| T8 | `durable.ts` short-write stub → throws, not silent | ignore `writeSync` return |
| T9 | operator-repair: `isOperator` revoked while queued → refused | keep :210 as today |
| T10 | `recheck` with an unchanged connection passes (no false refusals: 100 serial requests all `committed`) | compare `role` by object identity instead of value |

## 5. Files to change
`server/requestwire.ts`, `server/worldlog.ts`, `shared/protocol/authority/storage.js`, `server/durable.ts`, new `server/reqcap.ts`, `shared/protocol/refusalcodes.js` (+`ambiguous`), `spec/PROTOCOL.md` §7.

## 6. Scope — what the transaction does NOT cover yet (2026-10-18)

Stated plainly, so nobody reads more into "committed" than it says. The outcome (`txn: committed | rolled-back | ambiguous`)
covers the **world log** (`world.jsonl`) and, through its own wedge, the **moderator log** (`world.mod.jsonl`): a request is
`committed` only when every line it asked for is durable and in `entries`, and a throw from either file's durable write is
`ambiguous` (storage.js `txnOutcome` reads both wedges).

Outside it, today:

- **Blob writes** (`store/<hash>.*`, uploads): content-addressed and written *before* the log line that names them. A blob
  whose line never lands is an orphan with no reader — harmless, reclaimable, never state.
- **Directory writes outside the log**: identity minting at join (`.directory.json`), the content-address index
  (`eido-index.json`), key custody. Idempotent, keyed by what they record; a failed one is retried by the next join, not
  rolled back with a request. An in-place translation defers its identities until the swap has succeeded (world.ts), so a
  failed translation leaves none behind — that is a sequencing rule, not a transaction.
- **The HTTP door's `Who`** (`server/access.ts`): HTTP reads (`/geom`, `/heightmap`, `/snap`, `/worlds`) decide with a
  `Who`, not a `ReqCap`. They write nothing, so they have no commit seam to recheck at; `Who` carries the same narrowing
  (`nativeWorld`) and is recomputed per request.
- **Capability expiry**: `ReqCap` carries no `expiry` field. A timed grant (`roles:<id>.until`) is rechecked *through the
  role* at both seams (`reqcap.ts recheck`: `w.log.roleOf(cap.actorId) !== cap.role`), and the role ends when the
  authority writes `expire-roles` — the server's one-second sweep (`server/access.ts sweepAccess`,
  `scriptrun.js expireRoles`), not the request itself. Between `until` and that sweep (under a second) the grant still
  stands, by design (server.ts, "between `until` and the sweep the grant still holds"). A request that outlives its
  grant by more than the sweep is refused at the seam as a role change.
- **Scripts** run on their sponsor's rights outside `ReqCap`; a script's write goes through the authority's own gate, not a
  connection's capability, and never reaches a connection's commit seam.
