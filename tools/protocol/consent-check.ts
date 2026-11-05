// consent tool: names from the wire never reach a plain object's prototype (security pass 2, H-0); a refused change
// changes nothing; every retired argument says where to go (R 10-28: two gates, two lists)
import { setConsent, decide, tableOf, migratePresence } from "../../shared/protocol/consent.js";
let fails = 0; const ok = (c: boolean, n: string, d: any = "") => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) fails++; };
const P: any = {};
for (const op of ["allow", "block", "unlist"]) for (const who of ["__proto__", "constructor", "prototype"]) {
  const r = setConsent(P, "u-attacker", { [op]: who });
  ok(r.ok === false, `C1 ${op} '${who}' is refused (not a person)`, r);
}
ok(typeof Object.prototype.toString === "function" && !Object.getOwnPropertyNames(Object.prototype).some((k) => /^(true|allow|block)$/.test(k)), "C3 Object.prototype is untouched", Object.getOwnPropertyNames(Object.prototype));
const r3 = setConsent(P, "u-alice", { block: "u-bbbbbbbbbbbbbbbbbbbb" });
ok(r3.ok === true && Object.getPrototypeOf(P.consent["u-alice"].block) === null && Object.getPrototypeOf(P.consent["u-alice"]) === null, "C4 a real block works, on prototype-less tables", r3);
ok(decide(P, "u-bbbbbbbbbbbbbbbbbbbb", "u-alice", "shove").mode === "deny", "C5 …and is honoured (move's default is on)");
// C6: every retired argument (the switch and its asks, 10-28; the table before it, 10-20) is refused, says where to go, and changes nothing
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa";
  for (const [k, v] of [["switch", "refuse"], ["deny", "u-bbbbbbbbbbbbbbbbbbbb"], ["class", "touch"], ["for", 60000], ["answer", "ask-1"], ["yes", true], ["preset", "open"], ["set", { class: "touch", tier: "everyone", mode: "allow" }], ["pause", true], ["friend", "u-bbbbbbbbbbbbbbbbbbbb"], ["delegate", "u-bbbbbbbbbbbbbbbbbbbb"], ["of", A]] as const) {
    const r: any = setConsent(Q, A, { [k]: v });
    ok(r.ok === false && r.code === "shape" && /move/.test(r.fix ?? "") && /block/.test(r.fix ?? "") && !Q.consent?.[A], `C6 ${k} is retired: refused, pointing at the gates and lists, nothing written`, r); } }
// a refused change changes nothing: every argument is checked before any field is written
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  setConsent(Q, A, { move: true }); const before = JSON.stringify(Q.consent?.[A]);
  for (const a of [{ move: false, allow: "__proto__" }, { touch: true, move: "no" }, { move: false, allow: B, block: B }]) {
    const r = setConsent(Q, A, a);
    ok(r.ok === false && JSON.stringify(Q.consent?.[A]) === before, `C8 a refused change (${JSON.stringify(a)}) leaves the table as it was`, { r, table: Q.consent?.[A] }); } }
// C9 (review F2, R 10-28): a browser client that never chose leaves a migrated block and the world's move:false default alone
{ const { makeConsentSync } = await import("../../client/lib/consentsync.js"); const { readStored } = await import("../../client/lib/consent.js");
  const run = async (kv: Record<string, string>) => { const Q: any = { consent: { me: { over: { "u-bob": { touch: { mode: "deny" } } } } }, consentShape: 3, bodyDefault: { move: false } }; migratePresence(Q);
    const st = readStored((k: string) => kv[k] ?? null), sent: any[] = [];
    await makeConsentSync({ table: () => ({ move: st.move, touch: st.touch, allow: Object.keys(st.allow), block: Object.keys(st.block), unlist: st.unlist }), toast: () => {}, on: () => {}, later: () => {},
      send: async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(Q, "me", a) : { ok: true, table: tableOf(Q, "me") }; } }).sync();
    return { Q, sent }; };
  const f = await run({}); ok(decide(f.Q, "u-bob", "me", "touch").mode === "deny" && tableOf(f.Q, "me").block.includes("u-bob"), "C9 an authority block survives a fresh client's sync", f.sent);
  ok(f.sent.length === 1 && decide(f.Q, "pal", "me", "shove").mode === "deny", "C9b a never-chosen client in a move:false world stays move:false", f.sent);
  { const Q: any = { consent: { me: { switch: "refuse" } }, consentShape: 3 }; migratePresence(Q); const sent: any[] = [];
    await makeConsentSync({ table: () => ({ allow: [], block: [], unlist: [] }), toast: () => {}, on: () => {}, later: () => {}, send: async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(Q, "me", a) : { ok: true, table: tableOf(Q, "me") }; } }).sync();
    ok(sent.length === 1 && Q.consent.me.move === false && Q.consent.me.touch === false, "C9d a never-chosen client sends no gate where the authority holds one (a migrated refuse stays both off)", sent); }
  const c = await run({ "ew-pushable": "1" }); ok(JSON.stringify(c.sent.slice(1)) === '[{"move":true}]' && decide(c.Q, "pal", "me", "shove").mode === "allow", "C9c a client that chose move:true (main's ew-pushable kept) sends it", c.sent); }
