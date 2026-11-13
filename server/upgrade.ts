// server/upgrade.ts — opening a world saved in an older format: the join's structured refusal, and the operator's upgrade.
// world-upgrade-review {id, world} → {type, id, ok, world, report, hash, warning?}: the CLI's dry run (nothing written).
// world-upgrade {id, world, approved} → {type, id, ok, world, backup, report, rollback, people, warning?}: the CLI's in-place translation, bound to
// that hash (a verified backup first: server/backups.ts). Both run tools/protocol/world.ts itself: the translation has one code path.
// A server operator (SERVER_OPERATORS) or the world's owner, by a proven account (R 10-28): an owner main's records bind to
// that account ("bound"), or one main recorded no account for whose name the account's is ("name", provisional):
// the access index (worldindex.ts ownerIn, server/ownerrecognise.ts). An ownerless world's upgrader becomes its owner (--claim); a recognised owner is bound to them (report.claim). The translation binds an owner to the account main
// recorded for them; when no owner is bound, both replies carry `warning` and the server log says so (docs/TRANSLATING-OLD-WORLDS.md).
import fs from "node:fs";
import path from "node:path";
import { WORLDS_DIR, BACKUPS_DIR, OPT_DIR, ROOT } from "./config.ts";
import { accountOf } from "./auth.ts";
import { isOperator } from "./operators.ts";
import { type OldWorldKind } from "./oldworlds.ts";
import { toldOf, unavailable } from "./access.ts";
import { OLD_FORMAT_DOC } from "../shared/oldformat.js";
import type { Client } from "./world.ts";
import { runOneShot, FORCED } from "./oneshot.ts";

type Any = any;
type Ctx = { c: Client; ws: { send(d: string): void } };

/** The account a connection proves without a join, and its credential's name: its verified session, else an agent credential in the message. Never a typed name. */
export function provenWho(c: Client, msg: Any): { account: string; name: string } | null {
  if (c.auth && c.auth.exp > Date.now() && c.auth.sub) return { account: c.auth.sub, name: c.auth.name ?? "" };
  const a = accountOf(String(msg?.agentToken ?? ""));
  return a && "account" in a ? a : null;
}
export const provenAccount = (c: Client, msg: Any): string | null => provenWho(c, msg)?.account ?? null;

/** The refusal an old-format world's join carries beside its words (docs/WIRE.md 4005). `owner`: how the caller was recognised as its owner. */
export function oldFormatRefused(kind: OldWorldKind, reason: string, operator: boolean, owner: "bound" | "name" | null = null) {
  return { code: "old-format", reason, doc: OLD_FORMAT_DOC, upgrade: kind === "translatable" ? "operator-or-owner" : "operator-cli", operator,
    may: kind === "translatable" && (operator || !!owner), ...(owner && kind === "translatable" ? { owner } : {}) };
}


const CLI = path.join(ROOT, "tools", "protocol", "world.ts");
const CLI_MS = 10 * 60_000;
// one-shot, framed, its group checked (server/oneshot.ts); `stopped`: it gave no complete framed answer within CLI_MS
async function runCli(args: string[], extra: Record<string, string> = {}, label = "") {
  const r = await runOneShot([process.execPath, CLI, ...args], { cwd: ROOT, env: { ...process.env, WORLDS_DIR, BACKUPS_DIR, OPT_DIR, ...extra }, guardMs: CLI_MS, label: `upgrade ${label}` });
  return { ...r, stopped: r.end === "timed out" };
}
const tagged = (out: string, tag: string): Any => { const l = out.split("\n").find((x) => x.startsWith(`${tag} `)); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return null; } };

type Owner = { recognised: "bound" | "name" | null; owner?: string; ownerless: boolean; why?: string };

// one run per world at a time; at most RATE_N requests per account per RATE_MS (each runs the translator)
const RATE_N = 6, RATE_MS = 10 * 60_000;
const running = new Set<string>(), recent = new Map<string, number[]>();

