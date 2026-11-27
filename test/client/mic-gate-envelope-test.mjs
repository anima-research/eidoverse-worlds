// micgate.js's gain envelope on an AudioParam that keeps time. mic-room-hears-test.mjs's stub applies every automation
// at once and its cancel is a log entry, so it can check what was asked of the gain, not what the gain then does. Here
// the param is a model of the Web Audio one (setValueAtTime, linearRampToValueAtTime, setTargetAtTime,
// cancelScheduledValues, the value setter as a set at currentTime), read at any time on a clock the test holds, and the
// wall clock (performance.now) is held beside it, so a press, a release and a mute land exactly where a row says.
//
// Real: micgate.js, base.js. Stubbed: audioctx.js (the context below) and the two clocks.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/mic-gate-envelope-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { fileURLToPath } from "node:url";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));

let W = 5000;       // the wall clock, ms
let A = 10;         // the audio clock, s
const realPerf = performance.now.bind(performance);
performance.now = () => W;

class Param {
  constructor() { this.ev = []; this.refuse = null; }
  _add(e) { let i = this.ev.length; while (i > 0 && this.ev[i - 1].t > e.t) i--; this.ev.splice(i, 0, e); }
  _may(k) { if (this.refuse === k) { this.refuse = null; throw new Error(`${k} refused`); } }
  setValueAtTime(v, t) { this._may('set'); this._add({ k: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { this._may('ramp'); this._add({ k: 'ramp', v, t }); }
  setTargetAtTime(v, t, tau) { this._may('target'); this._add({ k: 'target', v, t, tau }); }
  cancelScheduledValues(t) { this._may('cancel'); this.ev = this.ev.filter((e) => e.t < t); }
  at(T) {
    let cur = () => 0, prevT = 0, prevV = 0;
    for (const e of this.ev) {
      if (e.t > T) return e.k === 'ramp' ? prevV + (e.v - prevV) * Math.max(0, (T - prevT) / (e.t - prevT)) : cur(T);
      if (e.k === 'target') { const from = cur(e.t); prevT = e.t; prevV = from; cur = (t) => e.v + (from - e.v) * Math.exp(-(t - e.t) / e.tau); }
      else { prevT = e.t; prevV = e.v; cur = () => e.v; }
    }
    return cur(T);
  }
  get value() { return this.at(A); }
  set value(v) { this._add({ k: 'set', v, t: A }); }
}
const node = () => ({ connect() {}, disconnect() {} });
const track = () => ({ kind: 'audio', enabled: true, readyState: 'live', stop() {} });
const streamOf = () => { const t = track(); return { getTracks: () => [t], getAudioTracks: () => [t] }; };
let gain = null, listeners = [];
// `delay`: has createDelay (the lookahead); `dest`: has createMediaStreamDestination (without it no gate can be built)
const makeCtx = ({ delay = true, dest = true, state = 'running' } = {}) => ({
  get currentTime() { return A; }, sampleRate: 48000, state, destination: node(),
  addEventListener(type, fn) { if (type === 'statechange') listeners.push(fn); },
  createMediaStreamSource: () => node(),
  createGain: () => { gain = new Param(); return { ...node(), gain }; },
  ...(delay ? { createDelay: () => ({ ...node(), delayTime: { value: 0 } }) } : {}),
  ...(dest ? { createMediaStreamDestination: () => ({ ...node(), stream: streamOf() }) } : {}),
});
let ctx = makeCtx();
mock.module(lib('audio/audioctx.js'), () => ({ audioContext: () => ctx }));
const mg = await import(lib('audio/micgate.js'));
const { check, done } = suite("mic-gate-envelope");

// time passes on both clocks, or on the wall clock alone (a suspended or stalled context)
const adv = (ms, { audio = true } = {}) => { W += ms; if (audio) A += ms / 1000; };
const fresh = (opts) => { ctx = makeCtx(opts); listeners = []; adv(2000); return mg.gateStream(streamOf(), () => 0); };
const press = () => mg.driveGate(true);
const release = () => mg.driveGate(false, { cut: true, tail: true });   // the key up: a cut one lookahead later
const mute = () => mg.driveGate(false, { cut: true });                    // stop now
const close = () => mg.driveGate(false);                                  // voice activation's own close: the fade
const g = () => gain.at(A);
const f = (x) => (typeof x === 'number' ? x.toFixed(4) : String(x));
// the largest gain over the next `ms` of audio, sampled each 0.25 ms (the clocks are left where they were)
const peak = (ms) => { let m = 0; for (let t = 0; t <= ms; t += 0.25) m = Math.max(m, gain.at(A + t / 1000)); return m; };

// ── 0. the model reads as a real param does: the release everyone already agrees on ──────────────────────────────────
fresh();
check('setup: a new gate starts shut and has a lookahead', g() === 0 && mg.gateLookahead() === true, `${f(g())} ${mg.gateLookahead()}`);
press(); adv(100);
check('held 100 ms: the gain is open', g() > 0.999, f(g()));
release();
check('a release: the tail is going out, 55 ms of it', mg.gateSending() === true && Math.abs(mg.gateTailLeft() - 55) < 1e-6, `${mg.gateSending()} ${mg.gateTailLeft()}`);
adv(49);
check('...49 ms on, the gain is still open (the end of the word)', g() > 0.999 && mg.gateSending() === true, f(g()));
adv(6.01);
check('...and shut 55 ms after the release, with the tail over', g() === 0 && mg.gateSending() === false && mg.gateTailLeft() === 0, `${f(g())} ${mg.gateSending()}`);

// ── 1. finding 2: a quick tap, then a re-press or a mute inside the tail: the gain is where it really is ────────────
fresh(); press(); adv(1); release(); adv(3);
{ const before = g();
  press();
  check('a release 1 ms into the attack, a re-press 3 ms later: the gain carries on from where it is (about 0.39), with no jump up',
    before > 0.3 && before < 0.5 && Math.abs(g() - before) < 0.02, `before=${f(before)} after=${f(g())}`); }
fresh(); press(); adv(1); release(); adv(3);
{ const before = g();
  mute();
  check('...and a mute there cuts from that level: nothing louder goes out in its 5 ms', peak(5) <= before + 0.02, `before=${f(before)} peak=${f(peak(5))}`);
  adv(5.01);
  check('...and it is shut 5 ms later', g() === 0, f(g())); }

// ── 2. a press and a release inside one render quantum (one currentTime): the attack survives the cut's cancel ─────
fresh(); press(); W += 1; release();   // 1 ms apart on the wall clock, the same audio time
adv(25);
check('a press and a release in one render quantum: the attack still runs through the tail (open 25 ms on, not held shut)', g() > 0.9, f(g()));
adv(24.9);
{ const justBefore = g(); adv(0.2);
  check('...and where the cut starts the gain does not jump', Math.abs(g() - justBefore) < 0.1, `before=${f(justBefore)} at the cut=${f(g())}`); }

// ── 3. finding 7: a plain close inside the tail (push-to-talk turned off) leaves the cut a cut ───────────────────────
fresh(); press(); adv(100); release(); adv(10);
close();
adv(46);
check('push-to-talk turned off 10 ms into the tail: still shut 55 ms after the release (not an 830 ms fade)',
  g() === 0 && mg.gateSending() === false, `gain=${f(g())} sending=${mg.gateSending()}`);
adv(20); close(); press(); adv(100);
check('...and the gate opens again afterwards', g() > 0.999, f(g()));

// ── 4. finding 3: a suspend and a resume told together, late: both read 'running' ──────────────────────────────────
fresh(); press(); adv(100); release();
adv(10);                       // 10 ms of the hold runs on both clocks
adv(90, { audio: false });     // the context is interrupted and resumes; the main thread hears of neither until now
for (const fn of listeners) fn();
{ const sending = mg.gateSending();
  adv(5.01);
  check('a statechange inside a tail that reads "running" (the suspend and resume arrived together): the tail is cut, and nothing goes out dark',
    sending === false && g() === 0 && peak(40) === 0, `sending=${sending} gain=${f(g())} peak over the old hold=${f(peak(40))}`); }

// ── 5. finding 25: a gain that refuses one automation call is stepped shut, and what it accepted does not outlive that ─
fresh(); press(); adv(100);
gain.refuse = 'ramp';          // the hold's set is accepted, the ramp refused
release();
adv(60);
check('a release whose ramp is refused after its hold was accepted: the gain is shut and stays shut (the accepted hold is cancelled)',
  g() === 0 && peak(200) === 0 && mg.gateSending() === false, `gain=${f(g())} peak=${f(peak(200))}`);

// ── 6. finding 5: a gate without a delay line has no tail ──────────────────────────────────────────────────────────
fresh({ delay: false }); press(); adv(100); release();
check('no createDelay: the gate says it has no lookahead, and a release cuts from now', mg.gateLookahead() === false && mg.gateTailLeft() === 0, `${mg.gateLookahead()} ${mg.gateTailLeft()}`);
adv(5.01);
check('...shut 5 ms after the release', g() === 0, f(g()));

// ── 7. finding 28: with no graph, gateRunning() is true whatever the context it was refused on is doing ────────────
{ const made = fresh({ dest: false, state: 'suspended' });
  check('a gate that could not be built on a suspended context: no lane, no lookahead to speak of, and gateRunning() is true (there is no graph to stop)',
    made === null && mg.gateUnavailable() === true && mg.gateLookahead() === null && mg.gateRunning() === true,
    `made=${made} unavailable=${mg.gateUnavailable()} lookahead=${mg.gateLookahead()} running=${mg.gateRunning()}`); }

performance.now = realPerf;
done();