// C10 (review full-260 #2): allow/block naming an identity no one wears now is refused "gone" before the authority: a
// guest's id is per connection (server/directory.ts), so a block on one who left (or from a past process) means nobody
{ process.env.WORLDS_DIR ??= require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/consent-gone-"); process.env.JOIN_TOKEN ??= "test-door";
  const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts"); const { directoryFor } = await import("../../server/directory.ts"); const { WORLDS_DIR } = await import("../../server/config.ts");
  const dir = directoryFor(WORLDS_DIR); const acct = dir.resolve({ sub: "human:kit", name: "Kit" }), here = dir.resolve({ name: "Gus" }), left = dir.resolve({ name: "Ann" });
  const me: any = { id: "me", actorId: dir.resolve({ sub: "human:me", name: "me" }) }, gus: any = { id: "Gus", actorId: here };
  let reached = 0;   // requests the gone-check let through to the (fake) authority (bot #497)
  const w: any = { name: "w", clients: new Set([me, gus]), log: { request: async () => { reached++; return { ok: true }; }, roleOf: () => null, bannedHere: () => false, mutedHere: () => false }, debug: () => {} }; me.world = w;
  const ask = (args: any) => new Promise<any>((res) => { REQUEST_MESSAGES.request({ c: me, ws: { send: (s: string) => res(JSON.parse(s)) }, expel: () => {}, sweep: () => {} } as any, { type: "request", id: 1, verb: "consent", args }); setTimeout(() => res(null), 500); });
  const code = async (a: any) => { const r = await ask(a); return r ? (r.reply?.refused?.code ?? "ok") : "timeout"; };
  const got = { left: await code({ block: left }), past: await code({ allow: "u-zzzzzzzzzzzzzzzzzzzz" }), here: await code({ block: here }), acct: await code({ block: acct }) };
  ok(got.left === "gone" && got.past === "gone", "C10 a guest who left, or an id no one has worn since the restart: refused gone", got);
  ok(got.here === "ok" && got.acct === "ok" && reached === 2, "C10b …a guest here now, and an account here or not, reach the authority and are answered ok (those two, no other)", { ...got, reached });
  const why = async (a: any) => String((await ask(a))?.reply?.refused?.reason ?? "");   // review delta-260 L-H: each says what it is
  const said = { left: await why({ block: left }), never: await why({ allow: "u-zzzzzzzzzzzzzzzzzzzz" }) };
  ok(/guest/.test(said.left) && !/guest/.test(said.never) && /knows no one/.test(said.never), "C10c a departed guest is said as one; an id this server never knew is said as that, not as a guest", said); }
