# Running a server

The world server is `bun server/server.ts` (`bun run start`). Most variables it reads are in `server/config.ts` (a few
live where they're used: `server/clientlog.ts`, `server/server.ts` RENAME_COOLDOWN_DAYS, `server/limits.ts` EW_*); the ones
an operator usually sets are below.

## The server

| variable | default | what |
|---|---|---|
| `PORT` | 8940 | the port |
| `HOST` | `0.0.0.0` | the interface; `127.0.0.1` keeps it on this machine |
| `WORLDS_DIR` | `./worlds` | where worlds live (the units: `/var/lib/eidoverse/worlds`) |
| `EIDOVERSE_DIR` | `../eidoverse-video` | the asset library checkout |
| `JOIN_TOKEN` | empty | gates the door; empty means open, fine on a tailnet, not on a public box |
| `TRUST_NAMES` | off | `1` takes a typed name as an account; for a private server only, never one strangers can reach |

On first boot a server with no operator prints `No operator yet. Open …/setup#token=…`: open that link in a signed-in
browser to become the operator (an agent POSTs the token to `/setup`). `bun tools/world.ts found <name> --owner <you>`
founds a world (under the units, as their user: [The units](#the-units)).

**Which library.** Use SkyeShark/eidoverse-video at the commit named by `LIBRARY_PIN`
(`test/gate/run.ts`). Until upstream takes the rain-splash ground fix (SkyeShark/eidoverse-video#9), rain splashes
draw on a flat plane at y=0. The anima-research fork's `prod-serving` has that fix but lacks the sunflower maps and
everything upstream added since July; don't start new servers on it.

## Behind a reverse proxy

The client's address rides `X-Real-IP`; the server believes that header only from loopback or the peers named in
`TRUSTED_PROXIES=<addr,addr>` (`server/peer.ts`), else it uses the socket's own. A proxy that writes `X-Forwarded-For`
instead takes `PROXY_ADDRESS_HEADER=x-forwarded-for`; only the one header named is read, since a proxy passes the other on
as the client sent it. Set `HN_NATIVE_ORIGIN=https://<public host>`: a signed-in socket from an older browser opens only
from that exact origin.

## Client logs

The browser's console tee (`POST /clientlog`) lands under `CLIENTLOG_DIR` (default `<worlds dir>/.clientlogs`), one file
per world and sender. Its rails are settings; `0` turns one off:

| setting | default | what |
|---|---|---|
| `CLIENTLOG_KEEP_DAYS` | 14 | a sender's file is removed this long after its last write (checked hourly); 0 = kept until the size caps evict it |
| `CLIENTLOG_IP_PER_10MIN` | 30 | posts per client address per 10 minutes (IPv6 by /64; a venue behind one NAT shares it); 0 = no limit |
| `CLIENTLOG_SENDER_PER_10MIN` | 30 | posts per signed-in account (else per address) per 10 minutes, 10 in a row; 0 = no limit |

## The agent door

Agents reach worlds through the door, `mcpl/net-server.ts`, a WebSocket server on port 8941 (`MCPL_PORT`) that talks to
the world server at `WORLD_URL` (default `ws://127.0.0.1:8940/ws`). Its package takes sibling repos by path, so install
it with `bun test/gate/run.ts --siblings` (clones and builds them in `.siblings/`, then installs `mcpl/`), put the agents'
tokens in `mcpl/tokens.json` (gitignored; `mcpl/tokens.example.json` shows the shape), and start it with
`bun mcpl/net-server.ts` from the checkout root. An agent connects to `ws://<host>:8941/?token=<its token>`.

## On the VPS

`deploy/deploy-vps.sh` resets the checkout hard to `origin/main` (tracked local edits are lost; gitignored runtime files
stay), installs what changed since the last deploy that finished (`.deploy-done`, gitignored; with none, everything), re-installs each `deploy/*.service` the box already
has in `/etc/systemd/system` when it differs (then `daemon-reload`, and makes the `User=` each installed unit names), restarts `eidoverse` and `eidoverse-mcpl`, try-restarts the
other installed units (one you stopped stays stopped) and exits nonzero if any unit that should be up is not running. A unit with secrets reads them from its `EnvironmentFile=` (`/etc/eidoverse/<unit>.env`; the MCPL template has none,
its tokens are `/etc/eidoverse/agent-tokens.json`); a unit whose new version needs an env file the box lacks stops the deploy before the reset, so nothing changes. `deploy/eidoverse.service.template` and `deploy/eidoverse-mcpl.service.template` are
written from this repo, not copied from the VPS: diff each against the installed unit before renaming it to `.service`.
On a box still in the old layout (the checkout under a home) it stops before fetching and changes nothing:
[Moving a box to /opt](#moving-a-box-to-opt).

The first deploy after the repo reorganisation (#333) runs the old script, which stops after the reset because
`tools/protocol/run.ts` moved to `test/gate/run.ts`. Run `deploy/deploy-vps.sh` again: it has no `.deploy-done` yet, so
it installs everything and restarts the units. A Mac renderer's watchdog (`deploy/run-mac-renderer.sh`) probes the
client's capture module by path, and that moved too (`/lib/capture.js` → `/lib/render/capture.js`): pull and restart each
Mac renderer in the same window, or its watchdog restarts healthy renderers. The bots moved from `tools/` to `services/`:
a captionbot run from its own directory keeps unconfirmed captions in `./captionbot.spool.jsonl`, so move
`tools/captionbot/captionbot.spool.jsonl` to `services/captionbot/` (or set `SPOOL`) before starting it there.
`client/voices/` is an ignored drop folder now: the reset deletes the one voice config git tracked there
(`hesperus-clockwork.onnx.json`) and keeps its untracked `.onnx`, so a box that serves `?voice=hesperus-clockwork` copies
that `.onnx.json` back first.

## The units

`deploy/` has a unit for the world server and one for the agent door (`.template`: installed by hand, below) and the chat
bridge's (`.service`: `deploy-vps.sh` keeps it current once installed). The code goes in `/opt`, as matrix.org's Synapse
package has it, and the state in `/var/lib/<name>`, as Gitea, Jellyfin and Vaultwarden have theirs:

| what | where | owned by |
|---|---|---|
| the checkout | `/opt/eidoverse` | the deploy user (`git`, `bun install`, `deploy-vps.sh`) |
| the library | `/opt/eidoverse-video`, beside it (`EIDOVERSE_DIR`'s default) | the deploy user |
| bun | `/usr/local/bin/bun` | root |
| worlds, their backups, the optimizer's store and variants, sign-in sessions | `/var/lib/eidoverse` | `eidoverse` |
| the door's memory | `/var/lib/eidoverse-mcpl` | `eidoverse` |
| secrets: `/etc/eidoverse/<unit>.env` (the door's holds `WORLD_TOKEN`, the server's `JOIN_TOKEN`), agents' tokens in `/etc/eidoverse/agent-tokens.json` | edit with `sudoedit`, which keeps owner and mode; the directory is 755, so the units can reach the tokens | root (the tokens: group `eidoverse`, 0640) |

The units run as `eidoverse`, a system user with no login and no home, with the system read-only but their state
directory, no `/home`, no capabilities and a syscall filter (`systemd-analyze security`: 1.1, from 9.0). Outbound network
stays open (STUN for voice; the bridge reaches Discord). Why each setting: [research/service-hardening](../research/service-hardening.md).

**Installing them** on a new box, as the deploy user:

```sh
sudo install -m 755 ~/.bun/bin/bun /usr/local/bin/bun      # the version package.json's engines.bun names
id -u eidoverse >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin eidoverse
sudo install -d -o "$USER" -g "$USER" /opt/eidoverse /opt/eidoverse-video
git clone <this repo> /opt/eidoverse && git clone <the library> /opt/eidoverse-video   # at LIBRARY_PIN (above)
cd /opt/eidoverse
sudo install -d -m 755 /etc/eidoverse
sudo install -m 600 /dev/null /etc/eidoverse/eidoverse.env              # then sudoedit it: JOIN_TOKEN=… and the like
sudo install -m 600 /dev/null /etc/eidoverse/eidoverse-mcpl.env         # WORLD_TOKEN=<that JOIN_TOKEN>, or agents are refused
echo '{}' | sudo install -o root -g eidoverse -m 640 /dev/stdin /etc/eidoverse/agent-tokens.json   # sudoedit: mcpl/tokens.example.json's shape
sudo install -m 644 deploy/eidoverse.service.template /etc/systemd/system/eidoverse.service
sudo install -m 644 deploy/eidoverse-mcpl.service.template /etc/systemd/system/eidoverse-mcpl.service
sudo systemctl daemon-reload && sudo systemctl enable eidoverse eidoverse-mcpl
deploy/deploy-vps.sh        # installs, starts both
```

A unit installed from a `.template` stays as you installed it: after a deploy that changes one, install it again.

**Tools that write state** (`tools/world.ts found`, `translate`, the operator tools) run as the units' user with the
server unit's environment, from the checkout, or the server can't keep writing what they made:

```sh
sudo -u eidoverse env $(systemctl show -p Environment --value eidoverse) bun tools/world.ts found <name> --owner <you>
```

**What differs on your box** goes in a drop-in, which deploys leave alone: `sudo systemctl edit eidoverse`. The units
can't see `/home`, so anything they read from there (a library elsewhere, `KTX2_TOKTX`, `EW_AVATAR_DONOR`) moves to
`/opt` or `/usr/local`, or is bound in with `BindReadOnlyPaths=`. A list setting in a drop-in adds to the unit's; an
empty line (`BindReadOnlyPaths=`) clears it first. Settings go in `/etc/eidoverse/<unit>.env`, not a `.env` in the
checkout: bun would skip one the units can't read without a word, so `deploy-vps.sh` stops on that. An env file wins
over the unit's `Environment=`, so it must not set what the templates already set (`WORLDS_DIR`, `BACKUPS_DIR`,
`OPT_DIR`, `SESSIONS_PATH`, `MCPL_STATE`, `AGENT_TOKENS_PATH`, `MCPL_TOKENS`, `GIT_CONFIG_*`): systemd won't say it
was overridden.

**Limits** are rails, not quotas: `MemoryMax=80%` on the world server (it stops, and restarts, before the box runs out
of memory), `TasksMax=1024`, `LimitNOFILE=65536`. `MemoryMax` is also the cap for the server's children (the optimizer,
a build check, an avatar import, an upgrade): each asks to be the kernel's first pick, so one too big for the box is
killed, and the optimizer's deferred, not the server. The optimizer's budget, `OPT_MEM_BUDGET_MB` (default half of
`MemoryMax`), defers what it estimates won't fit; outside systemd that estimate is the only cap.

### Upgrading bun

`deploy-vps.sh` never changes bun. It warns when `/usr/local/bin/bun` is not the version `package.json`'s `engines.bun`
names; then, as the deploy user:

```sh
curl -fsSL https://bun.sh/install | bash -s bun-v<that version>     # into ~/.bun
sudo install -m 755 ~/.bun/bin/bun /usr/local/bin/bun
/opt/eidoverse/deploy/deploy-vps.sh                                  # restarts the units on it
```

### Moving a box to /opt

A box set up before these units has the checkout and its state in `~/eidoverse-worlds`, the library in
`~/eidoverse-video`, bun in `~/.bun`, and runs the units as the deploy user. `deploy-vps.sh` stops on it before fetching
and changes nothing: the move is made by hand, once. Make it in place of the deploy that brings these units: the old
script would install the new chat bridge unit, which runs from `/opt` as a user the box doesn't have yet.

First look for what the units won't be able to read. Every `/home` path in a unit, drop-in or env file moves out or is
bound in, and an env file that sets one of the paths the templates set (above) loses that line: it would win over the
template. A checkout `.env` has its settings moved into `/etc/eidoverse/<unit>.env` and is then deleted. An encoder in
`~/.local/ktx` (found through `HOME`) goes to `/usr/local` or is named by `KTX2_TOKTX` in a drop-in
([KTX2-ENCODER](KTX2-ENCODER.md)). Other units that run from the checkout (a captionbot, a renderer) change their paths
too.

```sh
sudo sh -c 'grep -Hn /home /etc/systemd/system/eido*.service /etc/systemd/system/eido*.service.d/*.conf /etc/eidoverse/*.env'
sudo sh -c 'grep -HnE "^(WORLDS_DIR|BACKUPS_DIR|OPT_DIR|SESSIONS_PATH|MCPL_STATE|AGENT_TOKENS_PATH|MCPL_TOKENS|GIT_CONFIG_[A-Z0-9_]*)=" /etc/eidoverse/*.env'
ls -la ~/eidoverse-worlds/.env* ~/eidoverse-worlds/services/chatbridge/.env* ~/.local/ktx
```

Then, as the deploy user:

```sh
# 1. stop, and keep what a rollback needs
sudo systemctl stop eido-chatbridge eidoverse-mcpl eidoverse
mkdir -p ~/before-opt && git -C ~/eidoverse-worlds rev-parse HEAD > ~/before-opt/commit
for u in eidoverse eidoverse-mcpl eido-chatbridge; do sudo cp -a /etc/systemd/system/$u.service* ~/before-opt/ 2>/dev/null; done
# 2. code to /opt, bun to /usr/local
sudo mv -T ~/eidoverse-worlds /opt/eidoverse && sudo mv -T ~/eidoverse-video /opt/eidoverse-video
sudo install -m 755 ~/.bun/bin/bun /usr/local/bin/bun
# 3. state to /var/lib and the agents' tokens to /etc, for the units' user
id -u eidoverse >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin eidoverse
sudo install -d -o eidoverse -g eidoverse -m 700 /var/lib/eidoverse /var/lib/eidoverse-mcpl
sudo install -d -m 755 /etc/eidoverse
sudo test -e /etc/eidoverse/eidoverse-mcpl.env || sudo install -m 600 /dev/null /etc/eidoverse/eidoverse-mcpl.env   # the door's
cd /opt/eidoverse
for d in worlds backups; do [ ! -e $d ] || sudo mv -T $d /var/lib/eidoverse/$d; done
[ ! -e assets/opt ] || sudo mv -T assets/opt /var/lib/eidoverse/opt
[ ! -e .sessions.json ] || sudo mv .sessions.json /var/lib/eidoverse/sessions.json
[ ! -e mcpl/state.json ] || sudo mv mcpl/state.json /var/lib/eidoverse-mcpl/state.json
sudo chown -R eidoverse:eidoverse /var/lib/eidoverse /var/lib/eidoverse-mcpl
[ ! -e mcpl/tokens.json ] || { sudo install -o root -g eidoverse -m 640 mcpl/tokens.json /etc/eidoverse/agent-tokens.json && rm mcpl/tokens.json; }
# 4. the new code, and what the box's units set that the templates don't
git fetch origin main && git reset --hard origin/main
sudo diff ~/before-opt/eidoverse.service deploy/eidoverse.service.template
sudo diff ~/before-opt/eidoverse-mcpl.service deploy/eidoverse-mcpl.service.template
```

The next block replaces the box's `eidoverse.service` and `eidoverse-mcpl.service` with the templates, so first carry
over every setting the old units set inline that the templates lack: each `Environment=` (a `JOIN_TOKEN` there, left
behind, brings the box up open; the door's `WORLD_TOKEN`; a port) goes into `/etc/eidoverse/eidoverse.env` or
`/etc/eidoverse/eidoverse-mcpl.env` (`sudoedit`, one per line), anything else into a drop-in. A `/home` path is
rewritten to its new place, not copied (`EIDOVERSE_DIR=/home/…/eidoverse-video` is `/opt/eidoverse-video`, which is
the default anyway), and nothing the templates set is carried (env files override the units). Drop-ins stay as they
are. `grep -h '^Environment' ~/before-opt/*.service` lists the inline settings alone.

```sh
# 5. the new units, then the usual deploy, and the bridge it leaves stopped
sudo install -m 644 deploy/eidoverse.service.template /etc/systemd/system/eidoverse.service
sudo install -m 644 deploy/eidoverse-mcpl.service.template /etc/systemd/system/eidoverse-mcpl.service
[ ! -f /etc/systemd/system/eido-chatbridge.service ] || sudo install -m 644 deploy/eido-chatbridge.service /etc/systemd/system/
sudo systemctl daemon-reload && deploy/deploy-vps.sh && sudo systemctl start eido-chatbridge   # if the box has the bridge
sudo grep -q '^JOIN_TOKEN=.' /etc/eidoverse/eidoverse.env && echo gated || echo 'OPEN: no JOIN_TOKEN (fine on a tailnet, not on a public box)'
```

**Rolling back** puts everything where it was, with what the server wrote since. A rolled-back box must not run
`deploy-vps.sh` until it is moved again: its old script would fetch main and install the new chat bridge unit once
more. To run other code meanwhile, check that commit out and restart the units by hand.

```sh
sudo systemctl stop eido-chatbridge eidoverse-mcpl eidoverse
cd /opt/eidoverse
for d in worlds backups; do ! sudo test -e /var/lib/eidoverse/$d || sudo mv -T /var/lib/eidoverse/$d $d; done
! sudo test -e /var/lib/eidoverse/opt || sudo mv -T /var/lib/eidoverse/opt assets/opt
! sudo test -e /var/lib/eidoverse/sessions.json || sudo mv /var/lib/eidoverse/sessions.json .sessions.json
! sudo test -e /var/lib/eidoverse-mcpl/state.json || sudo mv /var/lib/eidoverse-mcpl/state.json mcpl/state.json
! sudo test -e /etc/eidoverse/agent-tokens.json || sudo mv /etc/eidoverse/agent-tokens.json mcpl/tokens.json
sudo chown -R "$USER:$USER" worlds backups assets .sessions.json mcpl/state.json mcpl/tokens.json 2>/dev/null
git reset --hard "$(cat ~/before-opt/commit)"
cd ~ && sudo mv -T /opt/eidoverse ~/eidoverse-worlds && sudo mv -T /opt/eidoverse-video ~/eidoverse-video
for u in eidoverse eidoverse-mcpl eido-chatbridge; do sudo rm -rf /etc/systemd/system/$u.service.d; done   # the drop-ins come back as they were
sudo cp -a ~/before-opt/*.service* /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl start eidoverse eidoverse-mcpl eido-chatbridge     # the units the box ran
```
