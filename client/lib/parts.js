// parts — the named mesh parts of a model, in traversal order: what a `material` value's `node` may name. Its own
// module so the inspector's `parts` extra and the picture editor read ONE list, and so suites that stub inspect.js
// still exercise the real walk.

/** Named mesh parts under `root`, in traversal order. */
export function namedParts(root) {
  const out = [];
  root?.traverse?.((c) => { if (c !== root && c.isMesh && c.name && c.material && !out.includes(c.name)) out.push(c.name); });
  return out;
}
