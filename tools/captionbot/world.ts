// The world client: joins EMBODIED as a visitor holding the caption deed for
// one screen (grant {id: <actor>, caption: "<screen>"}, owner-granted) and
// writes one `caption` verb per final line. It reads the stage cue (a
// `stage` comp on the screen) off the snapshot and the live log, so
// `speaker` is the operator's word, never the bot's guess.
//
// RECEIPTS (Mica, #187 review B3). A line is not done when it is sent; it is
// done when its own log echo comes back — verb `caption`, our actor, our
// screen, our session and n. Until then it is PENDING: kept in memory, kept
// on disk in the spool, and resent after a disconnect or a silent timeout.
// The sequencer refuses a duplicate n before append (shared/captions.js
// captionRefusal), so a resend can never write twice — that refusal is
// read here as the receipt it is.
//
// ORDER. One line in flight at a time, FIFO, paced under the door's verb
// rate (12 per 4 s): a burst of finals queues rather than tripping the
// limiter. WHO the captioner is, is the sequencer's fact, not ours: it
// stamps its leg generation on every line and the bag follows the live leg
// (a same-identity join is a takeover). A restart's old-session tail still
// drains first, FIFO, so the window switches exactly once.
//
// BACKPRESSURE. The queue is BOUNDED (`maxPending`, default 600 lines ≈ five
// minutes at the pace). Past it the OLDEST queued lines are dropped, each
// one written to the spool as `overflow` and counted out loud — never a
// silent drop, never unbounded memory. The spool (`spool` path, JSONL,
// append-only) is the bot's durable record of what it tried and what the
// world confirmed; a restart re-queues whatever it never saw confirmed.
//
// THE SPOOL IS A PROMISE, SO IT FAILS CLOSED (Mica, #187 round-two
// follow-up). A line is queued only once its `queued` row is on disk; if
// that write fails, the line is REFUSED and intake halts — new captions are
// counted and refused, out loud, until the operator fixes the disk and
// restarts (the replay then picks up exactly what was confirmed). What is
// already queued still drains: it is in memory and on disk. `end` is not a
// line — a perception clear, idempotent at the door — so it goes through
// even with the spool down. The other rows (acked, refused, overflow) are
// bookkeeping: a failed write there means a restart may resend a line that
// already landed, which the door's dedupe makes harmless, so those log and
// continue. `spoolBestEffort` (env SPOOL_BEST_EFFORT=1) states the weaker
// promise instead: every write failure logs and the line queues anyway.
//
// Captions are durable world testimony like `say`; `end` clears current
// perception, not history. This client keeps nothing the world does not.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { normalizeCaptionArgs, mintSession } from '../../shared/captions.js';
import type { Caption } from './captioner.ts';

export interface WorldOptions {
  url: string; token: string; world: string;
  /** The bot's actor id — reserved like an agent's, so the door knows it. */
  actor: string;
  /** The entity that owns the screen. */
  screenId: string;
  /** What is showing, for look(); rides the first line of each session. */
  title?: string;
  /** JSONL spool path; omit for none (tests). */
  spool?: string;
  /** Spool write failures log and continue instead of halting intake. */
  spoolBestEffort?: boolean;
  /** Queue bound, in lines (default 600). */
  maxPending?: number;
  /** Minimum ms between sends (default 500: 2/s, under the 12-per-4-s door). */
  paceMs?: number;
  /** Ms to wait for a receipt before resending (default 5000). */
  ackTimeoutMs?: number;
  /** Ms to wait after a deed/rank refusal before trying again (default 30000). */
  deedRetryMs?: number;
  log?: (m: string) => void;
  /** Test seam: the session to start with. */
  session?: string;
  /** Test seam: called with the key just before each send. */
  onSend?: (key: string) => void;
  /** Join as an agent (default true; tests join as a plain participant). */
  agent?: boolean;
}

type Args = { id: string; session: string; n?: number; end?: true; t0?: number; t1?: number; text?: string; speaker?: string; title?: string };
type Pending = { key: string; args: Args; tries: number };
type SpoolRow = { state: 'queued' | 'acked' | 'refused' | 'overflow'; key: string; args?: Args; why?: string; at: number };

const keyOf = (a: Args) => `${a.session}#${a.end ? 'end' : a.n}`;

export class WorldClient {
  private ws: WebSocket | null = null;
  private open = false;
  private stageSpeaker: string | undefined;
  private readonly log: (m: string) => void;
  /** FIFO of lines the world has not confirmed. */
  private pending: Pending[] = [];
  private inflight: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private halted: string | null = null;
  private titled = false;
  session: string;
  n = 0;
  sent = 0; acked = 0; refused = 0; overflow = 0;
  /** Lines refused because the spool could not take their `queued` row. */
  spoolRefused = 0;
  /** The first spool failure that halted intake, or null while writable. */
  spoolFailed: string | null = null;
  onReceipt: ((args: Args) => void) | null = null;

