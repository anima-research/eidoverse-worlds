// vrmheight — a body's stature read from its VRM file, so every body whose
// file has a humanoid head has a height on the roster before anyone has worn
// it.
//
// The rule is shared/rig.js's stature(): the humanoid head joint at rest plus
// a forehead, the rule the browser's portrait pass and the door's
// bodyHeightFor also use (the file's bind pose reads about a centimetre above
// the browser's posed head). The bounding box is no substitute, since it
// counts hair, ears and tails: the default claude.vrm boxes at about 2.2 m
// around a 1.5 m body, its crown of tentacles weighted to the Head bone itself.
//
// Only the GLB header and JSON chunk are read, a few milliseconds a body, so a
// result is kept in memory for the file's version (its mtime, as the roster
// stamps it) and nothing is written. Read-only on the VRM.
import * as THREE from "three";
import { closeSync, openSync, readSync } from "node:fs";
import { glbJson, rigMath } from "../shared/rig.js";

const { stature } = rigMath(THREE);
const memo = new Map<string, { v: string; h: number | null }>();
/** A VRM's JSON describes its nodes and extensions, well under a megabyte for
 *  any real body; the meshes are in the binary chunk. A header claiming more is
 *  refused before anything is allocated or decoded. */
const MAX_JSON = 16 * 1024 * 1024;

/** The header and JSON chunk of a GLB on disk. Its first 20 bytes say how long
 *  the JSON chunk is, and a length past MAX_JSON is refused. A short or foreign
 *  file reads as zeros past its end, which glbJson then refuses. */
function headerAndJson(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const head = new Uint8Array(20);
    readSync(fd, head, 0, 20, 0);
    const len = new DataView(head.buffer).getUint32(12, true);
    if (len > MAX_JSON) throw new Error("JSON chunk past MAX_JSON");
    const buf = new Uint8Array(20 + len);
    buf.set(head);
    readSync(fd, buf, 20, len, 20);
    return buf;
  } finally { closeSync(fd); }
}

/** The file's stature in metres, or null when it has no humanoid head, isn't
 *  a GLB this reads, or can't be read just now. `v` is the file's version as
 *  the roster stamps it, so a re-export is read again. */
export function vrmHeightFor(file: string, v: string): number | null {
  const hit = memo.get(file);
  if (hit?.v === v) return hit.h;
  let h: number | null;
  try { h = stature(glbJson(headerAndJson(file))); }
  catch (e) {
    // a failed read (EMFILE, EIO, a file swapped mid-read) may pass, so it
    // isn't remembered; a file that isn't a GLB this reads is, for its version
    if (typeof (e as { code?: unknown }).code === "string") return null;
    h = null;
  }
  memo.set(file, { v, h });
  return h;
}
