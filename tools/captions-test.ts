// The `caption` verb's meaning + text-tier perception, without a server.
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
//   1d. THE DEED — `born` is a creation generation (kept across a partial
//      re-light and a same-lib re-spawn, renewed when the id means a new
//      thing); the grant folds {id, born}; rightsIn carries it; `caption:
//      null` revokes; a grant that knows its sub follows a rename; the grant
//      fold is a subject-keyed migration (repeated renames → one record;
//      historical duplicates fail closed in rightsIn until a grant folds
//      them; a target name held by another sub fails closed; a sub-less
//      legacy record is adopted).
//   2. PERCEPTION — what look() carries for a resident who reads, folded from
//      `caption` entries through the agent's own fold: the line appears on the
//      owning entity, follows the newest caption, ignores a superseded leg,
//      and is gone after `end`; other component types still read as they did.
import { normalizeCaptions, describeCaptions, captionsDetail, clock, normalizeCaptionArgs, captionRefusal, foldCaption, mintSession, CAPTIONS_MAX_LINES, CAPTION_TEXT_MAX } from "../shared/captions.js";
import { rightsIn } from "../shared/rightsfold.js";
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const { WorldAgent } = await import("../mcpl/agent.ts");

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
check("a minted session has the shape the door accepts and sorts by time", (() => { const a = mintSession(new Date("2026-01-01T00:00:00Z")), b = mintSession(new Date("2026-01-01T00:00:01Z")); return normalizeCaptionArgs({ id: "c", session: a, n: 1, t0: 0, t1: 1, text: "x" }).ok && a < b; })());
// the server stamps `gen` AFTER the shape (vCaption); a client-supplied one never survives it
const L = (n: number, t0: number, text: string, session = S1, extra: Record<string, unknown> = {}, gen = 5) => ({ ...(normalizeCaptionArgs({ id: "cinema", session, n, t0, t1: t0 + 1, text, ...extra }) as any).args, gen });
const END = (session = S1, gen = 5) => ({ ...(normalizeCaptionArgs({ id: "cinema", session, end: true }) as any).args, gen });
check("a client-supplied gen never survives the shape", (normalizeCaptionArgs({ id: "cinema", session: S1, n: 1, t0: 0, t1: 1, text: "x", gen: 99 }) as any).args.gen === undefined);
check("an empty screen refuses nothing but an end", captionRefusal(undefined, L(1, 0, "a")) === null && /no captions to end/.test(captionRefusal(undefined, END()) ?? ""));
let bag = foldCaption(undefined, L(1, 0, "a", S1, { title: "a film" }));
check("the first line folds a bag: session, n, title, mediaTime, one-line window", !!bag && bag.session === S1 && bag.n === 1 && bag.title === "a film" && bag.mediaTime === 1 && bag.window.length === 1, JSON.stringify(bag));
check("n at the high-water is a duplicate: refused", /duplicate or out of order/.test(captionRefusal(bag, L(1, 0, "a")) ?? ""));
check("n after it is taken", captionRefusal(bag, L(2, 1, "b")) === null);
bag = foldCaption(bag, L(2, 1, "b"));
check("…and appends, keeping the title and advancing mediaTime and n", !!bag && bag.window.length === 2 && bag.title === "a film" && bag.mediaTime === 2 && bag.n === 2);
check("n below the high-water is old: refused", /n=1 is not after the folded high-water n=2/.test(captionRefusal(bag, L(1, 5, "late")) ?? ""), captionRefusal(bag, L(1, 5, "late")) ?? "accepted");
check("a LOWER generation is refused: a superseded leg, whatever its session says", /captioned by a newer leg \(generation 5; yours is 4\)/.test(captionRefusal(bag, L(9, 9, "z", S2, {}, 4)) ?? "") && /superseded/.test(captionRefusal(bag, L(9, 9, "z", S1, {}, 4)) ?? ""), captionRefusal(bag, L(9, 9, "z", S2, {}, 4)) ?? "accepted");
check("…and so is its end", /superseded/.test(captionRefusal(bag, END(S1, 4)) ?? ""));
check("the same leg under a DIFFERENT session is taken (a reattach: a new clock)", captionRefusal(bag, L(1, 0, "z", S2)) === null);
const bag2 = foldCaption(bag, L(1, 0, "z", S2));
check("…and starts a fresh window under the new session (title not carried: a new attach says its own)", !!bag2 && bag2.session === S2 && bag2.n === 1 && bag2.gen === 5 && bag2.window.length === 1 && bag2.window[0].text === "z" && bag2.title === undefined, JSON.stringify(bag2));
check("a HIGHER generation continuing the same session is taken and the bag follows it (a reconnect)", captionRefusal(bag2, L(2, 1, "y", S2, {}, 7)) === null && foldCaption(bag2, L(2, 1, "y", S2, {}, 7))!.gen === 7 && foldCaption(bag2, L(2, 1, "y", S2, {}, 7))!.window.length === 2);
check("a higher generation with an EARLIER-looking session still takes over (clock rollback is not a claim the door reads)", captionRefusal(bag2, L(1, 0, "w", "2026-09-16T00:00:00.000Z-back", {}, 8)) === null && foldCaption(bag2, L(1, 0, "w", "2026-09-16T00:00:00.000Z-back", {}, 8))!.window.length === 1);
check("an end for the wrong session is refused", /captioned under session/.test(captionRefusal(bag2, END(S1)) ?? ""));
check("an end for the right session is taken and clears the bag", captionRefusal(bag2, END(S2)) === null && foldCaption(bag2, END(S2)) === null);
let big = foldCaption(undefined, L(1, 0, "line 1"));
for (let i = 2; i <= CAPTIONS_MAX_LINES + 5; i++) big = foldCaption(big, L(i, i, `line ${i}`));
check(`the folded window is bounded: newest ${CAPTIONS_MAX_LINES}, oldest first`, !!big && big.window.length === CAPTIONS_MAX_LINES && big.window[0].text === "line 6" && big.n === CAPTIONS_MAX_LINES + 5, JSON.stringify(big?.window.map((w: any) => w.text)));

