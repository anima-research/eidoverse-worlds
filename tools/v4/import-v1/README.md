# import-v1: the one-way importer for old (v1) worlds

Everything here exists to read a world saved on disk in the first protocol's format (a `log.jsonl` of v1 verbs) **once**,
and write it out as a new v4 world. Nothing at runtime uses it: the server, the browser client and the agents speak v4
only, and a directory that holds only an old log is refused at open. It lives under `tools/`, so the server never serves
it and nothing at runtime can load it; `tools/v4/nov1-check.ts` (in `bun run test:v4`) fails if anything under
`client/`, `mcpl/`, `server/` or `shared/` imports anything under `tools/`.

| file | what it is |
| --- | --- |
| `fold.js` | the old fold (how a v1 entry changed the world), trimmed to what the translators read |
| `translate-v1.js` | v1/v2 log → v4 log: each old entry becomes a `legacy` act (its verb and args, kept as provenance) and one change entry that brings the v4 fold to the same place, checked after every entry |
| `translate-d3.js` | the same for dialect-3 logs (the old deterministic-sim epochs) |
| `build.ts` | the old fold's build hash, stamped into a translated world's `translated` act |
| `world.ts` | `translateV1World(src, dest)`: reads `src/log.jsonl` (never writes it), translates, re-reads the result with the strict reader, maps every old name to a door identity, then writes `dest/v4.jsonl` |

The operator runs it: `WORLDS_DIR=<dir> bun tools/v4/world.ts translate <old world> <new name>`. To cut a world over
under its own name (the Commons), move the old directory aside first, then translate it into the name:
`mv worlds/commons worlds/commons-v1 && bun tools/v4/world.ts translate commons-v1 commons` (the old directory is read,
never written; its remembered places come across keyed by identity). Until then, joining the name says it is saved in
the old format. The sweep
(`tools/v4/sweep.ts`, in `test:v4`) translates every old world log it can find and requires zero divergences.

**This directory is temporary.** It stays only until the live Commons has been cut over to v4 (decided 2026-10-06); a
follow-up change, about a month after that cutover, deletes this directory, the sweep's v1 half and the v1 fixtures in
`spec/fixtures/`.
