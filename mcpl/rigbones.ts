// The bones an avatar actually has, by name — what a pose over arbitrary bones
// is checked against (shared/humanoid.js validatePose `rig`). Humanoid names
// are a vocabulary every rig shares; `L_Wing_Upper` or `Pelvis` exist only on
// the rigs that have them, and a pose naming one a rig lacks does nothing on
// every renderer, silently. So the check needs the rig, and the rig is in the
// file's JSON chunk — the header bytes, not the multi-megabyte body.
import { glbJson, humanBones, stature } from "./rig.ts";

export type RigBones = {
  /** every skin joint and humanoid bone, by node name */
  bones: string[];
  /** raw node name -> VRM humanoid name, for the rig's humanoid bones */
  humanoidOf: Record<string, string>;
  /** the ancestors of hips (Root, Armature): placed from hips every frame, not poseable */
  aboveHips: string[];
};

// per avatar file, immutable — the promise is cached so concurrent calls share one fetch
const cache = new Map<string, Promise<RigBones | null>>();

export function rigBonesFor(httpBase: string, avatarPath: string): Promise<RigBones | null> {
  const key = avatarPath.split("?")[0];
  if (!key) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    p = readRig(`${httpBase}/library/${key}`).catch(() => null);
    cache.set(key, p);
    p.then((r) => { if (!r) cache.delete(key); });   // a failed read may succeed later
  }
  return p;
}

async function readRig(url: string): Promise<RigBones | null> {
  // Header first: 20 bytes say how long the JSON chunk is. A server that
  // ignores Range answers 200 with the whole file, which parses the same.
  const head = await fetch(url, { headers: { Range: "bytes=0-19" } });
  if (!head.ok) return null;
  let buf = new Uint8Array(await head.arrayBuffer());
  if (head.status === 206) {
    const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
    const body = await fetch(url, { headers: { Range: `bytes=0-${19 + len}` } });
    if (!body.ok) return null;
    buf = new Uint8Array(await body.arrayBuffer());
  }
  return rigFromGltf(glbJson(buf));
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
const heights = new Map<string, Promise<number | null>>();

/** A body's standing height in metres, shared/rig.js's stature() over the same header bytes: the
 *  rule the browser's Avatar.bodyHeight and the roster (server/vrmheight.ts) use. What water depth is
 *  measured against (shared/terrainshape.js waterStance). Null when the file has no humanoid head. */
export function bodyHeightFor(httpBase: string, avatarPath: string): Promise<number | null> {
  const key = avatarPath.split("?")[0];
  if (!key) return Promise.resolve(null);
  let p = heights.get(key);
  if (!p) {
    p = (async () => {
      const head = await fetch(`${httpBase}/library/${key}`, { headers: { Range: "bytes=0-19" } });
      if (!head.ok) return null;
      let buf = new Uint8Array(await head.arrayBuffer());
      if (head.status === 206) {
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
        buf = new Uint8Array(await (await fetch(`${httpBase}/library/${key}`, { headers: { Range: `bytes=0-${19 + len}` } })).arrayBuffer());
      }
      return stature(glbJson(buf));
    })().catch(() => null);
    heights.set(key, p);
    p.then((h) => { if (h == null) heights.delete(key); });
  }
  return p;
}
