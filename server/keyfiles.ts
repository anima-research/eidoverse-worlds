// server/keyfiles.ts — where a worlds dir keeps the files every world in it shares, outside every log: the authority's
// governance keys (server/custody.ts) and its identity directory (server/directory.ts). Both are written 0600.
//
// Before the 2026-10-07 names pass these files carried the protocol's number in their names. A worlds dir that still
// holds only the old name has it renamed once, the first time this server (or a tool) asks for the path, so a local
// world keeps its keys and its people keep their identities. If both names exist, the current one wins and the old one
// is left where it is (and said so): two files are never merged here.
import fs from "node:fs";
import path from "node:path";

export const CUSTODY_FILE = ".custody.json";
export const DIRECTORY_FILE = ".directory.json";
/** current name → the name the same file had before the names pass */
export const OLD_NAMES: Record<string, string> = { [CUSTODY_FILE]: ".v4-custody.json", [DIRECTORY_FILE]: ".v4-directory.json" };

const warned = new Set<string>();
/** The path of `name` in `worldsDir`, after renaming a file left under its old name. */
export function keyFileIn(worldsDir: string, name: string): string {
  const file = path.join(path.resolve(worldsDir), name), old = OLD_NAMES[name] && path.join(path.resolve(worldsDir), OLD_NAMES[name]);
  if (old && fs.existsSync(old)) {
    if (!fs.existsSync(file)) { fs.renameSync(old, file); console.log(`[keys] renamed ${old} → ${name} (once: the names pass of 2026-10-07)`); }
    else if (!warned.has(old)) { warned.add(old); console.warn(`[keys] ${old} is left beside ${name}: the current file is the one read; the old one is not merged (remove it when you're sure)`); }
  }
  return file;
}
export const custodyFileIn = (worldsDir: string) => keyFileIn(worldsDir, CUSTODY_FILE);
export const directoryFileIn = (worldsDir: string) => keyFileIn(worldsDir, DIRECTORY_FILE);
