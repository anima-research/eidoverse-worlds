# Cutover rollback — the operator runbook

The #132 contract (review, 2026-08-18): *"bounded deployment rollback to the
previous release during the migration acceptance window if cutover fails —
ordinary release rollback, not an ongoing product architecture."* This is that
procedure, executable as written. It assumes the deployment practice this
repository already uses: a checkout of a known sha served by `bun
server/server.ts` behind the tunnel.

## The acceptance window

Opens when the cutover release first serves production; closes when the
operator (antra) declares acceptance — suggested soak: one week of ordinary
use including at least one multi-party voice session and one agent voice leg.
Inside the window the previous release stays deployable as-is. After
acceptance, it retires: relay-only is the product and this runbook expires.

## Pre-deploy gate (before cutover goes live)

1. The composed receipt set green on the exact deploy sha (PR body lists it).
2. `bun tools/join-probe.mjs <public-url> <good-key>` — joins; and with a bad
   key — refused. The negative control is the half that catches auth wired
   open.
3. `/version` on the deployment reports the deploy sha (a stale process is
   invisible any other way).

## Deciding to roll back

Roll back when, inside the window, voice is materially worse than pre-cutover
and the cause is not resolved same-day: no audio where the mesh had audio,
`/relay-diag` showing legs that never go live, or a world-server crash traced
to the relay path. Text/presence regressions are NOT rollback triggers for
this seam — they indicate a different problem (the cutover touches no text
path; see CUTOVER-ARTIFACTS §3).

## The procedure (release rollback, ~minutes)

1. Note the failing state first: save `/relay-diag`, `/version`, and the
   world log tail. The rollback destroys the reproduction.
2. Check out the previous release sha (recorded at deploy time — the deploy
   that does not write down what it replaced cannot be rolled back calmly).
3. `bun install` at that sha (lockfile pairs with it), restart the server
   process, verify `/version` reports the OLD sha.
4. Canary: join with a good key from a real browser — voice works the old
   way; bad key refused.
5. Announce in-world that a reload is needed (the hard-reload seam runs in
   both directions: pages served by the new release do not speak the old
   voice protocol, and vice versa — CUTOVER-ARTIFACTS §3).

No data migrates in either direction: worlds, tokens, and state files are
untouched by the cutover, so rollback is process-swap only. The one durable
artifact the relay writes — `relay-incarnation` — is ignored by the previous
release and harmless to leave.

## After a rollback

The cutover PR reopens as CHANGES_REQUESTED against whatever the saved
diagnostics show. Re-cutover is a fresh deploy of a fixed sha through this
same gate — the window does not "resume", it restarts.