// C11 (Basil 1.4; owner chose (a) 10-30): a landed block survives the live host's restart: the reopened authority still
// refuses the blocked person and the read returns the block; the rest of presence (bodies) does not survive
{ const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { openLive, CONSENT_FILE } = await import("./labhost.ts"); const { request } = await import("../../shared/protocol/authority.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consent-restart-")), dir = path.join(root, "w"); fs.mkdirSync(dir);
  const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb"; let now = 1800000000000;
  const open = () => openLive(dir, "w", { now: () => now, custodyFile: path.join(root, "custody.json"), nameOf: () => null, kindOf: () => "human" });
  const call = (w: any, actor: string, verb: string, args: any = {}) => { now += 1000; try { return request(w, actor, verb, args); } catch (e: any) { return { crashed: String(e?.message ?? e) }; } };
  const w1 = open(); call(w1, A, "create-world", { title: "w" });
  for (const [who, at] of [[A, [0, 0, 0]], [B, [1, 0, 0]]] as const) call(w1, who, "move", { to: at });
  const set = call(w1, A, "consent", { block: B });
  const w2 = open(), bodies = Object.keys(w2.presence.bodies ?? {}).length;   // the restart: a new process opens the same directory
  for (const [who, at] of [[A, [0, 0, 0]], [B, [1, 0, 0]]] as const) call(w2, who, "move", { to: at });
  const read: any = call(w2, A, "consent"), shove: any = call(w2, B, "body", { to: A, kind: "shove" });
  const mode = (() => { try { return fs.statSync(path.join(dir, CONSENT_FILE)).mode & 0o777; } catch { return null; } })();
  ok(set.ok && (read.table?.block ?? []).includes(B) && shove.refused?.code === "consent" && (process.platform === "win32" ? mode !== null : mode === 0o600) && bodies === 0,
    "C11 a block survives a restart: the reopened authority refuses the blocked person, the read returns it, the file is 0600 (POSIX; Windows has no mode bits); bodies don't survive", { set, read: read.table, shove, mode, bodies }); }
// C12 (bot review of #260, #2): the consent file is replaced durably: written whole through a short write, its directory synced
// after the rename (a new name isn't on disk until its directory is: POSIX)
{ const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { openLive, CONSENT_FILE } = await import("./labhost.ts"); const { request } = await import("../../shared/protocol/authority.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consent-durable-")), dir = path.join(root, "w"); fs.mkdirSync(dir);
  const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb"; let now = 1800000000000;
  const w = openLive(dir, "w", { now: () => now, custodyFile: path.join(root, "custody.json"), nameOf: () => null, kindOf: () => "human" });
  now += 1000; request(w, A, "create-world", { title: "w" });
  const o = { open: fs.openSync, sync: fs.fsyncSync, write: fs.writeSync }; const dirFds = new Set<number>(), tmpFds = new Set<number>(); let dirSynced = 0, shorts = 0;
  fs.openSync = function (p: any, ...a: any[]) { const fd = o.open.call(fs, p, ...a); if (path.resolve(String(p)) === path.resolve(dir)) dirFds.add(fd);
    if (/consent\.json\..*\.tmp$/.test(String(p))) tmpFds.add(fd); return fd; };
  fs.fsyncSync = function (fd: number) { if (dirFds.has(fd)) dirSynced++; return o.sync.call(fs, fd); };
  fs.writeSync = function (fd: number, b: any, off?: any, len?: any, ...r: any[]) {   // the consent temp's first write takes all but its last byte
    if (shorts === 0 && tmpFds.has(fd) && typeof b !== "string" && len > 1) { shorts++; return o.write.call(fs, fd, b, off, len - 1, ...r); } return o.write.call(fs, fd, b, off, len, ...r); };
  let set: any; try { now += 1000; set = request(w, A, "consent", { block: B }); } finally { Object.assign(fs, { openSync: o.open, fsyncSync: o.sync, writeSync: o.write }); }
  let saved: any = null; try { saved = JSON.parse(fs.readFileSync(path.join(dir, CONSENT_FILE), "utf8")); } catch { /* torn or absent */ }
  ok(set?.ok && (process.platform === "win32" ? dirSynced === 0 : dirSynced >= 1), "C12 a block's consent file: its directory is synced after the rename (Windows can't sync a directory)", { set: set?.ok, dirSynced });
  ok(set?.ok && shorts === 1 && Object.keys(saved?.consent?.[A]?.block ?? {}).includes(B), "C12b …and a short write still lands the whole file (the injected short write is taken)", { shorts, saved }); }
console.log(`[consent-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
