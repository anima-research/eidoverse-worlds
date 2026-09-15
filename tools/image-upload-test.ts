// The image door — `POST /upload?as=image`: a PNG/JPEG/WebP lands in the
// content-addressed store and comes back as a picture source.
//
// Boots nothing itself — point it at a SCRATCH sequencer with a scratch store:
//
//   WORLDS_DIR=$(mktemp -d) OPT_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8994 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8994/ws JOIN_TOKEN=test-door bun run tools/image-upload-test.ts
//
// What must hold: the kind is judged by BYTES (a GLB named .png is refused,
// a PNG named .glb is a .png in the store), the path is content-addressed and
// idempotent, the /library route serves it back byte-identical with the right
// content-type and the store's immutable cache policy, the picture allow-list
// admits the path it returns, the manifest records who, and the door is
// token-gated, capped and rate-limited like the model door.
import { allowedPictureSrc } from "../shared/picture.js";

const URL_ = process.env.WORLD_URL ?? "ws://localhost:8994/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
const HTTP = URL_.replace(/^ws/, "http").replace(/\/ws$/, "");

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// A real 1×1 PNG (the smallest well-formed one), a JPEG SOI header with
// padding, and a WebP RIFF header with padding — the sniffer reads magic, the
// store does not decode, so headers are enough for the door.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(64).fill(0), 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(24).fill(0)]);
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, ...new Array(24).fill(0)]);
const JUNK = new Uint8Array(40).map((_, i) => (i * 37) & 0xff);

async function post(body: Uint8Array, q: Record<string, string>, token: string | null = TOKEN) {
  const p = new URLSearchParams(q);
  if (token != null) p.set("token", token);
  const r = await fetch(`${HTTP}/upload?${p}`, { method: "POST", body });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

console.log(`\nimage door — ${HTTP}\n`);

// ---- the door judges by bytes ------------------------------------------------
// The upload window is 4/min per IP and every POST past the token check
// spends it (refusals included), so the door is exercised four at a time
// with a window's rest between.
let r = await post(PNG, { as: "image", name: "hearth at dusk.png" });
check("a PNG lands: 200 with a store path", r.status === 200 && typeof r.json?.path === "string", r.text);
const pngPath: string = r.json?.path ?? "";
check("…content-addressed under store/images/, extension from the bytes", /^store\/images\/[a-f0-9]{16}\.png$/.test(pngPath), pngPath);
check("…and the picture allow-list admits exactly that path", allowedPictureSrc(pngPath) === true, pngPath);

const again = await post(PNG, { as: "image", name: "different name.png" });
check("re-uploading the same bytes is idempotent (same path, whatever the name)", again.json?.path === pngPath, again.text);

r = await post(PNG, { as: "image", name: "lies.glb" });
check("a PNG named .glb is still a .png in the store (the name is not evidence)", r.json?.path === pngPath, r.text);

r = await post(JPG, { as: "image", name: "photo.jpg" });
check("a JPEG lands as .jpg", r.status === 200 && /\.jpg$/.test(r.json?.path ?? ""), r.text);

r = await post(PNG, { as: "image" }, null);
check("no token: 401 (the image door is the same door)", r.status === 401, `${r.status} ${r.text}`);

// ---- served back (GETs spend nothing) --------------------------------------
const g = await fetch(`${HTTP}/library/${pngPath}`);
const served = new Uint8Array(await g.arrayBuffer());
check("GET /library/<path> serves it: 200 image/png", g.status === 200 && (g.headers.get("content-type") ?? "").startsWith("image/png"), `${g.status} ${g.headers.get("content-type")}`);
check("…byte-identical", served.length === PNG.length && served.every((b, i) => b === PNG[i]), `${served.length} vs ${PNG.length}`);
check("…under the store's immutable cache policy (content-addressed)", /immutable/.test(g.headers.get("cache-control") ?? ""), g.headers.get("cache-control") ?? "none");

console.log("  (resting out the 4/min upload window…)");
await new Promise((res) => setTimeout(res, 61_000));

r = await post(WEBP, { as: "image", name: "photo.webp" });
check("a WebP lands as .webp", r.status === 200 && /\.webp$/.test(r.json?.path ?? ""), r.text);
const gw = await fetch(`${HTTP}/library/${r.json?.path ?? "store/images/none.webp"}`);
check("a served .webp says image/webp", (gw.headers.get("content-type") ?? "").startsWith("image/webp"), gw.headers.get("content-type") ?? "none");

r = await post(GLB, { as: "image", name: "model.png" });
check("a GLB named .png is refused at the image door (415)", r.status === 415 && /not a PNG/.test(r.text), `${r.status} ${r.text}`);
r = await post(JUNK, { as: "image", name: "x.png" });
check("junk bytes are refused (415)", r.status === 415, `${r.status} ${r.text}`);
r = await post(PNG, {});
check("a PNG at the MODEL door is refused as not-a-GLB (the doors are distinct)", r.status === 415 && /GLB/.test(r.text), `${r.status} ${r.text}`);

// ---- the manifest remembers who ----------------------------------------------
const OPT = process.env.OPT_DIR;
if (OPT) {
  const man = JSON.parse(await Bun.file(`${OPT}/store/images/manifest.json`).text());
  const entry = man[pngPath.split("/").pop()!.replace(/\.png$/, "")];
  check("the manifest records the name and who (first upload wins the name)", entry && entry.name === "hearth at dusk" && typeof entry.by === "string", JSON.stringify(entry));
} else console.log("  (OPT_DIR not set — manifest check skipped)");

// ---- the cap ------------------------------------------------------------------
console.log("  (resting out the 4/min upload window…)");
await new Promise((res) => setTimeout(res, 61_000));
const big = new Uint8Array(8 * 1_000_000 + 1); big.set(PNG.subarray(0, 8));
r = await post(big, { as: "image" });
check("over the image cap: 413, before any sniffing", r.status === 413 && /cap/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
