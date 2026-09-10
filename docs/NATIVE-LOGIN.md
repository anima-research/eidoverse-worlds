# Browser-approved Unreal login

Deployment/restart is an operator decision. No home-node
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
   scopes and `nativeWorld: water`; the WS join gate checks it before world creation.
6. Unreal offers a separate **Join water** button. Pairing itself never joins.
   Native logout revokes only the independent native session. No persistent client
   credential store; closing Play clears/revokes the session best-effort.

Pending grants are process-local (restart cancels them), capped at 256 and five
minutes, with 30 starts/minute and 1200 route requests/minute globally. Deployment
behind multiple workers would need sticky routing or a shared atomic grant store.
The current single sequencer needs no additional storage. Native sessions use the
existing private session persistence. Re-login is required after native expiry.

`HN_NATIVE_ORIGIN` defaults to `https://eidoverse.animalabs.ai`. Staging/local
servers must set their exact public origin; Origin checks do not trust Host or
forwarded headers. The existing `HN_ISSUER_KEY` enables the feature and
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
  sessions, verified water join, other-world refusal before world creation, replay
  and browser/native logout isolation. Refuses an occupied test port.
- `bun tools/native-login-fixture.ts`: loopback :18996, memory-only fake identity.
  In Unreal PIE use `Eidoverse.TestDiscordPairing` (development builds only).
  `POST /fixture/approve` or `/fixture/deny` simulates browser consent. The actual
  native start/poll/cancel/logout requests run; this fixture can never join production.
  `/fixture/report` exposes counters only. Stop the fixture after QA.

After deployment, real Discord OAuth still needs a human sign-in test. The
automated tests use isolated fixture identities, never production credentials.
