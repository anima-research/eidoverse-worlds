// The `picture` component's meaning + text-tier perception, without a browser.
//
//   bun tools/picture-test.ts
//
// Two legs:
//   1. DECLARATION — the source allow-list (library-relative image under
//      eidoverse/assets/, never a URL, never a path escape), the named part,
//      the look line and its bound, unknown keys noted, and a `describe` that
//      says what the author said and nothing about pixels.
//   2. PERCEPTION  — what look() carries for a resident who reads: the line
//      appears on the owning entity, tracks a replace, and is gone on removal;
//      other component types still read as they did.
// Every check fails on main by construction: `picture` did not exist.
import { normalizePicture, describePicture, allowedPictureSrc, PICTURE_ALT_MAX } from "../shared/picture.js";
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const { WorldAgent } = await import("../mcpl/agent.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

console.log("— 1. declaration —");
const GOOD = "eidoverse/assets/pictures/hearth_at_dusk.png";
for (const [src, expect] of [
  [GOOD, true], ["eidoverse/assets/models/thing_preview.jpg", true], ["eidoverse/assets/x/y.webp", true],
  // the upload door's store — content-addressed pictures land here (POST /upload?as=image)
  ["store/images/0123456789abcdef.png", true], ["store/images/0123456789abcdef.jpg", true], ["store/images/0123456789abcdef.webp", true],
  ["store/0123456789abcdef.png", false], ["store/scripts/x.png", false], ["store/images/../secret.png", false], ["store/images/x.glb", false],
  ["store/imagesx/y.png", false], ["/store/images/x.png", false],
  ["https://example.com/x.png", false], ["http://x/y.jpg", false], ["data:image/png;base64,AAAA", false],
  ["/eidoverse/assets/x.png", false], ["eidoverse/assets/../secret.png", false], ["eidoverse/assets/./x.png", false],
  ["eidoverse/assets//x.png", false], ["other/x.png", false], ["eidoverse/assets/x.gif", false], ["eidoverse/assets/x.glb", false],
  ["eidoverse\\assets\\x.png", false], ["", false], [null, false],
] as [unknown, boolean][]) check(`allowedPictureSrc(${JSON.stringify(src)}) === ${expect}`, allowedPictureSrc(src) === expect);
// Encoded traversal (Mica, #186 review, blocker 2): the rule is over the path
// the FETCH canonicalizes to. A URL parser reads %2e%2e as a dot segment; a
// server may decode %41 after the check ran. Library paths are plain: any %
// is a refusal, and the parsed pathname must equal the declared one.
for (const src of [
  "eidoverse/assets/%2e%2e/%2e%2e/store/x.png", "eidoverse/assets/%2E%2E/secret.jpg", "eidoverse/assets/.%2e/x.png",
  "eidoverse/assets/%2e./x.png", "eidoverse/assets/%2e/x.png", "eidoverse/assets/a%2fb/x.png", "eidoverse/assets/%41.png",
  "eidoverse/assets/x%25.png", "eidoverse/assets/x.png?x=1", "eidoverse/assets/x.png#f", "eidoverse/assets/x y.png",
  "eidoverse/assets/x\u0000.png", "eidoverse/assets/x\t.png",
]) check(`encoded/odd source refused: ${JSON.stringify(src)}`, allowedPictureSrc(src) === false);
check("the canonical library path of an allowed source is itself", new URL(`/library/${GOOD}`, "http://library.invalid").pathname === `/library/${GOOD}`);

const n0 = normalizePicture({ src: GOOD, part: "screenplane", alt: "a print of the hearth at dusk", lit: "self" });
check("a well-formed bag normalizes", n0.ok && n0.picture.src === GOOD && n0.picture.part === "screenplane" && n0.picture.lit === "self" && n0.picture.flip === false, JSON.stringify(n0));
check("…with no notes", n0.ok && n0.notes.length === 0, JSON.stringify(n0.ok && n0.notes));
const nUrl = normalizePicture({ src: "https://example.com/x.png", part: "screenplane" });
// batch 2 (R 10-07): an https link is a source now; who may fetch it is shared/mediasrc.js (the tier); http and local hosts are refused
check("an https link is taken, with its tier (an untrusted host: only opted-in viewers fetch it)", nUrl.ok && nUrl.tier.tier === "link", JSON.stringify(nUrl));
check("an http link or a local host is refused, legibly", !normalizePicture({ src: "http://example.com/x.png" }).ok && /https/.test(normalizePicture({ src: "http://example.com/x.png" }).why) && !normalizePicture({ src: "https://192.168.0.2/x.png" }).ok);
const nPart = normalizePicture({ src: GOOD });
check("no part is a picture of its own (batch 2: quad mode), 1 m wide", nPart.ok && nPart.picture.part === undefined && nPart.picture.width === 1, JSON.stringify(nPart));
check("an over-long part is refused", !normalizePicture({ src: GOOD, part: "x".repeat(65) }).ok);
const nLook = normalizePicture({ src: GOOD, part: "p", alt: "  many   spaces\n\nand " + "z".repeat(400) });
check("look is whitespace-collapsed and clipped with a note", nLook.ok && nLook.picture.alt.length === PICTURE_ALT_MAX && nLook.picture.alt.startsWith("many spaces and ") && nLook.notes.some((x) => /clipped/.test(x)), JSON.stringify(nLook.ok && nLook.notes));
const nNoLook = normalizePicture({ src: GOOD, part: "p" });
check("no look line is allowed but noted (text-tier sees only the file)", nNoLook.ok && !nNoLook.picture.alt && nNoLook.notes.some((x) => /no alt text/.test(x)));
const nUnknown = normalizePicture({ src: GOOD, part: "p", alt: "x", scale: 2, _private: 1, lit: "neon" });
check("unknown keys and an unknown lit are noted, not fatal; _keys ignored silently", nUnknown.ok && nUnknown.notes.some((x) => /ignored by the evaluator: scale/.test(x) && !/_private/.test(x)) && nUnknown.notes.some((x) => /lit "neon" is unknown/.test(x)) && nUnknown.picture.lit === "scene", JSON.stringify(nUnknown.notes));
check("malformed bags are refused", !normalizePicture(null).ok && !normalizePicture([]).ok && !normalizePicture("x").ok);

check("describe: with a look line, says what the author said, on the part", describePicture({ src: GOOD, part: "screenplane", alt: "a print of the hearth at dusk" }) === "a picture on its screenplane: «a print of the hearth at dusk»");
check("describe: self-lit is named", /\(self-lit\)$/.test(describePicture({ src: GOOD, part: "p", alt: "x", lit: "self" })));
check("describe: without a look line, the file name", describePicture({ src: GOOD, part: "p" }) === "a picture on its p (hearth_at_dusk.png)");
check("describe: an invalid declaration says it is not shown", /not shown: invalid declaration/.test(describePicture({ src: "http://x/y.png", part: "p", alt: "x" })));
check("describe: malformed", describePicture(null) === "a picture (malformed declaration)");
check("describe never mentions pixels/colours (it carries the author's claim only)", !/pixel|colour|color/.test(describePicture({ src: GOOD, part: "p", alt: "x" })));

console.log("— 2. perception —");
// the agent's protocol path: a scratch authority, its cut adopted, and the next view taken after every write (tools/agent-scratch.ts)
const { agentOnDoor } = await import("./agent-scratch.ts");
const ag = new WorldAgent({ name: "reader" });
const { seed, act } = agentOnDoor(ag, "picture");
await seed({ console: { lib: "scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb", pos: [1, 0, 1] } });
const r1 = await act("set", { id: "console", component: "picture", value: { src: GOOD, part: "screenplane", alt: "a print of the hearth at dusk" } }, { who: "antra" });
let out = ag.look();
check("the door takes a well-formed picture", r1.ok, JSON.stringify(r1.refused));
check("look() names the picture on the owning entity, by the author's line", /\[console\][^\n]*a picture on its screenplane: «a print of the hearth at dusk»/.test(out), out.split("\n").find((l) => l.includes("console")) ?? out);
check("…and does not fall through to `components: picture`", !/components: picture/.test(out));
await act("set", { id: "console", component: "picture", value: { src: GOOD, part: "screenplane", alt: "the same print, re-hung" } }, { who: "antra" });
out = ag.look();
check("a replace reads as the new line, not both", /re-hung/.test(out) && !/hearth at dusk/.test(out));
const bad = await act("set", { id: "console", component: "picture", value: { src: "http://example.com/x.png", part: "screenplane", alt: "smuggled" } }, { who: "antra" });
out = ag.look();
check("an invalid source is refused at the door now (batch 2: the door judges picture sources) and nothing changes", !bad.ok && bad.refused?.code === "shape" && !/smuggled/.test(out), JSON.stringify([bad.refused, out.split("\n").find((l) => l.includes("console"))]));
await act("delete", { id: "console", component: "picture" }, { who: "antra" });
check("a removed picture is gone from look()", !/a picture/.test(ag.look()));
await act("set", { id: "console", component: "recipe", value: { x: 1 } }, { who: "antra" });
check("other component types still read as they did", /components: recipe/.test(ag.look()), ag.look().split("\n").find((l) => l.includes("console")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
