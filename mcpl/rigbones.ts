// The bones an avatar actually has, by name — what a pose over arbitrary bones
// is checked against (shared/humanoid.js validatePose `rig`). Humanoid names
// are a vocabulary every rig shares; `L_Wing_Upper` or `Pelvis` exist only on
// the rigs that have them, and a pose naming one a rig lacks does nothing on
// every renderer, silently. So the check needs the rig, and the rig is in the
// file's JSON chunk — the header bytes, not the multi-megabyte body.
import { glbJson, humanBones, stature, GLB_MAX_JSON } from "./rig.ts";
import { nameFromAvatarPath } from "../client/lib/seatcore.js";

export type RigBones = {
  /** every skin joint and humanoid bone, by node name */
  bones: string[];
  /** raw node name -> VRM humanoid name, for the rig's humanoid bones */
  humanoidOf: Record<string, string>;
  /** the ancestors of hips (Root, Armature): placed from hips every frame, not poseable */
  aboveHips: string[];
};

/** What the door reads from a body's header: its rig and its stature, from one read. */
type Reading = { rig: RigBones | null; height: number | null };
const NOTHING: Reading = { rig: null, height: null };
// per server, avatar path and version (its ?v=), the promise shared by concurrent calls. A failed download is dropped
// so the next call tries again; a file with nothing to read is kept, as server/vrmheight.ts keeps its own.
const readings = new Map<string, Promise<Reading>>();

function readingOf(httpBase: string, avatarPath: string): Promise<Reading> {
  const path = avatarPath.split("?")[0];
  if (!path) return Promise.resolve(NOTHING);
  const key = `${httpBase}/library/${avatarPath}`;
  let p = readings.get(key);
  if (!p) {
    const read = headerAndJson(`${httpBase}/library/${path}`).then((buf) => {
      try { const g = buf && glbJson(buf); return g ? { rig: rigFromGltf(g), height: stature(g) } : NOTHING; }
      catch { return NOTHING; }
    });
    const settled: Promise<Reading> = read.catch(() => { if (readings.get(key) === settled) readings.delete(key); return NOTHING; });
    readings.set(key, p = settled);
  }
  return p;
}

/** Forget every reading of this server's avatar `name`, worn now or not: its bytes changed (avatar-updated). */
export function forgetReadings(httpBase: string, name: string) {
  for (const key of readings.keys()) if (key.startsWith(`${httpBase}/library/`) && nameFromAvatarPath(key) === name) readings.delete(key);
}

export function rigBonesFor(httpBase: string, avatarPath: string): Promise<RigBones | null> {
  return readingOf(httpBase, avatarPath).then((r) => r.rig);
}

/** A GLB's header and JSON chunk, the bytes server/vrmheight.ts reads from disk: 20 bytes say how long the JSON
 *  chunk is, past GLB_MAX_JSON refused. Identity-encoded so /library answers ranged instead of gzipping the whole
 *  file; a server that ignores Range answers 200 with the whole file, which parses the same. Throws when the
 *  download fails, which may pass; null for a file this won't read. */
async function headerAndJson(url: string): Promise<Uint8Array | null> {
  const upTo = (end: number) => fetch(url, { headers: { Range: `bytes=0-${end}`, "Accept-Encoding": "identity" } });
  const head = await upTo(19);
  if (head.status === 416) return null;   // not even a header's worth of bytes (an empty file)
  if (!head.ok) throw new Error(`the world server answered ${head.status}`);
  const buf = new Uint8Array(await head.arrayBuffer());
  if (buf.length < 20) return null;
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
  if (len > GLB_MAX_JSON) return null;
  if (head.status !== 206) return buf;
  const body = await upTo(19 + len);
  if (!body.ok) throw new Error(`the world server answered ${body.status}`);
  return new Uint8Array(await body.arrayBuffer());
}

/** Exported for tests: the same reading over a parsed glTF. */
export function rigFromGltf(g: any): RigBones | null {
  const nodes: any[] = g?.nodes ?? [];
  const hb = humanBones(g) ?? {};
  const idx = new Set<number>();
  for (const s of g?.skins ?? []) for (const j of s.joints ?? []) idx.add(j);
  const humanoidOf: Record<string, string> = {};
  for (const [vrm, i] of Object.entries(hb)) {
    const n = nodes[i as number]?.name;
    if (typeof n === "string" && n) { humanoidOf[n] = vrm; idx.add(i as number); }
  }
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  const aboveHips: string[] = [];
  const seen = new Set<number>([hb.hips as number]);   // a malformed file's nodes may loop
  for (let i = parent.get(hb.hips as number); i != null && !seen.has(i); i = parent.get(i)) {
    seen.add(i);
    if (nodes[i]?.name) aboveHips.push(nodes[i].name);
  }
  const bones = [...idx].map((i) => nodes[i]?.name).filter((n): n is string => typeof n === "string" && !!n);
  return bones.length ? { bones: [...new Set(bones)], humanoidOf, aboveHips } : null;
}

// ---- stature ------------------------------------------------------------------
/** A body's standing height in metres, shared/rig.js's stature() over the same header bytes: the
 *  rule the browser's Avatar.bodyHeight and the roster (server/vrmheight.ts) use. What water depth is
 *  measured against (shared/terrainshape.js waterStance). Null when the file has no humanoid head. */
export function bodyHeightFor(httpBase: string, avatarPath: string): Promise<number | null> {
  return readingOf(httpBase, avatarPath).then((r) => r.height);
}
