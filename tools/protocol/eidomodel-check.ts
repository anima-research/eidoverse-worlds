// tools/protocol/eidomodel-check.ts — a model is its library path (R 10-17, binding: "definitely serve path again alongside
// hash"); the content hash rides beside it (model-hash sha256:<64 hex>), and an eido:sha256/<64 hex> address stored before
// (translate-v1@8–@11, review 2026-10-07 H3) still resolves on a host whose index knows it. Runs with its
// own scratch OPT_DIR and library (the server reads both at import), so it's its own suite.
//   bun tools/protocol/eidomodel-check.ts
// Cases:
//   U1  the translator keeps model paths and, given a resolver, writes model-hash beside each one whose bytes it knows; one
//       it can't hash is listed; the imported act keeps the path (provenance)
//   U2  the index: a store blob's address is the sha256 of its bytes (a blob whose bytes no longer match its 16-hex name
//       still gets the address of what's there, and is reported); a library
//       file's is its ORIGINAL's (never the optimized mirror); resolveLibFile and the catalogue take the address
//   U3  GET /eido/sha256/<hex> serves exactly the named bytes, immutable; an unknown digest is a 404
//   U4  GET /library/eido/sha256/<hex>.glb serves the host's rendition, as /library/<path> does (variants included)
//   U5  the client loads a model by its address through /library/eido/…; one mapping, shared (shared/eido.js)
//   U6  EIDO-URIS.md: `model`'s media is fixed by its role, so a bare eido: string is complete there
//   U7  credits by path (review r7 F3); U8 the catalogue's sha256 at measure; U9 a door-written world carries (r7 F4)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";

const S = scratch("eidomodel"); const OPT = path.join(S, "opt"), LIB = path.join(S, "lib");
fs.mkdirSync(path.join(OPT, "store"), { recursive: true }); fs.mkdirSync(path.join(LIB, "eidoverse/assets/models"), { recursive: true });
process.env.OPT_DIR = OPT; process.env.EIDOVERSE_DIR = LIB;
const glb = fs.readFileSync(path.join(ENGINE, "assets/opt/props/ball.glb"));
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const H = sha(glb); fs.writeFileSync(path.join(OPT, "store", `${H.slice(0, 16)}.glb`), glb);
// a library model whose optimized mirror differs from its original: the address is the original's
const orig = Buffer.concat([glb, Buffer.alloc(8)]); const LIBREL = "eidoverse/assets/models/rock.glb";
fs.writeFileSync(path.join(LIB, LIBREL), orig); fs.mkdirSync(path.join(OPT, "eidoverse/assets/models"), { recursive: true });
fs.writeFileSync(path.join(OPT, LIBREL), Buffer.concat([glb, Buffer.from([0, 0, 0, 0])]));
const HL = sha(orig);

let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => {
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); } else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 500)}` : ""}`); } };
const C = async (id: string, what: string, fn: () => any) => { try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); } catch (e) { ok(id, false, what, `threw: ${e?.stack ?? e}`); } };
const imp = (p: string) => import(path.join(ENGINE, p));

await C("U1", "the translator keeps model paths (R 10-17) and writes model-hash sha256:<64> beside one whose bytes the resolver knows; one it can't hash has none and is listed; the imported act keeps the path", async () => {
  const T = await imp("tools/protocol/import-v1/translate-v1.js");
  const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { olive: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "olive", verb: "spawn", args: { id: "a", lib: `store/${H.slice(0, 16)}.glb`, pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "olive", verb: "spawn", args: { id: "b", lib: "claude/no-such-thing", pos: [1, 0, 0] } }];
  const content = (p: string) => (p === `store/${H.slice(0, 16)}.glb` ? `sha256:${H}` : null);
  const r = T.translate(old, { content }); const f = r.final.translated;
  const act = r.out.find((e: any) => e.kind === "act" && e.body?.verb === "spawn" && e.body?.args?.id === "a");
  return [f.a.model === `store/${H.slice(0, 16)}.glb` && f.a["model-hash"] === `sha256:${H}` && f.b.model === "claude/no-such-thing" && !("model-hash" in f.b) && r.stats.divergences === 0 && JSON.stringify(r.stats.modelsUnhashed) === JSON.stringify(["claude/no-such-thing"])
    && r.stats.modelsHashed === 1 && act?.body?.args?.lib === `store/${H.slice(0, 16)}.glb`, { a: f.a, b: f.b, stats: r.stats, act: act?.body }]; });

await C("U2", "the index: a store blob's and a library original's addresses; resolveLibFile and the catalogue take them", async () => {
  const X = await imp("server/eidoindex.ts"); const L = await imp("server/libfile.ts"); const M = await imp("server/modelcatalogue.ts");
  const hs = X.contentAddressOf(`store/${H.slice(0, 16)}.glb`), hl = X.contentAddressOf(LIBREL);
  const bad = path.join(OPT, "store", "0000000000000000.glb"); fs.writeFileSync(bad, glb); const hb = X.contentAddressOf("store/0000000000000000.glb");
  const named = [X.storeNameMatches(`store/${H.slice(0, 16)}.glb`), X.storeNameMatches("store/0000000000000000.glb")];
  X.recordEido(hl, LIBREL);
  const fs1 = L.resolveLibFile(`eido:sha256/${H}`), fl = L.resolveLibFile(`eido:sha256/${HL}`);
  await M.warm([`eido:sha256/${H}`]); const e = M.ENGINE_CATALOGUE.get(`eido:sha256/${H}`);
  return [hs === H && hl === HL && hb === H && named[0] === true && named[1] === false && fs1 === path.join(OPT, "store", `${H.slice(0, 16)}.glb`) && fl === path.join(LIB, LIBREL) && M.isLibPath(`eido:sha256/${H}`) && Array.isArray(e?.size),
    { hs, hl, hb, fs1, fl, e }]; });

