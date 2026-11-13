// eidoverse-worlds sequencer — ban DATA (TEL0S_NOTES §15, step 7a).
// The instance-wide ban list and its persistence, plus the one lookup both
// doors share. Only the data lives here: `expel` (the act of removing a live
// body) stays in server.ts with the session's client maps — moderation owns
// what is REMEMBERED, not what is done. Imported by server.ts right after
// auth, so the restore-at-boot block runs exactly where it always did.

import { existsSync, readFileSync } from "node:fs";
import { writePrivate } from "./fsutil.ts";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { ACCOUNT_SHAPE } from "./directory.ts";
import { mainKnowledge, type Known } from "./mainknew.ts";
type Any = any;

// ---- server bans ------------------------------------------------------------
// The door's own list, across all its worlds (each world's own bans are its door's moderator log). There is no global
// log, so it is a JSON file INSIDE WORLDS_DIR (bans are world data: a scratch WORLDS_DIR gets a scratch list).
// Keyed by ACCOUNT (security review 10-06 H4/L4): a display name is typed, not proven, so banning a name hit every
// namesake and missed the person the moment they picked another. A guest has no account: their ban names their
// connection's address (hashed, never stored raw) and expires (ADDR_BAN_MS) — an address is shared and reassigned.
export type BanRec = { by: string; ts: number; reason?: string; name?: string; account?: string; addr?: string; until?: number; world?: string; legacySub?: boolean; boundFrom?: string };
export const ADDR_BAN_MS = 24 * 3600 * 1000;
export const BANS_FILE = join(WORLDS_DIR, ".bans.json");
export const serverBans: Record<string, BanRec> = {};
const refusedBans: Record<string, BanRec> = {};   // refused at boot (restoreBans): never enforced, written back as they were
/** Pre-account bans (a name alone) main's records bind to no one account: kept on disk, never enforced, listed for operators. */
export const pendingBans: Record<string, BanRec & { why: string }> = {};
/** Why a ban bound by name alone is worth a look (review full-260 L11): the name was typed, so its wearer may not be that account. */
export const BOUND_BY_NAME = "the name was typed, so a guest who wore it may have been someone else; server-unban <the name> lifts it";
export const PENDING_WORDS = "pre-account ban: bind to a person (server-ban <the name> binds whoever wears it here) or lift (server-unban <the name>)";
/** A ban or sanction file that couldn't be read at boot: kept as it was, never saved over (the ledger's rule). */
const unreadable = new Set<string>();
/** The ban or sanction files that couldn't be read at boot: while any is, the door is LOCKED (access.ts entryFor; R 11-03,
 *  a fail-safe default like a wiki's maintenance mode): owners, operators and role holders get in, everyone else is refused. */
export const doorLocked = (): boolean => unreadable.size > 0;
/** The refusal a locked door gives, in plain words. */
export const LOCKED_WHY = "this server can't read its ban list right now, so only its owner, operators and role holders can join until it's fixed";
/** One line for the boot log and the operator's list while the door is locked, else null. */
export const lockedLine = (): string | null => unreadable.size ? `LOCKED: ${LOCKED_WHY} (${[...unreadable].join(", ")}; fix or move aside and restart)` : null;
const keptAside = (f: string, what: string) => { if (!unreadable.has(f)) return null; const why = `${f} couldn't be read at boot and is kept as it was; fix or move it aside and restart`; console.log(`[mod] ${what} not saved: ${why}`); return why; };
/** The words a reply and the moderated line carry when a sanction's file wasn't written: it holds in memory only
 *  (`lifted`: the file still holds the sanction, so a restart brings it back). */
