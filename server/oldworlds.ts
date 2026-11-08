// server/oldworlds.ts — worlds saved in an old format, found and named (owner 10-15: "when someone tries to open a world
// saved by the old protocol, ping them with 'use the translator'"). The server serves only worlds in this protocol; a
// directory holding an old log is never opened. Before this file it was skipped in silence at boot (the operator was
// never told) and a visitor was handed a command line they can't run. Now:
//   - the OPERATOR is told at boot, one block per world, with the exact command (bootNotice);
//   - a VISITOR is told in plain words that the world is safe and needs a one-time conversion (visitorText).
// Two kinds, never confused:
//   translatable  a log.jsonl of the first protocol's verbs: tools/protocol/world.ts translate <name> translates it in
//                 place (the world keeps its name; the old log is renamed log.original.jsonl beside it, never written);
//   pre-names     a log of this protocol's family saved before the 2026-10-07 names pass (livehost isPreNamesDir): it
//                 can't be translated as it stands; it's re-translated from its ORIGINAL old log, or refounded.
// A world holding translation.lock (an in-place swap that stopped midway) is neither: never served, named at boot (interruptedSwapsIn).
// Pure reads of the directory: nothing here writes, and nothing here loads the translator.
import fs from "node:fs";
import path from "node:path";
import { isWorldDir, isPreNamesDir, isSwapUnfinished, swapRecovery } from "./livehost.ts";
import { notPlainIn, notPlainWords } from "./backups.ts";

export type OldWorldKind = "translatable" | "pre-names";
export type OldWorld = {
  name: string;
  kind: OldWorldKind;
  /** the old log found (absolute path) */
  file: string;
  /** a world name that is free in this directory (nothing on disk under it): a pre-names world's re-translation goes there */
  suggestedName: string;
  /** the operator's first command (the dry run: the report and its hash, nothing written), WORLDS_DIR filled in */
  command: string;
  /** the second: the translation, bound to the approved report hash, on the operator's countersignature alone (no owner can be attested) */
  approve: string;
  /** pre-names only: refounding it empty under the suggested name, when its original log is gone */
  refound?: string;
  /** what a visitor is told: plain words, no command line */
  visitor: string;
};

/** What a client that doesn't fold the log is told at join (server.ts, the 4005 refusal). A NATIVE session (the Unreal client,
 *  signed in through native-login: isNativeSession, native: true or an older nativeWorld) is told the truth about itself: this build can't fold the log
 *  (review of PR #260, Mica, item 7); a current build never sees it, since it rejoins through its bridge on this close. Anyone else
 *  (an old page, an old agent build) is told to reload or update. */
