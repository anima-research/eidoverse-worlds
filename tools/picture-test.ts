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
import { normalizePicture, describePicture, allowedPictureSrc, PICTURE_LOOK_MAX } from "../shared/picture.js";
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const { WorldAgent } = await import("../mcpl/agent.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

console.log("— 1. declaration —");
const GOOD = "eidoverse/assets/pictures/hearth_at_dusk.png";
for (const [src, expect] of [
  [GOOD, true], ["eidoverse/assets/models/thing_preview.jpg", true], ["eidoverse/assets/x/y.webp", true],
  ["https://example.com/x.png", false], ["http://x/y.jpg", false], ["data:image/png;base64,AAAA", false],
  ["/eidoverse/assets/x.png", false], ["eidoverse/assets/../secret.png", false], ["eidoverse/assets/./x.png", false],
  ["eidoverse/assets//x.png", false], ["other/x.png", false], ["eidoverse/assets/x.gif", false], ["eidoverse/assets/x.glb", false],
  ["eidoverse\\assets\\x.png", false], ["", false], [null, false],
] as [unknown, boolean][]) check(`allowedPictureSrc(${JSON.stringify(src)}) === ${expect}`, allowedPictureSrc(src) === expect);

const n0 = normalizePicture({ src: GOOD, part: "screenplane", look: "a print of the hearth at dusk", lit: "self" });
check("a well-formed bag normalizes", n0.ok && n0.picture.src === GOOD && n0.picture.part === "screenplane" && n0.picture.lit === "self" && n0.picture.flip === false, JSON.stringify(n0));
check("…with no notes", n0.ok && n0.notes.length === 0, JSON.stringify(n0.ok && n0.notes));
const nUrl = normalizePicture({ src: "https://example.com/x.png", part: "screenplane" });
check("a URL source is refused, legibly, naming the rule", !nUrl.ok && /not an allowed picture source/.test(nUrl.why) && /no URLs/.test(nUrl.why), JSON.stringify(nUrl));
const nPart = normalizePicture({ src: GOOD });
check("a missing part is refused and points at measure", !nPart.ok && /measure/.test(nPart.why), JSON.stringify(nPart));
check("an over-long part is refused", !normalizePicture({ src: GOOD, part: "x".repeat(65) }).ok);
const nLook = normalizePicture({ src: GOOD, part: "p", look: "  many   spaces\n\nand " + "z".repeat(400) });
check("look is whitespace-collapsed and clipped with a note", nLook.ok && nLook.picture.look.length === PICTURE_LOOK_MAX && nLook.picture.look.startsWith("many spaces and ") && nLook.notes.some((x) => /clipped/.test(x)), JSON.stringify(nLook.ok && nLook.notes));
const nNoLook = normalizePicture({ src: GOOD, part: "p" });
check("no look line is allowed but noted (text-tier sees only the file)", nNoLook.ok && !nNoLook.picture.look && nNoLook.notes.some((x) => /no look line/.test(x)));
const nUnknown = normalizePicture({ src: GOOD, part: "p", look: "x", scale: 2, _private: 1, lit: "neon" });
check("unknown keys and an unknown lit are noted, not fatal; _keys ignored silently", nUnknown.ok && nUnknown.notes.some((x) => /ignored by the evaluator: scale/.test(x) && !/_private/.test(x)) && nUnknown.notes.some((x) => /lit "neon" is unknown/.test(x)) && nUnknown.picture.lit === "scene", JSON.stringify(nUnknown.notes));
check("malformed bags are refused", !normalizePicture(null).ok && !normalizePicture([]).ok && !normalizePicture("x").ok);

check("describe: with a look line, says what the author said, on the part", describePicture({ src: GOOD, part: "screenplane", look: "a print of the hearth at dusk" }) === "a picture on its screenplane: a print of the hearth at dusk");
check("describe: self-lit is named", /\(self-lit\)$/.test(describePicture({ src: GOOD, part: "p", look: "x", lit: "self" })));
check("describe: without a look line, the file name", describePicture({ src: GOOD, part: "p" }) === "a picture on its p (hearth_at_dusk.png)");
check("describe: an invalid declaration says it is not shown", /not shown: invalid declaration/.test(describePicture({ src: "https://x/y.png", part: "p", look: "x" })));
check("describe: malformed", describePicture(null) === "a picture (malformed declaration)");
check("describe never mentions pixels/colours (it carries the author's claim only)", !/pixel|colour|color/.test(describePicture({ src: GOOD, part: "p", look: "x" })));

console.log("— 2. perception —");
const T0 = 1_754_000_000_000;
const ag = new WorldAgent({ name: "reader" });
const A = ag as any;
A.applyEntry({ verb: "spawn", args: { id: "console", lib: "scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb", pos: [1, 0, 1] }, ts: T0, seq: 1, actor: "antra" }, false);
A.applyEntry({ verb: "comp", args: { id: "console", type: "picture", data: { src: GOOD, part: "screenplane", look: "a print of the hearth at dusk" } }, ts: T0 + 1, seq: 2, actor: "antra" }, true);
let out = ag.look();
check("look() names the picture on the owning entity, by the author's line", /\[console\][^\n]*a picture on its screenplane: a print of the hearth at dusk/.test(out), out.split("\n").find((l) => l.includes("console")) ?? out);
check("…and does not fall through to `components: picture`", !/components: picture/.test(out));
A.applyEntry({ verb: "comp", args: { id: "console", type: "picture", data: { src: GOOD, part: "screenplane", look: "the same print, re-hung" } }, ts: T0 + 2, seq: 3, actor: "antra" }, true);
out = ag.look();
check("a replace reads as the new line, not both", /re-hung/.test(out) && !/hearth at dusk/.test(out));
A.applyEntry({ verb: "comp", args: { id: "console", type: "picture", data: { src: "https://example.com/x.png", part: "screenplane", look: "smuggled" } }, ts: T0 + 3, seq: 4, actor: "antra" }, true);
out = ag.look();
check("an invalid source folds (blind fold) but reads as not shown", /smuggled/.test(out) && /not shown: invalid declaration/.test(out), out.split("\n").find((l) => l.includes("console")) ?? out);
A.applyEntry({ verb: "comp", args: { id: "console", type: "picture", data: null }, ts: T0 + 4, seq: 5, actor: "antra" }, true);
check("a removed picture is gone from look()", !/a picture/.test(ag.look()));
A.applyEntry({ verb: "comp", args: { id: "console", type: "recipe", data: { x: 1 } }, ts: T0 + 5, seq: 6, actor: "antra" }, true);
check("other component types still read as they did", /components: recipe/.test(ag.look()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
