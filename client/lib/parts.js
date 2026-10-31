// parts — the named mesh parts of a model, in traversal order: what a picture's
// `part` may name (shared/picture.js). Its own module so the inspector's schema
// extra and the picture evaluator read ONE list, and so suites that stub
// inspect.js still exercise the real walk.

/** Named mesh parts under `root`, in traversal order. */
export function namedParts(root) {
  const out = [];
  root?.traverse?.((c) => { if (c !== root && c.isMesh && c.name && c.material && !out.includes(c.name)) out.push(c.name); });
  return out;
}
