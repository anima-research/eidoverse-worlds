// server/modelcatalogue.ts — the authority's model catalogue in the engine: library paths, measured from their GLBs.
//
// The lab's authority read its own table (shared/protocol/componentspec.js: table, chair, crate… with hand-written sizes). The
// engine's models are library paths (`eidoverse/assets/models/…glb`, `store/<hash>.glb`), so the catalogue here is
// what server/geometry.ts measures from the same GLB the client renders: the bounding box (in the model's own frame:
// a GLB's origin is wherever its author put it) and the up-facing flat zones (seat pans, table tops) as surfaces.
//
// The authority is synchronous and measuring is not, so this is a warm cache (the boxes.ts pattern): warm(libs) is awaited
// on the wire before a request reaches the authority (and on world load for every model standing in it); get(lib) answers
// at once. A lib this server can't find or parse is still a model the authority may NAME (refusing it would make worlds
// stop at whatever this host happens to have on disk), but it has no size: the authority says it can't place or collide
// it. A name that isn't a library path at all is refused (no model called …).
import { resolveLibFile } from "./libfile.ts";
import { r3 } from "../shared/protocol/round.js";
import { isEido, eidoHex, modelWord } from "../shared/eido.js";
import { eidoRel, originalOf, noteEido } from "./eidoindex.ts";
import { summarizeGlb } from "./geometry.ts";
import { readdirSync, statSync, readFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { creditsFor } from "../shared/libcredits.js";
import { join, relative } from "node:path";
import { OPT_DIR, LIBRARY_DIR, ROOT } from "./config.ts";

export type Entry = { label: string; size?: number[]; box?: number[][]; surfaces: { y: number; x?: number[]; z?: number[] }[]; solids?: number[][][]; credits?: Record<string, unknown> | null; sha256?: string };
// batch 2: who made each shipped asset (defs/library/credits.json, from the library's own CREDITS.md): the authority's
// inspect says it beside the model (derived.asset), /library-models beside each row
let CREDITS: Record<string, any> | null = null;
export function libraryCredits(): Record<string, any> {
  if (CREDITS) return CREDITS;
  try { CREDITS = JSON.parse(readFileSync(join(ROOT, "defs", "library", "credits.json"), "utf8")); } catch { CREDITS = {}; }
  return CREDITS!;
}
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
/** What a library path looks like (resolveLibFile's own rule, plus the content store's names). */
export const isLibPath = (s: unknown): s is string => isEido(s) || (typeof s === "string" && s.length <= 512 && !s.includes("..") && /^[A-Za-z0-9_./-]+\.(glb|vrm)$/i.test(s));
const MIN_ZONE = 0.02; // m²: smaller up-facing zones are trim and bevels, not surfaces

/** The sha256 of a file, streamed (the event loop keeps turning between chunks: other worlds aren't held up by a big model). */
const hashFile = (file: string): Promise<string | null> => new Promise((res) => {
  const h = createHash("sha256"); const s = createReadStream(file);
  s.on("data", (b) => h.update(b)); s.on("end", () => res(h.digest("hex"))); s.on("error", () => res(null)); });
/** A library path an old address names here (the index), or null. */
const pathOfAddress = (m: string): string | null => (isEido(m) ? eidoRel(eidoHex(m)!) : null);

async function measure(lib: string): Promise<void> {
  const named = pathOfAddress(lib) ?? lib;   // an old address is labelled by the file it names here
  const label = modelWord(named).replace(/[_-]+/g, " ");   // an address no file here names is "thing", never its hex
  let entry: Entry = { label, surfaces: [] };
  // R 10-17: what its bytes are (model-hash, stamped beside the path by the authority), hashed HERE, off the authority's
  // request: warm is awaited before a request reaches it. The original's bytes (the library's, never the optimized mirror's),
  // as a content address always named; an old address is its own hash. Nothing depends on it: unhashed, nothing is stamped
  try {
    const hex = isEido(lib) ? eidoHex(lib) : (() => { const o = originalOf(lib); return o ? hashFile(o) : null; })();
    const h = await hex; if (h) { entry.sha256 = h; if (!isEido(lib)) noteEido(h, lib); }
  } catch { /* unhashed */ }
  try {
    const file = resolveLibFile(lib);
    const sum = file ? await summarizeGlb(file, { solids: true }) : null;
    const bb = sum?.bbox;
    if (bb && [...bb.min, ...bb.max].every(Number.isFinite)) {
      const box = [bb.min.map(r3), bb.max.map(r3)];
      const surfaces = (sum!.topSurfaces ?? []).filter((s) => s.area >= MIN_ZONE && [s.y, ...s.x, ...s.z].every(Number.isFinite))
        .map((s) => ({ y: r3(s.y), x: s.x.map(r3), z: s.z.map(r3) })).sort((a, b) => a.y - b.y);
      // its solid parts (server/solids.ts): a building's walls, floor and roof with its rooms open, so a body walks in
      // through the authority and a thing can be put down inside (review 10-06 S0-3); absent, the box is the solid
      entry = { ...entry, label, box, size: box[1].map((v, i) => r3(v - box[0][i])), surfaces, ...(sum!.solids ? { solids: sum!.solids } : {}) };
    }
  } catch { /* unmeasured: named, not sized */ }
  cache.set(lib, entry); version++;
}
let version = 0;   // bumped by every measurement: the authority's spatial index is valid for one version of what's measured

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
 *  'model', value}, batch ops…): what to warm before the authority sees it. */
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

/** The authority's catalogue interface (shared/protocol/authority.js: get / list). */
export const ENGINE_CATALOGUE = {
  get version() { return version; },
  get(name: string): Entry | undefined {
    if (!isLibPath(name)) return undefined;
    const e = cache.get(name) ?? { label: isEido(name) ? modelWord(name, pathOfAddress) : name.split("/").pop()!, surfaces: [] }; // cold: named, not sized (warm first); an address by the file it names, never its hex
    // who made it, by its library PATH (review r7 F3: an old address's credits are its file's); every entry is its own object
    if (e.credits === undefined) e.credits = creditsFor(libraryCredits(), pathOfAddress(name) ?? name);
    return e;
  },
  /** The library path an old content address (eido:sha256/<hex>, stored before 10-17) names on this host, or null: the load
   *  repair writes it back as the model (shared/protocol/shaperepair.js). */
  pathOf(name: string): string | null { return typeof name === "string" ? pathOfAddress(name) : null; },
  list(q: string): [string, Entry][] {
    const ql = String(q ?? "").toLowerCase();
    return libraryListing().filter((l) => l.toLowerCase().includes(ql)).slice(0, 200).map((l) => [l, cache.get(l) ?? { label: l.split("/").pop()!, surfaces: [] }]);
  },
};
