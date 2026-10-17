# import-v1: the one-way importer for old (v1) worlds

Everything here exists to read a world saved on disk in the first protocol's format (a `log.jsonl` of v1 verbs) **once**,
and write it out as a new v4 world. Nothing at runtime uses it: the server, the browser client and the agents speak v4
only, and a directory that holds only an old log is refused at open. It lives under `tools/`, so the server never serves
it and nothing at runtime can load it; `tools/protocol/nov1-check.ts` (in `bun run test:protocol`) fails if anything under
`client/`, `mcpl/`, `server/` or `shared/` imports anything under `tools/`.

| file | what it is |
| --- | --- |
| `fold.js` | the old fold (how a v1 entry changed the world), trimmed to what the translators read |
| `translate-v1.js` | v1/v2 log → v4 log: each old entry becomes an `imported` act (`body {verb, args, from}`: its verb and args, kept as provenance) or a `say`, and one change entry that brings the v4 fold to the same place, checked after every entry |
| `translate-d3.js` | the name her four dialect-3 goldens are checked under (sweep §3): a thin wrapper over `translate-v1.js`, which since @10 runs her sim (the first eidosim, `eidosim-v1.js` here) beside the v1 fold whenever a log enters a physics `epoch` — a punt becomes a logged launch with its exact state, every rest a logged result, the epoch `@world physics-engine` and each collider's stamped box its `physics.shape`. A log with no epoch translates byte-for-byte as @9 did |
| `eidosim-v1.js` | the first eidosim (dialect 3), kept here so the translator, the sweep and the directory check can read what a physics-era v1 log's punts did; nothing at runtime loads it (the server runs `eidosim@1.0.0`) |
| `eidosim-v1-test.ts` | its covenant tests (self-agreement, schedule independence, quantization), run on the copy kept here |
| `build.ts` | the old fold's build hash, stamped into a translated world's `translated` act |
| `world.ts` | `translateV1World(src, dest, {founderKey, name})`: reads `src/log.jsonl` (never writes it), translates, re-reads the result with the strict reader (and, for a physics-era log, the authority's own sim layer, which re-checks every rest), maps every old name to a door identity, then writes `dest/world.jsonl` |
| `snapshot-oracle.ts` | the translator against the OLD ENGINE (suite `oracle`): every old world whose `snapshot.json` is a complete fold of its log (seq and bytes match) is translated for real, and its fold (and the server's lifted load) compared with the snapshot, through the translator's mapping and also field by field off the snapshot. Incomplete snapshots are skipped, never compared. `OPT_DIR=<serving checkout>/assets/opt` gives store models their real addresses |

The operator runs it, in place: `WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <world> --founder-key <ed25519:…>`
(or `--no-founder-key`, which leaves the world's top governance tier empty for ever; see the ceremony below). The world
keeps its name, so links to it keep working (the Commons is cut over with `translate commons --founder-key <KEY>`). It
is translated into a temporary sibling directory (`.translating-<world>-…`, never served) and verified there first: the
importer's own checks (0 divergences, projection equality, strict read-back), the result opened as the server opens it
(same digest), and, when the directory holds the old server's `snapshot.json`, `snapshot-oracle.ts`'s agreement with it
(a snapshot the oracle can't compare, a partial one or a physics-era log's, is reported as not compared). Only then is
it swapped in: `world.jsonl` lands in the world's directory in one rename, and the old files are renamed beside it,
`log.jsonl` → `log.original.jsonl`, `snapshot.json` → `snapshot.original.json`, `poses.json` → `poses.original.json`:
the same files, never rewritten or deleted. On any failure, before or during the swap, whatever moved is put back, the
temporary directory is removed, and it says why. A directory whose `world.jsonl` is a world is served as one, so the
kept `log.original.jsonl` never makes it look old; translating it again refuses. `translate <old world> <new name>`
still translates into a new name instead, leaving the old directory exactly as it was. At boot the server prints, for
each old world, the exact in-place command, with `WORLDS_DIR` filled in and a
placeholder for the founder key (`server/oldworlds.ts` `bootNotice`). A visitor is told in plain words that the world
needs a one-time conversion by whoever runs the server and that nothing is lost (`visitorText`; the browser keeps that
sentence on its splash, suite `refusedjoin`). The sweep
(`tools/protocol/sweep.ts`, in `test:protocol`) translates every old world log it can find and requires zero divergences.

**This directory is temporary.** It stays only until the live Commons has been cut over to v4 (decided 2026-10-06); a
follow-up change, about a month after that cutover, deletes this directory, the sweep's v1 half and the v1 fixtures in
`spec/fixtures/`.

## The Commons ceremony (governance keys, PROTOCOL §13)

A translated world's genesis names its governance keys, and genesis never changes. Under §13's add-key rule (GOV-5) a
lower tier can never add a key to a higher one, so **tier 0 must be the founder's key at translation, or it stays empty
for ever**. The public Commons was founded by **antra**; its owners (antra, fable, janus, mica, from the v1 log's grants)
and builder (Digi_Rat) come across as `roles:<id>` either way, because roles are rights inside the world and governance
keys are a separate list (§7, "two owner lists, never confused"). Neither R's key nor Burrow's goes in tier 0.

1. **The founder makes a key on her own machine.** The private half never leaves it. With OpenSSL (any recent
   version):

       openssl genpkey -algorithm ed25519 -out eidoverse-owner.pem
       printf 'ed25519:%s\n' "$(openssl pkey -in eidoverse-owner.pem -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=')"

   Keep `eidoverse-owner.pem` offline and backed up: it is the only thing that can reclaim, rewind or re-key the
   Commons from the top.
2. **She proves it's hers, and that the text is spelled right**, by signing the ceremony text with it and sending the
   public key and the signature (both are safe to share):

       KEY=ed25519:…   # the line printed above
       printf 'eidoverse-owner-key:%s' "$KEY" > msg.txt
       openssl pkeyutl -sign -inkey eidoverse-owner.pem -rawin -in msg.txt | base64 | tr -d '\n'; echo

3. **The operator checks it** (nothing is written): `bun tools/protocol/world.ts owner-key <KEY> <signature>`. It says
   `ok` only when the signature verifies over `eidoverse-owner-key:<KEY>`.
4. **Back up the host's custody** (`keys/custody.json` under the worlds directory) off this machine first: it holds the
   sequencer and operator keys. Lose it and the Commons can never sign another head; the only way on is a fork.
5. **Translate** with her key in tier 0 and the host's operator key in tier 1:
   `bun tools/protocol/world.ts translate commons --founder-key <KEY>`. `info commons` afterwards shows the
   roles; line 0 of `world.jsonl` shows `owners: [[<KEY>], [<operator>]]`.

`--no-founder-key` translates with tier 0 empty, knowingly (a test world, or a world whose founder can't be reached and
doesn't want to be its top key). The command refuses to guess between the two.
