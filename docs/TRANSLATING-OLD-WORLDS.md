# Translating a first-protocol world — the operator's procedure

Informative (recut C19, 2026-10-21): how an operator translates a world, moved out of spec/PROTOCOL.md §14, which keeps
only what a translated log must be. Where this and §14 disagree, §14 wins.

The first protocol (an untyped verb log) is retired. An old world's log can
be translated once, one way, into a world of this protocol, in two steps.
`bun tools/protocol/world.ts translate <world> --dry-run --no-founder-key`
writes nothing and prints the **dry-run report** — the old log's size and
sha256, the translator and fold build, `founderKey: null`, the counts
(entries, changes, guards that become locks, models without bytes here), the
translator's DROPPED table (what every translation drops or renames by
design), and `deferred`: every use of a feature this protocol does not carry
yet — and the report's sha256. The translation itself takes `--approved <that
hash>`: the report is recomputed from the old log as it stands and must hash
to it (else refused, both hashes named: the log or the tool changed since it
was read).

**A translation names no founder and carries no owner's signature.** First-
protocol logs record accounts, never keys, so nothing can yet bind a key to
the old world's owner; a key handed to the tool would be the operator's
choice, recorded as the owner's approval and installed as tier 0. So
`--founder-key` and `--approve-sig` are refused before anything is written,
the new world's tier 0 is empty (§13), and the approval is the **operator's**
countersignature alone: an ed25519 signature by the host's custody operator
key (never its sequencer key; whoever runs the tool on the host is the
operator, and the tool signs) over `eidoverse-approve-translation:<world>:<hash>`,
given only when the operator says `--operator-only-no-owner`, knowingly. The
writer checks it itself (`approvalProblem`) before the log is written: a
countersignature missing, not verifying, or over another hash or world, an
approval carrying an owner's signature, or a founder key is refused by name.
The approval rides in the new log as the system's `translation-approved` act
right after `repair-shapes` (`body {report, approval: {over, owner: null,
operator: {key, sig}, noOwner}}`, `noOwner` saying in words that no owner was
attested): provenance a reader checks against `log.original.jsonl`. The fold
never reads it (§1).

Main's #248/#254 components (`water`/`air`/`traversal`/`vehicle`/`collision`/
`environment` on an entity) are carried, each to its home (spec/PROTOCOL.md
§14); the translator's DEFERRED table is empty. A world that uses a
**deferred feature** — a water volume or an air box on `@world`, which has
no frame to hold one (`water` on `@world` without one is the world's water
level and is carried) — is **refused**, naming each use (component, entity, actor, seq); an approval
cannot override the refusal. Nothing of a world is ever dropped quietly.

It is translated in place: the world keeps its name, and the old log stays
beside the new one as `log.original.jsonl`, renamed, never written (the swap
refuses unless the old log still holds exactly the bytes that were
translated: nothing an old server wrote meanwhile is dropped); a directory
whose `world.jsonl` is a world of this protocol is served as one whatever
else it holds. (`translate <old> <new>` translates into a new name instead.)
The swap also writes `translation.json`: every file it renamed, every file
it made (`world.jsonl`, `poses.json`, `world.mod.jsonl` for imported bans)
with its sha256, the identities it minted, the report hash and the approval.
`bun tools/protocol/world.ts rollback <world>` undoes the whole swap from
it: the made files removed, the originals renamed back (the same files: bytes,
inode, mtime), the minted identities forgotten (those nobody has bound or
renamed since), the manifest removed — the world directory byte-identical to
before, and the shared directory rewritten without those identities (a
directory file the translation itself created stays, holding none of them). A made file the server has written to
since refuses the rollback unless `--discard-changes`, so no history is lost
unknowingly. Each old entry appears in the new log as an `act` with verb
`imported` (`body {verb, args, from}`) or as a `say`, followed by the change it
produced; fields with no component in this protocol ride along as `imported:<name>`. A
translated world is an ordinary world from then on.

## Upgrading from the browser

Opening an old-format world shows a splash: "This world was saved by an
older Eidoverse. It needs a one-time upgrade before anyone can enter.", the
server's own sentence, and a link to this page. The join is still refused
(close 4005); its `error` carries `refused {code: "old-format", doc,
upgrade: "operator", operator}`, so agents read the same thing in words.

Only the server's **operator** may upgrade a world: a signed-in account
listed in `SERVER_OPERATORS` (a session, or an agent's credential; never a
typed name). Not the old world's owner: an old log names its owner, and
nothing can yet bind an account or key to that name, so a name match would
let anyone who signs up as that name take the world. Everyone else is told
to ask the server's operator, and sees no report (it names people).

The operator's splash has a **Review upgrade** button. It shows the dry-run
report (what carries, what is mapped, what has no home and is kept as
`imported:<name>`, what is dropped by design, what is refused) and its
hash. **Back up and upgrade** is the only action: the server runs this
page's CLI itself (`world.ts translate <world> --no-founder-key --approved
<that hash> --operator-only-no-owner`), so the browser path and the command
line are one path. A report that changed since it was reviewed is refused.
The result screen says where the backup is and how to roll back. The world
opens on the next join; nobody needs to restart the server.

## Upgrading a main-era server

A server from the main era named its operators in `WORLD_ADMIN`, often by
display name, and its worlds record their owners by display name. Three
things change, and nobody is locked out.

**1. Name yourself by account.** The variable is now `SERVER_OPERATORS`, and
it lists accounts, never names. Rewrite

    WORLD_ADMIN=Name

as

    SERVER_OPERATORS=human:discord:123456789012345678

(several are comma-separated). To find your account id, sign in to the
server in a browser and open `https://<your server>/whoami`: the `"sub"` it
shows is the id to write. An enrolled agent's account is
`agent:token:<its id in tokens.json, lowercased>`. For one release the server
still reads `WORLD_ADMIN` too (merged with `SERVER_OPERATORS`) and logs one
line at boot asking you to rename it; an entry without a `:` in either
refuses to boot, saying so, so a typo can't quietly leave you out.

