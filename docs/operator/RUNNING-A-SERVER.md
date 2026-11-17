# Running a server

The world server is `bun server/server.ts` (`bun run start`). Most variables it reads are in `server/config.ts` (a few
live where they're used: `server/clientlog.ts`, `server/server.ts` RENAME_COOLDOWN_DAYS, `server/limits.ts` EW_*); the ones
an operator usually sets are below.

## The server

| variable | default | what |
|---|---|---|
| `PORT` | 8940 | the port |
| `HOST` | `0.0.0.0` | the interface; `127.0.0.1` keeps it on this machine |
| `WORLDS_DIR` | `./worlds` | where worlds live |
| `EIDOVERSE_DIR` | `../eidoverse-video` | the asset library checkout |
| `JOIN_TOKEN` | empty | gates the door; empty means open, fine on a tailnet, not on a public box |
| `TRUST_NAMES` | off | `1` takes a typed name as an account; for a private server only, never one strangers can reach |

On first boot a server with no operator prints `No operator yet. Open …/setup#token=…`: open that link in a signed-in
browser to become the operator (an agent POSTs the token to `/setup`). `bun tools/world.ts found <name> --owner <you>`
founds a world.

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
has in `/etc/systemd/system` when it differs (then `daemon-reload`), restarts `eidoverse` and `eidoverse-mcpl`, try-restarts the
other installed units (one you stopped stays stopped) and exits nonzero if any unit that should be up is not running. A unit with secrets reads them from its `EnvironmentFile=` (`/etc/eidoverse/<unit>.env`; the MCPL template has none,
its tokens are `mcpl/tokens.json`); a unit whose new version needs an env file the box lacks stops the deploy before the reset, so nothing changes. `deploy/eidoverse.service.template` and `deploy/eidoverse-mcpl.service.template` are
written from this repo, not copied from the VPS: diff each against the installed unit before renaming it to `.service`.

The first deploy after the repo reorganisation (#333) runs the old script, which stops after the reset because
`tools/protocol/run.ts` moved to `test/gate/run.ts`. Run `deploy/deploy-vps.sh` again: it has no `.deploy-done` yet, so
it installs everything and restarts the units. A Mac renderer's watchdog (`deploy/run-mac-renderer.sh`) probes the
client's capture module by path, and that moved too (`/lib/capture.js` → `/lib/render/capture.js`): pull and restart each
Mac renderer in the same window, or its watchdog restarts healthy renderers. The bots moved from `tools/` to `services/`:
a captionbot run from its own directory keeps unconfirmed captions in `./captionbot.spool.jsonl`, so move
`tools/captionbot/captionbot.spool.jsonl` to `services/captionbot/` (or set `SPOOL`) before starting it there.
