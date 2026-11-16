// rolespanels-access-test — World Settings › People & roles, painted under happy-dom with net/ui mocked (333-cm bugs a1, a2).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/rolespanels-access-test.ts
// Mutations (must go red): in client/lib/ui/rolespanels.js paintAccess, send the door batch as `{ ops }`; read `dr.gen` in the warning.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ width: 800, height: 600 });
import { mock } from "bun:test";
const S = suite("rolespanels-access");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
const L = "../../client/lib/";
const sent: any[] = [];
const replica: any = { st: { entities: { "@world": { c: {} } } } };
const net: any = { you: "u-owner", myRights: { role: "owner", rank: 100, permissions: [] } };
mock.module(L + "net.js", () => ({ net, replica, identities: new Map(), personName: (id: string) => id,
  sendRequest: async (verb: string, args: any) => { sent.push({ verb, args }); return { ok: true }; } }));
mock.module(L + "base.js", () => ({ bus: { on() {}, emit() {} }, report() {}, CONFIG: {} }));
mock.module(L + "ui/ui.js", () => ({ makeSection: () => ({}), moderationFrame: () => null, worldSettingsFrame: () => null, toast() {} }));
mock.module(L + "ui/ui-dock.js", () => ({ setDockEntry() {} }));
mock.module(L + "ui/accesspanel.js", () => ({ paintListed() {} }));
const { _test } = await import(L + "ui/rolespanels.js");
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// a1: a two-write door (open, public) goes as ONE batch, spelt {requests} (shared/protocol/authority/verbs.js refuses {ops})
for (const door of ["open", "public"]) {
  replica.st.entities["@world"].c = { access: { join: "listed" } }; sent.length = 0;
  const b = document.createElement("div"); document.body.append(b); _test.paintAccess(b);
  (b.querySelector(`button[data-door="${door}"]`) as any).click(); await settle();
  const r = sent[0];
  check(`a1 the ${door} door sends one batch whose args are {requests: [2 sets]}, not {ops}`,
    sent.length === 1 && r.verb === "batch" && Array.isArray(r.args.requests) && r.args.requests.length === 2 && !("ops" in r.args), JSON.stringify(sent));
  b.remove();
}
// a2: the newcomer warning names generation when only the default-role's own exception grants it
{
  replica.st.entities["@world"].c = { "default-role": { role: "member", can: { generate: true } } };
  const b = document.createElement("div"); document.body.append(b); _test.paintAccess(b);
  const w = b.querySelector(".rp-warn")?.textContent ?? "";
  check("a2 a default-role with can.generate warns that arrivals spend the world's generation credit", /generation credit/.test(w), JSON.stringify(w));
  b.remove();
}
S.done();