export const notPersisted = (why: string, lifted = false) => `NOT persisted: ${why} — ${lifted ? "it comes back at restart" : "it ends at restart"}`;
/** Writes the file; returns why it wasn't written (the record holds in memory only), else null. */
export function saveServerBans(): string | null {
  const kept = keptAside(BANS_FILE, "server bans"); if (kept) return kept;
  try {
    const pending = Object.fromEntries(Object.entries(pendingBans).map(([k, { why: _w, ...b }]) => [k, b]));
    writePrivate(BANS_FILE, JSON.stringify({ ...pending, ...refusedBans, ...serverBans }, null, 2)); return null;
  } catch (e) { console.log(`[mod] server ban save failed: ${e}`); return String((e as Any)?.message ?? e); }
}
/** The ban list as stored, made current. A record from before accounts carried the principal's bare `sub`: a signed-in
 *  person's account is that sub still, but an aid1 agent's is now `aid1:<iss>:<sub>`, so such a record is kept with
 *  `legacySub` and matches the aid1 account whose sub it names (review of #260). A name-keyed record with neither is
 *  bound to the one account main recorded for that name (`known`: mainknew.ts; R 10-28, the Minecraft migration); one
 *  main's records bind to no one account is never enforced (it would hit namesakes): kept in `pending`, listed. */
export function restoreBans(raw: Record<string, BanRec>, refused: Record<string, BanRec> = {}, { known = () => null, pending = {} }: { known?: (name: string) => Known | null; pending?: Record<string, BanRec & { why: string }> } = {}): Record<string, BanRec> {
  const out: Record<string, BanRec> = {}; const dropped: string[] = [], bound: string[] = [];
  for (const [k, b] of Object.entries(raw ?? {})) {
    if (!b || typeof b !== "object" || typeof b.by !== "string") { refused[k] = b; continue; }   // malformed: kept on disk as it was, never enforced
    const sub = (b as any).sub;
    if (b.account && !b.legacySub && !ACCOUNT_SHAPE.test(b.account)) refused[k] = b;   // a legacySub record is matched by its own rule (banHoldsAgainst)
    else if (b.account || b.addr) out[k] = b;
    else if (typeof sub === "string" && sub) { const { sub: _s, ...rest } = b as any; out[k] = { ...rest, account: sub, legacySub: true }; }
    else { const name = b.name ?? k, m = known(name), subs = [...new Set(m?.subs ?? [])];
      const legacy = (x: string) => /^agent:/.test(x) && !ACCOUNT_SHAPE.test(x);   // a home-node agent's sub: its aid1 account ends with it
      if (subs.length === 1 && (ACCOUNT_SHAPE.test(subs[0]) || legacy(subs[0]))) {
        out[`acct:${subs[0]}`] ??= { ...b, name, account: subs[0], ...(legacy(subs[0]) ? { legacySub: true } : {}), boundFrom: `main's ${m!.from.join(" and ")}` }; bound.push(name); }
      else { pending[k] = { ...b, name, why: subs.length > 1 ? `main recorded ${subs.length} accounts under this name` : subs.length ? "main recorded an account that isn't one here" : "main recorded no account for this name" }; dropped.push(name); } }
  }
  if (bound.length) console.log(`[mod] WARNING ${bound.length} pre-account server ban(s) bound to the one account main recorded for the name — check it: ${BOUND_BY_NAME}: ${bound.join(", ")}`);
  if (dropped.length) console.log(`[mod] ${dropped.length} ${PENDING_WORDS.replace(/^pre-account ban/, "pre-account server ban(s)")}; kept on disk, not enforced (they would hit namesakes): ${Object.values(pending).map((b) => `${b.name} (${b.why})`).join(", ")}`);
  const no = Object.entries(refused);
  if (no.length) console.log(`[mod] ${no.length} server ban(s) refused (malformed, or not an account shape; kept on disk, not enforced): ${no.map(([k, b]) => (b as any)?.name ?? k).join(", ")}`);
  return out;
}
try {
  if (existsSync(BANS_FILE)) {
    const raw = JSON.parse(readFileSync(BANS_FILE, "utf8")) as Record<string, BanRec>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object of ban records");
    // a name-keyed record from before accounts: bound through main's records, else kept pending (restoreBans)
    const nameOnly = Object.values(raw ?? {}).some((b) => b && !b.account && !b.addr && !(b as any).sub);   // the logs are read only when needed
    Object.assign(serverBans, restoreBans(raw, refusedBans, { pending: pendingBans, ...(nameOnly ? { known: mainKnowledge(WORLDS_DIR) } : {}) }));
    if (Object.entries(serverBans).some(([k, b]) => b.boundFrom && !(k in raw))) saveServerBans();   // the binding, kept
    if (Object.keys(serverBans).length) console.log(`[mod] ${Object.keys(serverBans).length} server ban(s) loaded`);
  }
} catch (e) { unreadable.add(BANS_FILE); console.log(`[mod] WARNING server ban restore failed: ${e}. ${BANS_FILE} is kept as it was and not saved over; its bans aren't enforced until it is fixed and the server restarted`); }

