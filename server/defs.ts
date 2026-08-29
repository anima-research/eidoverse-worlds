// eidoverse-worlds sequencer — the def registry (overhaul charter §3,
// phase 1 slice 2). Instance content as data: defs/<domain>/<name>.json,
// validated against the shared contract at load, served whole at GET /defs.
//
// A def that fails validation is refused LOUDLY (boot/reload log) and the
// rest keep serving — one bad file must not take the meadows down with it.
// The registry rescans on a short TTL, so editing a def during dev shows up
// on the next client boot without a server restart; clients fetch once per
// boot, so the rescan costs nothing in steady state.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./config.ts";
import { validateFloraDef, validateFloraColors, validateFloraPresets } from "../shared/floradefs.js";
import { validateAvatarDef } from "../shared/avatardefs.js";
import { validateAnimationDef, validateEmotes } from "../shared/animdefs.js";
import { validateSkyPresets } from "../shared/skydefs.js";
import { validateStructurePalette } from "../shared/structdefs.js";
import { validateGroundPalette } from "../shared/grounddefs.js";

// Scratch sequencers point this elsewhere, same pattern as WORLDS_DIR.
export const DEFS_DIR = resolve(process.env.DEFS_DIR ?? join(ROOT, "defs"));

const TTL_MS = 1000;
let cached: { at: number; reg: Record<string, Record<string, unknown>>; json: string } | null = null;

function loadDomain(domain: string, validate: (name: string, def: unknown) => string[]) {
  const dir = join(DEFS_DIR, domain);
  const out: Record<string, unknown> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    // underscore files are domain SIDECARS (_colors.json), not defs
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const name = f.slice(0, -5);
    try {
      const def = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const errs = validate(name, def);
      if (errs.length) {
        console.error(`[defs] REFUSED ${domain}/${f}: ${errs.join("; ")}`);
        continue;
      }
      out[name] = def;
    } catch (err) {
      console.error(`[defs] REFUSED ${domain}/${f}: unparseable JSON —`, err);
    }
  }
  return out;
}

/** Domain sidecars — whole tables validated as one, not def-per-file. */
function loadSidecar(rel: string, validate: (v: unknown) => string[]): Record<string, unknown> {
  const p = join(DEFS_DIR, rel);
  if (!existsSync(p)) return {};
  try {
    const table = JSON.parse(readFileSync(p, "utf8"));
    const errs = validate(table);
    if (errs.length) { console.error(`[defs] REFUSED ${rel}: ${errs.join("; ")}`); return {}; }
    const { doc: _doc, ...rest } = table;
    return rest;
  } catch (err) {
    console.error(`[defs] REFUSED ${rel}: unparseable JSON —`, err);
    return {};
  }
}

function registry() {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached;
  const reg = {
    flora: loadDomain("flora", validateFloraDef),
    floraColors: loadSidecar("flora/_colors.json", validateFloraColors),
    floraPresets: loadSidecar("flora/_presets.json", validateFloraPresets),
    avatars: loadDomain("avatars", validateAvatarDef),
    animations: loadDomain("animations", validateAnimationDef),
    emotes: loadSidecar("animations/_emotes.json", validateEmotes),
    skyPresets: loadSidecar("sky/_presets.json", validateSkyPresets),
    structurePalette: loadSidecar("structure/_palette.json", validateStructurePalette),
    groundPalette: loadSidecar("ground/_palette.json", validateGroundPalette),
  };
  const json = JSON.stringify(reg);
  if (!cached || cached.json !== json) {
    console.log(`[defs] serving ${Object.keys(reg.flora).length} flora`
      + ` + ${Object.keys(reg.avatars).length} avatar def(s) from ${DEFS_DIR}`);
  }
  cached = { at: now, reg, json };
  return cached;
}

/** The /defs response body, rebuilt at most once per TTL. */
export function defsPayload(): string { return registry().json; }

/** The avatar overlay, for the roster (routes.ts avatarRoster). */
export function avatarDefs(): Record<string, { vrm?: string; height?: number } & Record<string, unknown>> {
  return registry().reg.avatars as ReturnType<typeof avatarDefs>;
}

/** The animation overlay, for the clip roster (routes.ts animationRoster). */
export function animationDefs(): Record<string, { vrma?: string } & Record<string, unknown>> {
  return registry().reg.animations as ReturnType<typeof animationDefs>;
}

/** A cheap change fingerprint over every def file's (path, mtime, size) —
 *  the defs-watch tick system compares it once a second and broadcasts
 *  `defs-updated` when it moves, which is the whole hot-reload push. */
export function defsFingerprint(): string {
  const parts: string[] = [];
  if (!existsSync(DEFS_DIR)) return "";
  for (const domain of readdirSync(DEFS_DIR).sort()) {
    const dir = join(DEFS_DIR, domain);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".json")) continue;
      try { const s = statSync(join(dir, f)); parts.push(`${domain}/${f}:${s.mtimeMs}:${s.size}`); }
      catch { /* vanished mid-scan — the next tick sees the truth */ }
    }
  }
  return parts.join("|");
}
