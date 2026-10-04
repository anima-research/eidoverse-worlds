// Every tool declares its arguments: type, which modes they apply to, and an example. The door validates every
// request against this BEFORE doing anything, and `help {tool}` is generated from it (fresh-builder findings W1–W3).
const xz = { type: "xz", doc: "[x, z] in metres (ground position; y comes from what's below)" };
const ref = (doc) => ({ type: "id", doc });
const target = (doc) => ({ type: "id|xz", doc });
export const PLACE_MODES = ["on", "beside", "hang", "against", "near", "at"];
export const TOOLSPEC = {
  place: {
    doc: "put a thing somewhere by saying where it goes relative to other things; the door solves the numbers",
    oneOf: PLACE_MODES,
    args: {
      id: ref("the thing to move"),
      on: { ...ref("put it on this thing's surface"), example: { id: "lamp-1", on: "table-1" } },
      beside: { ...ref("next to this thing, on the same support, backs flush"), example: { id: "book-2", beside: "book-1" } },
      hang: { ...ref("hang it below this thing (a frame, a beam)"), example: { id: "swing-1", hang: "frame-1", height: 0.45 } },
      against: { ...ref("back against this thing's face (a wall)"), example: { id: "shelf-1", against: "wall-n" } },
      near: { ...ref("on the floor near this thing"), example: { id: "chair-1", near: "table-1", facing: "table-1" } },
      at: { ...xz, example: { id: "crate-1", at: [2, -1] } },
      facing: { ...target("turn its front (+Z) toward this thing or [x, z] point"), modes: ["on", "near", "at", "hang"] },
      away: { type: "bool", doc: "with facing: turn its back to the target instead", modes: ["on", "near", "at", "hang"] },
      level: { type: "int", doc: "which surface of an `on` target (0 = lowest; default highest)", modes: ["on"] },
      offset: { ...xz, doc: "[dx, dz] from the surface's centre", modes: ["on"] },
      side: { type: "enum", values: ["left", "right", 1, -1], doc: "beside: left|right; against: 1|-1 = which face", modes: ["beside", "against"] },
      gap: { type: "number", doc: "metres of clearance", modes: ["beside", "against", "near"] },
      height: { type: "number", doc: "metres above the ground: hang (seat height), against (wall-mount height)", modes: ["hang", "against"] },
      along: { type: "number", doc: "metres along the target's width from its centre", modes: ["hang", "against"] },
      lying: { type: "bool", doc: "rest it on its largest face (a book laid flat); the door handles the tilt", modes: ["on", "at", "near"] },
      attach: { type: "bool", doc: "ride with what it's placed on (default true for on/beside/hang/against-with-height)" },
      dry: { type: "bool", doc: "preview only" },
    },
  },
  create: {
    doc: "make a new thing; optionally place it in the same step",
    args: { id: { type: "string", doc: "optional; the server mints one if absent" }, model: { type: "string", doc: "a model from find {kind: 'model'}" },
      components: { type: "object", doc: "component values; see schema" }, from: { type: "string", doc: "a blueprint hash (find {kind: 'blueprint'})" },
      at: { type: "object", doc: "with from: {pos, yaw|q}" }, place: { type: "object", doc: "a place request without id", example: { model: "chair", place: { near: "table-1", facing: "table-1" } } }, dry: { type: "bool" } },
  },
  set: { doc: "replace a component's value (merge: true patches only the fields you send)", args: { id: ref("the thing"), component: { type: "string" }, value: { type: "any" }, merge: { type: "bool" }, force: { type: "bool", doc: "@world.sim only: cut even with things in flight (they freeze where they are)" }, base: { type: "int", doc: "the version you read (inspect → versions); refused if someone changed it since" }, dry: { type: "bool" } }, required: ["id", "component"],
    example: { id: "lamp-1", component: "light", value: { range: 8 }, merge: true } },
  delete: { doc: "remove a thing (with its children) or one component", args: { id: ref("the thing"), component: { type: "string" }, force: { type: "bool", doc: "@world.sim only: cut even with things in flight" }, dry: { type: "bool" } }, required: ["id"] },
  move: { doc: "walk your body somewhere (presence: not recorded). Things you hold come with you. The door tracks your body: about 6 m/s, 4 m at most in one go, not through walls. Your first move (arriving) and teleport: true are acts on the record, and can't carry things", args: { to: { type: "any", doc: "[x, y, z] in metres (y = the floor you stand on, usually 0)" }, teleport: { type: "bool", doc: "jump there (recorded; refused while holding; a world may limit arrivals to its spawn)" } }, required: ["to"],
    example: { to: [0, 0, 1.5] } },
  grab: { doc: "pick something up (within 1.5 m of your hand). Only things with physics {kind: 'dynamic'}; who may is physics.who (default builder). You can catch a thing in the air", args: { id: ref("the thing") }, required: ["id"],
    example: { id: "ball-1" } },
  put: { doc: "set down what you're holding. Leave pos out to set it straight down onto whatever's below your hand; or give pos (what a VR hand would): the door checks it like any write (not inside things, not floating, within reach)", args: { id: ref("the thing you hold"), pos: { type: "any", doc: "[x, y, z]: where its base rests" }, q: { type: "any", doc: "[x, y, z, w] (optional)" } }, required: ["id"],
    example: { id: "ball-1" } },
  throw: { doc: "let go of what you're holding with a velocity; physics (if the world runs it) decides where it lands, and the log records where it came to rest", args: { id: ref("the thing you hold"), v: { type: "any", doc: "[x, y, z] in m/s (+y is up); 20 m/s max" } }, required: ["id", "v"],
    example: { id: "ball-1", v: [0, 3, 4] } },
  drop: { doc: "let go of what you're holding: it falls (with physics), or is set straight down (without)", args: { id: ref("the thing you hold") }, required: ["id"], example: { id: "ball-1" } },
  use: { doc: "do something to a thing (inspect shows what it offers you)", args: { id: ref("the thing"), action: { type: "string" }, args: { type: "object" } }, required: ["id"],
    example: { id: "swing-1", action: "push", args: { impulse: [0, 0, 1.5] } } },
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const okType = (spec, v) => {
  switch (spec.type) {
    case "xz": return Array.isArray(v) && v.length === 2 && v.every(isNum);
    case "id": return typeof v === "string" && v.length > 0;
    case "id|xz": return (typeof v === "string" && v.length > 0) || (Array.isArray(v) && v.length === 2 && v.every(isNum));
    case "number": return isNum(v); case "int": return Number.isInteger(v); case "bool": return typeof v === "boolean";
    case "string": return typeof v === "string"; case "object": return v && typeof v === "object" && !Array.isArray(v);
    case "enum": return spec.values.includes(v); default: return true;
  }
};
export function validate(tool, a) {
  const T = TOOLSPEC[tool]; if (!T) return null;
  const ex = (k) => T.args[k]?.example ?? T.example;
  for (const k of Object.keys(a)) if (!(k in T.args)) return { code: "unknown-arg", reason: `${tool} has no argument '${k}'`, teach: `${tool} takes: ${Object.keys(T.args).join(", ")}`, example: ex(k) };
  for (const k of T.required ?? []) if (a[k] === undefined) return { code: "missing-arg", reason: `${tool} needs '${k}'`, teach: T.doc, example: T.example };
  if (T.oneOf) { const m = T.oneOf.filter((k) => a[k] !== undefined);
    if (m.length !== 1) return { code: "shape", reason: m.length ? `say one of ${m.join(" / ")}, not several` : `${tool} needs one of: ${T.oneOf.join(", ")}`, teach: T.oneOf.map((k) => `${k}: ${T.args[k].doc}`).join("; "), example: T.args[m[0] ?? "on"].example };
    for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && s.modes && !s.modes.includes(m[0])) return { code: "doesnt-apply", reason: `'${k}' doesn't apply with '${m[0]}' (it applies with ${s.modes.join(", ")})`, teach: `remove '${k}'${k === "facing" && ["beside", "against"].includes(m[0]) ? `: ${m[0]} sets the facing itself` : ""}`, example: T.args[m[0]].example }; }
  for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && !okType(s, a[k])) return { code: "shape", reason: `'${k}' should be ${s.type === "enum" ? `one of ${s.values.join(" | ")}` : s.doc ?? s.type}, got ${JSON.stringify(a[k])}`, teach: s.doc ?? "", example: ex(k) };
  return null;
}
export function toolHelp(tool) { const T = TOOLSPEC[tool]; if (!T) return null;
  return { tool, doc: T.doc, ...(T.oneOf ? { oneOf: T.oneOf } : {}), args: Object.fromEntries(Object.entries(T.args).map(([k, s]) => [k, { type: s.type === "enum" ? s.values : s.type, doc: s.doc, ...(s.modes ? { onlyWith: s.modes } : {}), ...(s.example ? { example: s.example } : {}) }])), ...(T.example ? { example: T.example } : {}) }; }
