// The `captions` component's meaning + text-tier perception, without a browser.
//
//   bun tools/captions-test.ts
//
// Two legs, mirroring picture-test:
//   1. DECLARATION — the bounded window (line count, text length, oldest
//      dropped first), malformed lines dropped with a note, times rounded and
//      ordered, the look line that says what the captioner wrote and nothing
//      about pixels or sound, the clock format, the detail level.
//   2. PERCEPTION  — what look() carries for a resident who reads: the line
//      appears on the owning entity, tracks a replace, and is gone when the
//      screen goes quiet; other component types still read as they did.
import { normalizeCaptions, describeCaptions, captionsDetail, clock, CAPTIONS_MAX_LINES, CAPTION_TEXT_MAX } from "../shared/captions.js";
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const { WorldAgent } = await import("../mcpl/agent.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };
const line = (t0: number, t1: number, text: string, speaker?: string) => ({ t0, t1, text, ...(speaker ? { speaker } : {}) });

console.log("— 1. declaration —");
const good = { title: "Solstice, main stage", mediaTime: 760.2, window: [line(752.1, 755.8, "we light the first candle"), line(756.0, 759.9, "for the year that was", "Ra")] };
const n0 = normalizeCaptions(good);
check("a well-formed bag normalizes with no notes", n0.ok && n0.notes.length === 0 && n0.captions.window.length === 2 && n0.captions.title === good.title, JSON.stringify(n0));
check("mediaTime kept when given", n0.ok && n0.captions.mediaTime === 760.2);
const nNoMt = normalizeCaptions({ window: good.window });
check("mediaTime defaults to the last line's t1", nNoMt.ok && nNoMt.captions.mediaTime === 759.9);
for (const [bag, why] of [[null, "object"], [[], "object"], [{}, "window"], [{ window: "x" }, "window"]] as [unknown, string][]) {
  const n = normalizeCaptions(bag);
  check(`refused: ${JSON.stringify(bag)} → mentions ${why}`, !n.ok && new RegExp(why).test(n.why));
}
const nBad = normalizeCaptions({ window: [line(1, 2, "ok"), line(3, 2, "backwards"), line(-1, 2, "negative"), { t0: 1, t1: 2, text: "   " }, "junk", line(NaN, 2, "nan")] });
check("malformed lines are dropped, counted in a note, the good one kept", nBad.ok && nBad.captions.window.length === 1 && nBad.notes.some((x) => /5 malformed captions dropped/.test(x)), JSON.stringify(nBad));
const many = { window: Array.from({ length: CAPTIONS_MAX_LINES + 7 }, (_, i) => line(i, i + 0.5, `line ${i}`)) };
const nMany = normalizeCaptions(many);
check(`the window is a window: newest ${CAPTIONS_MAX_LINES} survive, oldest go first`, nMany.ok && nMany.captions.window.length === CAPTIONS_MAX_LINES && nMany.captions.window[0].text === "line 7" && nMany.notes.some((x) => /clipped/.test(x)), JSON.stringify(nMany.ok && nMany.notes));
const nOrder = normalizeCaptions({ window: [line(10, 11, "second"), line(1, 2, "first")] });
check("lines are ordered by time whatever order they arrived in", nOrder.ok && nOrder.captions.window[0].text === "first");
const nText = normalizeCaptions({ window: [line(1, 2, "  many   spaces\n\n" + "z".repeat(500))] });
check(`text is whitespace-collapsed and clipped to ${CAPTION_TEXT_MAX}`, nText.ok && nText.captions.window[0].text.length === CAPTION_TEXT_MAX && nText.captions.window[0].text.startsWith("many spaces z"));
const nRound = normalizeCaptions({ window: [line(1.23456, 2.98765, "x")] });
check("times are rounded to 10 ms", nRound.ok && nRound.captions.window[0].t0 === 1.23 && nRound.captions.window[0].t1 === 2.99);
const nUnknown = normalizeCaptions({ window: [], src: "rtsp://x", _note: "private" });
check("unknown keys are noted, underscore keys are not", nUnknown.ok && nUnknown.notes.some((x) => /ignored: src/.test(x) && !/_note/.test(x)), JSON.stringify(nUnknown.notes));
check("clock: 0 → 0:00, 65 → 1:05, 3725 → 1:02:05", clock(0) === "0:00" && clock(65) === "1:05" && clock(3725) === "1:02:05");

console.log("— 1b. the look line —");
check("says what is showing, where in it, and the last line with its speaker", describeCaptions(good) === "a screen, showing Solstice, main stage, 12:40, last line: Ra: for the year that was", describeCaptions(good));
check("a bag-level speaker labels lines that carry none", describeCaptions({ speaker: "stage", window: [line(1, 2, "hello")] }) === "a screen, showing something uncaptioned by title, 0:02, last line: stage: hello", describeCaptions({ speaker: "stage", window: [line(1, 2, "hello")] }));
check("no lines yet reads as such", describeCaptions({ title: "a film", window: [] }) === "a screen, showing a film, nothing captioned yet");
check("a malformed declaration reads as malformed, never throws", describeCaptions("nope") === "a screen (malformed captions declaration)" && describeCaptions(null).includes("malformed"));
check("never a claim about pixels or sound", !/pixel|sound|audio|video/i.test(describeCaptions(good)));
const det = captionsDetail(good);
check("the detail level lists the window oldest first with clocks and speakers", det.length === 2 && det[0] === "[12:32–12:35] we light the first candle" && det[1] === "[12:36–12:39] Ra: for the year that was", JSON.stringify(det));
check("the detail level can be asked for fewer lines", captionsDetail(good, 1).length === 1 && captionsDetail(good, 1)[0].includes("Ra:"));

console.log("— 2. perception —");
const T0 = 1_754_000_000_000;
const ag = new WorldAgent({ name: "reader" });
const A = ag as any;
A.applyEntry({ verb: "spawn", args: { id: "cinema", lib: "screen.glb", pos: [0, 0, 0] }, ts: T0, seq: 1, actor: "antra" }, false);
A.applyEntry({ verb: "comp", args: { id: "cinema", type: "captions", data: good }, ts: T0 + 1, seq: 2, actor: "captioner" }, true);
let out = ag.look();
check("look() carries the captions line on the owning entity", /\[cinema\][^\n]*a screen, showing Solstice, main stage, 12:40, last line: Ra: for the year that was/.test(out), out.split("\n").find((l: string) => l.includes("cinema")) ?? out);
check("…and does not fall through to `components: captions`", !/components: captions/.test(out));
A.applyEntry({ verb: "comp", args: { id: "cinema", type: "captions", data: { ...good, mediaTime: 763, window: [...good.window, line(760, 763, "and the year to come", "Ra")] } }, ts: T0 + 2, seq: 3, actor: "captioner" }, true);
out = ag.look();
check("a replace reads as the new last line, not the old", /last line: Ra: and the year to come/.test(out) && !/last line: Ra: for the year/.test(out), out.split("\n").find((l: string) => l.includes("cinema")) ?? out);
A.applyEntry({ verb: "comp", args: { id: "cinema", type: "captions", data: "junk" }, ts: T0 + 3, seq: 4, actor: "captioner" }, true);
check("a malformed bag folds (blind fold) but reads as malformed, never throws", /malformed captions declaration/.test(ag.look()));
A.applyEntry({ verb: "comp", args: { id: "cinema", type: "captions", data: null }, ts: T0 + 4, seq: 5, actor: "captioner" }, true);
check("a quiet screen is gone from look()", !/a screen/.test(ag.look()));
A.applyEntry({ verb: "comp", args: { id: "cinema", type: "recipe", data: { x: 1 } }, ts: T0 + 5, seq: 6, actor: "antra" }, true);
check("other component types still read as they did", /components: recipe/.test(ag.look()));

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
