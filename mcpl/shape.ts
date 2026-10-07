// Shape guards for what this process reads from the world (#88: one malformed transform once crashed every agent
// that read it).

export const isFiniteVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