/** The checks both requests share; a refusal is answered here and null returned. */
async function admit({ c, ws }: Ctx, msg: Any, type: string, shape?: () => [string, string] | null) {
  const id = msg.id ?? null;
  const refuse = (code: string, reason: string, fix?: string) => { ws.send(JSON.stringify({ type, id, ok: false, refused: { code, reason, ...(fix ? { fix } : {}) } })); return null; };
  const who = provenWho(c, msg), account = who?.account ?? null, operator = isOperator(account);
  const world = String(msg.world ?? "");
  // §F F-3 (Mica 11-05): an old world is said only to the operator and its recognised owner (access.ts toldOf); to anyone
  // else, as a world that isn't there. A guest is neither, so is answered at once, for any name
  const unavailableHere = () => { const u = unavailable(world.slice(0, 64)); return refuse(u.code, u.message); };
  if (!account) return unavailableHere();
  const bad = shape?.(); if (bad) return refuse("shape", bad[0], bad[1]);   // before the rate slot: a malformed request runs nothing
  // the rate next, for every name (review full-260 L2: an owner check runs the CLI, so it is spent on the slot; and a slot
  // spent only on an old world's name would tell a stranger it is there)
  const now = Date.now(), mine = (recent.get(account) ?? []).filter((t) => now - t < RATE_MS);
  if (mine.length >= RATE_N) return refuse("rate", `at most ${RATE_N} upgrade requests in ${RATE_MS / 60_000} minutes`, "try again later");
  recent.set(account, [...mine, now]);   // taken in the same turn as the check, before the await below
  const told = await toldOf(world, { account }, who);
  if (told.kind !== "old") return operator ? refuse("not-old", `there is no world saved in an older format called "${world.slice(0, 64)}" here`) : unavailableHere();
  const old = told.old; const owner = told.owner ? { recognised: told.owner, owner: told.ownerName, ownerless: false } as Owner : null;
  if (old.kind !== "translatable") return refuse("cli", `"${world}" was saved before this protocol's names changed; it is re-translated from its original old log on the command line (the boot notice gives the commands): ${OLD_FORMAT_DOC}`);
  if (running.has(world)) return refuse("busy", `"${world}" is already being reviewed or upgraded`, "wait for that to finish");
  running.add(world);   // in the same turn as the busy check
  // as: how they may (an operator, or the owner and how recognised); claim: an ownerless world's upgrader becomes its owner
  const as = operator ? "operator" : `owner (${owner!.recognised})`;
  return { id, world, account: account!, name: who?.name ?? "", refuse, as, owner: owner?.recognised ? { recognised: owner.recognised, name: owner.owner } : null };
}
const claimEnv = (a: { account: string; name: string }) => ({ EIDO_UPGRADER_ACCOUNT: a.account, EIDO_UPGRADER_NAME: a.name });

export const UPGRADE_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "world-upgrade-review": (ctx, msg) => {
    const type = "world-upgrade-review"; void admit(ctx, msg, type).then((a) => { if (!a) return;
    void runCli(["translate", "--dry-run", "--no-founder-key", "--claim", "--json", "--", a.world], claimEnv(a), `review ${a.world}`).then((r) => {
      const got = r.accepted ? tagged(r.out, "report-json") : null;
      if (!got) { a.refuse("failed", `the dry run didn't finish${r.accepted ? "" : ` (${r.why})`}: ${(r.err || r.out).trim().slice(-1200)}`); return; }
      console.log(`[upgrade] ${a.world}: reviewed by ${a.account} as ${a.as} (report ${got.hash}${got.report?.refused ? ", refused" : ""})${r.receipt ? `; ${FORCED}` : ""}`);
      if (got.report?.ownerWarning) console.log(`[upgrade] WARNING ${a.world}: ${got.report.ownerWarning}`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, report: got.report, hash: got.hash, ...(a.owner ? { owner: a.owner } : {}), ...(got.report?.ownerWarning ? { warning: got.report.ownerWarning } : {}) }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world)); });
  },
  "world-upgrade": (ctx, msg) => {
    const type = "world-upgrade";
    const approved = String(msg.approved ?? "");
    const shape = (): [string, string] | null => /^[0-9a-f]{64}$/.test(approved) ? null : ["approved must be the reviewed report's hash (64 hex)", "review the upgrade first"];
    void admit(ctx, msg, type, shape).then((a) => { if (!a) return;
    void runCli(["translate", "--no-founder-key", "--operator-only-no-owner", "--claim", "--approved", approved, "--json", "--", a.world], claimEnv(a), `apply ${a.world}`).then((r) => {
      const got = r.accepted && r.code === 0 ? tagged(r.out, "result-json") : null;
      const said = `${r.err}\n${r.out}`.trim();
      // a CLI the timer stopped may have been mid-swap: its outcome is unknown, never "refused"
      // …and so may one that exited any way but a refusal (exit 1): a crash, a signal, or files it couldn't put back (exit 2),
      // and one whose answer wasn't accepted (server/oneshot.ts: no frame, a handle left open, a process of its group left)
      if (!got && (!r.accepted || r.code !== 1)) { const how = r.stopped ? `ran past ${CLI_MS / 60_000} min and was stopped` : !r.accepted ? `ended without an answer that can be trusted (${r.why})` : `stopped (exit ${r.code})`;
        a.refuse("interrupted", `the upgrade ${how}; it may be half done: ${said.slice(-1200)}`); console.log(`[upgrade] ${a.world}: upgrade by ${a.account} stopped (${r.stopped ? "timeout" : !r.accepted ? r.why : `exit ${r.code}`})`); return; }
      if (!got) { a.refuse(/is not the one that was approved/.test(said) ? "stale" : "refused", said.slice(-1500)); console.log(`[upgrade] ${a.world}: upgrade by ${a.account} refused${r.receipt ? `; ${FORCED}` : ""}`); return; }
      // the world is on disk in this protocol now: the next join opens it (nothing of it was ever loaded while it was old)
      console.log(`[upgrade] ${a.world}: upgraded by ${a.account} as ${a.as} (report ${got.report}); backup ${got.backup}${got.claimed ? `; it had no owner: ${a.account} claimed it` : ""}${r.receipt ? `; ${FORCED}` : ""}`);
      if (got.ownerWarning) console.log(`[upgrade] WARNING ${a.world}: ${got.ownerWarning}`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, backup: got.backup, report: got.report, rollback: got.rollback, people: got.people ?? [],
        ...(a.owner ? { owner: a.owner } : {}), ...(got.claimed ? { claimed: true, owned: "You're now this world's owner." } : {}), ...(got.ownerWarning ? { warning: got.ownerWarning } : {}) }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world)); });
  },
};
