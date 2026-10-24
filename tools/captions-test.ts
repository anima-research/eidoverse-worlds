// shared/captions.js, without a server: the caption bag a reader sees and the caption request's pure rules.
//
//   bun tools/captions-test.ts
//
// Legs:
//   1. DECLARATION — the bag a reader sees: the bounded window, malformed
//      lines dropped with a note, times rounded, the look line that says what
//      the captioner wrote and nothing about pixels or sound, the detail level.
//   1c. THE VERB — args shape; the refusals that happen BEFORE append (dup /
//      old n, a superseded leg, an end for the wrong session); the fold
//      (append, the window bound, a newer leg or a new session starts fresh,
//      end clears). `gen` is the sequencer's stamp: the live leg.
// (Protocol v1 removed, 2026-10-07. Two legs went with it and wait on the caption path, being designed: 1d THE
//  DEED (the per-entity caption grant folded by the v1 `grant` verb and carried by rightsIn: its born/rename/sub
//  migration rules) and 2 PERCEPTION (the agent's look() line folded from v1 `caption` entries: newest line,
//  duplicate n and superseded leg folding to nothing, `end` clearing it, a hand-written captions comp ignored).
//  What's left is shared/captions.js's pure functions: describeCaptions is what the agent's look() still calls.)
import { normalizeCaptions, describeCaptions, captionsDetail, clock, normalizeCaptionArgs, captionRefusal, foldCaption, mintSession, CAPTIONS_MAX_LINES, CAPTION_TEXT_MAX } from "../shared/captions.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };
const line = (t0: number, t1: number, text: string, speaker?: string) => ({ t0, t1, text, ...(speaker ? { speaker } : {}) });
const S1 = "2026-09-16T20:00:00.000Z-aaaa", S2 = "2026-09-16T21:00:00.000Z-bbbb";

console.log("— 1. declaration —");
const good = { session: S1, n: 2, title: "Solstice, main stage", mediaTime: 760.2, window: [line(752.1, 755.8, "we light the first candle"), line(756.0, 759.9, "for the year that was", "Ra")] };
const n0 = normalizeCaptions(good);
check("a well-formed bag normalizes with no notes", n0.ok && n0.notes.length === 0 && n0.captions.window.length === 2 && n0.captions.title === good.title && n0.captions.session === S1 && n0.captions.n === 2, JSON.stringify(n0));
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
const nText = normalizeCaptions({ window: [line(1, 2, "  many   spaces\n\n" + "z".repeat(500))] });
check(`text is whitespace-collapsed and clipped to ${CAPTION_TEXT_MAX} CHARACTERS`, nText.ok && nText.captions.window[0].text.length === CAPTION_TEXT_MAX && nText.captions.window[0].text.startsWith("many spaces z"));
const cjk = normalizeCaptions({ window: [line(1, 2, "字".repeat(CAPTION_TEXT_MAX))] });
check("…characters, not bytes: a full CJK line keeps all its characters", cjk.ok && cjk.captions.window[0].text.length === CAPTION_TEXT_MAX && Buffer.byteLength(cjk.captions.window[0].text) > CAPTION_TEXT_MAX);
const nRound = normalizeCaptions({ window: [line(1.23456, 2.98765, "x")] });
check("times are rounded to 10 ms", nRound.ok && nRound.captions.window[0].t0 === 1.23 && nRound.captions.window[0].t1 === 2.99);
const nUnknown = normalizeCaptions({ window: [], src: "rtsp://x", _note: "private" });
check("unknown keys are noted, underscore keys are not", nUnknown.ok && nUnknown.notes.some((x) => /ignored: src/.test(x) && !/_note/.test(x)), JSON.stringify(nUnknown.notes));
check("clock: 0 → 0:00, 65 → 1:05, 3725 → 1:02:05", clock(0) === "0:00" && clock(65) === "1:05" && clock(3725) === "1:02:05");

