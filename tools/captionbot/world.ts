// The world client: joins EMBODIED (spectators cannot author — runVerb's
// first gate) as the screen's captioner and writes the captions comp on the
// screen entity. It also reads the stage cue (a `stage` comp on the same
// entity) off the snapshot and the live log, so `speaker` is the operator's
// word, never the bot's guess.
//
// Writes are coalesced: at most one comp per `minIntervalMs` (default 1 s),
// always carrying the CURRENT window — a burst of finals becomes one edit,
// and the verb rate limit (VERB_RATE per 4 s) is never the thing that drops
// a caption. The bot needs builder rights in the world (comp is rank 1):
// the owner grants them to its actor id once.

export interface WorldOptions {
  url: string; token: string; world: string;
  /** The bot's actor id — reserved like an agent's, so the door knows it. */
  actor: string;
  /** The entity that owns the screen. */
  screenId: string;
  minIntervalMs?: number;
  log?: (m: string) => void;
}

export class WorldClient {
  private ws: WebSocket | null = null;
  private open = false;
  private latest: Record<string, unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private stageSpeaker: string | undefined;
  private readonly log: (m: string) => void;
  sent = 0;
  constructor(private opts: WorldOptions) { this.log = opts.log ?? (() => {}); }

  connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', world: this.opts.world, id: this.opts.actor, avatar: '', agent: true, token: this.opts.token }));
    };
    ws.onclose = () => { this.open = false; this.log('world socket closed — reconnecting'); setTimeout(() => this.connect(), 1500); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'snapshot') {
        this.open = true;
        const ent = msg.state?.entities?.[this.opts.screenId];
        this.stageSpeaker = ent?.comp?.stage?.speaker;
        this.log(`joined "${this.opts.world}" as ${this.opts.actor}; screen ${this.opts.screenId} ${ent ? 'present' : 'NOT PRESENT — spawn it first'}`);
        if (this.latest) this.schedule();
      } else if (msg.type === 'error') {
        this.log(`world error: ${msg.error}`);
      } else if (msg.type === 'log' && msg.entry?.verb === 'comp' && msg.entry.args?.id === this.opts.screenId && msg.entry.args?.type === 'stage') {
        this.stageSpeaker = msg.entry.args.data?.speaker;
        this.log(`stage cue: speaker = ${this.stageSpeaker ?? '(none)'}`);
      }
    };
  }

  /** The operator's stage cue, if any. */
  speaker(): string | undefined { return this.stageSpeaker; }

  /** Queue the current window; sends coalesce to one comp per interval. */
  update(data: Record<string, unknown>): void {
    this.latest = data;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || !this.open || !this.latest) return;
    const wait = Math.max(0, (this.opts.minIntervalMs ?? 1000) - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }

  private flush(): void {
    if (!this.open || !this.latest || !this.ws) return;
    const data = this.latest;
    this.latest = null;
    this.lastSentAt = Date.now();
    this.sent++;
    this.ws.send(JSON.stringify({ type: 'verb', verb: 'comp', args: { id: this.opts.screenId, type: 'captions', data } }));
  }

  /** The screen goes quiet: one comp with data null. */
  clear(): void {
    if (!this.open || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'verb', verb: 'comp', args: { id: this.opts.screenId, type: 'captions', data: null } }));
  }

  close(): void { this.ws?.close(); }
}
