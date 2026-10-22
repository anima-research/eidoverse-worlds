// videosources — the operator's video source registry, the appliance's source state, and the WHEP sessions the
// sequencer brokers for viewers (projector design revision 2; shared/video.js says what a `video` MEANS).
//
// THE REGISTRY is an operator file, never a world's state: VIDEO_SOURCES names it (default: none, so no source is
// admitted and every `video` write is refused at the door). It maps an id to where its stream is:
//
//   { "sources": { "solstice": { "whep": "http://127.0.0.1:8889/screen/whep",   the appliance's WHEP play face
//                                "user": "reader", "pass": "…",                 the appliance's read credential
//                                "api": "http://127.0.0.1:9997", "path": "screen",  where the state is read (optional)
//                                "ended": false } } }                           the operator says the event is over
//
// It is read at boot and again whenever the file changes, so the operator can admit, revoke or end a source without a
// restart. A revoked id is refused at the door from that moment, its observations are forgotten, and every session
// brokered for it is closed. The endpoint and the credential never leave this module: they are not logged, not
// broadcast and not sent to any client. A malformed entry is dropped and named by its id alone.
//
// THE SOURCE STATE is what the appliance observed (mediamtx's API, /v3/paths/get/<path>): offline (no publisher), live
// (a publisher, and bytes arrived since the last read), ended (the operator's word) — and nothing when the appliance
// can't be read, so the observation goes stale and look says unknown (shared/video.js sourceStateNow). A path that is
// ready but whose bytes stopped is not live: it reads as offline until bytes flow again. Each world with anyone in it
// gets the states as {source, state, ageMs}: an AGE, never a timestamp, so another machine's clock can't freshen it.
//
// THE SESSIONS. A viewer never learns the endpoint: it sends its SDP offer over its own authenticated connection
// (video-offer), and the sequencer posts it to the appliance with the read credential and returns the answer
// (video-answer). The appliance's session resource stays here. A session is bound to the entity's `video` value as it
// was when brokered: when that value changes (another source, or the screen taken down), the viewer leaves the world,
// or the source is revoked, the sequencer DELETEs the appliance session and tells the viewer (video-closed). Each viewer
// holds at most VIEWER_SESSION_CAP sessions and may offer at most once per OFFER_GAP_MS.
//
// What this can't hide: WebRTC media flows between the browser and the appliance, so the answer's ICE candidates carry
// the appliance's media address (an IP and a UDP port). That is transport, not the endpoint or a credential, and only a
// relay (TURN, or route B through the SFU) would hide it.

import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { admitVideoSources, noteSourceState, forgetSourceState, sourceStateOf, VIDEO_SOURCE_ID, SOURCE_STATES } from "../shared/video.js";

export const VIEWER_SESSION_CAP = 4;
export const OFFER_GAP_MS = 2_000;
export const POLL_MS = 5_000;
export const SWEEP_MS = 1_000;
export const APPLIANCE_TIMEOUT_MS = 5_000;
export const SDP_MAX = 64 * 1024;

type Source = { id: string; whep: string; user?: string; pass?: string; api?: string; path?: string; ended: boolean };
type Session = { id: string; resource: string | null; source: string; world: any; entity: string; client: any; bound: string; auth?: string };

const SOURCES = new Map<string, Source>();
const SESSIONS = new Map<string, Session>();
const LAST_BYTES = new Map<string, number>();
const LAST_OFFER = new WeakMap<object, number>();
// each viewer's newest offer per screen that is still at the appliance: it holds a slot, and an older answer for that
// screen is closed when it lands (a rebuilt screen drops the late answer, and only the server can be relied on to close it)
const IN_FLIGHT = new WeakMap<object, Map<string, string>>();
let FILE = "";
let FILE_STAMP = "";

const httpUrl = (s: unknown): string | null => {
  if (typeof s !== "string" || s.length > 2048) return null;
  try { const u = new URL(s); return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.toString() : null; } catch { return null; }
};
const basic = (s: Source) => (s.user ? "Basic " + Buffer.from(`${s.user}:${s.pass ?? ""}`).toString("base64") : undefined);