export function noFoldRefusal(world: string, native: boolean): string {
  return native
    ? `"${world}" is a world of the current protocol, and this Unreal build can't fold its log. Nothing is wrong with your sign-in or with the world: update the Unreal client (current builds join through their local bridge), or join from a browser.`
    : `"${world}" needs a client that folds its log, and this one doesn't — reload the page for the current client, or update the agent`;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;   // a letter or digit first: "-x" would read as a flag to the CLI
const TOOL = "bun tools/protocol/world.ts";
export const HASH_PLACEHOLDER = "<the report hash the dry run printed>";
/** Who claims a world with no owner (world.ts --claim): the operator running the commands, as the browser path's upgrader does. */
export const CLAIMER = "EIDO_UPGRADER_ACCOUNT=<your-account>";
const CLAIMS = "<your-account> is your account as SERVER_OPERATORS lists it (e.g. human:<provider>:<id>): a world with no owner becomes yours, and everyone else keeps building there as in main; a world with owners keeps them.";
const APPROVAL = "The dry run writes nothing: it prints what the translation would do (what is dropped by design, what it would refuse) and the report's hash. Read it; then translate it, bound to that hash:";
const KEPT_IN_PLACE = "It keeps its name, so links to it keep working; the original log is kept untouched beside it as log.original.jsonl.";
const KEPT = "the original log is kept untouched; translate into a new name, then point links at it (or rename the directories)";

/** A shell word as typed (a directory with spaces or quotes is single-quoted). */
export const shellWord = (s: string): string => (/^[\w/.,:@%+=~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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
    ? `"${name}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server or the world's owner. Nothing is lost — the world's log is kept as it was.`
    : `"${name}" was saved while this version of Eidoverse was still settling its names, and whoever runs this server needs to convert it again before it can open. Nothing is lost — the world's saved log is kept as it was.`;
}

/** The old world at `dir/name`, or null when that is a current world, holds no old log (an empty directory), or is missing. */
export function oldWorldAt(dir: string, name: string): OldWorld | null {
  if (!NAME.test(name)) return null;
  const d = path.join(dir, name);
  let st: fs.Stats; try { st = fs.lstatSync(d); } catch { return null; }
  if (!st.isDirectory() || isWorldDir(d) || isSwapUnfinished(d)) return null;   // an unfinished swap is its own case (interruptedSwapsIn); lstat: a symlinked world dir is never followed (backup, translate)
  const suggestedName = freeName(dir, name);
  const head = `WORLDS_DIR=${shellWord(dir)} ${TOOL}`, claimHead = `${CLAIMER} ${head}`;
  if (isPreNamesDir(d)) {   // checked first: such a log may be named log.jsonl too (an older file name)
    const file = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort((a, b) => (a === "world.jsonl" ? -1 : b === "world.jsonl" ? 1 : a.localeCompare(b)))[0]!;
    return { name, kind: "pre-names", file: path.join(d, file), suggestedName,
      command: `${claimHead} translate <its-original-old-world> ${suggestedName} --dry-run --no-founder-key --claim`,
      approve: `${claimHead} translate <its-original-old-world> ${suggestedName} --no-founder-key --approved ${HASH_PLACEHOLDER} --operator-only-no-owner --claim`,
      refound: `${head} found ${suggestedName} --owner <your id>`, visitor: visitorText(name, "pre-names") };
  }
  const file = path.join(d, "log.jsonl");
  if (!fs.existsSync(file)) return null;
  return { name, kind: "translatable", file, suggestedName,
    command: `${claimHead} translate ${name} --dry-run --no-founder-key --claim`,
    approve: `${claimHead} translate ${name} --no-founder-key --approved ${HASH_PLACEHOLDER} --operator-only-no-owner --claim`, visitor: visitorText(name, "translatable") };
}

/** Every old world in `dir`, by name. */
export function oldWorldsIn(dir: string): OldWorld[] {
  let names: string[]; try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  return names.map((n) => oldWorldAt(dir, n)).filter((o): o is OldWorld => !!o);
}

/** Every world in `dir` whose in-place translation stopped mid-swap (it holds livehost's SWAP_MARKER), by name. */
export function interruptedSwapsIn(dir: string): string[] {
  let names: string[]; try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  return names.filter((n) => NAME.test(n) && isSwapUnfinished(path.join(dir, n)));
}
/** What a visitor is told about a world whose conversion was interrupted. */
export const interruptedVisitorText = (name: string) => `"${name}" is in the middle of a one-time conversion that was interrupted, so it can't open yet. Whoever runs this server needs to finish it. Nothing is lost.`;

/** What the server logs at boot about `dir`'s old worlds: one block per world and one summary line ("" when there are none). */
export function bootNotice(dir: string): string {
  const half = interruptedSwapsIn(dir).map((n) => `[boot] world "${n}" is NOT being served: ${swapRecovery(n, `WORLDS_DIR=${shellWord(dir)} ${TOOL}`)}`).join("\n");
  const old = oldWorldsIn(dir);
  if (!old.length) return half;
  const blocks = old.map((o) => {
    const at = path.relative(dir, o.file).split(path.sep).join("/");
    let link: string | null = null; try { link = o.kind === "translatable" ? notPlainIn(path.join(dir, o.name)) : null; } catch { /* unreadable: the upgrade says */ }
    return o.kind === "translatable"
      ? [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved by an older version of Eidoverse (a log.jsonl of the first protocol). Translate it once, in place. First the dry run:`,
         `    ${o.command}`,
         `  ${APPROVAL}`,
         `    ${o.approve}`,
         `  ${CLAIMS}`,
         `  A translation names no founder: nothing can yet bind a key to the old world's owner (an old-format log records accounts, not keys), so the world's top governance tier (tier 0) stays empty, the operator's countersignature is the only signature, and the record says no owner was attested.`,
         `  ${KEPT_IN_PLACE}`,
         `  The translation first copies the whole directory, verified, to BACKUPS_DIR (backups/ beside the worlds directory). Or open it in the browser signed in as a server operator (an account in SERVER_OPERATORS, or the one that opened the setup link): its splash offers Upgrade world…, the same steps.`,
         ...(link ? [`  It can't be upgraded as it stands: ${notPlainWords(`${o.name}/${link}`)}.`] : [])].join("\n")
      : [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved before this server's protocol names changed (2026-10-07), so it can't be translated as it stands. Re-translate it from its original old log (the directory its first-protocol log.jsonl is in) into a new world. First the dry run:`,
         `    ${o.command}`,
         `  ${APPROVAL}`,
         `    ${o.approve}`,
         `  ${CLAIMS}`,
         `  or, if that original is gone, refound it empty:`,
         `    ${o.refound}`,
         `  ${KEPT}`].join("\n");
  });
  return `${half ? `${half}\n` : ""}${blocks.join("\n")}\n[boot] ${old.length} world(s) need translating — see above`;
}
