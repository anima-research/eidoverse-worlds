// relayadapter — the sequencer ↔ LiveKit bridge (#104 phase-1 spike).
// The adapter IS the project: it mints least-authority media credentials
// (A1), owns the durable service incarnation (A2/amendment 2), enforces
// admission for everything LiveKit cannot know about our generations
// (amendment 1 — the probed removed-replay hole), and maps world consent
// onto per-listener subscriptions (A3/amendment 3). Every decision it makes
// lives in relaydecision.ts, headless and pinned by tests; this file is
// only the glue: config, the incarnation file, LiveKit's server SDK, and
// the webhook/probe surfaces.
//
// Deliberately OPTIONAL: with no RELAY_URL configured the adapter is inert
// and the sequencer behaves byte-identically to main (staging posture — the
// mesh remains production until phase-1 acceptance; #104 amendment 6).
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { AccessToken, TokenVerifier, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import { admitParticipant, relayIdentity, parseRelayIdentity, nextIncarnation,
  subscriptionActive, applyConsentUpdate, type RelayClaims } from "./relaydecision.ts";

// ---- config (env; absent = adapter off) ------------------------------------
const RELAY_URL = process.env.RELAY_URL ?? "";                 // http(s)://host:7880
const RELAY_WS_URL = process.env.RELAY_WS_URL ?? RELAY_URL.replace(/^http/, "ws");
// Client-facing address may differ from the adapter's loopback path (phone on
// the tailnet reaches the relay by its tailscale ip, the adapter by 127.0.0.1).
const RELAY_PUBLIC_WS_URL = process.env.RELAY_PUBLIC_WS_URL ?? RELAY_WS_URL;
const RELAY_KEY = process.env.RELAY_KEY ?? "devkey";
const RELAY_SECRET = process.env.RELAY_SECRET ?? "secret";     // NEVER sent to any client
const CRED_TTL_S = 120;                                        // ≤10m is a ceiling, not the default
// Measured 2026-08-13 (killq-a/refusals): livekit-server admits ~60s past exp;
// TokenVerifier defaults to 10s tolerance. Both pinned here: effective
// credential life = CRED_TTL_S + server skew; our own verification is exact.
const VERIFY_TOLERANCE_S = 0;

export const relayEnabled = () => !!RELAY_URL;

// ---- durable incarnation (amendment 2) -------------------------------------
// Advanced atomically at every adapter boot: tmp + rename, so a torn write
// leaves the previous file intact and the entropy suffix makes even a
// lost-file counter reuse non-colliding. All credentials and admission checks
// carry it; a restart strands every old credential structurally.
let incarnation = "i0-unstarted";
function bootIncarnation(dir: string) {
  const file = join(dir, "relay-incarnation");
  const prev = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  incarnation = nextIncarnation(prev, crypto.randomUUID().slice(0, 8));
  const tmp = file + ".tmp";
  writeFileSync(tmp, incarnation);
  renameSync(tmp, file);
  return incarnation;
}
export const currentIncarnation = () => incarnation;

// ---- per-world relay-leg registry ------------------------------------------
// The relay leg is a surface session in the #103 model: a gen from the same
// counter as every other leg, surface "voice-relay", retired by the same
// funnel. The sequencer is the presence authority in every topology — the
// relay never learns to announce a death, it is TOLD about one.
export interface RelayLeg {
  id: string;
  gen: number;              // mediaGen — the sequencer generation of THIS leg
  primaryGen: number;       // the primary it is bound to (revoked with it)
  nonce: string;            // single-use credential id
  identity: string;         // gen-bearing LiveKit identity
}
interface WorldRelayState {
  legs: Map<string, RelayLeg>;                                   // id -> live leg
  usedNonces: Set<string>;                                       // admitted once, ever
  consent: Map<string, { gen: number; consent: boolean }>;       // listenerId -> receive consent
  moderatorMuted: Set<string>;                                   // speaker ids under global mute
}
const worldsState = new Map<string, WorldRelayState>();
const wstate = (world: string): WorldRelayState => {
  let s = worldsState.get(world);
  if (!s) { s = { legs: new Map(), usedNonces: new Set(), consent: new Map(), moderatorMuted: new Set() }; worldsState.set(world, s); }
  return s;
};

// ---- LiveKit handles -------------------------------------------------------
let svc: RoomServiceClient | null = null;
let verifier: TokenVerifier | null = null;
let receiver: WebhookReceiver | null = null;

// ---- health probe (A2: probe + client watchdog are separate evidence) ------
export type ServiceState = "up" | "degraded";
let serviceState: ServiceState = "degraded";
let onServiceChange: ((state: ServiceState, incarnation: string) => void) | null = null;
async function probeOnce() {
  if (!svc) return;
  try {
    await svc.listRooms();
    if (serviceState !== "up") { serviceState = "up"; onServiceChange?.("up", incarnation); }
  } catch {
    if (serviceState !== "degraded") { serviceState = "degraded"; onServiceChange?.("degraded", incarnation); }
  }
}
export const relayServiceState = () => ({ state: serviceState, incarnation });

/** Boot the adapter. `optDir` hosts the incarnation file; `notify` receives
 *  service transitions for the resident-visible chart (one product, one
 *  chart — amendment 2). No-op when RELAY_URL is absent. */
export function bootRelayAdapter(optDir: string, notify: (state: ServiceState, incarnation: string) => void) {
  if (!relayEnabled()) return null;
  bootIncarnation(optDir);
  svc = new RoomServiceClient(RELAY_URL, RELAY_KEY, RELAY_SECRET);
  verifier = new TokenVerifier(RELAY_KEY, RELAY_SECRET);
  receiver = new WebhookReceiver(RELAY_KEY, RELAY_SECRET);
  onServiceChange = notify;
  probeOnce();
  setInterval(probeOnce, 5000);
  console.log(`[relay] adapter up — ${RELAY_URL}, incarnation ${incarnation}`);
  return { incarnation };
}

// ---- A1: mint --------------------------------------------------------------
/** Mint the least-authority media credential for an ADMITTED identity. The
 *  caller is the sequencer's join/admission path — the same gate that owns
 *  aux binding (B1) — so by the time this runs, identity authority is proven.
 *  Media + nothing: room-scoped join/publish/subscribe, no world verbs ride
 *  this token, and the API secret never leaves this process. */
export async function mintRelayCredential(world: string, id: string, primaryGen: number, mediaGen: number,
  scopes: { publish: boolean; subscribe: boolean }) {
  if (!relayEnabled()) throw new Error("relay not configured");
  const s = wstate(world);
  const nonce = crypto.randomUUID();
  const identity = relayIdentity(id, mediaGen);
  const claims: RelayClaims = { world, id, primaryGen, mediaGen, incarnation, nonce };
  const at = new AccessToken(RELAY_KEY, RELAY_SECRET, {
    identity, ttl: CRED_TTL_S, metadata: JSON.stringify(claims) });
  at.addGrant({ room: world, roomJoin: true, canPublish: scopes.publish, canSubscribe: scopes.subscribe,
    canPublishData: false });
  s.legs.set(id, { id, gen: mediaGen, primaryGen, nonce, identity });
  return { token: await at.toJwt(), url: RELAY_PUBLIC_WS_URL, identity, incarnation, ttl: CRED_TTL_S };
}

// ---- amendment 1: admission enforcement ------------------------------------
/** Validate a participant the relay reports joined. LiveKit proved signature,
 *  room grant, and (±60s) expiry; everything generation-shaped is ours. A
 *  refusal is enforced with RemoveParticipant — and because the probed
 *  removed-replay hole is real, the nonce burns on FIRST admission so the
 *  same credential can never re-enter. */
export async function enforceAdmission(world: string, participantIdentity: string, metadata: string | undefined) {
  const s = wstate(world);
  const parsed = parseRelayIdentity(participantIdentity);
  let refuse = "";
  let claims: RelayClaims | null = null;
  try { claims = metadata ? JSON.parse(metadata) : null; } catch { /* refused below */ }
  if (!parsed || !claims) refuse = "malformed identity/claims";
  else {
    const leg = s.legs.get(claims.id);
    const verdict = admitParticipant(claims, {
      world, incarnation,
      primaryGen: leg?.primaryGen, mediaGen: leg?.gen,
      usedNonces: s.usedNonces,
    });
    if (!verdict.admit) refuse = verdict.reason;
    else if (parsed.id !== claims.id || parsed.mediaGen !== claims.mediaGen) refuse = "identity/claims mismatch";
  }
  if (refuse) {
    console.log(`[relay:${world}] admission refused for "${participantIdentity}": ${refuse}`);
    await svc?.removeParticipant(world, participantIdentity).catch(() => {});
    return { admitted: false, reason: refuse };
  }
  s.usedNonces.add(claims!.nonce);
  // Fail-closed receive: a fresh participant hears nothing until consent says
  // so. autoSubscribe=false client-side is the belt; this is the suspenders —
  // reconcile subscriptions for the new arrival explicitly.
  await reconcileSubscriptionsFor(world, claims!.id).catch(() => {});
  return { admitted: true };
}

/** The webhook surface routes here (routes table owns the URL). Signature is
 *  verified by the SDK against our key/secret. */
export async function handleRelayWebhook(body: string, authHeader: string) {
  if (!receiver) return { ok: false };
  const ev = await receiver.receive(body, authHeader);
  if (ev.event === "participant_joined" && ev.room && ev.participant) {
    await enforceAdmission(ev.room.name, ev.participant.identity, ev.participant.metadata);
  }
  if (ev.event === "participant_left" && ev.room && ev.participant) {
    const parsed = parseRelayIdentity(ev.participant.identity);
    if (parsed) legDeparted(ev.room.name, parsed.id, parsed.mediaGen);
  }
  return { ok: true, event: ev.event };
}
let onLegRetired: ((world: string, id: string, gen: number) => void) | null = null;
export const setLegRetiredHook = (fn: typeof onLegRetired) => { onLegRetired = fn; };
function legDeparted(world: string, id: string, gen: number) {
  const s = wstate(world);
  const leg = s.legs.get(id);
  if (leg && leg.gen === gen) {                    // a stale departure must not retire a successor
    s.legs.delete(id);
    onLegRetired?.(world, id, gen);                // sequencer broadcasts surface-transition
  }
}

// ---- retirement (primary death / takeover / moderation) --------------------
/** The sequencer's retirement funnel calls this: revoke the leg AT THE RELAY
 *  (RemoveParticipant) and burn its credential. Measured target: takeover →
 *  old leg's packets refused ≤2s (acceptance row). */
export async function revokeRelayLeg(world: string, id: string): Promise<RelayLeg | null> {
  const s = wstate(world);
  const leg = s.legs.get(id);
  if (!leg) return null;
  s.legs.delete(id);
  s.usedNonces.add(leg.nonce);                     // even an unused credential dies with its leg
  await svc?.removeParticipant(world, leg.identity).catch(() => {});
  return leg;
}

// ---- A3 / amendment 3: consent → subscriptions -----------------------------
/** Listener-authored receive consent (gen-bound, idempotent — decision layer
 *  enforces both). Maps onto UpdateSubscriptions per (listener, speaker
 *  track): the relay stops forwarding, not the client discarding. */
export async function setListenerConsent(world: string, listenerId: string, listenerGen: number, consent: boolean) {
  const s = wstate(world);
  const r = applyConsentUpdate(s.consent, listenerId, listenerGen, consent);
  if (!r.changed) return r;
  await reconcileSubscriptionsFor(world, listenerId).catch(() => {});
  return r;
}

/** Moderator/global mute for a speaker — a different state than consent
 *  (amendment 3), enforced with MutePublishedTrack at the SFU. */
export async function setModeratorMute(world: string, speakerId: string, mutedFlag: boolean) {
  const s = wstate(world);
  mutedFlag ? s.moderatorMuted.add(speakerId) : s.moderatorMuted.delete(speakerId);
  const leg = s.legs.get(speakerId);
  if (!leg || !svc) return;
  const parts = await svc.listParticipants(world).catch(() => []);
  const p = parts.find((x) => x.identity === leg.identity);
  for (const tr of p?.tracks ?? []) {
    await svc.mutePublishedTrack(world, leg.identity, tr.sid, mutedFlag).catch(() => {});
  }
}

/** Reconcile ONE listener's subscriptions against the audibility states.
 *  Idempotent by construction — it states the desired set. */
async function reconcileSubscriptionsFor(world: string, listenerId: string) {
  if (!svc) return;
  const s = wstate(world);
  const listenerLeg = s.legs.get(listenerId);
  if (!listenerLeg) return;
  const consent = s.consent.get(listenerId)?.consent ?? false;   // fail closed
  const parts = await svc.listParticipants(world).catch(() => []);
  for (const p of parts) {
    const parsed = parseRelayIdentity(p.identity);
    if (!parsed || parsed.id === listenerId) continue;
    const active = subscriptionActive({ listenerConsent: consent, moderatorMuted: s.moderatorMuted.has(parsed.id) });
    const sids = (p.tracks ?? []).map((t) => t.sid);
    if (sids.length) await svc.updateSubscriptions(world, listenerLeg.identity, sids, active).catch(() => {});
  }
}

// ---- diagnostics -----------------------------------------------------------
export function relayDiag(world: string) {
  const s = worldsState.get(world);
  return {
    enabled: relayEnabled(), state: serviceState, incarnation,
    legs: s ? [...s.legs.values()].map((l) => ({ id: l.id, gen: l.gen, identity: l.identity })) : [],
    consent: s ? Object.fromEntries([...s.consent].map(([k, v]) => [k, v])) : {},
    moderatorMuted: s ? [...s.moderatorMuted] : [],
  };
}
