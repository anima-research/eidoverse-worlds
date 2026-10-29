# Translating a first-protocol world — the operator's procedure

If you run this server, open the setup link printed in its console (or add your account to `SERVER_OPERATORS`).
Otherwise ask whoever runs it.

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

**What a translation keeps of main's meaning** (translate-v1@27, R 10-28; the
report lists each one):

- *Rights.* Main gave everyone without a grant its `'*'` rule, builder when
  none was written, guests included; a world with no owner let everyone build
  and generate. The translation writes that out: `default-role` with
  `guests` the same role, and for an ownerless world the member role's
  permissions (`role-defs`) set to the builder's plus generate, since this
  protocol caps an ownerless world at member. Rank stays member there, so
  a lock is member strength (anyone may lift it, as in main), and a
  `who: builder` gate refuses everyone until the world has an owner (the
  upgrader's claim, below, or operator-repair set, which gives builder
  generate the same way). The report's `rights` says which, and its notes
  what can't be said (generate for guests). Worlds founded new keep this
  protocol's defaults.
- *Particles.* A preset retuned with main's knobs (wobble, up, spread, gravity,
  grow, swirl, twinkle, converge, rotate, color, blending) becomes a derived
  effect document: the Essential with those knobs read as the builder read
  them, stored in the world's `blobs/` by its content address and named by the
  `particles` component. A knob with no faithful reading stays in
  `imported:particles` and is listed with why.