const R = await imp("server/routes.ts").catch((e) => ({ __err: String(e) }));
const get = async (p: string) => { const res = await R.route(new Request(`http://x${p}`), { upgrade: () => false, requestIP: () => null }); return { status: res.status, cc: res.headers.get("cache-control"), body: res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null }; };
await C("U3", "GET /eido/sha256/<hex> serves exactly the named bytes, immutable; an unknown digest is a 404; a library original, not its mirror", async () => {
  const a = await get(`/eido/sha256/${H}`), b = await get(`/eido/sha256/${"0".repeat(64)}`), c = await get(`/eido/sha256/${HL}`);
  return [a.status === 200 && sha(a.body) === H && /immutable/.test(a.cc ?? "") && b.status === 404 && c.status === 200 && sha(c.body) === HL, { a: [a.status, a.cc], b: b.status, c: c.status }]; });
await C("U4", "GET /library/eido/sha256/<hex>.glb serves what /library/<its path> serves (the host's rendition)", async () => {
  const a = await get(`/library/eido/sha256/${HL}.glb`), b = await get(`/library/${LIBREL}`);
  return [a.status === 200 && b.status === 200 && sha(a.body) === sha(b.body), { a: a.status, b: b.status }]; });
await C("U5", "the client maps a model's address to /library/eido/sha256/<hex>.glb through shared/eido.js, at its one load seam", async () => {
  const E = await imp("shared/eido.js"); const src = fs.readFileSync(path.join(ENGINE, "client/lib/assets.js"), "utf8");
  return [E.libRelOf(`eido:sha256/${H}`) === `eido/sha256/${H}.glb` && E.libRelOf("store/x.glb") === "store/x.glb" && E.isEido(`eido:sha256/${H}`) && !E.isEido(`eido:sha256/${H.slice(0, 16)}`)
    && /libRelOf\(libPath\)/.test(src), E.libRelOf?.(`eido:sha256/${H}`)]; });
await C("U6", "EIDO-URIS.md: model's media is fixed by its role (glTF binary), so a bare eido: string is complete there", () => {
  const t = fs.readFileSync(path.join(ENGINE, "spec/EIDO-URIS.md"), "utf8"); return [/`model`[^\n]*role[^\n]*glb|media is fixed by its role/i.test(t) && !/needs a new versioned name \(`model@2`/.test(t), null]; });

// R 10-17 (review r7 F3, F4): the catalogue measures a path's hash off the request path, credits are looked up by path, and a
// world written through the door names its models by path, so it loads with no index at all
await C("U7", "credits survive: a library path's entry has them, an old address's entry has its file's (looked up by path), and neither entry is the other", async () => {
  const M = await imp("server/modelcatalogue.ts"); const X = await imp("server/eidoindex.ts");
  X.recordEido(HL, LIBREL); await M.warm([LIBREL, `eido:sha256/${HL}`]);
  const p = M.ENGINE_CATALOGUE.get(LIBREL), a = M.ENGINE_CATALOGUE.get(`eido:sha256/${HL}`);
  return [!!p?.credits && !!a?.credits && a.credits.path === LIBREL && p !== a && !!M.ENGINE_CATALOGUE.get(LIBREL)?.credits, { p: p?.credits, a: a?.credits, same: p === a }]; });
await C("U8", "the catalogue knows a measured path's sha256 (its original's bytes, never the mirror's), and an old address's is its own hex", async () => {
  const M = await imp("server/modelcatalogue.ts"); await M.warm([LIBREL, `eido:sha256/${H}`]);
  return [M.ENGINE_CATALOGUE.get(LIBREL)?.sha256 === HL && M.ENGINE_CATALOGUE.get(`eido:sha256/${H}`)?.sha256 === H && typeof M.ENGINE_CATALOGUE.address !== "function",
    { p: M.ENGINE_CATALOGUE.get(LIBREL)?.sha256, a: M.ENGINE_CATALOGUE.get(`eido:sha256/${H}`)?.sha256 }]; });
await C("U9", "a create through the door with the engine's catalogue stores the library path and model-hash beside it; with the index gone, the path still resolves", async () => {
  const M = await imp("server/modelcatalogue.ts"); const L = await imp("server/libfile.ts");
  const { request } = await imp("shared/protocol/authority.js"); const { openLive } = await imp("server/livehost.ts");
  const dir = path.join(S, "w9", "w") + "/"; fs.mkdirSync(dir, { recursive: true }); let now = 1800000000000;
  const lw = openLive(dir, "w", { now: () => ++now, catalogue: M.ENGINE_CATALOGUE, custodyFile: path.join(S, "w9", "custody.json"), nameOf: () => null, kindOf: () => "human" });
  request(lw, "rowan", "create-world", { title: "carry" });
  await M.warm([LIBREL]); now += 1000;
  const r = request(lw, "rowan", "create", { id: "rock", model: LIBREL, components: { transform: { pos: [0, 0, 0] } } });
  const c = lw.state().entities.rock?.c ?? {};
  fs.rmSync(path.join(OPT, "eido-index.json"), { force: true });
  return [r.ok && c.model === LIBREL && c["model-hash"] === `sha256:${HL}` && L.resolveLibFile(c.model) === path.join(OPT, LIBREL), { r: r.refused, c, file: L.resolveLibFile(c.model) }]; });

console.log(`\neidomodel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
