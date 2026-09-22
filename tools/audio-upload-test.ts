// The audio door — `POST /upload?as=audio`: an MP3/Ogg/WAV/WebM/M4A lands in
// the content-addressed store and comes back as a sound source.
//
// Owns its sequencer: a scratch child on a random port, proved ours by the
// nonce echo (probe-harness ownedWorld), with a scratch OPT_DIR so the
// manifest leg always runs — a fixed default port used to be the recipe, and
// runs sharing one door shared its upload window too (Mica, #192 blocker 3).
//
//   bun tools/audio-upload-test.ts
//
// To point it at a door you run yourself instead (identity unchecked):
//   WORLD_URL=ws://host:port/ws JOIN_TOKEN=… [OPT_DIR=…] bun tools/audio-upload-test.ts
//
// Kind by BYTES (a PNG named .mp3 is refused; a WAV named .glb is a .wav),
// content-addressed and idempotent, served back byte-identical with the right
// content-type under the store's immutable policy, admitted by the sound
// allow-list, manifest first-arrival-wins, same token gate as everything.
// The upload window is 4/min per IP and every POST past the token check
// spends it, so the door is exercised four at a time with a rest between.
import { allowedSoundSrc } from "../shared/sound.js";
import { ownedWorld, proveOwned } from "./probe-harness.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPT = process.env.OPT_DIR ?? mkdtempSync(join(tmpdir(), "audio-door-opt-"));
const world = process.env.WORLD_URL
  ? await ownedWorld({ live: process.env.WORLD_URL.replace(/^ws/, "http").replace(/\/ws$/, ""), key: process.env.JOIN_TOKEN ?? "test-door" })
  : await ownedWorld({ key: "test-door", env: { OPT_DIR: OPT } });
const HTTP = world.origin;
const TOKEN = world.key;
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }

import { wavBytes } from "./wav-fixture.ts";
const WAV = wavBytes();
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...new Array(64).fill(0)]);            // ID3v2 header + padding
const MP3RAW = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(64).fill(0)]);                                         // bare MPEG frame sync
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, ...new Array(64).fill(0)]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(64).fill(0)]);
const M4A = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, ...new Array(64).fill(0)]);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const JUNK = new Uint8Array(40).map((_, i) => (i * 53) & 0xff);
async function post(body: Uint8Array, q: Record<string, string>, token: string | null = TOKEN) {
  const p = new URLSearchParams(q); if (token != null) p.set("token", token);
  const r = await fetch(`${HTTP}/upload?${p}`, { method: "POST", body }); const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}
const rest = async () => { console.log("  (resting out the 4/min upload window…)"); await new Promise((r) => setTimeout(r, 61_000)); };

