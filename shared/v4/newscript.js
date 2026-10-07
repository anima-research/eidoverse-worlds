// shared/v4/newscript.js — the editor's "new script" (ship list 10-07: the editor couldn't make a script; nothing in the
// client called `upload`). A person fills in a small card (a name, what starts it, the source); this plans the SAME two
// requests an agent sends (docs/SCRIPTS-v4.md, "the loop"):
//   1. upload {text}                                     → {src}   (not an act: a blob in the world's store)
//   2. one batch (one act, one Ctrl+Z):
//        set {id, component: 'script:<name>', value: {src, scope, on, every?}}
//        set {id, component: 'reactions', value: {<action>: {kind: 'script', script: <name>}}, merge: true}   (on use)
// Pure: no DOM, no network (client/lib/scriptnew.js draws the card and sends; tools/v4/build-check.ts K runs these
// requests through the real door and sandbox).
import { set } from "./ops.js";

/** A starting point that runs as it stands and shows the loop: use it, and it speaks. */
export const TEMPLATES = Object.freeze({
  use: `// runs when someone uses this thing (its action in the inspector, /use, or an agent's use)
world.on("use", (e) => {
  const n = (world.get("self", "counter")?.n ?? 0) + 1;
  world.set("self", "counter", { n });
  world.say((world.name(e.by) ?? "someone") + " used me (" + n + ")");
});
`,
  timer: `// runs every few seconds while someone is here (set how often below)
world.on("tick", () => {
  const n = (world.get("self", "counter")?.n ?? 0) + 1;
  world.set("self", "counter", { n });
  world.log("tick", n);
});
`,
});

/** What a template writes (its scope), so the card's defaults run as they stand. */
export const TEMPLATE_SCOPE = Object.freeze({ use: { comps: ["counter"], say: true }, timer: { comps: ["counter"], say: false } });

/** A script name the door takes (script:<name>: a–z, 0–9 and '-', up to 64), from whatever was typed. */
export function scriptName(typed) {
  const s = String(typed ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 64);
  return s || null;
}

/** The reaction action a use-script answers: `use` when the thing has none by that name (or it already runs this
 *  script), else the script's name (a thing's existing door/toggle reaction is never overwritten). */
export function actionFor(reactions, name) {
  const r = reactions && typeof reactions === "object" ? reactions : {};
  const mine = (a) => r[a]?.kind === "script" && r[a]?.script === name;
  if (!r.use || mine("use")) return "use";
  return name;
}

/** Plan a new script. form: {id, name, text, trigger: 'use'|'timer', every?, comps?: string[], say?: boolean}; `thing`
 *  is the thing's components as the viewer sees them (for its reactions and its existing scripts).
 *  Returns {errors: [...]} or {name, action, upload: {tool, args}, install(src) → the batch's ops}. */
export function planNewScript(form, thing = {}) {
  const errors = [];
  const name = scriptName(form?.name);
  if (!name) errors.push("give it a name (letters, numbers and '-')");
  else if (thing && Object.hasOwn(thing, `script:${name}`)) errors.push(`this thing already has a script called '${name}': pick another name`);
  const text = String(form?.text ?? "");
  if (!text.trim()) errors.push("the script is empty");
  const trigger = form?.trigger === "timer" ? "timer" : "use";
  const every = Number(form?.every);
  if (trigger === "timer" && !(every >= 5)) errors.push("a timer runs every 5 seconds at the least");
  const comps = [...new Set((form?.comps ?? []).map((c) => String(c).trim()).filter(Boolean))];
  if (comps.length > 16) errors.push("a script may change at most 16 components");
  if (errors.length) return { errors };
  const action = trigger === "use" ? actionFor(thing?.reactions, name) : null;
  const value = (src) => ({ src, scope: { ids: "self", comps, ...(form?.say ? { say: true } : {}) }, on: trigger === "use" ? ["use"] : [], ...(trigger === "timer" ? { every } : {}) });
  return {
    errors: [], name, action, trigger,
    upload: { tool: "upload", args: { text } },
    install: (src) => [set(form.id, `script:${name}`, value(src)), ...(action ? [set(form.id, "reactions", { [action]: { kind: "script", script: name } }, { merge: true })] : [])],
  };
}
