// bun test/server/upload-rate-test.ts — /upload's rate window is the uploader's: 30 uploads a minute for the identity an
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
writeFileSync(tokensPath, JSON.stringify({ "rate-bearer-ash": { id: "ash" }, "rate-bearer-birch": { id: "birch" }, "door-key": { id: "keeper" } }));
Object.assign(process.env, {
  SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: OPT, EIDOVERSE_DIR: join(root, "lib"), JOIN_TOKEN: "door-key",
  AGENT_TOKENS_PATH: tokensPath, SESSIONS_PATH: join(root, "sessions.json"), KTX2_TOKTX: "",
});
const { handleUpload, UPLOADS_PER_MINUTE } = await import("../../server/upload.ts");
const { hnSessions } = await import("../../server/auth.ts");

const png = (() => {   // a 2×2 grayscale PNG: the image door stores it as is, with no optimize pass and no build check
  const { PNG } = require("pngjs");
  const p = new PNG({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  p.data = Buffer.from([0, 85, 170, 255]);
  return new Uint8Array(PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false }));
})();
const stored = () => { try { return readdirSync(join(OPT, "store", "images")).filter((f) => f !== "manifest.json").length; } catch { return 0; } };
async function upload(headers: Record<string, string>, address: string) {
  const url = new URL("http://x/upload?as=image&name=dot.png");
  const log = console.log; console.log = () => {};   // the door logs each upload: a hundred lines here
  try {
    const r = await handleUpload(new Request(url, { method: "POST", headers, body: png }), url, { requestIP: () => ({ address }) });
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
S.done();