console.log("— 1d. the deed —");
const T0 = 1_754_000_000_000;
const rig = () => { const ag = new WorldAgent({ name: "reader" }); const A = ag as any; let seq = 0; const e = (verb: string, args: Record<string, unknown>, actor = "antra", live = false) => A.applyEntry({ verb, args, ts: T0 + seq, seq: ++seq, actor }, live); return { ag, A, e }; };
{
  const { A, e } = rig();
  e("spawn", { id: "cinema", lib: "screen.glb", pos: [0, 0, 0] });
  const born = A.st.entities.cinema.born;
  check("a spawn stamps born = its seq", born === 1, String(born));
  e("spawn", { id: "cinema", lib: "screen.glb", pos: [1, 0, 0] });
  check("a same-lib re-spawn is the same object: born kept", A.st.entities.cinema.born === born, String(A.st.entities.cinema.born));
  e("spawn", { id: "cinema", lib: "other.glb", pos: [1, 0, 0] });
  check("a different lib under the same id is a NEW object: born renewed", A.st.entities.cinema.born === 3, String(A.st.entities.cinema.born));
  e("light", { id: "lamp", pos: [1, 1, 1], intensity: 10 });
  e("light", { id: "lamp", intensity: 40 });
  check("a partial re-light keeps the lamp's born", A.st.entities.lamp.born === 4, String(A.st.entities.lamp.born));
  e("remove", { id: "lamp" }); e("light", { id: "lamp", pos: [1, 1, 1] });
  check("a light after a remove is new: born renewed", A.st.entities.lamp.born === 7, String(A.st.entities.lamp.born));
  e("grant", { id: "antra", role: "owner" });
  e("grant", { id: "cap", role: "visitor", caption: { id: "cinema", born: 3 } });
  const r = rightsIn(A.st, "cap");
  check("the grant folds the deed and rightsIn carries it", r.role === "visitor" && r.caption?.id === "cinema" && r.caption?.born === 3, JSON.stringify(r));
  e("grant", { id: "cap", gen: true });
  check("a later grant touching other fields keeps the deed", rightsIn(A.st, "cap").caption?.id === "cinema");
  e("grant", { id: "cap", caption: null });
  check("caption: null revokes it", rightsIn(A.st, "cap").caption === undefined, JSON.stringify(rightsIn(A.st, "cap")));
  check("nobody else has one", rightsIn(A.st, "antra").caption === undefined && rightsIn(A.st, "stranger").caption === undefined);
  // a grant written while the subject's sub was known follows the SUB, not the name
  e("grant", { id: "cap", role: "visitor", caption: { id: "cinema", born: 3 }, sub: "human:discord:77" });
  check("the deed follows the durable sub across a rename (rightsIn finds the name-keyed grant by sub)", rightsIn(A.st, "cap-renamed", "human:discord:77").caption?.id === "cinema" && rightsIn(A.st, "cap-renamed", "human:discord:77").role === "visitor", JSON.stringify(rightsIn(A.st, "cap-renamed", "human:discord:77")));
  check("…and an impostor wearing the old name with another sub gets the wildcard, not the deed", rightsIn(A.st, "cap", "human:discord:78").caption === undefined && rightsIn(A.st, "cap", "human:discord:78").role === "builder", JSON.stringify(rightsIn(A.st, "cap", "human:discord:78")));
  check("…and gen/fly ride the same repair", (() => { e("grant", { id: "fly", role: "builder", fly: true, sub: "human:discord:79" }); return rightsIn(A.st, "fly-renamed", "human:discord:79").fly === true; })());
  // a subject has ONE record: a grant under the new name continues the old
  // record and retires it, so a lookup by sub never meets two answers
  e("spawn", { id: "kiosk", lib: "kiosk.glb", pos: [3, 0, 0] });
  e("grant", { id: "cap-renamed", caption: { id: "kiosk", born: A.st.entities.kiosk.born }, sub: "human:discord:77" });
  check("a regrant under the new name moves the subject's record: the old name-keyed record is gone", A.st.roles["cap"] === undefined && A.st.roles["cap-renamed"]?.sub === "human:discord:77" && A.st.roles["cap-renamed"]?.role === "visitor", JSON.stringify(A.st.roles));
  check("…and the new deed is the one answered, under either name", rightsIn(A.st, "cap-renamed", "human:discord:77").caption?.id === "kiosk" && rightsIn(A.st, "cap", "human:discord:77").caption?.id === "kiosk" && rightsIn(A.st, "cap-renamed", "human:discord:77").role === "visitor", JSON.stringify(rightsIn(A.st, "cap", "human:discord:77")));
  e("grant", { id: "cap-renamed", caption: null, sub: "human:discord:77" });
  check("…and a revoke under the new name revokes for the subject", rightsIn(A.st, "cap-renamed", "human:discord:77").caption === undefined && Object.values(A.st.roles).filter((r: any) => r.sub === "human:discord:77").length === 1);
  // repeated renames: every grant migrates, so the subject never holds more than one record
  e("grant", { id: "cap-three", role: "visitor", caption: { id: "kiosk", born: A.st.entities.kiosk.born }, sub: "human:discord:77" });
  e("grant", { id: "cap-four", fly: true, sub: "human:discord:77" });
  check("repeated renames with grants leave exactly one record, under the latest name, carrying everything granted along the way", Object.keys(A.st.roles).filter((k) => A.st.roles[k].sub === "human:discord:77").join() === "cap-four" && rightsIn(A.st, "cap-four", "human:discord:77").caption?.id === "kiosk" && rightsIn(A.st, "cap-four", "human:discord:77").fly === true && rightsIn(A.st, "cap-four", "human:discord:77").role === "visitor", JSON.stringify(A.st.roles));
  // HISTORICAL DUPLICATES: a world written before the migration can hold two
  // name-keyed records for one sub — rightsIn fails closed until a grant folds them
  A.st.roles["old-a"] = { role: "visitor", fly: true, sub: "human:discord:88" };
  A.st.roles["old-b"] = { role: "builder", gen: true, sub: "human:discord:88" };
  const amb = rightsIn(A.st, "old-b", "human:discord:88");
  check("two historical records for one sub: rightsIn FAILS CLOSED to the wildcard default (no fly, no gen, no deed) rather than picking one", amb.role === "builder" && amb.fly === false && amb.gen === false && amb.caption === undefined, JSON.stringify(amb));
  e("grant", { id: "old-c", role: "visitor", caption: { id: "kiosk", born: A.st.entities.kiosk.born }, sub: "human:discord:88" });
  check("…the next grant migrates: ALL stale records removed, exactly one written, from the default (ambiguous history is not merged)", Object.keys(A.st.roles).filter((k) => A.st.roles[k].sub === "human:discord:88").join() === "old-c" && A.st.roles["old-c"].fly === undefined && A.st.roles["old-c"].gen === undefined && rightsIn(A.st, "old-c", "human:discord:88").caption?.id === "kiosk", JSON.stringify(A.st.roles["old-c"]));
  // COLLISION: the target name already carries ANOTHER subject's record
  e("grant", { id: "taken", role: "owner", gen: true, sub: "human:discord:99" });
  const beforeT = JSON.stringify(A.st.roles["taken"]);
  e("grant", { id: "taken", role: "visitor", caption: { id: "kiosk", born: A.st.entities.kiosk.born }, sub: "human:discord:88" });
  check("a grant onto a name held by another subject FAILS CLOSED: the occupant's record is untouched…", JSON.stringify(A.st.roles["taken"]) === beforeT && rightsIn(A.st, "taken", "human:discord:99").role === "owner", JSON.stringify(A.st.roles["taken"]));
  check("…and the subject's own record is exactly as it was — found under either name, with nothing of the occupant's (no owner, no gen)", Object.keys(A.st.roles).filter((k) => A.st.roles[k].sub === "human:discord:88").join() === "old-c" && JSON.stringify(rightsIn(A.st, "taken", "human:discord:88")) === JSON.stringify(rightsIn(A.st, "old-c", "human:discord:88")) && rightsIn(A.st, "taken", "human:discord:88").role === "visitor" && rightsIn(A.st, "taken", "human:discord:88").gen === false && rightsIn(A.st, "taken", "human:discord:88").caption?.id === "kiosk", JSON.stringify(rightsIn(A.st, "taken", "human:discord:88")));
  // a legacy name record WITHOUT a sub is adopted by the subject's grant (it was theirs, self-asserted)
  A.st.roles["legacy"] = { role: "builder", fly: true };
  e("grant", { id: "legacy", caption: { id: "kiosk", born: A.st.entities.kiosk.born }, sub: "human:discord:66" });
  check("a sub-less legacy record under the target name is adopted, not refused: it gains the sub and keeps what it had", A.st.roles["legacy"].sub === "human:discord:66" && A.st.roles["legacy"].fly === true && rightsIn(A.st, "legacy", "human:discord:66").caption?.id === "kiosk", JSON.stringify(A.st.roles["legacy"]));
}