- *Lights* fall off at decay 2 (inverse square, as every new light), each
  brightened once so it matches main's at half its own range: intensity ×
  (range/2)^0.3 (main's rig fell off as d^-1.7).
- *Ranges.* A value outside the component registry's ranges is brought inside
  them and listed (`adjusted`), so the world's next edit isn't refused.
- *Carried, with their fate said:* vehicle `minY`/`maxY` (invisible hull-only
  walls once collision layers exist), `probes` (retired: the authority's hull
  sweep), water `speed` (a physics-area speed factor once that exists).
- *Sky audio* (the weather's own sounds) is `@world.sky.audio`, as main's.

A report reviewed under an earlier translator is never approvable: each
version translates differently, so its hash differs, and the refusal says so.

**Global bans from before accounts.** A main-era `.bans.json` entry that names
only a name is bound at boot to the one account main recorded for it
(`.principals.json`, or a pair another world's log stamped). One main's records
bind to no one account, or to several, is kept on disk, never enforced (it would
hit namesakes), said in the boot log and listed in the operators' `/gbans` as
"pre-account ban: bind to a person or lift": `global-ban <the name>` binds it to
whoever wears that name here, `global-unban <the name>` lifts it.

It is translated in place: the world keeps its name, and the old log stays
beside the new one as `log.original.jsonl`, renamed, never written (the swap
refuses unless the old log still holds exactly the bytes that were
translated: nothing an old server wrote meanwhile is dropped); a directory
whose `world.jsonl` is a world of this protocol is served as one whatever
else it holds. (`translate <old> <new>` translates into a new name instead.)
The swap also writes `translation.json`: every file it renamed, every file
it made (`world.jsonl`, `poses.json`, `world.mod.jsonl` for imported bans,
`blobs/` for derived particle effects)
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
upgrade: "operator-or-owner", operator, may, owner?}`, so agents read the same thing in words.

A server **operator** or the world's **owner** may upgrade it (R 10-28),
signed in (a session, or an agent's credential; never a typed name):

- an operator: an account listed in `SERVER_OPERATORS`, or the one that opened the setup link (below);
- an owner **bound** by main's own records: the old log's grant carried the
  account, or main's `.principals.json` or another world's log on this server
  pairs the owner's name with exactly this one account (as below, step 2);
- an owner main recorded **no** account for, whose name the signed-in
  account's name is (any case), when main's records never bound that name to
  another account and only one account on this server holds the name.
  Name-matched ownership is provisional, an alpha risk the owner accepted,
  until durable accounts; the pre-upgrade backup stays the undo.

An owner main recorded several accounts for is not guessed, and no sign-in
proves nothing: everyone else is told an operator or the world's (verified)
owner can upgrade it, and sees no report (it names people). The review's and
the upgrade's replies (`owner {recognised: "bound" | "name", name}`) and the
server's log say how the owner was recognised. **The owner who upgrades stays
the owner:** the translation binds that owner (and no one else) to the
upgrader's account, and the report says so (`claim {by, how: "bound" | "name"}`,
in the approved hash); a rollback forgets that binding.

**An ownerless world is claimed.** A world with no owner at all becomes the
upgrader's (`world.ts translate … --claim`, the account from
`EIDO_UPGRADER_ACCOUNT`): the report says so (`claim`, in the approved hash),
the upgrader's identity is set owner as their own recorded operator repair,
and the builder role gains generate, so everyone else keeps what main gave
them there (build and generate). The result and the success page say "You're
now this world's owner". The boot notice's commands carry `--claim` with
`EIDO_UPGRADER_ACCOUNT=<your-account>` (yours, as `SERVER_OPERATORS` lists
it), so the command line claims as the browser does. Without `--claim` it
stays ownerless, warned; its locks stay member strength, so nobody is
locked out of their builds. Existing owners always stay owners.

The splash of anyone who may upgrade has a **Upgrade world…** button. It shows the dry-run
report (what carries, what is mapped, what has no home and is kept as
`imported:<name>`, what is dropped by design, what is refused) and its
hash. **Back up and upgrade** is the only action: the server runs this
page's CLI itself (`world.ts translate <world> --no-founder-key --approved
<that hash> --operator-only-no-owner --claim`), so the browser path and the command
line are one path. A report that changed since it was reviewed is refused.
The result screen says where the backup is and how to roll back. The world
opens on the next join; nobody needs to restart the server.

## Becoming the operator: the setup link

A server with no operator (`SERVER_OPERATORS` empty, and nobody claimed it yet)
prints one line at boot (R 10-28):

    No operator yet. Open http://localhost:8940/setup#token=… while signed in (person or agent) to become this server's operator.

Open it in a browser where you are signed in to this server (behind a proxy,
the same `/setup#…` on its public address). The page says "You're this server's
operator." The link works once: the account is stored in
`<worlds dir>/.operators.json` (0600; read at every boot and merged with
`SERVER_OPERATORS`), the token is gone, no link is printed again, and `/setup`
is a missing page. Being the operator takes effect at once, no restart.
To revoke it, remove the account from `.operators.json` (or delete the file)
and restart the server; operators named in `SERVER_OPERATORS` are removed there.

An agent claims it with its own credential, in the header, never the URL:

    curl -X POST http://localhost:8940/setup -H "Authorization: Bearer <agent credential>" -H "content-type: application/json" -d '{"token":"…"}'

It becomes the operator as the same account its join proves (`agent:token:<id>`
or `aid1:<iss>:<sub>`). A guest (no sign-in) is refused, as is a wrong or used
token, another site's page, and more than a few tries a minute. The token lives
only in the server's memory: a restart before it is used prints a new one.

## Upgrading a main-era server

A server from the main era named its operators in `WORLD_ADMIN`, often by
display name, and its worlds record their owners by display name. Three
things change, and nobody is locked out.

**1. Name yourself by account.** With no operator listed at all, the setup
link (above) is the quickest way. Otherwise: the variable is now `SERVER_OPERATORS`, and
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

**2. Upgrade the world; its owners come with their accounts where main
knew them.** A main-era world mostly records its owners by display name.
The upgrade binds each name to the account main itself recorded for it, when
there is exactly one: the server's `.principals.json` (every account a
verified door saw, under its name), or a pair main stamped into another world
on the same server (a grant's or ban's `sub`, a placer's). The world's own
record wins over both. That is the rule main's own grant used to resolve a
name, so whoever signs in with that account is the owner, as before.

A name main recorded no account for, or several, comes over as an
*imported* person: it holds its role, and no account can be it yet. The dry
run lists every role holder, bound or not (`people` in the report), and says
for each unbound one why and how to bind it:

    owner fable has no account yet (main recorded no account for this name): bind with bun tools/operator-repair.ts bind commons "fable" <their account>

Bans come over the same way: a banned name is bound to main's one account for
it, so that account stays banned, and the report lists every ban (`bans`,
in the approved hash) with the account it holds against or why none. A ban
bound by name alone says "check it": a guest who wore the name was someone else.

If no owner is bound to any account, the dry run, the report
(`ownerWarning`), the browser's review and result, and the server's log all
say so, naming them. The upgrade still runs: refusing it would leave the
world refusing everyone, its owners included, while once it is upgraded a
server operator enters it and can bind them (below).

**Binding an imported owner.** Ask the owner for their account (the `"sub"`
`https://<your server>/whoami` shows them when they're signed in), then, on
the host:

    WORLDS_DIR=<dir> bun tools/operator-repair.ts bind <world> <their old name, or its u- id> <their account>

From then on, signing in with that account *is* that identity, with its roles,
in every world. The bind is recorded in the world's `world.mod.jsonl` as an
operator repair (`verb: "bind"`, `operator: true`); the account itself is kept
only in the server's directory. It refuses an identity that isn't imported
(one already bound, or a guest), an account that isn't one
(`human:<provider>:<id>`, `agent:token:<id>`, `aid1:<iss>:<sub>`,
`local:<name>`), a name two imported people share (name the `u-` id instead),
and an account that already wears another identity here. The server may keep
running: it picks the bind up at that account's next sign-in.

**If they already signed in.** An owner who signed in to this server before
being bound already has an identity of their own, so their account can't
also wear the imported one. Give them the world from the inside instead. Ask
them to open the world (they arrive as a newcomer), and, while they're there,
look them up and give them the world with operator-repair. Put your browser's
`ew_sess` cookie for the server in place of `<cookie>` (or set
`EIDO_AGENT_TOKEN` to an operator agent's token instead), your server's
address for `https://your.server`, and the world's name for `<world>`:

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
was never bound, `operator-repair bind` or operator-repair set is the way back in.

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
