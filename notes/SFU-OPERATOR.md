# Running the SFU as an operator

The honest answer to "does it just work?": **two env vars, and one paragraph
about NAT you should read before blaming the code.** Everything else is
in-band. (Complete env inventory, verified by grep over `server/sfu*` +
`transport.ts`: `VOICE_TRANSPORT` and `SFU_ICE_SERVERS` — that's all.)

## The two knobs

- **`VOICE_TRANSPORT=sfu`** — the switch. Unset (default) is a deliberately
  silent no-voice world: text, presence and builds all work, nothing minted,
  nothing bound. There is no half-on state.
- **`SFU_ICE_SERVERS`** — optional JSON array, handed to browsers inside the
  media credential (so changing it needs no client rebuild):
  `[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:…","username":"…","credential":"…"}]`
  Default when unset: Google's public STUN. **Invalid JSON is refused loudly
  and yields `[]`** — an operator who set the var meant to change it, and a
  silent fallback would hand out config they didn't choose; the symptom would
  be unreachable voice for exactly the remote users the var exists to serve.
  Set it to `[]` explicitly for a LAN-only world with no external dependency.

Dependencies: `bun install` (werift is in package.json as of the engine PR).
No external media server, no SDK, no API keys, no extra process — the world
server IS the relay.

## The NAT paragraph (the part that isn't obvious)

Signaling rides the world websocket, so it traverses whatever HTTP tunnel or
reverse proxy you already have. **Media does not** — RTP flows directly
between each browser and the world server over UDP, negotiated by ICE. What
this means in practice, field-tested 2026-08-16 (phone on cellular ↔ server
behind a home NAT, no port forwarding):

- **You do NOT need to port-forward or hold a public IP.** Both sides send
  outbound; ordinary NATs open a return path for the connectivity checks
  (standard ICE hole-punching). STUN is what lets each side learn its public
  address — which is why the default exists and why removing it breaks
  exactly and only the cross-network case.
- **Outbound UDP must not be blocked** on the server's host firewall. werift
  binds ephemeral UDP ports; there is nothing to forward, but there must be a
  way out.
- **Symmetric NAT (some corporate/CGNAT setups) defeats hole-punching.** The
  symptom is ICE stalling in `checking` — the client logs it explicitly after
  8s and tells the user their mic is capturing but transmitting nothing. The
  fix is a TURN server in `SFU_ICE_SERVERS`; that is the only scenario that
  needs one.

## How you know it's working (no ssh required)

- **`/relay-diag`** (server): per-leg `state` / `rxPackets` / `hears` /
  `publishing`, plus consent, mutes and forwarded counts. `rxPackets: 0` on a
  `connected` leg = signaling fine, media path dead → read the NAT paragraph.
- **`/audio`** (typed in the client): the phone-holder's report — starts with
  the served build sha (stale page vs broken probe are indistinguishable
  without it), then live ICE state, candidate types, gate and TTS state.
- **`tools/join-probe.mjs`** over your public URL: protocol-level join check — asserts a good key joins
  AND a bad key is refused — the negative control is the half that catches
  auth accidentally wired open.

## What operators do NOT manage

Credentials are minted per-join by the server (amendment 1 — no API secret
exists to leak), consent/mute/moderation are in-band verbs, and the
supervisor restarts the engine in-process. Speaker-cap and proximity gating
default off; they are world-policy code, not deployment config.
