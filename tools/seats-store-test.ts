/**
 * seats-store fixture — #105 review B2/B3: the rights-bearing store's
 * integrity boundaries, driven with injected faults.
 *
 * B2: dangerous keys never index the maps (schema refusal + null-prototype
 * maps + roster membership), and a refused write mutates NOTHING — no store,
 * no log, no Object.prototype.
 * B3: every write is provenance-first. An append failure changes nothing; a
 * snapshot failure leaves the log AHEAD and a fresh load folds it forward
 * (durable-with-receipt or not at all); a snapshot AHEAD of its log is
 * quarantined and served as missing; a countersign against a moved revision
 * refuses.
 *
 * Run: bun run tools/seats-store-test.ts   (scratch dirs only)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatStore } from "../server/seats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const OPT = mkdtempSync(join(tmpdir(), "seatstore-"));
mkdirSync(join(OPT, "eidoverse/assets/vrms"), { recursive: true });
writeFileSync(join(OPT, "eidoverse/assets/vrms/seatdummy.vrm"), "not a real vrm — roster presence is what's under test");

const profile = (avatar: string, pose = "sitchair") => ({
  avatar, avatarSha256: "a".repeat(64), pose, clipSha256: "c".repeat(64),
  seatContactY: 0.2055,
  derivation: { toolVersion: "seatlab-4", method: "skinned-pelvis-contact-v1",
    winner: { mesh: "Body", vertexIndex: 42, rootLocal: [0, 0.2055, 0] },
    supportPatch: { count: 31, spreadY: 0.0184, radiusXZ: 0.1 }, runs: 3, deterministic: true },
  review: { status: "proposed" },
});
const seatsDir = join(OPT, "seats");
const snapshotOf = () => existsSync(join(seatsDir, "profiles.json")) ? readFileSync(join(seatsDir, "profiles.json"), "utf8") : null;
const logOf = () => existsSync(join(seatsDir, "profiles.log.jsonl")) ? readFileSync(join(seatsDir, "profiles.log.jsonl"), "utf8") : null;

try {
  console.log("B2 — dangerous keys and unknown subjects bounce whole");
  {
    const store = new SeatStore(OPT, LIB);
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      const r = store.propose(profile(bad), "attacker") as any;
      check(`avatar "${bad}" refused with a 4xx`, !r.ok && r.status >= 400 && r.status < 500, JSON.stringify(r));
    }
    const unknown = store.propose(profile("ghost-rig"), "someone") as any;
    check("unrostered avatar refused (404 — no bytes to judge against)", !unknown.ok && unknown.status === 404, JSON.stringify(unknown));
    const pose = store.propose(profile("seatdummy", "sitground"), "someone") as any;
    check("pose outside the slice refused", !pose.ok && pose.status === 422);
    check("refused writes mutated nothing on disk", snapshotOf() === null && logOf() === null);
    check("refused writes left rev at 0", store.rev === 0);
    check("Object.prototype is unpolluted", ({} as any).polluted === undefined
      && !("sitchair" in {}) && Object.keys({}).length === 0
      && ({} as any).accepted === undefined && ({} as any).proposed === undefined);
  }

  console.log("happy path + countersign CAS (B3)");
  {
    const store = new SeatStore(OPT, LIB);
    const p = store.propose(profile("seatdummy"), "aid1:someone") as any;
    check("rostered proposal lands at rev 1", p.ok && p.rev === 1);
    check("the log line precedes and matches the snapshot rev",
      JSON.parse(logOf()!.trim().split("\n").at(-1)!).rev === 1 && JSON.parse(snapshotOf()!).rev === 1);
    const noRev = store.accept("seatdummy", "sitchair", "receipt", "op", undefined as any) as any;
    check("accept without expectedRev refused", !noRev.ok && /expectedRev required/.test(noRev.why));
    const stale = store.accept("seatdummy", "sitchair", "receipt", "op", 0) as any;
    check("accept against a moved revision refused (review what you sign)", !stale.ok && /re-list/.test(stale.why));
    const good = store.accept("seatdummy", "sitchair", "receipt", "op", 1) as any;
    check("accept at the reviewed revision lands at rev 2", good.ok && good.rev === 2);

    // two writers: B holds a stale view while A advances the disk
    const storeB = new SeatStore(OPT, LIB);
    const p2 = store.propose(profile("seatdummy"), "aid1:someone") as any;   // disk → rev 3
    const clobber = storeB.accept("seatdummy", "sitchair", "receipt", "op", 2) as any;
    check("a second process cannot countersign from a stale snapshot", p2.ok && !clobber.ok && /re-list/.test(clobber.why));
    const honest = storeB.accept("seatdummy", "sitchair", "receipt2", "op", 3) as any;
    check("…and succeeds after re-reviewing the moved store", honest.ok && honest.rev === 4);
  }

  console.log("B3 — injected faults leave no unreceipted state");
  {
    const failAppend = new SeatStore(OPT, LIB, { appendFileSync: () => { throw new Error("disk full"); } });
    const revBefore = failAppend.rev;
    const r = failAppend.propose(profile("seatdummy"), "someone") as any;
    check("append failure: write refused, nothing changed", !r.ok && /provenance append failed/.test(r.why));
    check("append failure: in-memory rev unchanged", failAppend.rev === revBefore);
    check("append failure: disk snapshot unchanged", JSON.parse(snapshotOf()!).rev === revBefore);

    const failRename = new SeatStore(OPT, LIB, { renameSync: () => { throw new Error("rename torn"); } });
    const revBefore2 = failRename.rev;
    const r2 = failRename.propose(profile("seatdummy"), "someone") as any;
    check("snapshot failure: reported as failure, live store unchanged", !r2.ok && failRename.rev === revBefore2, JSON.stringify(r2));
    const logRev = JSON.parse(logOf()!.trim().split("\n").at(-1)!).rev;
    check("snapshot failure: the log holds the receipt (log ahead by one)", logRev === revBefore2 + 1);

    // recovery: a fresh load folds the receipted write forward
    const recovered = new SeatStore(OPT, LIB);
    check("recovery folds the log-ahead write forward", recovered.rev === logRev, `rev=${recovered.rev}`);
    check("…and the recovered record is live", recovered.list().records.some((x) => x.name === "seatdummy" && x.slot === "proposed"));
    check("…and the snapshot was rewritten to match its receipts", JSON.parse(snapshotOf()!).rev === logRev);
  }

  console.log("B3 — a snapshot with no receipt is quarantined");
  {
    const snap = JSON.parse(snapshotOf()!);
    writeFileSync(join(seatsDir, "profiles.json"), JSON.stringify({ ...snap, rev: snap.rev + 50 }));
    const q = new SeatStore(OPT, LIB);
    check("snapshot ahead of its log → quarantined", q.quarantineReason !== null);
    check("quarantined store serves missing, never the unreceipted state",
      q.judge("seatdummy", join(OPT, "eidoverse/assets/vrms/seatdummy.vrm")).status === "missing");
    const w = q.propose(profile("seatdummy"), "someone") as any;
    check("quarantined store refuses writes (503)", !w.ok && w.status === 503);
  }
} finally {
  rmSync(OPT, { recursive: true, force: true });
}

console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
