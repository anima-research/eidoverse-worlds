// server/oldworlds.ts — worlds saved in an old format, found and named (owner 10-15: "when someone tries to open a world
// saved by the old protocol, ping them with 'use the translator'"). The server serves only worlds in this protocol; a
// directory holding an old log is never opened. Before this file it was skipped in silence at boot (the operator was
// never told) and a visitor was handed a command line they can't run. Now:
//   - the OPERATOR is told at boot, one block per world, with the exact command (bootNotice);
//   - a VISITOR is told in plain words that the world is safe and needs a one-time conversion (visitorText).
// Two kinds, never confused:
//   translatable  a log.jsonl of the first protocol's verbs: tools/protocol/world.ts translate reads it (never writes it)
//                 into a NEW world;
//   pre-names     a log of this protocol's family saved before the 2026-10-07 names pass (livehost isPreNamesDir): it
//                 can't be translated as it stands; it's re-translated from its ORIGINAL old log, or refounded.
// Pure reads of the directory: nothing here writes, and nothing here loads the translator.
import fs from "node:fs";
import path from "node:path";
import { isWorldDir, isPreNamesDir } from "./livehost.ts";

export type OldWorldKind = "translatable" | "pre-names";
export type OldWorld = {
  name: string;
  kind: OldWorldKind;
  /** the old log found (absolute path) */
  file: string;
  /** a world name that is free in this directory (nothing on disk under it) */
  suggestedName: string;
  /** the operator's command, WORLDS_DIR filled in, the founder's key a placeholder */
  command: string;
  /** pre-names only: refounding it empty under the suggested name, when its original log is gone */
  refound?: string;
  /** what a visitor is told: plain words, no command line */
  visitor: string;
};

const NAME = /^[a-z0-9_-]{1,64}$/i;
const TOOL = "bun tools/protocol/world.ts";
export const FOUNDER_KEY_PLACEHOLDER = "<the founder's ed25519 key>";
const KEPT = "the original log is kept untouched; translate into a new name, then point links at it (or rename the directories)";

/** A shell word as typed (a directory with spaces or quotes is single-quoted). */
const sh = (s: string) => (/^[\w/.,:@%+=~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `<name>-2`, `-3`, …: the first that nothing on disk holds (an empty directory counts as taken), within the name grammar. */
function freeName(dir: string, name: string): string {
  for (let k = 2; ; k++) {
    const tail = `-${k}`;
    const cand = name.slice(0, 64 - tail.length) + tail;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
}

export function visitorText(name: string, kind: OldWorldKind): string {
  return kind === "translatable"
    ? `"${name}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost — the world's log is kept as it was.`
    : `"${name}" was saved while this version of Eidoverse was still settling its names, and whoever runs this server needs to convert it again before it can open. Nothing is lost — the world's saved log is kept as it was.`;
}

/** The old world at `dir/name`, or null when that is a current world, holds no old log (an empty directory), or is missing. */
export function oldWorldAt(dir: string, name: string): OldWorld | null {
  if (!NAME.test(name)) return null;
  const d = path.join(dir, name);
  let st: fs.Stats; try { st = fs.statSync(d); } catch { return null; }
  if (!st.isDirectory() || isWorldDir(d)) return null;
  const suggestedName = freeName(dir, name);
  const head = `WORLDS_DIR=${sh(dir)} ${TOOL}`;
  if (isPreNamesDir(d)) {   // checked first: such a log may be named log.jsonl too (an older file name)
    const file = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort((a, b) => (a === "world.jsonl" ? -1 : b === "world.jsonl" ? 1 : a.localeCompare(b)))[0]!;
    return { name, kind: "pre-names", file: path.join(d, file), suggestedName,
      command: `${head} translate <its-original-old-world> ${suggestedName} --founder-key ${FOUNDER_KEY_PLACEHOLDER}`,
      refound: `${head} found ${suggestedName} --owner <your id>`, visitor: visitorText(name, "pre-names") };
  }
  const file = path.join(d, "log.jsonl");
  if (!fs.existsSync(file)) return null;
  return { name, kind: "translatable", file, suggestedName,
    command: `${head} translate ${name} ${suggestedName} --founder-key ${FOUNDER_KEY_PLACEHOLDER}`, visitor: visitorText(name, "translatable") };
}

/** Every old world in `dir`, by name. */
export function oldWorldsIn(dir: string): OldWorld[] {
  let names: string[]; try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  return names.map((n) => oldWorldAt(dir, n)).filter((o): o is OldWorld => !!o);
}

/** What the server logs at boot about `dir`'s old worlds: one block per world and one summary line ("" when there are none). */
export function bootNotice(dir: string): string {
  const old = oldWorldsIn(dir);
  if (!old.length) return "";
  const blocks = old.map((o) => {
    const at = path.relative(dir, o.file);
    return o.kind === "translatable"
      ? [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved by an older version of Eidoverse (a log.jsonl of the first protocol). Translate it once into a new world:`,
         `    ${o.command}`,
         `  The founder makes that key on their own machine and you check it with \`${TOOL} owner-key <key> <signature>\`; --no-founder-key instead leaves the world's top governance tier empty for ever.`,
         `  ${KEPT}`].join("\n")
      : [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved before this server's protocol names changed (2026-10-07), so it can't be translated as it stands. Re-translate it from its original old log (the directory its first-protocol log.jsonl is in) into a new world:`,
         `    ${o.command}`,
         `  or, if that original is gone, refound it empty:`,
         `    ${o.refound}`,
         `  ${KEPT}`].join("\n");
  });
  return `${blocks.join("\n")}\n[boot] ${old.length} world(s) need translating — see above`;
}
