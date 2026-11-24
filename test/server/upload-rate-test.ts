// bun test/server/upload-rate-test.ts — /upload's rate window and its byte budgets (a day's bytes, the disk's floor) are the uploader's: 30 uploads a minute for the identity an
// upload stands on (an agent's bearer, a person's sign-in), whatever address it comes from, and for the address when it
// proves none (the door key everyone shares). The agent tool server posts every agent's upload from one address, so a
// window per address would be one window for all of them. In-process: handleUpload with a stand-in for Bun's server.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
const S = suite("upload-rate");
const check = (n: string, ok: unknown, d?: unknown) => S.check(n, ok, d);
const root = mkdtempSync(join(tmpdir(), "uploadrate-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const tokensPath = join(root, "tokens.json"), OPT = join(root, "opt");
mkdirSync(OPT);
// the door key is ALSO enrolled as an agent's bearer here (a host may do that): it is still everyone's key, so it still proves no one
writeFileSync(tokensPath, JSON.stringify({ "rate-bearer-ash": { id: "ash" }, "rate-bearer-birch": { id: "birch" }, "rate-bearer-elm": { id: "elm" }, "rate-bearer-oak": { id: "oak" }, "rate-bearer-pine": { id: "pine" }, "rate-bearer-fir": { id: "fir" }, "rate-bearer-yew": { id: "yew" }, "rate-bearer-larch": { id: "larch" }, "door-key": { id: "keeper" } }));
Object.assign(process.env, {
  SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: OPT, EIDOVERSE_DIR: join(root, "lib"), JOIN_TOKEN: "door-key",
  AGENT_TOKENS_PATH: tokensPath, SESSIONS_PATH: join(root, "sessions.json"), KTX2_TOKTX: "",
});
const { handleUpload, UPLOADS_PER_MINUTE, uploadBudget } = await import("../../server/upload.ts");
const { hnSessions } = await import("../../server/auth.ts");

// a 2×2 grayscale PNG: the image door stores it as is, with no optimize pass and no build check; `seed` makes other bytes
const pngOf = (seed = 0) => {
  const { PNG } = require("pngjs");
  const p = new PNG({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  p.data = Buffer.from([seed & 255, 85, 170, 255]);
  return new Uint8Array(PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false }));
};
const png = pngOf(0);
const stored = () => { try { return readdirSync(join(OPT, "store", "images")).filter((f) => f !== "manifest.json").length; } catch { return 0; } };
async function upload(headers: Record<string, string>, address: string, body: Uint8Array = png) {
  const url = new URL("http://x/upload?as=image&name=dot.png");
  const log = console.log; console.log = () => {};   // the door logs each upload: a hundred lines here
  try {
    const r = await handleUpload(new Request(url, { method: "POST", headers, body }), url, { requestIP: () => ({ address }) });
    return { status: r.status, text: await r.text(), retry: r.headers.get("retry-after") };
  } finally { console.log = log; }
}
/** `n` uploads one after another; their statuses, counted. */
async function burst(n: number, headers: Record<string, string>, address: (i: number) => string) {
  const got: Record<number, number> = {};
  for (let i = 0; i < n; i++) { const s = (await upload(headers, address(i))).status; got[s] = (got[s] ?? 0) + 1; }
  return got;
}
const ash = { authorization: "Bearer rate-bearer-ash" }, birch = { authorization: "Bearer rate-bearer-birch" }, key = { authorization: "Bearer door-key" };
const ONE = "198.51.100.7";   // the one address both agents' uploads come from (the agent tool server's)

check("the limit is 30 uploads a minute", UPLOADS_PER_MINUTE === 30, UPLOADS_PER_MINUTE);
// ---- an identity has its own window ----
const first = await burst(UPLOADS_PER_MINUTE, ash, () => ONE);
check("an agent's first 30 uploads in a minute are all taken", first[200] === UPLOADS_PER_MINUTE, first);
const over = await upload(ash, ONE);
check("its 31st is refused 429, saying the limit and when to try again", over.status === 429 && over.text.startsWith("upload rate limit (30 uploads a minute); try again in ") && Number(over.retry) >= 1 && Number(over.retry) <= 60, `${over.status} ${over.text} retry-after=${over.retry}`);
const other = await burst(UPLOADS_PER_MINUTE, birch, () => ONE);
check("another agent, from the same address, has its own 30 (the window is the identity's, not the address's)", other[200] === UPLOADS_PER_MINUTE, other);
const elsewhere = await upload(ash, "203.0.113.50");
check("the refused agent from another address is still refused (its window goes with it)", elsewhere.status === 429, `${elsewhere.status} ${elsewhere.text}`);
// a signed-in person is an identity too
const sid = "b".repeat(64);
hnSessions.set(sid, { sub: "human:discord:7770001", name: "Reader", scopes: ["worlds:join"], exp: Date.now() + 600_000 });
const person = await upload({ cookie: `ew_sess=${sid}`, "sec-fetch-site": "same-origin" }, ONE);
check("a signed-in person, from that same address, is taken: their own window", person.status === 200, `${person.status} ${person.text}`);
// ---- no identity: the address ----
const shared = await burst(UPLOADS_PER_MINUTE + 1, key, () => "198.51.100.8");
check("the door key proves no identity, enrolled or not: its uploads count against their address, 30 taken and the 31st refused", shared[200] === UPLOADS_PER_MINUTE && shared[429] === 1, shared);
const keyElsewhere = await upload(key, "198.51.100.9");
check("...and the same key from another address is taken (that address's own window)", keyElsewhere.status === 200, `${keyElsewhere.status} ${keyElsewhere.text}`);
check("every upload stored the one file its bytes name (content-addressed)", stored() === 1, stored());
// ---- an IPv6 host is its /64: two addresses in one /64 share an address's window ----
const v6 = await burst(UPLOADS_PER_MINUTE, key, (i) => `2001:db8:7:7::${(i + 1).toString(16)}`);
const v6next = await upload(key, "2001:db8:7:7:ffff::1");
check("B1 uploads from one IPv6 /64 count as one address: 30 from thirty of its addresses, then a 31st from another is refused", v6[200] === UPLOADS_PER_MINUTE && v6next.status === 429, { v6, next: v6next.status });
// ---- bytes a day per uploader (UPLOAD_MB_PER_DAY) ----
// (three different pictures: the same bytes again are stored once, and charged once: B4b)
const three = [pngOf(1), pngOf(2), pngOf(3)], threeBytes = three.reduce((n, b) => n + b.length, 0);
{ const was = uploadBudget.perDayBytes; uploadBudget.perDayBytes = threeBytes;
  const elm = { authorization: "Bearer rate-bearer-elm" };
  const day: Record<number, number> = {}; for (const b of three) { const st = (await upload(elm, "192.0.2.80", b)).status; day[st] = (day[st] ?? 0) + 1; }
  const past = await upload(elm, "192.0.2.80", pngOf(4));
  check("B2 an uploader past its bytes for the day is refused 429, saying so", day[200] === 3 && past.status === 429 && /a day/.test(past.text), { day, past });
  const fresh = await upload({ authorization: "Bearer rate-bearer-oak" }, "192.0.2.80");
  check("B2b ...another uploader is not", fresh.status === 200, `${fresh.status} ${fresh.text}`);
  uploadBudget.perDayBytes = was; }
// ---- only what is stored is charged: a refusal, and the same bytes again, are free ----
{ const was = uploadBudget.perDayBytes; uploadBudget.perDayBytes = threeBytes;
  const fir = { authorization: "Bearer rate-bearer-fir" }, yew = { authorization: "Bearer rate-bearer-yew" };
  const junk = new Uint8Array(threeBytes);   // not a picture: refused 415 once read, the whole day's bytes in size
  const refused: number[] = []; for (let i = 0; i < 5; i++) refused.push((await upload(fir, "192.0.2.82", junk)).status);
  const after: number[] = []; for (const b of [pngOf(11), pngOf(12), pngOf(13)]) after.push((await upload(fir, "192.0.2.82", b)).status);
  check("B4 refused uploads (415) are not charged to the day: after five the size of the whole day, the day's pictures still land", refused.every((x) => x === 415) && after.every((x) => x === 200), { refused, after });
  const same: number[] = []; for (let i = 0; i < 10; i++) same.push((await upload(yew, "192.0.2.83", pngOf(21))).status);
  const next: number[] = []; for (const b of [pngOf(22), pngOf(23)]) next.push((await upload(yew, "192.0.2.83", b)).status);
  check("B4b the same picture sent ten times is stored, and charged, once: two more different ones still land", same.every((x) => x === 200) && next.every((x) => x === 200), { same, next });
  uploadBudget.perDayBytes = was; }
// ---- a new uploader's first uploads at once share one day: each is charged (neither charge replaces the other) ----
{ const was = uploadBudget.perDayBytes; const pair = [pngOf(31), pngOf(32)]; uploadBudget.perDayBytes = pair[0].length + pair[1].length;
  const larch = { authorization: "Bearer rate-bearer-larch" };
  const send = (b: Uint8Array) => { const url = new URL("http://x/upload?as=image&name=dot.png");
    return handleUpload(new Request(url, { method: "POST", headers: larch, body: b }), url, { requestIP: () => ({ address: "192.0.2.84" }) }).then((r) => r.status); };
  const log = console.log; console.log = () => {};
  let both: number[], third: number;
  try { both = await Promise.all(pair.map(send)); third = await send(pngOf(33)); } finally { console.log = log; }
  check("B5 two first uploads at once are both charged to the day: a third past the day's bytes is refused", both.every((x) => x === 200) && third === 429, { both, third });
  uploadBudget.perDayBytes = was; }
// ---- the disk's floor (UPLOAD_MIN_FREE_MB) ----
{ const was = uploadBudget.minFreeBytes; uploadBudget.minFreeBytes = Number.MAX_SAFE_INTEGER;
  const r = await upload({ authorization: "Bearer rate-bearer-pine" }, "192.0.2.81");
  check("B3 with less free disk than the floor, an upload is refused 507 before its body is stored", r.status === 507 && /disk/.test(r.text), `${r.status} ${r.text}`);
  uploadBudget.minFreeBytes = was; }
S.done();
