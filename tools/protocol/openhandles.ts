// The event-loop handles this process still holds, as Bun's heap sees them (its protected objects: a live timer, immediate,
// socket, listener, server, stat watcher or child process). Bun stubs process.getActiveResourcesInfo (always []); this doesn't.
// Not seen here: fs.watch and Worker (Bun 1.3.14 doesn't protect them).
import { heapStats } from "bun:jsc";

const HANDLE = /Timeout|Immediate|Listener|Socket|Server|Watcher|Subprocess|Worker/;
export function openHandles(): string {
  const open = Object.entries(heapStats().protectedObjectTypeCounts).filter(([k, n]) => HANDLE.test(k) && n > 0);
  return open.length ? open.map(([k, n]) => `${k}×${n}`).join(", ") : "none";
}
