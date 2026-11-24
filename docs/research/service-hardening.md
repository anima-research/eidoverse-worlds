# Hardening the systemd units (deploy/*.service, *.service.template)

What the units in `deploy/` set, why, and what was measured. Operator steps: [RUNNING-A-SERVER](../operator/RUNNING-A-SERVER.md),
"The units". Measured 2026-11-24 on systemd 255, bun 1.4.4, Ubuntu 24.04 (WSL2), on a throwaway box moved from the old
layout (checkout, state, library and bun under a `0750` home, units running as its owner) to this one.

## The shape others use

The layout is the FHS one that Gitea (`contrib/systemd/gitea.service`), Jellyfin and Vaultwarden (Arch's package) use:
code where the deploy puts it (`/opt/eidoverse`, `/usr/local/bin/bun`), state in `/var/lib/<name>` owned by a
dedicated system user, made by `StateDirectory=`. The one difference is that the checkout belongs to the deploy user,
not the service user (`deploy-vps.sh` runs `git` and `bun install` as it), so the server cannot change its own code.

The directive block is the one Synapse ships as its optional `contrib/systemd/override-hardened.conf` and Mastodon
(`dist/mastodon-*.service`) and Arch's Vaultwarden ship by default: `ProtectSystem=strict`, `ProtectHome=`, an empty
capability set, `SystemCallFilter=@system-service` then `~@privileged @resources`, the `Protect*` and `Restrict*`
options, `ProcSubset=pid`. Synapse leaves `MemoryDenyWriteExecute` off for the same reason as here (a JIT).
`systemd-analyze security <unit>` checks it.

## What the server needs at runtime (read from server/, mcpl/, services/chatbridge/)

- **Writes:** `WORLDS_DIR` (worlds, `.directory.json`, `.custody.json`, `.clientlogs/`, `.perflogs.jsonl`), `BACKUPS_DIR`,
  `OPT_DIR` (store, store-min, variants, seats, thumbs, checks, the relay incarnation), `SESSIONS_PATH` (written by
  rename), and `os.tmpdir()` for the KTX2 encoder's scratch (`PrivateTmp=` serves it). The door writes `MCPL_STATE` by
  rename too. All are env settings already; the units point them into `/var/lib/eidoverse` and `/var/lib/eidoverse-mcpl`.
  The chat bridge writes nothing.
- **Reads:** the checkout, bun, the library (`../eidoverse-video`, so `/opt/eidoverse-video`), `mcpl/tokens.json`
  (group `eidoverse`, `deploy-vps.sh` sets it).
- **Children:** the optimizer (`bun run server/optimize.ts` under `/bin/sh`, which raises its `oom_score_adj` first),
  buildcheck, the avatar importer, `toktx`/`ktx` when installed, and `git` (world provenance, `/version`), which refuses
  a checkout another user owns unless it is named in `safe.directory` (the unit sets it by `GIT_CONFIG_*`; measured:
  "dubious ownership" without).
- **Network:** listens on `PORT`; outbound STUN (`stun.l.google.com`, UDP) for the voice SFU; netlink for the interfaces
  werift offers. The bridge reaches Discord over HTTPS/WSS. So no `PrivateNetwork=` or `IPAddressDeny=`.

## The optimizer's memory cap

The optimize child used to run under `ulimit -d <budget>`. `RLIMIT_DATA` charges every private writable mapping
(`is_data_mapping()` in Linux `mm/vma.h`; `MAP_NORESERVE` does not matter), so bun's startup reservations count: a
1 GiB mimalloc arena, a 1 GiB JIT pool, then the Structure heap. bun 1.4.4 and 1.4.5 abort at start when less than
128 MiB is left for the last (up to 260, 1029 to 1156 and 2053 to 2180 MB), and run silently without the JIT when the
pool doesn't fit (below about 2300 MB, every default budget on a box under ~4.6 GB). Upstream knows the abort windows
(oven-sh/bun#39967, oven-sh/WebKit#760).

No referent caps a child with an rlimit. The systemd-native cap is the cgroup, which charges touched memory: the world
server's `MemoryMax=` with `OOMPolicy=continue`, and the child at `oom_score_adj` 1000 so the kernel picks it. Outside
systemd only the estimate gate (`OPT_MEM_BUDGET_MB`) applies.

## Measured

| check | result |
|---|---|
| `systemd-analyze security`, before | 9.0 UNSAFE, all three |
| after (offline and live) | 1.3 OK, all three |
| `MemoryDenyWriteExecute=yes` | bun runs, with the JIT off: a hot loop 857 ms → 2760 ms. Left off |
| `ProcSubset=pid` | `os.totalmem()`, `os.cpus()`, `os.networkInterfaces()` unchanged under it |
| optimizer budget with `MemoryMax=2G` | before `cgroupMemoryMax()` 29483 MB (half of physical: the root cgroup reads `max`); after, 1073 MB |
| the child's `oom_score_adj`, in the unit (`ProtectProc=invisible`, `ProcSubset=pid`) | 1000, data limit `unlimited` |
| `MemoryMax=700M`, an `OPT_CMD` that allocates until killed | the kernel killed the child 51 times (`oom_score_adj:1000` in each kill line); the server kept its PID, `NRestarts=0`, every item deferred `child died (SIGKILL)` |
| a hot loop under `ulimit -d` (bun 1.4.4) | 1086 ms uncapped, 3042 ms at 1000 MB, 2827 ms at 2000 MB, 923 ms at 2400 MB |

## Left out, and why

- `PrivateUsers=`, `DynamicUser=`: operators' tools write the same state as the units (`sudo -u eidoverse`), so the
  user is a real, stable one.
- `MemoryMax=`/`TasksMax=` on the door and the bridge: no referent ships one and nothing here has needed one.
- `LimitCORE=`: no referent sets one; `coredumpctl` keeps recording crashes.
- `CPUQuota=`: on a box that runs only this, a quota only slows the server. A drop-in can set one.
- `IPAddressDeny=`/`PrivateNetwork=`: outbound is needed (above).
