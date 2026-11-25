// library-fetch-test — the library tool tells a catalog it couldn't read from an empty one (#292).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/mcpl/library-fetch-test.ts
// The real library handler (mcpl/tools.ts) against a local Bun.serve whose /library-models answers as each case sets,
// with EIDOVERSE_DIR naming a checkout that holds one model, so the local-scan fallback is in play.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { suite } from "../gate/suite.ts";
const { check, done } = suite("library-fetch");

const dir = mkdtempSync(join(process.env.PROTOCOL_SCRATCH ?? tmpdir(), "library-fetch-"));
mkdirSync(join(dir, "eidoverse/assets/models"), { recursive: true });
writeFileSync(join(dir, "eidoverse/assets/models/chair-oak.glb"), "");
process.env.EIDOVERSE_DIR = dir;   // read when tools.ts loads
const { handleTool } = await import("../../mcpl/tools.ts");

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
let models: () => Response = () => Response.json([]);
let avatars: () => Response = () => new Response("not found", { status: 404 });
const server = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/library-models") return models();
  if (u.pathname === "/avatars") return avatars();
  if (u.pathname === "/library/broken_preview.jpg") return new Response("boom", { status: 500 });
  if (u.pathname === "/library/html_preview.jpg" || u.pathname === "/thumb/htmlbody.png") return new Response("<html>login</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  if (u.pathname === "/library/shouty_preview.jpg") return new Response(PNG_1PX, { headers: { "content-type": "Image/PNG" } });
  if (u.pathname === "/thumb/shouty.png") return new Response(PNG_1PX, { headers: { "content-type": "Image/PNG" } });
  if (u.pathname === "/thumb/fine.png") return new Response(PNG_1PX, { headers: { "content-type": "image/png" } });
  if (u.pathname === "/library/fine_preview.jpg") return new Response(PNG_1PX, { headers: { "content-type": "image/png" } });
  return new Response("not found", { status: 404 });
} });
const call = (a: any, httpBase = `http://127.0.0.1:${server.port}`) => handleTool({ agent: { httpBase }, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } } as any, "library", a);
const said = (r: any) => String(r?.content?.[0]?.text ?? "");
const imageHash = (r: any) => createHash("sha256").update(String(r?.content?.find((c: any) => c.type === "image")?.data ?? "")).digest("hex");

// search
models = () => new Response("down", { status: 503 });
let r: any = await call({ query: "zebra" });
check("query, catalog 503, nothing local: an error naming the failed search and its status, not 'no matches'",
  r?.isError === true && /catalog/.test(said(r)) && /503/.test(said(r)) && !/no matches/.test(said(r)), said(r));
check("…and, a 503 being passing, says calling again may work", /may work/.test(said(r)), said(r));
models = () => new Response("gone", { status: 404 });
r = await call({ query: "zebra" });
check("query, catalog 404: an error that doesn't promise a retry will work", r?.isError === true && /404/.test(said(r)) && !/may work/.test(said(r)), said(r));
models = () => new Response("down", { status: 503 });
r = await call({ query: "chair" });
check("query, catalog 503, a local match: the local hit, and beside it that the catalog search failed",
  !r?.isError && /eidoverse\/assets\/models\/chair-oak\.glb/.test(said(r)) && /catalog/.test(said(r)) && /503/.test(said(r)), said(r));
check("…and, a 503 being passing, says calling again may find the catalog's hits", /calling again may find/.test(said(r)), said(r));
models = () => new Response("gone", { status: 404 });
r = await call({ query: "chair" });
check("query, catalog 404, a local match: the local hit and the failure, without promising a retry will find more",
  !r?.isError && /chair-oak\.glb/.test(said(r)) && /404/.test(said(r)) && !/calling again/.test(said(r)), said(r));
const closed = Bun.serve({ port: 0, fetch: () => new Response("") }); const deadBase = `http://127.0.0.1:${closed.port}`; closed.stop(true);
r = await call({ query: "zebra" }, deadBase);
check("query, nothing listening: an error saying the catalog search failed, not 'no matches'",
  r?.isError === true && /catalog/.test(said(r)) && !/no matches/.test(said(r)), said(r));
models = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
r = await call({ query: "zebra" });
check("query, catalog 200 with a body that isn't a list: an error saying so, that doesn't promise a retry will work",
  r?.isError === true && /isn't a list/.test(said(r)) && !/may work/.test(said(r)) && !/no matches/.test(said(r)), said(r));
models = () => Response.json([null]);
r = await call({ query: "zebra" });
check("query, catalog 200 with a list that isn't of models ([null]): the same error, not a thrown one",
  r?.isError === true && /isn't a list of models/.test(said(r)) && !/may work/.test(said(r)), said(r));
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as any;
try { r = await call({ query: "zebra" }); } finally { globalThis.fetch = realFetch; }
check("query, catalog read timed out: an error naming the bound, not the bare 'operation timed out', and that calling again may work",
  r?.isError === true && /no answer within \d+ s/.test(said(r)) && !/operation timed out/i.test(said(r)) && /may work/.test(said(r)), said(r));
// a 200 whose body fails mid-read: a stall past the read bound is a timeout, a reset a failed request; both may pass.
// The stall is a body that rejects with the TimeoutError AbortSignal.timeout raises; door-unit-test waits out a real body stall
// (on measure) under the same READ() bound, none on this path
const stalledBody = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("[")); c.error(new DOMException("The operation timed out.", "TimeoutError")); } }),
  { headers: { "content-type": "application/json" } })) as any;