/** The operator's ban list in words (server-bans): the lock if any, the enforced bans, then the pre-account ones, listed and never enforced.
 *  A timed ban past its end is left out, as findBan leaves it out; the record stays in the file (the history). */
export function serverBansText(map: Record<string, BanRec> = serverBans, pending: Record<string, BanRec & { why: string }> = pendingBans, locked: string | null = lockedLine(), now = Date.now()): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const list = Object.entries(map).filter(([, b]) => b.until == null || b.until > now).map(([k, b]) => `${b.name ?? k}${b.account ? ` (${b.account})` : b.addr ? " (a guest's connection)" : ""} — by ${b.by}, ${day(b.ts)}${b.until && b.account ? `, until ${day(b.until)}` : ""}${b.reason ? `: ${b.reason}` : ""}${b.boundFrom ? ` [bound by name from ${b.boundFrom}; check it: ${BOUND_BY_NAME}]` : ""}`);
  const pre = Object.values(pending).map((b) => `${b.name} — ${PENDING_WORDS} (${b.why}); by ${b.by}, ${day(b.ts)}${b.reason ? `: ${b.reason}` : ""}`);
  return [...(locked ? [locked] : []), list.length ? `server bans (${list.length}):\n${list.join("\n")}` : "no server bans", ...(pre.length ? [`pre-account bans, not enforced (${pre.length}):\n${pre.join("\n")}`] : [])].join("\n");
}
/** The pre-account bans filed under this name (any case, by `fold`), removed: an unban lifts them, a ban that binds replaces them. */
export function takePending(id: string, fold: (s: string) => string, pending: Record<string, BanRec & { why: string }> = pendingBans): string[] {
  const keys = Object.entries(pending).filter(([k, b]) => fold(b.name ?? k) === fold(id)).map(([k]) => k);
  for (const k of keys) delete pending[k];
  return keys;
}
/** Whether a ban record names this account: its own account, or, for a record from before accounts (`legacySub`), the aid1
 *  account whose sub it names, under any issuer. */
export function banHoldsAgainst(b: BanRec, account: string | null | undefined): boolean {
  if (!account || !b.account) return false;
  return b.account === account || (!!b.legacySub && account.startsWith("aid1:") && account.endsWith(`:${b.account}`));
}
/** The keys of the server bans an unban of `id` lifts: the one filed under it, any filed under that name, and any that
 *  holds against one of `accounts` (the account `id` names, or those wearing that name), by the rule a door checks. */
export function bansLiftedBy(map: Record<string, BanRec>, id: string, accounts: Iterable<string>, fold: (s: string) => string): string[] {
  const accts = [...accounts];
  return Object.entries(map).filter(([k, b]) => k === id.toLowerCase() || (b.name && fold(b.name) === fold(id)) || accts.some((a) => banHoldsAgainst(b, a)) || (b as any).sub === id).map(([k]) => k);
}
/** Does a ban list hit this connection? By its account; a guest (no account) by its hashed address while unexpired. */
export function findBan(map: Record<string, BanRec> | undefined, account: string | null | undefined, addr?: string | null, now = Date.now(), world: string | null = null): BanRec | null {
  if (!map) return null;
  for (const b of Object.values(map)) {
    if (b.world && b.world !== world) continue;   // a guest's ban in one world (the door's world ban can't name a guest)
    if (banHoldsAgainst(b, account) && (b.until == null || b.until > now)) return b;   // a timed server ban ends
    if (!account && addr && b.addr === addr && (b.until ?? 0) > now) return b;
  }
  return null;
}
/** The key a ban is filed under. */
export const banKey = (account: string | null | undefined, addr?: string | null, world?: string | null) => `${world ? `world:${world}:` : ""}${account ? `acct:${account}` : `addr:${addr}`}`;

