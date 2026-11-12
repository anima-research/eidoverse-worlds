// The bones an avatar actually has, by name — what a pose over arbitrary bones
// is checked against (shared/humanoid.js validatePose `rig`). Humanoid names
// are a vocabulary every rig shares; `L_Wing_Upper` or `Pelvis` exist only on
// the rigs that have them, and a pose naming one a rig lacks does nothing on
// every renderer, silently. So the check needs the rig, and the rig is in the
// file's JSON chunk — the header bytes, not the multi-megabyte body.
import { glbJson, humanBones, stature, GLB_MAX_JSON } from "./rig.ts";

export type RigBones = {
  /** every skin joint and humanoid bone, by node name */
  bones: string[];
  /** raw node name -> VRM humanoid name, for the rig's humanoid bones */
  humanoidOf: Record<string, string>;
  /** the ancestors of hips (Root, Armature): placed from hips every frame, not poseable */
  aboveHips: string[];
};

// per avatar path and version (its ?v=), immutable — the promise is cached so concurrent calls share one fetch
const cache = new Map<string, Promise<RigBones | null>>();

export function rigBonesFor(httpBase: string, avatarPath: string): Promise<RigBones | null> {
  const path = avatarPath.split("?")[0];
  if (!path) return Promise.resolve(null);
  let p = cache.get(avatarPath);
  if (!p) {
    p = headerAndJson(`${httpBase}/library/${path}`).then((buf) => buf && rigFromGltf(glbJson(buf))).catch(() => null);
    cache.set(avatarPath, p);
    p.then((r) => { if (!r) cache.delete(avatarPath); });   // a failed read may succeed later
  }
  return p;
}

/** A GLB's header and JSON chunk, the bytes server/vrmheight.ts reads from disk: 20 bytes say how long the JSON
 *  chunk is, past GLB_MAX_JSON refused. Identity-encoded so /library answers ranged instead of gzipping the whole
 *  file; a server that ignores Range answers 200 with the whole file, which parses the same. */
async function headerAndJson(url: string): Promise<Uint8Array | null> {
  const upTo = (end: number) => fetch(url, { headers: { Range: `bytes=0-${end}`, "Accept-Encoding": "identity" } });
  const head = await upTo(19);
  if (!head.ok) return null;
  const buf = new Uint8Array(await head.arrayBuffer());
  if (head.status !== 206) return buf;
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
  if (len > GLB_MAX_JSON) return null;
  const body = await upTo(19 + len);
  return body.ok ? new Uint8Array(await body.arrayBuffer()) : null;
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
  for (let i = parent.get(hb.hips as number); i != null; i = parent.get(i)) {
    if (nodes[i]?.name) aboveHips.push(nodes[i].name);
  }
  const bones = [...idx].map((i) => nodes[i]?.name).filter((n): n is string => typeof n === "string" && !!n);
  return bones.length ? { bones: [...new Set(bones)], humanoidOf, aboveHips } : null;
}

// ---- stature ------------------------------------------------------------------
// per avatar path and version, as the roster's own read (server/vrmheight.ts) keeps one per version
const heights = new Map<string, Promise<number | null>>();

/** A body's standing height in metres, shared/rig.js's stature() over the same header bytes: the
 *  rule the browser's Avatar.bodyHeight and the roster (server/vrmheight.ts) use. What water depth is
 *  measured against (shared/terrainshape.js waterStance). Null when the file has no humanoid head. */
export function bodyHeightFor(httpBase: string, avatarPath: string): Promise<number | null> {
  const path = avatarPath.split("?")[0];
  if (!path) return Promise.resolve(null);
  let p = heights.get(avatarPath);
  if (!p) {
    p = headerAndJson(`${httpBase}/library/${path}`).then((buf) => buf && stature(glbJson(buf))).catch(() => null);
    heights.set(avatarPath, p);
    p.then((h) => { if (h == null) heights.delete(avatarPath); });
  }
  return p;
}
