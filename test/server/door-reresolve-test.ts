// bun test/server/door-reresolve-test.ts — /upload (behind JOIN_TOKEN) and /seat-profile ask who the caller is again after
// the body read: a credential revoked (or a session logged out) while the body streams in writes nothing. In-process and
// deterministic: the body stream's second pull() does the revoke, and a stream's second pull runs only once the door is
// reading (the first fills the queue at construction), so the first check has passed by then. Each revoke row has a control.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
const S = suite("door-reresolve");
const check = (n: string, ok: unknown, d?: unknown) => S.check(n, ok, d);
const root = mkdtempSync(join(tmpdir(), "reresolve-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const tokensPath = join(root, "tokens.json"), OPT = join(root, "opt");
const ENROLLED = { "reresolve-bearer": { id: "uploader" } };
mkdirSync(OPT);
writeFileSync(tokensPath, JSON.stringify(ENROLLED));
Object.assign(process.env, {
  SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: OPT, EIDOVERSE_DIR: join(root, "lib"), JOIN_TOKEN: "door-key",
  AGENT_TOKENS_PATH: tokensPath, SESSIONS_PATH: join(root, "sessions.json"), KTX2_TOKTX: "",
});
const { handleUpload } = await import("../../server/upload.ts");
const { route } = await import("../../server/routes.ts");
const { accountOf, hnSessions } = await import("../../server/auth.ts");
const { seatStore } = await import("../../server/seats.ts");

const png = (() => {   // a 2×2 grayscale PNG: the image door stores it as is, with no optimize pass
  const { PNG } = require("pngjs");
  const p = new PNG({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  p.data = Buffer.from([0, 85, 170, 255]);
  return new Uint8Array(PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false }));
})();
/** A body in three pulls; the second runs `during` (the revoke) before handing over the rest. */
function bodyThat(bytes: Uint8Array, during: () => void) {
  let pulls = 0; const half = bytes.length >> 1;
  const s = { pulls: 0, ran: false, stream: new ReadableStream<Uint8Array>({ pull(c) {
    s.pulls = ++pulls;
    if (pulls === 1) c.enqueue(bytes.slice(0, half));
    else if (pulls === 2) { during(); s.ran = true; c.enqueue(bytes.slice(half)); }
    else c.close();
  } }) };
  return s;
}
const storedImages = () => { try { return readdirSync(join(OPT, "store", "images")).filter((f) => f !== "manifest.json"); } catch { return []; } };
const srvAt = (address: string) => ({ requestIP: () => ({ address }), upgrade: () => false });
const revokeToken = () => writeFileSync(tokensPath, "{}");
const enrol = () => writeFileSync(tokensPath, JSON.stringify(ENROLLED));
let n = 0;
async function upload(headers: Record<string, string>, during: () => void, png0 = png) {
  const body = bodyThat(png0, during), url = new URL(`http://x/upload?as=image&name=r${n}.png`);
  const r = await handleUpload(new Request(url, { method: "POST", headers, body: body.stream }), url, srvAt(`198.51.100.${++n}`));
  return { status: r.status, text: await r.text(), body };
}
const bearer = { authorization: "Bearer reresolve-bearer" };

// ---- /upload, an enrolled bearer ----
check("setup: the bearer is enrolled", "account" in (accountOf("reresolve-bearer") ?? {}));
let validAtRevoke = false;
const revoked = await upload(bearer, () => { validAtRevoke = "account" in (accountOf("reresolve-bearer") ?? {}); revokeToken(); });
check("setup: the revoke ran inside the read, while the bearer was still valid", revoked.body.ran && validAtRevoke, JSON.stringify({ ran: revoked.body.ran, validAtRevoke }));
check("setup: ...and the bearer is gone after it", !("account" in (accountOf("reresolve-bearer") ?? {})));
check("/upload: a bearer revoked during the body read → 401, naming the bearer (not a sign-in)", revoked.status === 401 && /bearer .*could not be confirmed after the read/.test(revoked.text) && !/sign/.test(revoked.text), `${revoked.status} ${revoked.text.slice(0, 120)}`);
check("...and nothing was stored", storedImages().length === 0, storedImages());
enrol();
const kept = await upload(bearer, () => {});
check("control: the same flow with no revoke → 200, stored", kept.status === 200 && kept.body.ran && storedImages().length === 1, `${kept.status} ${kept.text.slice(0, 90)} stored=${storedImages().length}`);

const tooBig = await upload(bearer, revokeToken, new Uint8Array(21_000_000));
check("/upload: a bearer revoked during an over-cap read → 413, the refusal a renewed bearer would get too", tooBig.body.ran && tooBig.status === 413, `${tooBig.status} ${tooBig.text.slice(0, 90)}`);
enrol();

// ---- /upload, a session that logs out during the read ----
const sid = "a".repeat(64);
const signIn = () => hnSessions.set(sid, { sub: "human:discord:8880001", name: "Reader", scopes: ["worlds:join"], exp: Date.now() + 600_000 });
signIn();
const cookie = { cookie: `ew_sess=${sid}`, "sec-fetch-site": "same-origin" };
const png2 = (() => { const b = png.slice(); b[b.length - 5] ^= 1; return b; })();   // another hash (the IEND CRC's byte: still a PNG to the sniffer)
const loggedOut = await upload(cookie, () => hnSessions.delete(sid), png2);
check("/upload: a session logged out during the body read → 401", loggedOut.body.ran && loggedOut.status === 401, `${loggedOut.status} ${loggedOut.text.slice(0, 90)}`);
check("...and nothing was stored", storedImages().length === 1, storedImages());
signIn();
const stayed = await upload(cookie, () => {}, png2);
check("control: the session that stays signed in → 200", stayed.status === 200, `${stayed.status} ${stayed.text.slice(0, 90)}`);
const png3 = (() => { const b = png.slice(); b[b.length - 6] ^= 1; return b; })();
const gained = await upload({ ...cookie, authorization: "Bearer later-enrolled" }, () =>
  writeFileSync(tokensPath, JSON.stringify({ ...ENROLLED, "later-enrolled": { id: "latecomer" } })), png3);
check("/upload: a session whose request also gains a bearer during the read → 200 (the session it stood on still holds)", gained.body.ran && gained.status === 200, `${gained.status} ${gained.text.slice(0, 90)}`);
enrol();

// ---- /upload, the door key also enrolled as an agent keeps its name in the manifest ----
const manifest = () => JSON.parse(readFileSync(join(OPT, "store", "images", "manifest.json"), "utf8")) as Record<string, { by: string }>;
writeFileSync(tokensPath, JSON.stringify({ ...ENROLLED, "door-key": { id: "keyholder" } }));
const png4 = (() => { const b = png.slice(); b[b.length - 7] ^= 1; return b; })();
const keyed = await upload({ authorization: "Bearer door-key" }, () => {}, png4);
const keyedBy = keyed.status === 200 ? manifest()[JSON.parse(keyed.text).path.split("/").pop().split(".")[0]]?.by : undefined;
check("/upload: the door key enrolled as an agent → stored by that agent's id", keyedBy === "keyholder", `${keyed.status} by=${keyedBy}`);
enrol();

// ---- /seat-profile, through route(); the store is stubbed, so a write is a call to propose() ----
const proposed: string[] = [];
(seatStore as any).propose = (_rec: unknown, actor: string) => { proposed.push(actor); return { ok: true, rev: proposed.length, name: "bee", pose: "sitchair" }; };
async function seat(during: () => void) {
  const body = bodyThat(new TextEncoder().encode(JSON.stringify({ name: "bee", pose: "sitchair" })), during);
  const r = await route(new Request("http://x/seat-profile", { method: "POST", headers: bearer, body: body.stream }), srvAt("198.51.100.200"));
  return { status: r.status, text: await r.text(), body };
}
enrol();
const seatRevoked = await seat(revokeToken);
check("/seat-profile: a bearer revoked during the body read → 401, naming the bearer, nothing proposed", seatRevoked.body.ran && seatRevoked.status === 401 && /bearer .*could not be confirmed after the read/.test(seatRevoked.text) && proposed.length === 0, `${seatRevoked.status} ${seatRevoked.text.slice(0, 90)} proposed=${proposed.length}`);
enrol();
const seatKept = await seat(() => {});
check("control: the same proposal with no revoke → 200, proposed by the enrolled name", seatKept.status === 200 && proposed.join() === "uploader", `${seatKept.status} ${seatKept.text.slice(0, 90)} proposed=${proposed.join()}`);
S.done();