try {
console.log(`\naudio door — ${HTTP}\n`);
let r = await post(WAV, { as: "audio", name: "quiet tone.wav" });
check("a WAV lands: 200 with a store path", r.status === 200 && typeof r.json?.path === "string", r.text);
const wavPath: string = r.json?.path ?? "";
check("…content-addressed under store/audio/, extension from the bytes", /^store\/audio\/[a-f0-9]{16}\.wav$/.test(wavPath), wavPath);
check("…and the sound allow-list admits exactly that path", allowedSoundSrc(wavPath) === true, wavPath);
r = await post(WAV, { as: "audio", name: "lies.glb" });
check("the same bytes named .glb: same path (idempotent; the name is not evidence)", r.json?.path === wavPath, r.text);
r = await post(MP3, { as: "audio", name: "song.mp3" });
check("an ID3-tagged MP3 lands as .mp3", r.status === 200 && /\.mp3$/.test(r.json?.path ?? ""), r.text);
r = await post(OGG, { as: "audio", name: "song.ogg" });
check("an Ogg lands as .ogg", r.status === 200 && /\.ogg$/.test(r.json?.path ?? ""), r.text);
r = await post(WAV, { as: "audio" }, null);
check("no token: 401", r.status === 401, `${r.status} ${r.text}`);
const g = await fetch(`${HTTP}/library/${wavPath}`); const served = new Uint8Array(await g.arrayBuffer());
check("GET /library/<path> serves it: 200 audio/wav", g.status === 200 && (g.headers.get("content-type") ?? "").startsWith("audio/wav"), `${g.status} ${g.headers.get("content-type")}`);
check("…byte-identical", served.length === WAV.length && served.every((b, i) => b === WAV[i]), `${served.length} vs ${WAV.length}`);
check("…under the store's immutable cache policy", /immutable/.test(g.headers.get("cache-control") ?? ""), g.headers.get("cache-control") ?? "none");

await rest();
r = await post(MP3RAW, { as: "audio", name: "raw.mp3" });
check("a bare MPEG frame (no ID3) is still an .mp3", r.status === 200 && /\.mp3$/.test(r.json?.path ?? ""), r.text);
r = await post(WEBM, { as: "audio", name: "x.webm" });
check("a WebM/Matroska lands as .webm", r.status === 200 && /\.webm$/.test(r.json?.path ?? ""), r.text);
r = await post(M4A, { as: "audio", name: "x.m4a" });
check("an MP4 container (ftyp) lands as .m4a", r.status === 200 && /\.m4a$/.test(r.json?.path ?? ""), r.text);
r = await post(PNG, { as: "audio", name: "song.mp3" });
check("a PNG named .mp3 is refused at the audio door (415)", r.status === 415 && /not an MP3/.test(r.text), `${r.status} ${r.text}`);

await rest();
r = await post(JUNK, { as: "audio", name: "x.wav" });
check("junk bytes are refused (415)", r.status === 415, `${r.status} ${r.text}`);
r = await post(WAV, {});
check("a WAV at the MODEL door is refused as not-a-GLB (the doors are distinct)", r.status === 415 && /GLB/.test(r.text), `${r.status} ${r.text}`);
r = await post(WAV, { as: "image" });
check("a WAV at the IMAGE door is refused (415)", r.status === 415, `${r.status} ${r.text}`);
const gm = await fetch(`${HTTP}/library/${(await post(MP3, { as: "audio" })).json?.path ?? "store/audio/none.mp3"}`);
check("a served .mp3 says audio/mpeg", (gm.headers.get("content-type") ?? "").startsWith("audio/mpeg"), gm.headers.get("content-type") ?? "none");
// owned child: the scratch OPT_DIR above; a live door: only if the caller
// told us where its store is
const MANIFEST_DIR = world.owned ? OPT : process.env.OPT_DIR;
if (MANIFEST_DIR) {
  const man = JSON.parse(await Bun.file(`${MANIFEST_DIR}/store/audio/manifest.json`).text());
  const entry = man[wavPath.split("/").pop()!.replace(/\.wav$/, "")];
  check("the manifest records the first name and who", entry && entry.name === "quiet tone" && typeof entry.by === "string", JSON.stringify(entry));
} else console.log("  (OPT_DIR not set — manifest check skipped)");

  // the negative control: a responder that does not echo our nonce is refused
  // before any verdict — the identity check the door above passed is the one
  // thing an ambient or stale listener on the same port could not
  {
    const impostor = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === "/version" ? Response.json({ version: "impostor", nonce: "not-ours" }) : new Response("Unsupported method ('POST')", { status: 501 }) });
    const v = await proveOwned(`http://127.0.0.1:${impostor.port}`, "the-nonce-we-actually-gave", { attempts: 3 });
    check("negative control: a responder with the wrong nonce is refused, not judged", v.ours === false && /wrong nonce/.test(v.reason), JSON.stringify(v));
    const mute = Bun.serve({ port: 0, fetch: () => Response.json({ version: "stale" }) });
    const v2 = await proveOwned(`http://127.0.0.1:${mute.port}`, "any", { attempts: 3 });
    check("negative control: a responder with no nonce field is refused as a stale listener", v2.ours === false && /no nonce field/.test(v2.reason), JSON.stringify(v2));
    impostor.stop(true); mute.stop(true);
  }
} finally {
  await world.close();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
