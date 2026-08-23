// eidoverse-worlds sequencer — the def registry (overhaul charter §3,
// phase 1 slice 2). Instance content as data: defs/<domain>/<name>.json,
// validated against the shared contract at load, served whole at GET /defs.
//
// A def that fails validation is refused LOUDLY (boot/reload log) and the
// rest keep serving — one bad file must not take the meadows down with it.
// The registry rescans on a short TTL, so editing a def during dev shows up
// on the next client boot without a server restart; clients fetch once per
// boot, so the rescan costs nothing in steady state.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./config.ts";
import { validateFloraDef } from "../shared/floradefs.js";

// Scratch sequencers point this elsewhere, same pattern as WORLDS_DIR.
export const DEFS_DIR = resolve(process.env.DEFS_DIR ?? join(ROOT, "defs"));

const TTL_MS = 1000;
let cached: { at: number; json: string } | null = null;

function loadDomain(domain: string, validate: (name: string, def: unknown) => string[]) {
  const dir = join(DEFS_DIR, domain);
  const out: Record<string, unknown> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
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

/** The /defs response body, rebuilt at most once per TTL. */
export function defsPayload(): string {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.json;
  const flora = loadDomain("flora", validateFloraDef);
  const json = JSON.stringify({ flora });
  if (!cached || cached.json !== json) {
    console.log(`[defs] serving ${Object.keys(flora).length} flora def(s) from ${DEFS_DIR}`);
  }
  cached = { at: now, json };
  return json;
}
