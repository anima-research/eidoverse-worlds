# Browser-approved Unreal login

Deployed to production on 2026-09-10 as targeted commit `097ab71`, based on the
previous production release `78d79b9`. Deployment/restart is an operator decision. No home-node
or Discord OAuth configuration changes, world verbs, or fold changes are needed.

1. Unreal posts `{}` to `/native/start`; receives a 256-bit `device_code`, a
   display `user_code`, five-minute expiry and two-second polling interval.
2. It opens `/native#code=ABCDE-12345`. Only the display code is in the fragment;
   the secret device code stays in native memory and POST bodies.
3. The approval page uses ordinary Discord login. It retains the display code
   in same-tab sessionStorage; `/auth` returns to `/native` after its existing
   token/cookie exchange instead of entering the browser world.
4. The user verifies the matching code and explicitly approves. Same-origin JSON
   POST plus the HttpOnly browser session is required. Cross-origin/missing Origin
   approvals, spectators without join scope, and native-session re-delegation fail.
5. `/native/poll` returns 202 pending, 429 slow down, 403 denied/revoked or 410
   expired/used. A successful single-use redemption returns a separate `ew_sess`
   cookie plus name and remaining lifetime. Native cookies carry only join/spectate
   scopes, for every world the account may join (as the browser's session does), and
   `native: true`, which stops them approving another pairing. Sessions issued before
   this flow was deployed carry `nativeWorld` instead and are treated the same; the poll
   still answers `world_scope: "*"` for clients of that time.
6. The approval page has one **Approve** button: there is no per-world choice. Pairing
   itself never joins; the client joins a world as the signed-in person afterwards.
   Native logout revokes only the independent native session.

Pending grants are process-local (restart cancels them), capped at 256 and five
minutes, with 30 starts/minute and 1200 route requests/minute globally. Deployment
behind multiple workers would need sticky routing or a shared atomic grant store.
The current single sequencer needs no additional storage. Native sessions use the
existing private session persistence. Re-login is required after native expiry.

`HN_NATIVE_ORIGIN` defaults to `https://eidoverse.animalabs.ai`. Staging/local
servers must set their exact public origin. A native-login request carrying an
Origin is compared with that configured or default origin only; it does not trust
Host or forwarded headers (server/native-login.ts).

The signed-in WebSocket guard (server/auth.ts `ownOrigin`) applies when a browser
sends no `Sec-Fetch-Site`, and has two cases:
- `HN_NATIVE_ORIGIN` set: the Origin must equal it exactly (scheme, host, port).
- unset: the Origin must equal the request's own scheme and its `Host` header
  (the URL's host without one). Behind a proxy that is not the public origin, so
  set `HN_NATIVE_ORIGIN` there (README, deploy/SHOW_RUNBOOK.md).

The existing `HN_ISSUER_KEY` enables the feature and
`HN_LOGIN_URL` supplies the browser login destination. `HN_SESSIONS_FILE` optionally
isolates session persistence for tests; the production default is unchanged.

No request bodies, cookie headers, or device secrets should be captured by proxy
logging. Serve these paths over HTTPS, without caching or CORS. Pairing pages have
no-referrer, anti-framing and nonce-based script policies. Users must never approve
a code received from someone else (standard device-pairing phishing risk).

## Verification

- `bun tools/native-login-test.ts`: isolated handler safety/expiry/replay/rate tests;
  no session/world files or production traffic.
- `bun tools/native-login-wire-test.ts`: scratch issuer, real HTTP and WS on
  loopback :18997, scratch worlds/session/optimizer/relay state. Verifies independent
  sessions, verified joins in three worlds, a session paired before this flow joining
  another world and answered there over HTTP as the browser's session is, no
  re-delegation, replay and browser/native logout isolation. Refuses an occupied
  test port.
- `bun tools/native-login-fixture.ts`: loopback :18996, memory-only fake identity.
  In Unreal PIE use `Eidoverse.TestDiscordPairing` (development builds only).
  `POST /fixture/approve` or `/fixture/deny` simulates browser consent. The actual
  native start/poll/cancel/logout requests run; this fixture can never join production.
  `/fixture/report` exposes counters only. Stop the fixture after QA.

Production HTTPS smoke checks passed for the page/security headers, start,
pending, authentication/Origin guards, cancellation and replay refusal. Actual
Discord OAuth and approved native login still need the user's human sign-in test.

The production checkout is on `deploy/native-login-20260910`, with a clean
worktree. Only the world server was restarted; the MCPL service was not restarted.
The patch has not been pushed/merged into upstream main: merge it before running
the generic deploy script, whose reset to origin/main would otherwise remove it.
Rollback source is retained on the VPS at
`/home/ubuntu/eidoverse-native-deploy.9EXgyp/source-before.tgz` and Git branch
`backup/pre-native-login-20260910`. Any rollback after native sessions have been
issued must revoke those native sessions first. Preserve ordinary browser sessions and
world data. (Before this flow was deployed, a native session was limited to the water
world unless its approval chose all accessible worlds.)