// ---- a guest's mute, by address (R 10-07) ----------------------
// A guest is a fresh identity per connection, so a mute on one was shed by reconnecting. Like a guest's ban
// (above), the sanction is also filed against the connection's HASHED address in that world, for at most
// ADDR_BAN_MS (or the sanction's own shorter end), and every new guest joining that world from the address is given
// the same sanction (server.ts, at join). Lifting it on any identity it was carried to lifts the address record. Kept
// apart from the ban list so nothing that reads bans (findBan, the operator's list) can mistake a mute for a ban.
export type AddrSanction = { kind: "mute"; world: string; addr: string; actor: string; by: string; ts: number; until: number; channels?: string[]; reason?: string; ids: string[] };
export const ADDR_SANCTIONS_FILE = join(WORLDS_DIR, ".addr-sanctions.json");
export const addrSanctions: Record<string, AddrSanction> = {};
/** One record per issuer (`actor`): two people's mutes are never merged into one. */
export const addrSanctionKey = (kind: string, world: string, addr: string, actor: string) => `world:${world}:addr:${addr}:${kind}:by:${actor}`;
/** Writes the file; returns why it wasn't written (the sanction holds in memory only), else null. */
export function saveAddrSanctions(now = Date.now()): string | null {
  const kept = keptAside(ADDR_SANCTIONS_FILE, "address sanctions"); if (kept) return kept;
  for (const [k, s] of Object.entries(addrSanctions)) if (!(s.until > now)) delete addrSanctions[k];
  try { writePrivate(ADDR_SANCTIONS_FILE, JSON.stringify(addrSanctions, null, 2)); return null; }
  catch (e) { console.log(`[mod] address sanction save failed: ${e}`); return String((e as Any)?.message ?? e); }
}
try {
  if (existsSync(ADDR_SANCTIONS_FILE)) {
    const raw = JSON.parse(readFileSync(ADDR_SANCTIONS_FILE, "utf8")) as Record<string, AddrSanction>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object of sanction records");
    for (const [k, s] of Object.entries(raw)) if (s && s.kind === "mute" && typeof s.addr === "string" && typeof s.world === "string" && typeof s.actor === "string" && s.until > Date.now()) addrSanctions[k] = { ...s, ids: Array.isArray(s.ids) ? s.ids : [] };
  }
} catch (e) { unreadable.add(ADDR_SANCTIONS_FILE); console.log(`[mod] WARNING address sanction restore failed: ${e}. ${ADDR_SANCTIONS_FILE} is kept as it was and not saved over; its sanctions aren't enforced until it is fixed and the server restarted`); }
if (lockedLine()) console.log(`[mod] WARNING ${lockedLine()}`);
/** The address sanctions in force for a guest joining `world` from `addr`. */
export function addrSanctionsFor(world: string, addr: string | null | undefined, now = Date.now()): AddrSanction[] {
  if (!addr) return [];
  return Object.values(addrSanctions).filter((s) => s.kind === "mute" && s.world === world && s.addr === addr && s.until > now);
}
/** File (or refresh) a guest's sanction against their address: at most a day, never past the sanction's own end. */
export function fileAddrSanction(s: Omit<AddrSanction, "ts" | "ids" | "until"> & { until?: number | null; who: string }, now = Date.now()): string | null {
  const until = Math.min(now + ADDR_BAN_MS, s.until ?? Infinity);
  const key = addrSanctionKey(s.kind, s.world, s.addr, s.actor); const prev = addrSanctions[key];
  const { who, ...rest } = s;
  addrSanctions[key] = { ...rest, ts: now, until, ids: [...new Set([...(prev?.ids ?? []), who])] };
  return saveAddrSanctions(now);
}
/** Lifting a mute on an identity lifts the address record it was filed or carried under (by that identity,
 *  or by the address it is joined from now). Returns why the file wasn't written (the lift holds in memory only), else null. */
export function liftAddrSanction(kind: "mute", world: string, who: string, addr?: string | null): string | null {
  let n = 0;
  for (const [k, s] of Object.entries(addrSanctions)) if (s.kind === kind && s.world === world && (s.ids.includes(who) || (addr && s.addr === addr))) { delete addrSanctions[k]; n++; }
  return n ? saveAddrSanctions() : null;
}
