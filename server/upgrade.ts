// server/upgrade.ts — opening a world saved in an older format: the join's structured refusal, and the operator's upgrade.
// world-upgrade-review {id, world} → {type, id, ok, world, report, hash, warning?}: the CLI's dry run (nothing written).
// world-upgrade {id, world, approved} → {type, id, ok, world, backup, report, rollback, people, warning?}: the CLI's in-place translation, bound to
// that hash (a verified backup first: server/backups.ts). Both run tools/protocol/world.ts itself: the translation has one code path.
// A server operator (SERVER_OPERATORS) or the world's owner, by a proven account (R 10-28): an owner main's records bind to
// that account ("bound"), or one main recorded no account for whose name the account's is ("name", provisional): world.ts
// owner-of. An ownerless world's upgrader becomes its owner (--claim); a recognised owner is bound to them (report.claim). The translation binds an owner to the account main
// recorded for them; when no owner is bound, both replies carry `warning` and the server log says so (docs/TRANSLATING-OLD-WORLDS.md).
import fs from "node:fs";
import path from "node:path";
import { WORLDS_DIR, BACKUPS_DIR, OPT_DIR, ROOT } from "./config.ts";
import { accountOf } from "./auth.ts";
import { isOperator } from "./operators.ts";
import { oldWorldAt, type OldWorldKind } from "./oldworlds.ts";
import { OLD_FORMAT_DOC, IF_YOU_RUN_IT } from "../shared/oldformat.js";
import type { Client } from "./world.ts";

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
async function runCli(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: ROOT, env: { ...process.env, WORLDS_DIR, BACKUPS_DIR, OPT_DIR, ...extra }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, CLI_MS);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(timer);
  return { code, out, err };
}
const tagged = (out: string, tag: string): Any => { const l = out.split("\n").find((x) => x.startsWith(`${tag} `)); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return null; } };

type Owner = { recognised: "bound" | "name" | null; owner?: string; ownerless: boolean; why?: string };
const OWNER_MS = 30_000, ownerSeen = new Map<string, { at: number; p: Promise<Owner | null> }>();
/** world.ts owner-of: is this proven account an owner of the old world? Cached briefly per (world, account, name, log); null when the check didn't run. */
export function ownerOf(world: string, who: { account: string; name: string } | null): Promise<Owner | null> {
  if (!who) return Promise.resolve(null);
  let st: { size: number; mtimeMs: number }; try { st = fs.statSync(path.join(WORLDS_DIR, world, "log.jsonl")); } catch { return Promise.resolve(null); }
  const key = JSON.stringify([world, who.account, who.name, st.size, st.mtimeMs]), now = Date.now(), hit = ownerSeen.get(key);
  if (hit && now - hit.at < OWNER_MS) return hit.p;
  for (const [k, v] of ownerSeen) if (now - v.at >= OWNER_MS) ownerSeen.delete(k);
  const p = runCli(["owner-of", "--", world], { EIDO_UPGRADER_ACCOUNT: who.account, EIDO_UPGRADER_NAME: who.name }).then((r) => tagged(r.out, "owner-json") as Owner | null).catch(() => null);
  ownerSeen.set(key, { at: now, p }); return p;
}

// one run per world at a time; at most RATE_N requests per account per RATE_MS (each runs the translator)
const RATE_N = 6, RATE_MS = 10 * 60_000;
const running = new Set<string>(), recent = new Map<string, number[]>();

