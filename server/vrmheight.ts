// vrmheight — a body's stature read from its VRM file, so a body has a height on the roster before anyone has worn it.
// The rule is shared/rig.js's stature() (head joint at rest plus a forehead), the one the browser and the door use; the
// bounding box is no substitute (it counts hair, ears and tails). Only the GLB header and JSON chunk are read, memoised
// per file version (mtime); read-only on the VRM.
import * as THREE from "three";
import { closeSync, openSync, readSync } from "node:fs";
import { glbJson, rigMath, GLB_MAX_JSON } from "../shared/rig.js";

const { stature } = rigMath(THREE);
const memo = new Map<string, { v: string; h: number | null }>();

/** The header and JSON chunk of a GLB on disk. A short or foreign file reads as zeros past its end, which glbJson then refuses. */
function headerAndJson(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const head = new Uint8Array(20);
    readSync(fd, head, 0, 20, 0);
    const len = new DataView(head.buffer).getUint32(12, true);
    if (len > GLB_MAX_JSON) throw new Error("JSON chunk past GLB_MAX_JSON");
    const buf = new Uint8Array(20 + len);
    buf.set(head);
    readSync(fd, buf, 20, len, 20);
    return buf;
  } finally { closeSync(fd); }
}

/** The file's stature in metres, or null (no humanoid head, not a GLB, or unreadable just now). `v`: the roster's version stamp, so a re-export is read again. */
export function vrmHeightFor(file: string, v: string): number | null {
  const hit = memo.get(file);
  if (hit?.v === v) return hit.h;
  let h: number | null;
  try { h = stature(glbJson(headerAndJson(file))); }
  catch (e) {
    // a failed read (EMFILE, EIO, a swap mid-read) may pass later, so it isn't memoised; a non-GLB is, for its version
    if (typeof (e as { code?: unknown }).code === "string") return null;
    h = null;
  }
  memo.set(file, { v, h });
  return h;
}
