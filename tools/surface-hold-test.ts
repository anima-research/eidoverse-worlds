// surface-hold-test.ts — B3 (#57 review): the client half's founding receipt.
// surface-test.py exercises the server's matrix over an external door; NOTHING
// in-tree executed the browser's hold-then-fallback path. This does, headless,
// through the real client/lib/world.js with only its heavy deps stubbed
// (tools/world-hold-stub.mjs — a REAL bus, because the whole contract is bus
// traffic). The six pinned behaviors are Antra's list, verbatim.
//
//   bun tools/surface-hold-test.ts
//
// Recut (#57 B1 re-review): the hold path lives in the live-cause dispatcher
// (client/lib/realize/causes.js) now, not world.js — the applyEntry switch is
// gone (TEL0S_NOTES §11). Same six pinned behaviors, same real bus, driven
// through handleLiveCause exactly as net.js's 'live-entry' does.
import { plugin } from "bun";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("./world-hold-stub.mjs", import.meta.url));
plugin({
  name: "world-hold-stub",
  setup(build) {
    // causes.js imports ../core.js and ../chat.js (from realize/) and
    // ./models.js (PORTED only) — all stubbed; the bus must be REAL.
    for (const f of ["^\\.\\./core\\.js$", "^\\.\\./chat\\.js$", "^\\./models\\.js$"]) {
      build.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});

const stub = await import("./world-hold-stub.mjs");
const causes = await import("../client/lib/realize/causes.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  [" + extra + "]"}`);
  ok ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOLD_MS = 2500;                      // world.js's performance window
const spoken: any[] = [];
stub.bus.on("speech", (s: any) => spoken.push(s));
let seq = 100;
const say = (actor: string, text: string, extra: Record<string, unknown> = {}) =>
  causes.handleLiveCause({ verb: "say", actor, args: { text, ...extra }, seq: ++seq, ts: Date.now() });

// ── 1. first voice join enables hold ────────────────────────────────────────
{
  spoken.length = 0;
  await say("norrin", "before any voice leg");
  check("an actor with NO voice leg speaks immediately", spoken.length === 1 && spoken[0].text === "before any voice leg",
    JSON.stringify(spoken));
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: 7, retired: null });
  spoken.length = 0;
  await say("norrin", "after the voice leg joined");
  await sleep(150);
  check("first voice join enables hold: the say does NOT speak locally at once", spoken.length === 0,
    JSON.stringify(spoken));
  check("…but the caption is logged during the hold (text is never delayed)",
    stub.chatLog.some((c: any) => c.text === "after the voice leg joined"), `${stub.chatLog.length} chat rows`);
  // don't let this pending say leak into later vectors
  stub.bus.emit("performed", { actor: "norrin", seq, gen: 7 });
}

// ── 2. a matching performed receipt cancels exactly THAT say's fallback ─────
{
  spoken.length = 0;
  await say("norrin", "receipted line");
  const receipted = seq;
  await say("norrin", "unreceipted line");
  stub.bus.emit("performed", { actor: "norrin", seq: receipted, gen: 7 });
  await sleep(HOLD_MS + 400);
  // (the receipt's display-only re-emit carries performed:true — §8; a
  // FALLBACK is a speech event without it)
  check("receipted say never falls back to local speech", !spoken.some((s) => s.text === "receipted line" && !s.performed),
    JSON.stringify(spoken));
  check("the OTHER pending say still falls back (receipt cancelled exactly one)",
    spoken.filter((s) => s.text === "unreceipted line").length === 1, JSON.stringify(spoken));
}

// ── 2b. a receipt cancels on the right author and a NON-stale generation (B2):
//        wrong actor → no cancel (falls back); predecessor gen → no cancel
//        (a retired leg's late frame); successor gen → DOES cancel (a takeover
//        leg legitimately performed the inherited say). gen is matched `>=`. ──
{
  // hold three says while gen 7 is live, then fire receipts that differ on one
  // composite member each.
  spoken.length = 0;
  await say("norrin", "wrong-actor receipt");
  const sWrongActor = seq;
  await say("norrin", "predecessor-gen receipt");
  const sPredGen = seq;
  await say("norrin", "successor-gen receipt");
  const sSuccGen = seq;
  stub.bus.emit("performed", { actor: "zarniwoop", seq: sWrongActor, gen: 7 }); // wrong actor → ignore
  stub.bus.emit("performed", { actor: "norrin", seq: sPredGen, gen: 6 });       // predecessor (stale) → ignore
  stub.bus.emit("performed", { actor: "norrin", seq: sSuccGen, gen: 9 });       // successor (takeover) → CANCEL
  await sleep(HOLD_MS + 400);
  check("wrong-actor receipt does not cancel the hold (falls back)",
    spoken.filter((s) => s.text === "wrong-actor receipt").length === 1, JSON.stringify(spoken));
  check("predecessor-generation receipt does not cancel the hold (falls back — stale leg)",
    spoken.filter((s) => s.text === "predecessor-gen receipt").length === 1, JSON.stringify(spoken));
  check("successor-generation receipt DOES cancel the hold (a takeover leg performed it — no double-speak)",
    spoken.filter((s) => s.text === "successor-gen receipt" && !s.performed).length === 0, JSON.stringify(spoken));
}

// ── 3. no receipt → falls back exactly once ─────────────────────────────────
{
  spoken.length = 0;
  await say("norrin", "the leg went deaf");
  await sleep(HOLD_MS + 400);
  check("no receipt: exactly one fallback speech, not zero, not a repeat",
    spoken.filter((s) => s.text === "the leg went deaf").length === 1, JSON.stringify(spoken));
}

// ── 4. aux death removes capability immediately: later says do not wait ─────
{
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: null, retired: 7 });
  spoken.length = 0;
  await say("norrin", "after the leg died");
  check("after aux death, a say speaks IMMEDIATELY (no 2.5s wait against a gone leg)",
    spoken.length === 1 && spoken[0].text === "after the leg died", JSON.stringify(spoken));
}

// ── 5. a stale retirement cannot remove a successor generation ──────────────
{
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: 9, retired: 7 });   // successor
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: null, retired: 7 }); // STALE death of gen 7
  spoken.length = 0;
  await say("norrin", "successor should still hold");
  await sleep(150);
  check("stale retirement (old gen) does not strip the successor: the say still holds",
    spoken.length === 0, JSON.stringify(spoken));
  stub.bus.emit("performed", { actor: "norrin", seq, gen: 9 });
}

// ── 6. transition/takeover works without reload ─────────────────────────────
{
  // takeover: gen 9 → gen 12, one event, same session, no snapshot re-seed
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: 12, retired: 9 });
  spoken.length = 0;
  await say("norrin", "spoken through the successor");
  await sleep(150);
  check("takeover (new gen via transition alone) keeps hold working — no reload needed",
    spoken.length === 0, JSON.stringify(spoken));
  stub.bus.emit("performed", { actor: "norrin", seq, gen: 12 });
  // and the true death of the CURRENT gen releases it
  stub.bus.emit("surface-transition", { actor: "norrin", surface: "voice", gen: null, retired: 12 });
  spoken.length = 0;
  await say("norrin", "released after real death");
  check("real death of the current gen releases the hold immediately",
    spoken.length === 1, JSON.stringify(spoken));
}

// ── snapshot seeding (the other entry point for capability) ─────────────────
{
  stub.bus.emit("surfaces", [{ id: "zora", surfaces: [{ surface: "voice", gen: 3 }] }]);
  spoken.length = 0;
  await say("zora", "seeded from snapshot");
  await sleep(150);
  check("snapshot-seeded capability holds exactly like transition-built capability",
    spoken.length === 0, JSON.stringify(spoken));
  stub.bus.emit("performed", { actor: "zora", seq, gen: 3 });
  stub.bus.emit("surfaces", []);   // re-seed with no legs (e.g. reconnect snapshot)
  spoken.length = 0;
  await say("zora", "after empty re-seed");
  check("an empty surfaces re-seed clears capability (reconnect truth wins)",
    spoken.length === 1, JSON.stringify(spoken));
}

// ── 7. B2 (re-review): `spoken` is DISPLAY metadata, never performance truth.
//    #100's typed say door exposes {spoken,utt,t0} as author-controlled fields,
//    so an agent can send spoken:true — and before this recut that skipped the
//    receipt path entirely: a live leg that never attested left SILENCE, the
//    exact presence-derived hole #57 exists to remove. Three vectors, per the
//    review: no leg / live leg + no receipt / live leg + matching receipt.
{
  // (a) spoken:true with NO voice leg → speaks immediately (the flag alone
  //     must not suppress local speech)
  spoken.length = 0;
  await say("miri", "spoken flag, no leg", { spoken: true, utt: 1, t0: Date.now() });
  check("spoken:true with no voice leg speaks IMMEDIATELY (flag is not capability)",
    spoken.length === 1 && spoken[0].text === "spoken flag, no leg", JSON.stringify(spoken));

  // (b) spoken:true with a live leg and NO receipt → holds, then falls back
  stub.bus.emit("surface-transition", { actor: "miri", surface: "voice", gen: 21, retired: null });
  spoken.length = 0;
  await say("miri", "spoken flag, leg deaf", { spoken: true, utt: 2, t0: Date.now() });
  await sleep(150);
  check("spoken:true with a live leg still HOLDS (claim is not a receipt)",
    spoken.length === 0, JSON.stringify(spoken));
  await sleep(HOLD_MS + 400);
  check("…and with no receipt it falls back exactly once (no claim-derived silence)",
    spoken.filter((s) => s.text === "spoken flag, leg deaf").length === 1, JSON.stringify(spoken));

  // (c) spoken:true with a live leg and a MATCHING receipt → skip (performed)
  spoken.length = 0;
  await say("miri", "spoken flag, receipted", { spoken: true, utt: 3, t0: Date.now() });
  stub.bus.emit("performed", { actor: "miri", seq, gen: 21 });
  await sleep(HOLD_MS + 400);
  check("spoken:true with a matching receipt never speaks locally (the leg performed it)",
    spoken.filter((s) => s.text === "spoken flag, receipted").length === 0, JSON.stringify(spoken));
  stub.bus.emit("surface-transition", { actor: "miri", surface: "voice", gen: null, retired: 21 });
}

// ── 8. receipt SUCCESS still performs visually (review finding 9) ───────────
//    A cancel-only receipt made the system look broken exactly when it worked:
//    fallback drew bubble+mouth, success drew nothing. A matching receipt
//    re-emits 'speech' with performed:true — display consumers draw, TTS
//    consumers skip. Not for spoken:true says: that field owns display/caption
//    continuation, so a caption-paced bubble is never drawn twice.
{
  stub.bus.emit("surface-transition", { actor: "vex", surface: "voice", gen: 31, retired: null });
  spoken.length = 0;
  await say("vex", "performed and visible");
  stub.bus.emit("performed", { actor: "vex", seq, gen: 31 });
  await sleep(150);
  const disp = spoken.filter((s) => s.text === "performed and visible");
  check("receipt re-emits a display-only speech (performed: true)",
    disp.length === 1 && disp[0].performed === true, JSON.stringify(spoken));
  await sleep(HOLD_MS + 400);
  check("…exactly once — the cancelled fallback never fires on top",
    spoken.filter((s) => s.text === "performed and visible").length === 1, JSON.stringify(spoken));

  spoken.length = 0;
  await say("vex", "caption-paced line", { spoken: true, utt: 9, t0: Date.now() });
  stub.bus.emit("performed", { actor: "vex", seq, gen: 31 });
  await sleep(150);
  check("spoken:true + receipt draws NO display re-emit (captions own that plane)",
    spoken.length === 0, JSON.stringify(spoken));
  stub.bus.emit("surface-transition", { actor: "vex", surface: "voice", gen: null, retired: 31 });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
