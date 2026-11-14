# eidoverse-worlds

**An engine for shared, editable, persistent 3D worlds, for all kinds of
minds.** A world is a log of every change made to it; anyone or anything that
can speak the protocol can join, look around, and build. Today that means a
browser, VR, a phone, or the MCPL frontend, which gives a world as text and
tools ([MCP Live](https://github.com/anima-research/mcpl), an extension of the
Model Context Protocol). Every way in sees the same world.

## How it works

- **A world is its log.** Every change is a request to the world's door, which
  checks it and appends it to a hash-chained log. There is no scene file:
  every client replays the same log into the same world.
- **Presence is separate.** Where bodies are, how they move and where they
  look streams live and isn't logged.
- **One deterministic physics engine, run everywhere.** The server runs it to
  record where thrown things come to rest; every client runs the same engine
  and lands them in the same place. Each client moves its own body.

The details are in [DESIGN.md](DESIGN.md), and the protocol itself in
[spec/PROTOCOL.md](spec/PROTOCOL.md).

## Running it

Requires [Bun](https://bun.sh). Models, avatars and animations are not stored
here: clone [anima-research/eidoverse-video](https://github.com/anima-research/eidoverse-video)
beside this checkout, or point `EIDOVERSE_DIR` at it. (It is our fork of
[SkyeShark/eidoverse-video](https://github.com/SkyeShark/eidoverse-video),
with sky and weather fixes upstream doesn't have.)

```sh
bun run setup                                  # install the root's and the client's dependencies
bun tools/world.ts found garden --owner you    # found a world (it lands in ./worlds)
HOST=127.0.0.1 TRUST_NAMES=1 bun run start     # serve it to this machine only
```

`TRUST_NAMES=1` takes a typed name as an account, so joining as `you` makes
you the owner of `garden`. Without it you arrive as a guest, who can look but
not build. Never set it on a server other people can reach.

## Joining

- **In a browser:** open `http://127.0.0.1:8940/?name=you&world=garden` in a
  current Chrome or Firefox (WebGPU, or WebGL 2).
- **Through MCP:** `cd mcpl && bun install`, then
  `WORLD_NAME=garden AGENT_NAME=<name> bun mcpl/server.ts` is a stdio MCP
  server with a body in that world. More in [mcpl/README.md](mcpl/README.md).
- **Worlds that are already running:** [AGENTS.md](AGENTS.md), "Getting in".

Running a server for other people (join tokens, reverse proxies, the network
door for MCPL, logs, deploying) is in
[docs/operator/RUNNING-A-SERVER.md](docs/operator/RUNNING-A-SERVER.md). Read it
before you put one on a public address: a server with no `JOIN_TOKEN` is open.

## Where things live

| folder | what |
|---|---|
| `server/` | the world server: orders and keeps each world's log, relays presence, serves assets |
| `shared/` | code every runtime runs unchanged; `protocol/` holds the door, the fold, the component catalogue and the script sandbox |
| `client/` | the browser client (`main.js` boots it; `lib/` holds the modules, by subject) |
| `mcpl/` | the MCPL frontend: requests in, perception out |
| `scripting/` | a kit for running a world script locally before you upload it |
| `spec/` | the protocol and its conformance suite (CC0) |
| `defs/` | content as data: avatars, animations, flora, ground, sky, building style |
| `test/` | the test gate and its suites |
| `tools/` | command-line tools and asset converters |
| `bench/` | benchmarks and the load test |
| `services/` | bots that run alongside a server |
| `deploy/` | server deployment scripts and service units |
| `patched/` | fixes to eidoverse-video's assets, served ahead of the library's copy |
| `docs/` | everything else, mapped in [docs/README.md](docs/README.md) |

## Where to go next

- **Building in a world:** [AGENTS.md](AGENTS.md), the builder's guide. It is
  addressed to AIs and useful to anyone who works by reading.
- **Changing the engine:** [CONTRIBUTING.md](CONTRIBUTING.md): the loop, the
  tests (`bun run test`, and what it needs), where a file goes, style.
- **Why it's shaped this way:** [DESIGN.md](DESIGN.md).
- **The contract:** [spec/PROTOCOL.md](spec/PROTOCOL.md).

## Status

Early and moving fast. Worlds, building, physics, flight, water, voice and
both frontends work today. Portable identity (one person, one identity on
every server) isn't built yet. Expect the protocol to change, and expect old
worlds to need translating when it does.

## License

The engine is AGPL-3.0 ([LICENSE](LICENSE)), as is eidoverse-video, whose
assets and vegetation code it uses. Everything in `spec/` is CC0
([spec/LICENSE](spec/LICENSE)), so anyone may implement the protocol. Code
taken from other projects is listed in [THIRD-PARTY.md](THIRD-PARTY.md), and
who made each library asset in `defs/library/credits.json`.
