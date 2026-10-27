// The `sound` component's meaning + text-tier perception, without a browser.
//
//   bun tools/sound-test.ts
//
// Two legs, the picture-test shape:
//   1. DECLARATION — the source allow-list (library-relative audio under
//      eidoverse/assets/ or store/audio/, never a URL, never a path escape),
//      defaults and bounds, the clock note, the description and its bound, and
//      a `describe` that says what the author said and whether it plays.
//   2. PERCEPTION — what look() carries for a resident who reads.
import { normalizeSound, describeSound, allowedSoundSrc, SOUND_DESCRIPTION_MAX, SOUND_DEFAULTS } from "../shared/sound.js";
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const { WorldAgent } = await import("../mcpl/agent.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

console.log("— 1. declaration —");
const GOOD = "eidoverse/assets/audio/rain_on_the_awning.mp3";
const STORE = "store/audio/0123456789abcdef.ogg";
for (const [src, expect] of [
  [GOOD, true], [STORE, true], ["eidoverse/assets/x/y.wav", true], ["store/audio/a.webm", true], ["store/audio/a.m4a", true], ["store/audio/a.opus", true],
  ["https://example.com/x.mp3", false], ["data:audio/mpeg;base64,AAAA", false], ["/eidoverse/assets/x.mp3", false],
  ["eidoverse/assets/../secret.mp3", false], ["eidoverse/assets/x.png", false], ["eidoverse/assets/x.glb", false],
  ["store/x.mp3", false], ["store/images/x.mp3", false], ["store/audio/../x.mp3", false], ["store/audiox/y.mp3", false],
  ["eidoverse/assets/x%2e.mp3", false], ["eidoverse/assets/x y.mp3", false], ["eidoverse/assets/x.mp3?x=1", false],
  ["eidoverse/assets/x\u0000.mp3", false], ["eidoverse/assets/x\t.mp3", false], ["", false], [null, false],
] as [unknown, boolean][]) check(`allowedSoundSrc(${JSON.stringify(src)}) === ${expect}`, allowedSoundSrc(src) === expect);

const n0 = normalizeSound({ src: GOOD, description: "rain on the awning, a field recording", t0: 1_754_000_000_000 });
check("a well-formed bag normalizes with defaults", n0.ok && n0.sound.playing === true && n0.sound.loop === true && n0.sound.volume === SOUND_DEFAULTS.volume && n0.sound.radius === SOUND_DEFAULTS.radius && n0.sound.t0 === 1_754_000_000_000, JSON.stringify(n0));
check("…with no notes", n0.ok && n0.notes.length === 0, JSON.stringify(n0.ok && n0.notes));
const n1 = normalizeSound({ src: GOOD, playing: false, loop: false, volume: 7, radius: 0.1, description: "x" });
check("explicit playing/loop false stick; volume and radius are clamped", n1.ok && n1.sound.playing === false && n1.sound.loop === false && n1.sound.volume === 1 && n1.sound.radius === 1, JSON.stringify(n1));
const nT = normalizeSound({ src: GOOD, description: "x" });
check("playing without t0 is allowed but noted (listeners drift)", nT.ok && nT.sound.t0 === undefined && nT.notes.some((x) => /no t0/.test(x)), JSON.stringify(nT.notes));
const nBad = normalizeSound({ src: GOOD, description: "x", t0: "yesterday" });
check("a non-numeric t0 is dropped with a note", nBad.ok && nBad.sound.t0 === undefined && nBad.notes.some((x) => /t0 is not/.test(x)));
const nUrl = normalizeSound({ src: "https://x/y.mp3", description: "x" });
// batch 2 (R 10-07): an https link is a source; who fetches it is its tier (shared/mediasrc.js). http and local hosts are refused
check("an https link is taken with its tier; http and a bare host are refused, legibly", nUrl.ok === false && /address or a local name/.test(nUrl.why) && normalizeSound({ src: "https://radio.example.org/y.mp3" }).tier?.tier === "link" && !normalizeSound({ src: "http://radio.example.org/y.mp3" }).ok);
const nLook = normalizeSound({ src: GOOD, description: "  many   spaces and " + "x".repeat(300) });
check("description is whitespace-collapsed and clipped with a note", nLook.ok && nLook.sound.description.length === SOUND_DESCRIPTION_MAX && nLook.sound.description.startsWith("many spaces and ") && nLook.notes.some((x) => /clipped/.test(x)));
const nNo = normalizeSound({ src: GOOD, t0: 1 });
check("no description is allowed but noted", nNo.ok && !nNo.sound.description && nNo.notes.some((x) => /no description/.test(x)));
const nUnk = normalizeSound({ src: GOOD, description: "x", t0: 1, speed: 2, _mine: 1 });
check("unknown keys are noted, not fatal; _keys ignored silently", nUnk.ok && nUnk.notes.some((x) => /ignored by the evaluator: speed/.test(x) && !/_mine/.test(x)));
check("malformed bags are refused", !normalizeSound(null).ok && !normalizeSound([]).ok && !normalizeSound("x").ok);
check("describe: playing, by the author's line", describeSound({ src: GOOD, description: "rain on the awning" }) === "a sound, playing (loops; heard within 12 m): «rain on the awning»");
check("describe: paused", describeSound({ src: GOOD, description: "rain on the awning", playing: false }) === "a sound, paused: «rain on the awning»");
check("describe: without a description, the file name", describeSound({ src: GOOD }) === "a sound, playing (loops; heard within 12 m) (rain_on_the_awning.mp3)");
check("describe: an invalid source says it is not heard", /not heard: invalid declaration/.test(describeSound({ src: "http://x/y.mp3", description: "x" })));
check("describe: malformed", describeSound(null) === "a sound (malformed declaration)");
check("describe never claims anything about the audio (no 'loud', 'hz', 'waveform')", !/loud|hz|waveform|db/i.test(describeSound({ src: GOOD, description: "x" })));

console.log("— 2. perception —");
const T0 = 1_754_000_000_000;
// the agent's path: a scratch door, its cut adopted, and the next view taken after every write (tools/agent-scratch.ts)
const { agentOnDoor } = await import("./agent-scratch.ts");
const ag = new WorldAgent({ name: "reader" });
const { seed, act } = agentOnDoor(ag, "sound");
await seed({ radio1: { model: "store/8efae885a443a323.glb", pos: [1, 0, 1] } });
const r1 = await act("set", { id: "radio1", component: "sound", value: { src: GOOD, description: "rain on the awning", t0: T0 } }, { who: "ra" });
let out = ag.look();
check("the door takes a well-formed sound", r1.ok, JSON.stringify(r1.refused));
check("look() names the sound on the owning entity, playing, by the author's line", /\[radio1\][^\n]*a sound, playing \(loops; heard within 12 m\): «rain on the awning»/.test(out), out.split("\n").find((l) => l.includes("radio1")) ?? out);
check("…and does not fall through to `components: sound`", !/components: sound/.test(out));
await act("set", { id: "radio1", component: "sound", value: { src: GOOD, description: "rain on the awning", playing: false } }, { who: "ra" });
out = ag.look();
check("pausing reads as paused", /a sound, paused: «rain on the awning»/.test(out));
const bad = await act("set", { id: "radio1", component: "sound", value: { src: "http://x.example.org/y.mp3", description: "smuggled" } }, { who: "ra" });
out = ag.look();
check("an invalid source is refused at the door now (batch 2: the door judges sound sources), nothing changes", !bad.ok && bad.refused?.code === "shape" && !/smuggled/.test(out), JSON.stringify([bad.refused, out.split("\n").find((l) => l.includes("radio1"))]));
await act("delete", { id: "radio1", component: "sound" }, { who: "ra" });
check("a silenced sound is gone from look()", !/a sound/.test(ag.look()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
