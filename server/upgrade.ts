// server/upgrade.ts — opening a world saved in an older format: the join's structured refusal, and the operator's upgrade.
// world-upgrade-review {id, world} → {type, id, ok, world, report, hash}: the CLI's dry run (nothing written).
// world-upgrade {id, world, approved} → {type, id, ok, world, backup, report, rollback}: the CLI's in-place translation, bound to
// that hash (a verified backup first: server/backups.ts). Both run tools/protocol/world.ts itself: the translation has one code path.
// Operator only (WORLD_ADMIN, by a proven account): an old world's owner is a name nothing binds yet (docs/TRANSLATING-OLD-WORLDS.md).
import path from "node:path";
import { WORLDS_DIR, BACKUPS_DIR, OPT_DIR, ROOT } from "./config.ts";
import { agentTokens, aid1JoinIdentity } from "./auth.ts";
import { isOperator } from "./operators.ts";
import { oldWorldAt, type OldWorldKind } from "./oldworlds.ts";
import { OLD_FORMAT_DOC, ASK_OPERATOR } from "../shared/oldformat.js";
import type { Client } from "./world.ts";

type Any = any;
type Ctx = { c: Client; ws: { send(d: string): void } };

/** The account a connection proves without a join: its verified session, else an agent credential in the message. Never a typed name. */
export function provenAccount(c: Client, msg: Any): string | null {
  if (c.auth && c.auth.exp > Date.now() && c.auth.sub) return c.auth.sub;
  const tok = String(msg?.agentToken ?? ""); if (!tok) return null;
  const at = agentTokens(); const enrolled = at.byToken.get(tok);
  if (enrolled) return `agent:token:${enrolled.toLowerCase()}`;
  const a = aid1JoinIdentity(tok); if (!a || a.payload.kind !== "agent") return null;
  const via = at.bySub.get(a.payload.sub);
  return via ? `agent:token:${via.toLowerCase()}` : `aid1:${a.payload.iss}:${a.payload.sub}`;
}

/** The refusal an old-format world's join carries beside its words (docs/WIRE.md 4005). */
export function oldFormatRefused(kind: OldWorldKind, reason: string, operator: boolean) {
  return { code: "old-format", reason, doc: OLD_FORMAT_DOC, upgrade: kind === "translatable" ? "operator" : "operator-cli", operator };
}

const CLI = path.join(ROOT, "tools", "protocol", "world.ts");
const CLI_MS = 10 * 60_000;
async function runCli(args: string[]) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: ROOT, env: { ...process.env, WORLDS_DIR, BACKUPS_DIR, OPT_DIR }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, CLI_MS);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(timer);
  return { code, out, err };
}
const tagged = (out: string, tag: string) => { const l = out.split("\n").find((x) => x.startsWith(`${tag} `)); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return null; } };

// one run per world at a time; at most RATE_N requests per operator account per RATE_MS (each runs the translator)
const RATE_N = 6, RATE_MS = 10 * 60_000;
const running = new Set<string>(), recent = new Map<string, number[]>();

/** The checks both requests share; a refusal is answered here and null returned. */
function admit({ c, ws }: Ctx, msg: Any, type: string) {
  const id = msg.id ?? null;
  const refuse = (code: string, reason: string, fix?: string) => { ws.send(JSON.stringify({ type, id, ok: false, refused: { code, reason, ...(fix ? { fix } : {}) } })); return null; };
  const account = provenAccount(c, msg);
  if (!isOperator(account)) return refuse("rights", `upgrading a world saved in an older format is for this server's operator (WORLD_ADMIN, a signed-in account). ${ASK_OPERATOR}`, "ask the server's operator");
  const world = String(msg.world ?? "");
  const old = oldWorldAt(WORLDS_DIR, world);
  if (!old) return refuse("not-old", `there is no world saved in an older format called "${world.slice(0, 64)}" here`);
  if (old.kind !== "translatable") return refuse("cli", `"${world}" was saved before this protocol's names changed; it is re-translated from its original old log on the command line (the boot notice gives the commands): ${OLD_FORMAT_DOC}`);
  if (running.has(world)) return refuse("busy", `"${world}" is already being reviewed or upgraded`, "wait for that to finish");
  const now = Date.now(), mine = (recent.get(account!) ?? []).filter((t) => now - t < RATE_MS);
  if (mine.length >= RATE_N) return refuse("rate", `at most ${RATE_N} upgrade requests in ${RATE_MS / 60_000} minutes`, "try again later");
  recent.set(account!, [...mine, now]);
  return { id, world, account: account!, refuse };
}

export const UPGRADE_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "world-upgrade-review": (ctx, msg) => {
    const type = "world-upgrade-review"; const a = admit(ctx, msg, type); if (!a) return;
    running.add(a.world);
    void runCli(["translate", "--dry-run", "--no-founder-key", "--json", "--", a.world]).then((r) => {
      const got = tagged(r.out, "report-json");
      if (!got) { a.refuse("failed", `the dry run didn't finish: ${(r.err || r.out).trim().slice(-1200)}`); return; }
      console.log(`[upgrade] ${a.world}: reviewed by ${a.account} (report ${got.hash}${got.report?.refused ? ", refused" : ""})`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, report: got.report, hash: got.hash }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world));
  },
  "world-upgrade": (ctx, msg) => {
    const type = "world-upgrade";
    const approved = String(msg.approved ?? "");
    if (!/^[0-9a-f]{64}$/.test(approved) && isOperator(provenAccount(ctx.c, msg))) { ctx.ws.send(JSON.stringify({ type, id: msg.id ?? null, ok: false, refused: { code: "shape", reason: "approved must be the reviewed report's hash (64 hex)", fix: "review the upgrade first" } })); return; }
    const a = admit(ctx, msg, type); if (!a) return;
    running.add(a.world);
    void runCli(["translate", "--no-founder-key", "--operator-only-no-owner", "--approved", approved, "--json", "--", a.world]).then((r) => {
      const got = r.code === 0 ? tagged(r.out, "result-json") : null;
      const said = `${r.err}\n${r.out}`.trim();
      if (!got) { a.refuse(/is not the one that was approved/.test(said) ? "stale" : "refused", said.slice(-1500)); console.log(`[upgrade] ${a.world}: upgrade by ${a.account} refused`); return; }
      // the world is on disk in this protocol now: the next join opens it (nothing of it was ever loaded while it was old)
      console.log(`[upgrade] ${a.world}: upgraded by ${a.account} (report ${got.report}); backup ${got.backup}`);
      ctx.ws.send(JSON.stringify({ type, id: a.id, ok: true, world: a.world, backup: got.backup, report: got.report, rollback: got.rollback }));
    }).catch((x) => a.refuse("failed", String(x?.message ?? x))).finally(() => running.delete(a.world));
  },
};