console.log("— 2. perception —");
{
  const { ag, A, e } = rig();
  e("spawn", { id: "cinema", lib: "screen.glb", pos: [0, 0, 0] });
  e("caption", { id: "cinema", session: S1, n: 1, t0: 752.1, t1: 755.8, text: "we light the first candle", title: "Solstice, main stage", gen: 5 }, "captioner", true);
  e("caption", { id: "cinema", session: S1, n: 2, t0: 756.0, t1: 759.9, text: "for the year that was", speaker: "Ra", gen: 5 }, "captioner", true);
  let out = ag.look();
  check("look() carries the captions line on the owning entity, folded from caption entries", /\[cinema\][^\n]*a screen, showing Solstice, main stage, 12:39, last line: Ra: for the year that was/.test(out), out.split("\n").find((l: string) => l.includes("cinema")) ?? out);
  check("…and does not fall through to `components: captions`", !/components: captions/.test(out));
  e("caption", { id: "cinema", session: S1, n: 3, t0: 760, t1: 763, text: "and the year to come", speaker: "Ra", gen: 5 }, "captioner", true);
  out = ag.look();
  check("the newest line reads as the last line, not the old", /last line: Ra: and the year to come/.test(out) && !/last line: Ra: for the year/.test(out), out.split("\n").find((l: string) => l.includes("cinema")) ?? out);
  e("caption", { id: "cinema", session: S1, n: 3, t0: 770, t1: 771, text: "a replayed duplicate", speaker: "Ra", gen: 5 }, "captioner", true);
  e("caption", { id: "cinema", session: "2026-09-16T19:00:00.000Z-old0", n: 1, t0: 0, t1: 1, text: "a superseded leg", speaker: "Ra", gen: 1 }, "captioner", true);
  check("a duplicate n and a lower-generation leg fold to nothing (the fold is total; the door never lets them in)", /last line: Ra: and the year to come/.test(ag.look()));
  e("comp", { id: "cinema", type: "captions", data: "junk" }, "bob", true);
  check("a hand-written captions comp changes nothing here either", /last line: Ra: and the year to come/.test(ag.look()));
  e("caption", { id: "cinema", session: S1, end: true, gen: 5 }, "captioner", true);
  check("a quiet screen is gone from look()", !/a screen/.test(ag.look()));
  e("comp", { id: "cinema", type: "recipe", data: { x: 1 } }, "antra", true);
  check("other component types still read as they did", /components: recipe/.test(ag.look()));
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
