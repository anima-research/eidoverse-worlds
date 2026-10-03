// One world's stage batch. Isolate each receiver: a departing socket must
// neither skip later recipients nor erase a frame from an active archive.
import { FRAME_SKIP_BUFFERED } from "./config.ts";
import { frameRecorder } from "./recording.ts";
import type { World } from "./world.ts";

export function stageFrame(w: World) {
  if (w.dirty.size === 0) return;
  const data = JSON.stringify({ type: "frame", seq: w.frameSeq++, t: Date.now(), poses: Object.fromEntries(w.dirty) });
  w.dirty.clear();
  for (const c of w.clients) {
    try {
      if ((c.ws.getBufferedAmount?.() ?? 0) > FRAME_SKIP_BUFFERED) continue;
      c.ws.send(data);
    } catch (err) { console.error("[world:" + w.name + "] frame send to " + c.id, err); }
  }
  // Deliver first. Archival admission/I/O failure costs only the archive;
  // receiver failures above cost only their own receiver.
  const archive = frameRecorder(w);
  if (archive) {
    const roster = JSON.stringify([...w.clients]
      .filter(c => !c.spectator && !c.superseded && (c.surface ?? "world") === "world")
      .map(c => ({ id: c.id, avatar: c.avatar })));
    archive.append(data, roster, w.frameSeq - 1, w.snapSeq + w.entries.length);
  }
}
