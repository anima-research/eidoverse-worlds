// server/v4/catalogue.ts — the door's model catalogue in the engine: library paths, measured from their GLBs.
//
// The lab's door read its own table (shared/v4/catalogue.js: table, chair, crate… with hand-written sizes). The
// engine's models are library paths (`eidoverse/assets/models/…glb`, `store/<hash>.glb`), so the catalogue here is
// what server/geometry.ts measures from the same GLB the client renders: the bounding box (in the model's own frame:
// a GLB's origin is wherever its author put it) and the up-facing flat zones (seat pans, table tops) as surfaces.
//
// The door is synchronous and measuring is not, so this is a warm cache (the boxes.ts pattern): warm(libs) is awaited
// on the wire before a request reaches the door (and on world load for every model standing in it); get(lib) answers
// at once. A lib this server can't find or parse is still a model the door may NAME (refusing it would make worlds
// stop at whatever this host happens to have on disk), but it has no size: the door says it can't place or collide
// it. A name that isn't a library path at all is refused (no model called …).
import { resolveLibFile } from "../libfile.ts";
import { summarizeGlb } from "../geometry.ts";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OPT_DIR, LIBRARY_DIR } from "../config.ts";

export type Entry = { label: string; size?: number[]; box?: number[][]; surfaces: { y: number; x?: number[]; z?: number[] }[]; solids?: number[][][] };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
/** What a library path looks like (resolveLibFile's own rule, plus the content store's names). */
export const isLibPath = (s: unknown): s is string => typeof s === "string" && s.length <= 512 && !s.includes("..") && /^[A-Za-z0-9_./-]+\.(glb|vrm)$/i.test(s);
const MIN_ZONE = 0.02; // m²: smaller up-facing zones are trim and bevels, not surfaces

async function measure(lib: string): Promise<void> {
  const label = lib.split("/").pop()!.replace(/\.(glb|vrm)$/i, "").replace(/[_-]+/g, " ");
  let entry: Entry = { label, surfaces: [] };
  try {
    const file = resolveLibFile(lib);
    const sum = file ? await summarizeGlb(file, { solids: true }) : null;
    const bb = sum?.bbox;
    if (bb && [...bb.min, ...bb.max].every(Number.isFinite)) {
      const box = [bb.min.map(r3), bb.max.map(r3)];
      const surfaces = (sum!.topSurfaces ?? []).filter((s) => s.area >= MIN_ZONE && [s.y, ...s.x, ...s.z].every(Number.isFinite))
        .map((s) => ({ y: r3(s.y), x: s.x.map(r3), z: s.z.map(r3) })).sort((a, b) => a.y - b.y);
      // its solid parts (server/v4/solids.ts): a building's walls, floor and roof with its rooms open, so a body walks in
      // through the door and a thing can be put down inside (review 10-06 S0-3); absent, the box is the solid
      entry = { label, box, size: box[1].map((v, i) => r3(v - box[0][i])), surfaces, ...(sum!.solids ? { solids: sum!.solids } : {}) };
    }
  } catch { /* unmeasured: named, not sized */ }
  cache.set(lib, entry); version++;
}
let version = 0;   // bumped by every measurement: the door's spatial index is valid for one version of what's measured

/** Make every lib in `libs` answerable synchronously. */
export async function warm(libs: Iterable<unknown>): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const lib of new Set(libs)) {
    if (!isLibPath(lib) || cache.has(lib)) continue;
    let j = pending.get(lib);
    if (!j) { j = measure(lib).finally(() => pending.delete(lib)); pending.set(lib, j); }
    jobs.push(j);
  }
  await Promise.all(jobs);
}

/** Every string under a `model` key anywhere in a request (create {model}, components.model, set {component:
 *  'model', value}, batch ops…): what to warm before the door sees it. */
export function modelsIn(args: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 16 || !args || typeof args !== "object") return out;
  const a = args as Record<string, unknown>;
  if (typeof a.model === "string") out.push(a.model);
  if (a.component === "model" && typeof a.value === "string") out.push(a.value);
  for (const v of Object.values(a)) if (v && typeof v === "object") modelsIn(v, out, depth + 1);
  return out;
}

let listing: string[] | null = null;
function libraryListing(): string[] {
  if (listing) return listing;
  const out: string[] = [];
  for (const base of [OPT_DIR, LIBRARY_DIR]) {
    const walk = (d: string, depth: number) => { if (depth > 6 || out.length > 5000) return; let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) { const p = join(d, n); let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (/\.glb$/i.test(n) && !/\.(lod|ktx2)\./i.test(n)) out.push(relative(base, p)); } };
    walk(base, 0);
  }
  return (listing = [...new Set(out)].sort());
}

/** The door's catalogue interface (shared/v4/door.js: get / list). */
export const ENGINE_CATALOGUE = {
  get version() { return version; },
  get(name: string): Entry | undefined {
    if (!isLibPath(name)) return undefined;
    return cache.get(name) ?? { label: name.split("/").pop()!, surfaces: [] }; // cold: named, not sized (warm first)
  },
  list(q: string): [string, Entry][] {
    const ql = String(q ?? "").toLowerCase();
    return libraryListing().filter((l) => l.toLowerCase().includes(ql)).slice(0, 200).map((l) => [l, cache.get(l) ?? { label: l.split("/").pop()!, surfaces: [] }]);
  },
};