/** Parse a registry document into sources and the ids it dropped (by id only: a bad entry's contents aren't echoed). */
export function parseRegistry(doc: unknown): { sources: Source[]; dropped: string[] } {
  const out: Source[] = []; const dropped: string[] = [];
  const raw = doc && typeof doc === "object" && (doc as any).sources && typeof (doc as any).sources === "object" ? (doc as any).sources : {};
  for (const [id, e] of Object.entries<any>(raw)) {
    const whep = httpUrl(e?.whep); const api = e?.api === undefined ? undefined : httpUrl(e.api);
    const path = e?.path === undefined ? undefined : typeof e.path === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(e.path) ? e.path : null;
    const okCred = (e?.user === undefined || (typeof e.user === "string" && e.user.length <= 128)) && (e?.pass === undefined || (typeof e.pass === "string" && e.pass.length <= 256));
    if (!VIDEO_SOURCE_ID.test(id) || !whep || api === null || path === null || (api && !path) || !okCred || (e?.ended !== undefined && typeof e.ended !== "boolean")) { dropped.push(id); continue; }
    out.push({ id, whep, user: e.user, pass: e.pass, api: api ?? undefined, path: path ?? undefined, ended: e.ended === true });
  }
  return { sources: out, dropped };
}

/** Install a registry: admit its ids at the door, forget the revoked ones, close their sessions. Returns what changed. */
export function installSources(list: Source[]): { admitted: string[]; revoked: string[] } {
  const before = new Set(SOURCES.keys());
  SOURCES.clear(); for (const s of list) SOURCES.set(s.id, s);
  const { admitted } = admitVideoSources([...SOURCES.keys()]);
  const revoked = [...before].filter((id) => !SOURCES.has(id));
  for (const id of revoked) { forgetSourceState(id); LAST_BYTES.delete(id); for (const s of [...SESSIONS.values()]) if (s.source === id) void closeSession(s, "the operator revoked this source"); }
  for (const s of SOURCES.values()) if (s.ended) noteSourceState(s.id, { state: "ended", at: Date.now() });
  return { admitted, revoked };
}

/** Read the operator's registry file (VIDEO_SOURCES). No file named: nothing admitted. An unreadable or unparsable
 *  file keeps what was installed and says so: a typo mid-event doesn't take every screen down. */