console.log("— 1b. the look line —");
check("says what is showing, where in it, and the last line with its speaker", describeCaptions(good) === "a screen, showing Solstice, main stage, 12:40, last line: Ra: for the year that was", describeCaptions(good));
check("no lines yet reads as such", describeCaptions({ title: "a film", window: [] }) === "a screen, showing a film, nothing captioned yet");
check("a malformed declaration reads as malformed, never throws", describeCaptions("nope") === "a screen (malformed captions declaration)" && describeCaptions(null).includes("malformed"));
check("never a claim about pixels or sound", !/pixel|sound|audio|video/i.test(describeCaptions(good)));
const det = captionsDetail(good);
check("the detail level lists the window oldest first with clocks and speakers", det.length === 2 && det[0] === "[12:32–12:35] we light the first candle" && det[1] === "[12:36–12:39] Ra: for the year that was", JSON.stringify(det));
check("the detail level can be asked for fewer lines", captionsDetail(good, 1).length === 1 && captionsDetail(good, 1)[0].includes("Ra:"));

console.log("— 1c. the verb —");
const a1 = normalizeCaptionArgs({ id: "cinema", session: S1, n: 1, t0: 1.004, t1: 2.5, text: "  hello   there ", speaker: "Ra", title: "a film", junk: 1 });
check("args normalize: id, session, n, rounded times, cleaned text, speaker, title; unknown keys dropped", a1.ok && JSON.stringify(a1.args) === JSON.stringify({ id: "cinema", session: S1, n: 1, t0: 1, t1: 2.5, text: "hello there", speaker: "Ra", title: "a film" }), JSON.stringify(a1));
check("end normalizes to {id, session, end}", (() => { const e = normalizeCaptionArgs({ id: "cinema", session: S1, end: true, n: 9 }); return e.ok && JSON.stringify(e.args) === JSON.stringify({ id: "cinema", session: S1, end: true }); })());
for (const [args, why] of [
  [{ session: S1, n: 1, t0: 0, t1: 1, text: "x" }, "entity id"],
  [{ id: "c", n: 1, t0: 0, t1: 1, text: "x" }, "session"],
  [{ id: "c", session: "random", n: 1, t0: 0, t1: 1, text: "x" }, "session"],
  [{ id: "c", session: S1, t0: 0, t1: 1, text: "x" }, "integer n"],
  [{ id: "c", session: S1, n: 0, t0: 0, t1: 1, text: "x" }, "integer n"],
  [{ id: "c", session: S1, n: 1.5, t0: 0, t1: 1, text: "x" }, "integer n"],
  [{ id: "c", session: S1, n: 1, t0: 2, t1: 1, text: "x" }, "t0"],
  [{ id: "c", session: S1, n: 1, t0: 0, t1: 1, text: "   " }, "text"],
] as [unknown, string][]) {
  const n = normalizeCaptionArgs(args);
  check(`refused shape: ${JSON.stringify(args)} → mentions ${why}`, !n.ok && new RegExp(why).test(n.why), n.ok ? "accepted" : n.why);
}
// a refusal names what failed, and only that, quoting what was sent
const refusalOf = (args: unknown) => { const n = normalizeCaptionArgs(args); return n.ok ? "accepted" : n.why; };
const onlyTimes = refusalOf({ id: "c", session: S1, n: 1, t0: 2, t1: 1, text: "x" });
check("a line refused for its times names them and their values, not the text", /t0 2, t1 1/.test(onlyTimes) && !/text/.test(onlyTimes), onlyTimes);
const onlyText = refusalOf({ id: "c", session: S1, n: 1, t0: 0, t1: 1, text: "   " });
check("a line refused for its text names the text, not the times", /text/.test(onlyText) && !/t0/.test(onlyText), onlyText);
const both = refusalOf({ id: "c", session: S1, n: 1, t0: -1, t1: 1, text: "" });
check("a line wrong both ways names both at once", /t0 -1, t1 1/.test(both) && /text/.test(both), both);
const badN = refusalOf({ id: "c", session: S1, n: 1.5, t0: 0, t1: 1, text: "x" });
check("the n refusal quotes the n sent", /got 1\.5/.test(badN), badN);
const badSession = refusalOf({ id: "c", session: "random", n: 1, t0: 0, t1: 1, text: "x" });
check("the session refusal quotes the session sent and shows the form", /got "random"/.test(badSession) && /"2026-09-16T20:00:00\.000Z-k3f9"/.test(badSession), badSession);
const nanTime = refusalOf({ id: "c", session: S1, n: 1, t0: NaN, t1: Infinity, text: "x" });
check("a non-finite time is quoted as itself, not as JSON's null", /t0 NaN, t1 Infinity/.test(nanTime), nanTime);
let unwritable: string;
try { unwritable = refusalOf({ id: "c", session: 5n, n: 1, t0: 0, t1: 1, text: "x" }); } catch (e) { unwritable = `threw: ${e}`; }
check("a value JSON can't write is still refused, and quoted, rather than thrown", /got 5\b/.test(unwritable), unwritable);
const cyclic: any = {}; cyclic.self = cyclic;
let cyclicWhy: string;
try { cyclicWhy = refusalOf({ id: "c", session: cyclic, n: 1, t0: 0, t1: 1, text: "x" }); } catch (e) { cyclicWhy = `threw: ${e}`; }
check("...a cycle included", /^caption wants a session/.test(cyclicWhy), cyclicWhy);
// shared/shown.js quotes it: a long value is cut at 60 code points, so the
// cut never lands between the two halves of a character outside the BMP.
const astral = refusalOf({ id: "c", session: "a" + "😀".repeat(70), n: 1, t0: 0, t1: 1, text: "x" });
const quotedSession = /\(got ([\s\S]*?)\); mint it once/.exec(astral)?.[1] ?? "";
check("a long value is cut at 60 code points, never inside a character",
  Array.from(quotedSession).length === 60 && quotedSession.endsWith("…")
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(quotedSession), astral);
check("a minted session has the shape the door accepts and sorts by time", (() => { const a = mintSession(new Date("2026-01-01T00:00:00Z")), b = mintSession(new Date("2026-01-01T00:00:01Z")); return normalizeCaptionArgs({ id: "c", session: a, n: 1, t0: 0, t1: 1, text: "x" }).ok && a < b; })());
// the server stamps `gen` AFTER the shape (vCaption); a client-supplied one never survives it
const L = (n: number, t0: number, text: string, session = S1, extra: Record<string, unknown> = {}, gen = 5) => ({ ...(normalizeCaptionArgs({ id: "cinema", session, n, t0, t1: t0 + 1, text, ...extra }) as any).args, gen });
const END = (session = S1, gen = 5) => ({ ...(normalizeCaptionArgs({ id: "cinema", session, end: true }) as any).args, gen });
check("a client-supplied gen never survives the shape", (normalizeCaptionArgs({ id: "cinema", session: S1, n: 1, t0: 0, t1: 1, text: "x", gen: 99 }) as any).args.gen === undefined);
check("an empty screen refuses nothing but an end", captionRefusal(undefined, L(1, 0, "a")) === null && /no captions to end/.test(captionRefusal(undefined, END()) ?? ""));
let bag = foldCaption(undefined, L(1, 0, "a", S1, { title: "a film" }));
// shape audit 10-16 (render-media-env §11): the bag holds its current line, once (no window, no mediaTime: the log is the transcript)
check("the first line folds a bag: session, n, title, its line (no window, no mediaTime)", !!bag && bag.session === S1 && bag.n === 1 && bag.title === "a film" && bag.line?.text === "a" && bag.line?.t1 === 1 && !("window" in bag) && !("mediaTime" in bag), JSON.stringify(bag));
check("n at the high-water is a duplicate: refused", /duplicate or out of order/.test(captionRefusal(bag, L(1, 0, "a")) ?? ""));
check("...and told the n its session needs next", /next line needs n=2 or higher/.test(captionRefusal(bag, L(1, 0, "a")) ?? ""), captionRefusal(bag, L(1, 0, "a")) ?? "accepted");
check("n after it is taken", captionRefusal(bag, L(2, 1, "b")) === null);
bag = foldCaption(bag, L(2, 1, "b"));
check("…and holds the new line in place of the last, keeping the title and advancing n", !!bag && bag.line?.text === "b" && bag.title === "a film" && bag.n === 2 && !("window" in bag));
check("n below the high-water is old: refused", /n=1 is not after the folded high-water n=2/.test(captionRefusal(bag, L(1, 5, "late")) ?? ""), captionRefusal(bag, L(1, 5, "late")) ?? "accepted");
check("a LOWER generation is refused: a superseded leg, whatever its session says", /captioned by a newer leg \(generation 5; yours is 4\)/.test(captionRefusal(bag, L(9, 9, "z", S2, {}, 4)) ?? "") && /superseded/.test(captionRefusal(bag, L(9, 9, "z", S1, {}, 4)) ?? ""), captionRefusal(bag, L(9, 9, "z", S2, {}, 4)) ?? "accepted");
check("…and so is its end", /superseded/.test(captionRefusal(bag, END(S1, 4)) ?? ""));
check("…and a superseded leg is told how to take the screen back", /rejoin/.test(captionRefusal(bag, L(9, 9, "z", S1, {}, 4)) ?? ""), captionRefusal(bag, L(9, 9, "z", S1, {}, 4)) ?? "accepted");
check("the same leg under a DIFFERENT session is taken (a reattach: a new clock)", captionRefusal(bag, L(1, 0, "z", S2)) === null);
const bag2 = foldCaption(bag, L(1, 0, "z", S2));
check("…and starts a fresh window under the new session (title not carried: a new attach says its own)", !!bag2 && bag2.session === S2 && bag2.n === 1 && bag2.gen === 5 && bag2.line?.text === "z" && bag2.title === undefined, JSON.stringify(bag2));
check("a HIGHER generation continuing the same session is taken and the bag follows it (a reconnect)", captionRefusal(bag2, L(2, 1, "y", S2, {}, 7)) === null && foldCaption(bag2, L(2, 1, "y", S2, {}, 7))!.gen === 7 && foldCaption(bag2, L(2, 1, "y", S2, {}, 7))!.line.text === "y");
check("a higher generation with an EARLIER-looking session still takes over (clock rollback is not a claim the door reads)", captionRefusal(bag2, L(1, 0, "w", "2026-09-16T00:00:00.000Z-back", {}, 8)) === null && foldCaption(bag2, L(1, 0, "w", "2026-09-16T00:00:00.000Z-back", {}, 8))!.line.text === "w");
check("an end for the wrong session is refused", /captioned under session/.test(captionRefusal(bag2, END(S1)) ?? ""));
check("...and names the session that would end what the screen shows", (captionRefusal(bag2, END(S1)) ?? "").includes(`end session ${S2}`), captionRefusal(bag2, END(S1)) ?? "accepted");
check("an end for the right session is taken and clears the bag", captionRefusal(bag2, END(S2)) === null && foldCaption(bag2, END(S2)) === null);
let big = foldCaption(undefined, L(1, 0, "line 1"));
for (let i = 2; i <= CAPTIONS_MAX_LINES + 5; i++) big = foldCaption(big, L(i, i, `line ${i}`));
check("a value never grows with its session: the last line only, however many came before", !!big && big.line?.text === `line ${CAPTIONS_MAX_LINES + 5}` && big.n === CAPTIONS_MAX_LINES + 5 && JSON.stringify(big).length < 300, JSON.stringify(big));

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
