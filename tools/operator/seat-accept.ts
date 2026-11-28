/**
 * seat-accept — the operator's half of the seat-profile lifecycle (#101). Acceptance has no HTTP path on purpose:
 * an accepted profile moves every wearer of an avatar, so it is done on the box with a review receipt. This edits
 * the store the server serves (OPT_DIR/seats/profiles.json); a running server notices by mtime (server/seats.ts)
 * and pushes `avatar-profile-updated` itself.
 *
 *   bun run tools/operator/seat-accept.ts list
 *   bun run tools/operator/seat-accept.ts propose <derivation.json> [--operator name] [--allow-unrostered]
 *   bun run tools/operator/seat-accept.ts accept <avatar> <pose> --receipt <url> --by <reviewer> --expect-rev <n>
 *
 * `propose` names the operator who carried the file in (a local door has no HTTP proposer to attribute).
 * `--expect-rev` is mandatory: if the store moved since `list`, accept refuses rather than bless an unreviewed record.
 */

// the server's own store (server/config.ts OPT_DIR, LIBRARY_DIR, PATCH_DIR): the file a running server serves
import { seatStore as store } from "../../server/seats.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};


if (cmd === "list") {
  const { rev, records } = store.list();
  console.log(`profiles.json rev ${rev}`);
  if (!records.length) console.log("  (no records)");
  for (const r of records) console.log(`  ${r.name}/${r.pose} [${r.slot}] ${r.status}`);
} else if (cmd === "propose") {
  const file = args[1];
  if (!file) { console.error("usage: seat-accept.ts propose <derivation.json> [--operator name] [--allow-unrostered]"); process.exit(2); }
  const record = JSON.parse(await Bun.file(file).text());
  const r = store.importProposal(record, flag("operator") ?? process.env.USER ?? process.env.USERNAME ?? "operator",
    { allowUnrostered: args.includes("--allow-unrostered") });
  if (!r.ok) { console.error(`refused: ${r.why}`); process.exit(1); }
  console.log(`proposed ${r.name}/${r.pose} → rev ${r.rev} (a running server will announce it within ~5s)`);
} else if (cmd === "accept") {
  const [, name, pose] = args;
  const receipt = flag("receipt"), by = flag("by");
  const expectRev = Number(flag("expect-rev"));
  if (!name || !pose || !receipt || !by || !Number.isInteger(expectRev)) {
    console.error("usage: seat-accept.ts accept <avatar> <pose> --receipt <url> --by <reviewer> --expect-rev <n>\n(--expect-rev = the revision `list` printed when you reviewed — accept exactly what you saw)");
    process.exit(2);
  }
  const r = store.accept(name, pose, receipt, by, expectRev);
  if (!r.ok) { console.error(`refused: ${r.why}`); process.exit(1); }
  console.log(`accepted ${name}/${pose} → rev ${r.rev} (receipt ${receipt}, by ${by})`);
} else {
  console.error("commands: list | propose <file> [--allow-unrostered] | accept <avatar> <pose> --receipt <url> --by <reviewer> --expect-rev <n>");
  process.exit(2);
}