export function loadSourcesFile(file = FILE): void {
  FILE = file;
  if (!file) { installSources([]); console.log("[video] no VIDEO_SOURCES file: no video source is admitted (every video write is refused)"); return; }
  let doc: unknown;
  try { const st = statSync(file); FILE_STAMP = `${st.mtimeMs}:${st.size}`; doc = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { console.warn(`[video] VIDEO_SOURCES couldn't be read (${(e as Error).name}): keeping the ${SOURCES.size} source(s) already admitted`); return; }
  const { sources, dropped } = parseRegistry(doc);
  const { admitted, revoked } = installSources(sources);
  console.log(`[video] sources admitted: ${admitted.join(", ") || "none"}${dropped.length ? `; dropped as malformed: ${dropped.join(", ")}` : ""}${revoked.length ? `; revoked: ${revoked.join(", ")}` : ""}`);
}
function reloadIfChanged() {
  if (!FILE) return;
  try { const st = statSync(FILE); if (`${st.mtimeMs}:${st.size}` !== FILE_STAMP) loadSourcesFile(FILE); } catch { /* gone: keep what's installed */ }
}

// ---- the source state ----
async function observe(s: Source): Promise<void> {
  if (s.ended) { noteSourceState(s.id, { state: "ended", at: Date.now() }); return; }
  if (!s.api || !s.path) return;   // no API to ask: never observed, so look says unknown
  try {
    const r = await fetch(new URL(`v3/paths/get/${s.path}`, s.api.endsWith("/") ? s.api : s.api + "/"), { headers: basic(s) ? { authorization: basic(s)! } : {}, signal: AbortSignal.timeout(APPLIANCE_TIMEOUT_MS) });
    if (!SOURCES.has(s.id)) return;   // revoked while asking
    if (r.status === 404) { LAST_BYTES.delete(s.id); noteSourceState(s.id, { state: "offline", at: Date.now() }); return; }
    if (!r.ok) return;
    const j: any = await r.json();
    const bytes = Number(j?.bytesReceived); const prev = LAST_BYTES.get(s.id);
    if (Number.isFinite(bytes)) LAST_BYTES.set(s.id, bytes);
    const flowing = j?.ready === true && Number.isFinite(bytes) && prev !== undefined && bytes > prev;
    if (j?.ready !== true) noteSourceState(s.id, { state: "offline", at: Date.now() });
    else if (prev !== undefined) noteSourceState(s.id, { state: flowing ? "live" : "offline", at: Date.now() });
    // ready on the first read with no baseline: wait one poll for bytes before saying live
  } catch { /* unreachable: leave it to go stale (unknown), never guess */ }
}

/** Read every source's state from its appliance once. */
export async function observeAll(): Promise<void> { await Promise.all([...SOURCES.values()].map(observe)); }

/** What each world is told: every admitted source's last observation, as an age. */
export function stateFrame(now = Date.now()) {
  const states = [...SOURCES.keys()].map((id) => { const o = sourceStateOf(id); return o && SOURCE_STATES.includes(o.state) ? { source: id, state: o.state, ageMs: Math.max(0, now - o.at) } : null; }).filter(Boolean);
  return { type: "video-state", states };
}

// ---- the sessions ----
// The sequencer's World.state is the VIEW (worldlog.ts viewState → shared/protocol/view.js viewOf): an entity's components
// sit on its record, not under `c` as in the authority's fold record
const videoOf = (world: any, entity: string): any => world?.state?.entities?.[entity]?.video;
const boundOf = (world: any, entity: string): string | null => { const v = videoOf(world, entity); return v && typeof v === "object" && typeof v.source === "string" ? JSON.stringify([v.source]) : null; };

async function closeSession(s: Session, why: string): Promise<void> {
  if (!SESSIONS.delete(s.id)) return;
  try { s.client?.ws?.send(JSON.stringify({ type: "video-closed", session: s.id, id: s.entity, why })); } catch { /* gone */ }
  if (s.resource) { try { await fetch(s.resource, { method: "DELETE", headers: s.auth ? { authorization: s.auth } : {}, signal: AbortSignal.timeout(APPLIANCE_TIMEOUT_MS) }); } catch { /* the appliance reaps it */ } }
}

/** A viewer's offer for the screen on `entity`: refusals say why in words, never naming the endpoint. */
export async function offer(c: any, msg: any, now = Date.now()): Promise<object> {
  const req = typeof msg?.req === "string" ? msg.req.slice(0, 64) : null;
  const no = (why: string) => ({ type: "video-error", req, id: typeof msg?.id === "string" ? msg.id.slice(0, 128) : null, why });
  if (!c?.world || c.spectator) return no("only someone in this world can watch its screens");
  const last = LAST_OFFER.get(c) ?? -Infinity;
  if (now - last < OFFER_GAP_MS) return no(`too soon: one offer every ${OFFER_GAP_MS / 1000} s`);
  LAST_OFFER.set(c, now);
  if (typeof msg.id !== "string" || typeof msg.sdp !== "string" || !msg.sdp || msg.sdp.length > SDP_MAX) return no("video-offer is {id, sdp, req?}: the screen's thing and an SDP offer");
  const v = videoOf(c.world, msg.id);
  if (!v || typeof v !== "object") return no(`${msg.id} has no video`);
  const src = SOURCES.get(v.source);
  if (!src) return no(`the source '${String(v.source).slice(0, 40)}' isn't admitted on this server`);
  if (src.ended) return no(`the source '${src.id}' has ended`);
  let inFlight = IN_FLIGHT.get(c); if (!inFlight) IN_FLIGHT.set(c, inFlight = new Map());
  // screens this viewer holds or is connecting, the one offered aside (a new offer replaces its own screen's session)
  const screens = new Set([...SESSIONS.values()].filter((s) => s.client === c).map((s) => s.entity));
  for (const e of inFlight.keys()) screens.add(e);
  screens.delete(msg.id);
  if (screens.size >= VIEWER_SESSION_CAP) return no(`at most ${VIEWER_SESSION_CAP} screens at once`);
  const token = randomUUID(); inFlight.set(msg.id, token);
  try { return await connect(c, msg, src, token, inFlight, no); }
  finally { if (inFlight.get(msg.id) === token) inFlight.delete(msg.id); }
}

async function connect(c: any, msg: any, src: Source, token: string, inFlight: Map<string, string>, no: (why: string) => object): Promise<object> {
  const req = typeof msg?.req === "string" ? msg.req.slice(0, 64) : null;
  const bound = boundOf(c.world, msg.id)!;
  let r: Response;
  try { r = await fetch(src.whep, { method: "POST", headers: { "content-type": "application/sdp", ...(basic(src) ? { authorization: basic(src)! } : {}) }, body: msg.sdp, signal: AbortSignal.timeout(APPLIANCE_TIMEOUT_MS) }); }
  catch { return no("the projector didn't answer"); }
  const answer = await r.text().catch(() => "");
  if (r.status === 404) return no(`the source '${src.id}' isn't publishing`);
  if (r.status !== 201 || !answer) return no(`the projector refused the offer (${r.status})`);
  const loc = r.headers.get("location");
  const resource = loc ? new URL(loc, src.whep).toString() : null;
  const s: Session = { id: randomUUID(), resource, source: src.id, world: c.world, entity: msg.id, client: c, bound, auth: basic(src) };
  // the value may have changed, or the viewer gone, while the appliance answered: the sweep would close it, but say so now
  if (boundOf(c.world, msg.id) !== bound || !c.world.clients?.has?.(c)) { SESSIONS.set(s.id, s); await closeSession(s, "the screen changed while connecting"); return no("the screen changed while connecting"); }
  // a newer offer for this screen was made while this one was at the appliance: its answer will be the one used
  if (inFlight.get(msg.id) !== token) { SESSIONS.set(s.id, s); await closeSession(s, "replaced by a newer offer"); return no("replaced by a newer offer"); }
  // one session per viewer per screen: a new one replaces any the viewer still holds there
  for (const old of [...SESSIONS.values()]) if (old.client === c && old.entity === msg.id) await closeSession(old, "replaced by a newer offer");
  SESSIONS.set(s.id, s);
  return { type: "video-answer", req, id: msg.id, session: s.id, sdp: answer };
}

/** A viewer closes its own session. */
export async function close(c: any, msg: any): Promise<void> {
  const s = typeof msg?.session === "string" ? SESSIONS.get(msg.session) : undefined;
  if (s && s.client === c) await closeSession(s, "closed by the viewer");
}

/** Close every session whose binding no longer holds: its viewer left, or its screen's video changed or came down. */
export async function sweep(): Promise<void> {
  for (const s of [...SESSIONS.values()]) {
    if (!s.world?.clients?.has?.(s.client) || s.client.world !== s.world) await closeSession(s, "the viewer left");
    else if (boundOf(s.world, s.entity) !== s.bound) await closeSession(s, "the screen's video changed");
    else if (!SOURCES.has(s.source)) await closeSession(s, "the operator revoked this source");
  }
}
export const sessionCount = (c?: any) => (c ? [...SESSIONS.values()].filter((s) => s.client === c).length : SESSIONS.size);

/** Start: load the registry, poll the appliance, broadcast the states, sweep the sessions. Returns a stop function. */
export function startVideo(worlds: () => Iterable<any>, file = process.env.VIDEO_SOURCES ?? ""): () => void {
  loadSourcesFile(file);
  let polling = false;
  const poll = setInterval(async () => {
    if (polling) return; polling = true;
    try { reloadIfChanged(); await observeAll();
      const frame = JSON.stringify(stateFrame());
      for (const w of worlds()) if (w.clients?.size) for (const c of w.clients) { try { c.ws.send(frame); } catch { /* gone */ } } }
    finally { polling = false; }
  }, POLL_MS);
  const sw = setInterval(() => { void sweep(); }, SWEEP_MS);
  return () => { clearInterval(poll); clearInterval(sw); };
}