/** The checks both requests share; a refusal is answered here and null returned. */
async function admit({ c, ws }: Ctx, msg: Any, type: string) {
  const id = msg.id ?? null;
  const refuse = (code: string, reason: string, fix?: string) => { ws.send(JSON.stringify({ type, id, ok: false, refused: { code, reason, ...(fix ? { fix } : {}) } })); return null; };
  const who = provenWho(c, msg), account = who?.account ?? null, operator = isOperator(account);
  const world = String(msg.world ?? "");
  const old = oldWorldAt(WORLDS_DIR, world);
  const rights = (why = "") => refuse("rights", `upgrading a world saved in an older format is for this server's operator (an account in SERVER_OPERATORS) or the world's owner, signed in${why ? ` (${why})` : ""}. ${IF_YOU_RUN_IT}`, "ask the server's operator or the world's owner");
  let owner: Owner | null = null;
  if (!operator) { if (!old || old.kind !== "translatable") return rights(account ? "" : "not signed in");
    owner = await ownerOf(world, who); if (!owner?.recognised) return rights(owner?.why ?? (account ? "" : "not signed in")); }
  if (!old) return refuse("not-old", `there is no world saved in an older format called "${world.slice(0, 64)}" here`);
  if (old.kind !== "translatable") return refuse("cli", `"${world}" was saved before this protocol's names changed; it is re-translated from its original old log on the command line (the boot notice gives the commands): ${OLD_FORMAT_DOC}`);
  if (running.has(world)) return refuse("busy", `"${world}" is already being reviewed or upgraded`, "wait for that to finish");
  const now = Date.now(), mine = (recent.get(account!) ?? []).filter((t) => now - t < RATE_MS);
  if (mine.length >= RATE_N) return refuse("rate", `at most ${RATE_N} upgrade requests in ${RATE_MS / 60_000} minutes`, "try again later");
  recent.set(account!, [...mine, now]); running.add(world);   // taken here, in the same turn as the check (admit awaits above)
  // as: how they may (an operator, or the owner and how recognised); claim: an ownerless world's upgrader becomes its owner
  const as = operator ? "operator" : `owner (${owner!.recognised})`;
  return { id, world, account: account!, name: who?.name ?? "", refuse, as, owner: owner?.recognised ? { recognised: owner.recognised, name: owner.owner } : null };
}
const claimEnv = (a: { account: string; name: string }) => ({ EIDO_UPGRADER_ACCOUNT: a.account, EIDO_UPGRADER_NAME: a.name });

export const UPGRADE_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "world-upgrade-review": (ctx, msg) => {
    const type = "world-upgrade-review"; void admit(ctx, msg, type).then((a) => { if (!a) return;
    void runCli(["translate", "--dry-run", "--no-founder-key", "--claim", "--json", "--", a.world], claimEnv(a)).then((r) => {
      const got = tagged(r.out, "report-json");
      if (!got) { a.refuse("failed", `the dry run didn't finish: ${(r.err || r.out).trim().slice(-1200)}`); return; }
      console.log(`[upgrade] ${a.world}: reviewed by ${a.account} as ${a.as} (report ${got.hash}${got.report?.refused ? ", refused" : ""})`);
      if (got.report?.ownerWarning) console.log(`[upgrade] WARNING ${a.world}: ${got.report.ownerWarning}`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, report: got.report, hash: got.hash, ...(a.owner ? { owner: a.owner } : {}), ...(got.report?.ownerWarning ? { warning: got.report.ownerWarning } : {}) }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world)); });
  },
  "world-upgrade": (ctx, msg) => {
    const type = "world-upgrade";
    const approved = String(msg.approved ?? "");
    void admit(ctx, msg, type).then((a) => { if (!a) return;
    if (!/^[0-9a-f]{64}$/.test(approved)) { running.delete(a.world); a.refuse("shape", "approved must be the reviewed report's hash (64 hex)", "review the upgrade first"); return; }
    void runCli(["translate", "--no-founder-key", "--operator-only-no-owner", "--claim", "--approved", approved, "--json", "--", a.world], claimEnv(a)).then((r) => {
      const got = r.code === 0 ? tagged(r.out, "result-json") : null;
      const said = `${r.err}\n${r.out}`.trim();
      if (!got) { a.refuse(/is not the one that was approved/.test(said) ? "stale" : "refused", said.slice(-1500)); console.log(`[upgrade] ${a.world}: upgrade by ${a.account} refused`); return; }
      // the world is on disk in this protocol now: the next join opens it (nothing of it was ever loaded while it was old)
      console.log(`[upgrade] ${a.world}: upgraded by ${a.account} as ${a.as} (report ${got.report}); backup ${got.backup}${got.claimed ? `; it had no owner: ${a.account} claimed it` : ""}`);
      if (got.ownerWarning) console.log(`[upgrade] WARNING ${a.world}: ${got.ownerWarning}`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, backup: got.backup, report: got.report, rollback: got.rollback, people: got.people ?? [],
        ...(a.owner ? { owner: a.owner } : {}), ...(got.claimed ? { claimed: true, owned: "You're now this world's owner." } : {}), ...(got.ownerWarning ? { warning: got.ownerWarning } : {}) }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world)); });
  },
};
