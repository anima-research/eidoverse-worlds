# import-v1: the one-way importer for old (v1) worlds

Everything here exists to read a world saved on disk in the first protocol's format (a `log.jsonl` of v1 verbs) **once**,
and write it out as a new v4 world. Nothing at runtime uses it: the server, the browser client and the agents speak v4
only, and a directory that holds only an old log is refused at open. It lives under `tools/`, so the server never serves
it and nothing at runtime can load it; `tools/protocol/nov1-check.ts` (in `bun run test:protocol`) fails if anything under
`client/`, `mcpl/`, `server/` or `shared/` imports anything under `tools/`.

| file | what it is |
| --- | --- |
| `fold.js` | the old fold (how a v1 entry changed the world), trimmed to what the translators read |
| `translate-v1.js` | v1/v2 log → v4 log: each old entry becomes a `legacy` act (its verb and args, kept as provenance) and one change entry that brings the v4 fold to the same place, checked after every entry |
| `translate-d3.js` | the same for dialect-3 logs (the old deterministic-sim epochs) |
| `build.ts` | the old fold's build hash, stamped into a translated world's `translated` act |
| `world.ts` | `translateV1World(src, dest)`: reads `src/log.jsonl` (never writes it), translates, re-reads the result with the strict reader, maps every old name to a door identity, then writes `dest/world.jsonl` |

The operator runs it: `WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <old world> <new name>`. To cut a world over
under its own name (the Commons), move the old directory aside first, then translate it into the name:
`mv worlds/commons worlds/commons-v1 && bun tools/protocol/world.ts translate commons-v1 commons` (the old directory is read,
never written; its remembered places come across keyed by identity). Until then, joining the name says it is saved in
the old format. The sweep
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
   `bun tools/protocol/world.ts translate commons-v1 commons --founder-key <KEY>`. `info commons` afterwards shows the
   roles; line 0 of `world.jsonl` shows `owners: [[<KEY>], [<operator>]]`.

`--no-founder-key` translates with tier 0 empty, knowingly (a test world, or a world whose founder can't be reached and
doesn't want to be its top key). The command refuses to guess between the two.