**2. Upgrade the world, then give it to its owner.** A main-era world's
owner is recorded by display name, and nothing can yet bind that name to an
account (anyone could sign up as it). So the server operator upgrades the
world (the browser's Review upgrade, or the CLI above), and the old owner
comes over as an *imported* person who holds the owner role but whom no
account can be. Then ask the real owner to sign in and open the world (they
arrive as a newcomer), and, while they're there, look them up and give them
the world with operator-repair. Put your browser's `ew_sess` cookie for the
server in place of `<cookie>` (or set `EIDO_AGENT_TOKEN` to an operator
agent's token instead), your server's address for `https://your.server`, and
the world's name for `<world>`:

    EIDO_SESSION=<cookie> bun tools/operator-repair.ts https://your.server <world> whois '{"name":"Ann"}'
    EIDO_SESSION=<cookie> bun tools/operator-repair.ts https://your.server <world> whois '{"name":"Ann-tann"}'

The first looks up the old owner's name: the entry marked `"imported": true`
is the old record. The second looks up the name on the real owner's
nameplate, which may carry a suffix (here `Ann-tann`) because the imported
record holds the plain name: the entry marked `"here": true` is the person in
front of you. Give them the world, and clear the old record's role:

    EIDO_SESSION=<cookie> bun tools/operator-repair.ts https://your.server <world> set '{"id":"@world","component":"roles:u-THEIR-ID","value":{"role":"owner"}}'
    EIDO_SESSION=<cookie> bun tools/operator-repair.ts https://your.server <world> delete '{"id":"@world","component":"roles:u-IMPORTED-ID"}'

(`u-THEIR-ID` and `u-IMPORTED-ID` are the two `id`s whois printed.) The
owner's rights change at once; each repair is the operator's own recorded
act, marked `operator: true`.

**3. Nobody is locked out.** A server operator enters every world and can
always run operator-repair there: to set or clear anyone's role, the world's
`access` and `default-role`, or lift a ban. If an owner is lost, banned, or
was never bound, operator-repair is the way back in.

## Backups

Every in-place translation, from the CLI or the browser, first copies the
whole old world directory to `BACKUPS_DIR/<world>-<UTC yyyymmddThhmmssZ>/`
with a `SHA256SUMS` file, then re-reads every copy and checks its hash
against the original. Any copy error or mismatch refuses the translation
before anything moves. `BACKUPS_DIR` defaults to `backups/` beside the
worlds directory; it may never be inside it (every directory there is
served as a world). The translation's output and `translation.json` name
the backup. Nothing writes to a backup afterwards, and `rollback` never
touches it.

To restore one by hand (stop the server first): check it with
`cd <backup> && sha256sum -c SHA256SUMS`, move the world's directory
aside, then copy the backup back under the world's name without its
`SHA256SUMS`:

    mv worlds/<world> worlds-aside-<world>
    cp -a backups/<world>-<stamp> worlds/<world> && rm worlds/<world>/SHA256SUMS

`rollback <world>` is still the first way back (it undoes the swap byte for
byte); the backup is for when that can't run.