  constructor(private opts: WorldOptions) {
    this.log = opts.log ?? (() => {});
    this.session = opts.session ?? mintSession();
    if (opts.spool) this.replaySpool(opts.spool);
  }

  get pendingCount(): number { return this.pending.length + (this.inflight ? 1 : 0); }

  connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', world: this.opts.world, id: this.opts.actor, avatar: '', ...(this.opts.agent === false ? {} : { agent: true }), token: this.opts.token }));
    };
    ws.onclose = () => {
      this.open = false;
      // whatever was in flight is unconfirmed: back to the head of the queue
      if (this.inflight) { this.pending.unshift(this.inflight); this.inflight = null; }
      if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
      this.log('world socket closed — reconnecting');
      setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'snapshot') {
        this.open = true;
        const ent = msg.state?.entities?.[this.opts.screenId];
        this.stageSpeaker = ent?.comp?.stage?.speaker;
        const deed = msg.yourRights?.caption;
        this.log(`joined "${this.opts.world}" as ${this.opts.actor} (${msg.yourRights?.role ?? '?'}${deed ? `, caption deed for ${deed.id}` : ', NO caption deed — ask the owner: grant {id: "' + this.opts.actor + '", caption: "' + this.opts.screenId + '"}'}); screen ${this.opts.screenId} ${ent ? 'present' : 'NOT PRESENT — spawn it first'}`);
        this.schedule();
      } else if (msg.type === 'error') {
        this.onError(String(msg.error ?? ''));
      } else if (msg.type === 'log' && msg.entry?.verb === 'comp' && msg.entry.args?.id === this.opts.screenId && msg.entry.args?.type === 'stage') {
        this.stageSpeaker = msg.entry.args.data?.speaker;
        this.log(`stage cue: speaker = ${this.stageSpeaker ?? '(none)'}`);
      } else if (msg.type === 'log' && msg.entry?.verb === 'caption' && msg.entry.actor === this.opts.actor && msg.entry.args?.id === this.opts.screenId) {
        this.onEcho(msg.entry.args as Args);
      }
    };
  }

  /** The operator's stage cue, if any. */
  speaker(): string | undefined { return this.stageSpeaker; }

  /** One final line: numbered, queued, spooled; sent when its turn comes. */
  caption(c: Caption): void {
    const args: Args = { id: this.opts.screenId, session: this.session, n: ++this.n, t0: c.t0, t1: c.t1, text: c.text, ...(c.speaker ? { speaker: c.speaker } : {}) };
    if (this.opts.title && !this.titled) { args.title = this.opts.title; this.titled = true; }
    const shape = normalizeCaptionArgs(args);
    if (!shape.ok) { this.log(`caption dropped before send (${shape.why})`); return; }
    this.enqueue({ key: keyOf(args), args: shape.args as Args, tries: 0 });
  }

  /** The screen goes quiet for this session (idempotent at the door). */
  end(): void {
    const args: Args = { id: this.opts.screenId, session: this.session, end: true };
    this.enqueue({ key: keyOf(args), args, tries: 0 }, { durable: false });
  }

  /** A new time origin (source reconnect, restart): a later session. The old
   *  session's unconfirmed tail stays queued ahead and drains first. */
  rotateSession(session = mintSession()): void {
    if (session <= this.session) throw new Error(`session ${session} does not follow ${this.session}`);
    this.session = session; this.n = 0; this.titled = false;
    this.log(`session → ${session}`);
  }

  private enqueue(p: Pending, { durable = true } = {}): void {
    // the `queued` row is the promise a restart keeps: on disk BEFORE the
    // line is in memory, or the line is not taken
    if (durable && this.spoolFailed && !this.opts.spoolBestEffort) {
      this.spoolRefused++;
      // the halt was said once; from here every 100th refusal, not per line
      if (this.spoolRefused % 100 === 0) this.log(`⛔ refused ${p.key}: spool unwritable (${this.spoolFailed}); ${this.spoolRefused} refused so far`);
      return;
    }
    const wrote = this.spool({ state: 'queued', key: p.key, args: p.args, at: Date.now() });
    if (durable && !wrote && !this.opts.spoolBestEffort) {
      this.spoolRefused++;
      this.log(`⛔ spool write failed (${this.spoolFailed}): intake halted — new captions are refused until the spool is writable and the bot restarts; the ${this.pendingCount} already queued still drain (SPOOL_BEST_EFFORT=1 to log and continue instead)`);
      return;
    }
    this.pending.push(p);
    const max = this.opts.maxPending ?? 600;
    let dropped = 0;
    while (this.pending.length > max) {
      const old = this.pending.shift()!;
      this.spool({ state: 'overflow', key: old.key, at: Date.now() });
      dropped++;
    }
    if (dropped) { this.overflow += dropped; this.log(`⚠ overflow: dropped the ${dropped} oldest queued caption${dropped === 1 ? '' : 's'} (queue > ${max}); they are in the spool as overflow`); }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || !this.open || this.inflight || this.halted || !this.pending.length) return;
    const wait = Math.max(0, (this.opts.paceMs ?? 500) - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => { this.timer = null; this.send(); }, wait);
  }

  private send(): void {
    if (!this.open || !this.ws || this.inflight || !this.pending.length) return;
    const p = this.pending.shift()!;
    this.inflight = p;
    p.tries++;
    this.lastSentAt = Date.now();
    this.sent++;
    this.opts.onSend?.(p.key);
    this.ws.send(JSON.stringify({ type: 'verb', verb: 'caption', args: p.args }));
    // no receipt in time: unconfirmed, so resend — the door dedupes
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.inflight !== p) return;
      this.log(`no receipt for ${p.key} in ${this.opts.ackTimeoutMs ?? 5000} ms — resending`);
      this.inflight = null; this.pending.unshift(p); this.schedule();
    }, this.opts.ackTimeoutMs ?? 5000);
  }

  private settle(p: Pending, row: SpoolRow): void {
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    this.inflight = null;
    this.spool(row);
    this.schedule();
  }

  /** Our own entry came back through the log: the world holds it. */
  private onEcho(args: Args): void {
    const key = keyOf(args);
    const p = this.inflight;
    if (p && p.key === key) {
      this.acked++;
      this.onReceipt?.(args);
      this.settle(p, { state: 'acked', key, at: Date.now() });
    } else {
      // an echo for something not in flight: a resend that had already
      // landed, or a previous life of this bot — either way, confirmed
      const i = this.pending.findIndex((q) => q.key === key);
      if (i >= 0) { this.pending.splice(i, 1); this.acked++; this.spool({ state: 'acked', key, at: Date.now() }); }
    }
  }

  private onError(error: string): void {
    const p = this.inflight;
    if (!p) { this.log(`world error: ${error}`); return; }
    // the door's dedupe IS a receipt: the line is already history
    if (/not after the folded high-water|has no captions to end/.test(error)) {
      this.acked++;
      this.settle(p, { state: 'acked', key: p.key, why: error, at: Date.now() });
      return;
    }
    // a stale session, or an end for a session the screen has left behind:
    // this line is refused for good, the next may not be
    if (/is captioned under session/.test(error)) {
      this.refused++;
      this.log(`refused ${p.key}: ${error}`);
      this.settle(p, { state: 'refused', key: p.key, why: error, at: Date.now() });
      return;
    }
    // no deed / wrong deed / screen gone / rank: nothing will land until the
    // owner acts — hold everything, say so once, and try again later
    // …and a NEWER leg holding the screen (another captioner joined after
    // us): ours is superseded until we rejoin; hold, do not drop
    if (/caption deed|not here|was replaced|needs .* rights|spectators|superseded captioner/.test(error)) {
      if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
      this.inflight = null; this.pending.unshift(p);
      if (this.halted !== error) { this.halted = error; this.log(`⛔ held (${this.pendingCount} pending): ${error}`); }
      setTimeout(() => { this.halted = null; this.schedule(); }, this.opts.deedRetryMs ?? 30_000);
      return;
    }
    // the rate limiter, or anything else: unconfirmed, back off, resend
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    this.inflight = null; this.pending.unshift(p);
    this.log(`world error on ${p.key}: ${error} — will resend`);
    this.lastSentAt = Date.now() + (/rate/i.test(error) ? 4000 : 1000);
    this.schedule();
  }

  /** Append one row. True when it is on disk (or there is no spool). */
  private spool(row: SpoolRow): boolean {
    if (!this.opts.spool) return true;
    try { appendFileSync(this.opts.spool, JSON.stringify(row) + '\n'); return true; }
    catch (e) {
      const why = (e as Error).message;
      if (row.state === 'queued') this.spoolFailed ??= why;
      else this.log(`spool write failed on a ${row.state} row for ${row.key}: ${why} — a restart may resend it; the door dedupes`);
      return false;
    }
  }

  /** Re-queue whatever a previous life never saw confirmed. Their sessions
   *  precede ours by construction (minted earlier), so they drain first. */
  private replaySpool(path: string): void {
    if (!existsSync(path)) return;
    const open = new Map<string, Args>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: SpoolRow; try { row = JSON.parse(line); } catch { continue; }
      if (row.state === 'queued' && row.args) open.set(row.key, row.args);
      else open.delete(row.key);
    }
    for (const [key, args] of open) this.pending.push({ key, args, tries: 0 });
    if (open.size) this.log(`spool: ${open.size} unconfirmed caption${open.size === 1 ? '' : 's'} from a previous run re-queued ahead of this session`);
  }

  close(): void { this.ws?.close(); }
}
