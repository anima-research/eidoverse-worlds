// library-fetch-test — the library tool tells a catalog it couldn't read from an empty one (#292).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/library-fetch-test.ts
// The real library handler (mcpl/tools.ts) against a local Bun.serve whose /library-models answers as each case sets,
// with EIDOVERSE_DIR naming a checkout that holds one model, so the local-scan fallback is in play.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const dir = mkdtempSync(join(process.env.PROTOCOL_SCRATCH ?? tmpdir(), "library-fetch-"));
mkdirSync(join(dir, "eidoverse/assets/models"), { recursive: true });
writeFileSync(join(dir, "eidoverse/assets/models/chair-oak.glb"), "");
process.env.EIDOVERSE_DIR = dir;   // read when tools.ts loads
const { handleTool } = await import("../mcpl/tools.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  — ${detail}` : ""}`); };
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
let models: () => Response = () => Response.json([]);
const server = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/library-models") return models();
  if (u.pathname === "/library/broken_preview.jpg") return new Response("boom", { status: 500 });
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
r = await call({ query: "chair" });
check("query, catalog 503, a local match: the local hit, and beside it that the catalog search failed",
  !r?.isError && /eidoverse\/assets\/models\/chair-oak\.glb/.test(said(r)) && /catalog/.test(said(r)) && /503/.test(said(r)), said(r));
const closed = Bun.serve({ port: 0, fetch: () => new Response("") }); const deadBase = `http://127.0.0.1:${closed.port}`; closed.stop(true);
r = await call({ query: "zebra" }, deadBase);
check("query, nothing listening: an error saying the catalog couldn't be reached, not 'no matches'",
  r?.isError === true && /catalog/.test(said(r)) && !/no matches/.test(said(r)), said(r));
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

server.stop(true);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