globalThis.fetch = stalledBody;
try { r = await call({ query: "zebra" }); } finally { globalThis.fetch = realFetch; }
check("query, a 200 body whose read rejects with a TimeoutError: a timeout that may work on a retry, not a body that isn't a list",
  r?.isError === true && /no answer within \d+ s/.test(said(r)) && /may work/.test(said(r)) && !/isn't a list/.test(said(r)), said(r));
// the reset is real: a server that promises 100 bytes, sends part of a list and closes the socket
const { createServer } = await import("node:net");
const cut = createServer((sock) => sock.once("data", () => { sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n[{"path"'); setTimeout(() => sock.destroy(), 50); })).listen(0);
await new Promise((ok) => cut.once("listening", ok));
r = await call({ query: "zebra" }, `http://127.0.0.1:${(cut.address() as any).port}`);
cut.close();
check("query, a 200 body the server cuts off mid-read: a failed request that may work on a retry, not a body that isn't a list",
  r?.isError === true && /request failed/.test(said(r)) && /may work/.test(said(r)) && !/isn't a list/.test(said(r)), said(r));
models = () => Response.json([]);
r = await call({ query: "zebra" });
check("(control) query, catalog answers []: 'no matches', not an error", !r?.isError && said(r) === "no matches", said(r));
models = () => Response.json([{ path: "library/chair-pine.glb" }]);
r = await call({ query: "chair" });
check("(control) query, catalog answers one hit: that hit alone", !r?.isError && said(r) === "library/chair-pine.glb", said(r));

// contact sheet
models = () => new Response("down", { status: 503 });
r = await call({ kind: "models" });
check("sheet, catalog 503: an error naming the failed fetch and its status, not an empty library",
  r?.isError === true && /503/.test(said(r)) && !/no models to show/.test(said(r)), said(r));
r = await call({ kind: "avatars" });   // this server has no /avatars route: it answers 404
check("sheet of avatars, roster 404: an error naming the failed fetch, not an empty roster", r?.isError === true && /404/.test(said(r)) && !/no avatars to show/.test(said(r)), said(r));
avatars = () => new Response("<html>oops</html>", { headers: { "content-type": "text/html" } });
r = await call({ kind: "avatars" });
check("sheet of avatars, roster 200 but not JSON: an error saying the roster couldn't be read", r?.isError === true && /couldn't read the avatar roster/.test(said(r)), said(r));
avatars = () => new Response("not found", { status: 404 });
r = await call({ kind: "models" }, deadBase);
check("sheet of models, nothing listening: an error saying the model list couldn't be read", r?.isError === true && /couldn't read the model list/.test(said(r)), said(r));
models = () => Response.json([{ path: "library/broken.glb", name: "broken", preview: "broken_preview.jpg" }]);
const failed = await call({ kind: "models" });
models = () => Response.json([{ path: "library/broken.glb", name: "broken", preview: null }]);
const none = await call({ kind: "models" });
check("sheet: a tile whose preview fetch answered 500 is drawn and said apart from one with no preview",
  imageHash(failed) !== imageHash(none) && /preview/i.test(said(failed)) && /500/.test(said(failed)) && !/500/.test(said(none)),
  JSON.stringify({ failed: said(failed), none: said(none), hashes: [imageHash(failed), imageHash(none)] }));
models = () => Response.json([{ path: "library/fine.glb", name: "fine", preview: "fine_preview.jpg" }]);
r = await call({ kind: "models" });
check("(control) sheet: a tile whose preview came back is said plainly", !r?.isError && said(r) === "models — page 1/1: fine", said(r));

// a 200 that isn't an image is no preview
r = await call({ preview: "htmlbody" });
check("preview, a 200 text/html body: an error naming what came back, not an image", r?.isError === true && !r.content.some((c: any) => c.type === "image") && /text\/html/.test(said(r)), JSON.stringify(r));
r = await call({ preview: "shouty" });
check("preview, a 200 Image/PNG (media types are case-insensitive): the image", !r?.isError && r?.content?.[0]?.type === "image", JSON.stringify(r).slice(0, 200));
r = await call({ preview: "fine" });
check("(control) preview, a 200 image/png: the image", !r?.isError && r?.content?.[0]?.type === "image" && r.content[0].mimeType === "image/png", JSON.stringify(r).slice(0, 200));
models = () => Response.json([{ path: "library/shouty.glb", name: "shouty", preview: "shouty_preview.jpg" }]);
r = await call({ kind: "models" });
check("sheet: a tile whose preview answered 200 Image/PNG is drawn, not a failed preview", !r?.isError && said(r) === "models — page 1/1: shouty", said(r));
models = () => Response.json([{ path: "library/html.glb", name: "html", preview: "html_preview.jpg" }]);
r = await call({ kind: "models" });
check("sheet: a tile whose preview answered 200 text/html is said as a preview that couldn't be fetched", !r?.isError && /couldn't be fetched/.test(said(r)) && /text\/html/.test(said(r)), said(r));

server.stop(true);
rmSync(dir, { recursive: true, force: true });
done();
