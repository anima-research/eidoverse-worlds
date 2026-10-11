// The stage-frame tick. Isolate each receiver: a departing socket must
// neither skip later recipients nor erase a frame from an active archive.
// Every world's frame is sent before any world's frame is archived: archive
// I/O stays synchronous on the tick, so a stalled disk still stalls the
// tick, but only after every client of every world has its frame.
import { FRAME_SKIP_BUFFERED } from "./config.ts";
import { frameRecorder } from "./recording.ts";
import type { World } from "./world.ts";

type Sent = { data: string; seq: number; logSeq: number };
type Recorder = (w: World) => { append(frame: string, roster: string, seq: number, logSeq: number): boolean } | null;

/** Send one world's dirty poses to its clients, skipping a receiver whose
 *  socket is already backed up; returns what the archive phase writes. */
function sendStageFrame(w: World): Sent | null {
  if (w.dirty.size === 0) return null;
  const seq = w.frameSeq++;
  const data = JSON.stringify({ type: "frame", seq, t: Date.now(), poses: Object.fromEntries(w.dirty) });
  w.dirty.clear();
  for (const c of w.clients) {
    try {
      if ((c.ws.getBufferedAmount?.() ?? 0) > FRAME_SKIP_BUFFERED) continue;
      c.ws.send(data);
    } catch (err) { console.error("[world:" + w.name + "] frame send to " + c.id, err); }
  }
  // The last authored entry applied when this frame was sent; it precedes the frame.
  return { data, seq, logSeq: w.snapSeq + w.entries.length };
}

/** Archive one sent frame. Archival admission/I/O failure costs only the
 *  archive. The roster lists who performs in the world: a spectator, a
 *  superseded leg or a non-world surface (the voice relay) isn't a performer. */
function archiveStageFrame(w: World, sent: Sent, recorder: Recorder) {
  const archive = recorder(w);
  if (!archive) return;
  const roster = JSON.stringify([...w.clients]
    .filter(c => !c.spectator && !c.superseded && (c.surface ?? "world") === "world")
    .map(c => ({ id: c.id, avatar: c.avatar })));
  archive.append(sent.data, roster, sent.seq, sent.logSeq);
}

/** One tick: every world's send, then every world's archive write. */
export function stageFrames(worlds: Iterable<World>, recorder: Recorder = frameRecorder) {
  const sent: [World, Sent][] = [];
  for (const w of worlds) {
    try {
      const frame = sendStageFrame(w);
      if (frame) sent.push([w, frame]);
    } catch (err) { console.error("[world:" + w.name + "] frame tick", err); }
  }
  for (const [w, frame] of sent) {
    try { archiveStageFrame(w, frame, recorder); }
    catch (err) { console.error("[world:" + w.name + "] frame archive", err); }
  }
}

/** One world's tick, for a caller holding a single world. */
export function stageFrame(w: World, recorder: Recorder = frameRecorder) { stageFrames([w], recorder); }
