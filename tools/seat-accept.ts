/**
 * seat-accept — the operator's half of the seat-profile lifecycle (#101 B4).
 *
 * Countersign deliberately has NO HTTP path: an accepted profile moves every
 * wearer of an avatar, so acceptance is an act performed on the box, by the
 * operator, with a review receipt in hand. This tool edits the same store the
 * server serves (assets/opt/seats/profiles.json); a running server notices
 * the change by mtime within ~5s and pushes `avatar-profile-updated` itself —
 * no restart, no endpoint.
 *
 *   bun run tools/seat-accept.ts list
 *   bun run tools/seat-accept.ts propose <derivation.json> [--operator name]
 *   bun run tools/seat-accept.ts accept <avatar> <pose> --receipt <url> --by <reviewer>
 *
 * `propose` is the operator-import lane: environments with no home node (a
 * local dev door) cannot attribute an HTTP proposer, and inventing authorship
 * is worse than naming the operator who carried the file in.
 */

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatStore } from "../server/seats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPT_DIR = join(ROOT, "assets", "opt");
const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const store = new SeatStore(OPT_DIR, LIBRARY_DIR);

if (cmd === "list") {
  const { rev, records } = store.list();
  console.log(`profiles.json rev ${rev}`);
  if (!records.length) console.log("  (no records)");
  for (const r of records) console.log(`  ${r.name}/${r.pose} [${r.slot}] ${r.status}`);
} else if (cmd === "propose") {
  const file = args[1];
  if (!file) { console.error("usage: seat-accept.ts propose <derivation.json> [--operator name]"); process.exit(2); }
  const record = JSON.parse(await Bun.file(file).text());
  const r = store.importProposal(record, flag("operator") ?? process.env.USER ?? process.env.USERNAME ?? "operator");
  if (!r.ok) { console.error(`refused: ${r.why}`); process.exit(1); }
  console.log(`proposed ${r.name}/${r.pose} → rev ${r.rev} (a running server will announce it within ~5s)`);
} else if (cmd === "accept") {
  const [, name, pose] = args;
  const receipt = flag("receipt"), by = flag("by");
  if (!name || !pose || !receipt || !by) {
    console.error("usage: seat-accept.ts accept <avatar> <pose> --receipt <url> --by <reviewer>");
    process.exit(2);
  }
  const r = store.accept(name, pose, receipt, by);
  if (!r.ok) { console.error(`refused: ${r.why}`); process.exit(1); }
  console.log(`accepted ${name}/${pose} → rev ${r.rev} (receipt ${receipt}, by ${by})`);
} else {
  console.error("commands: list | propose <file> | accept <avatar> <pose> --receipt <url> --by <reviewer>");
  process.exit(2);
}
