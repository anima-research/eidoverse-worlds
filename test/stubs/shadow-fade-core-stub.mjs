// core-stub with a TSL whose nodes have IDENTITY: every call makes a new object, so a test can tell "the same module-
// level node on every material" from "a fresh graph per material" (core-stub's TSL is one proxy for everything).
export * from './core-stub.mjs';
let made = 0;
const mkNode = (tag) => {
  const self = { tag, n: ++made };
  return new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : k in self ? self[k] : mkNode(`${tag}.${String(k)}`)),
    apply: () => mkNode(`${tag}()`),
    construct: () => mkNode(`new ${tag}`),
  });
};
export const TSL = new Proxy({}, { get: (_t, k) => mkNode(String(k)) });
export const nodesMade = () => made;
