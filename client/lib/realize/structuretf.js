// A building's drawn transform from its view record: pure, so it can be tested without a renderer (review of #260, #474).
export const transformOf = (ent) => ({
  position: Array.isArray(ent?.pos) && ent.pos.length === 3 && ent.pos.every(Number.isFinite)
    ? ent.pos : [0, 0, 0],
  yaw: Number.isFinite(ent?.yaw) ? ent.yaw : 0,
  scale: Number.isFinite(ent?.scale) && ent.scale !== 0 ? ent.scale : 1,   // a negative scale mirrors (componentspec.js:26; review of #260, #474)
  // the drawn group and the collider boxes both take the whole rotation and per-axis scale (view.js gives q and scale3)
  q: Array.isArray(ent?.q) && ent.q.length === 4 && ent.q.every(Number.isFinite) ? ent.q : null,
  scale3: Array.isArray(ent?.scale3) && ent.scale3.length === 3 && ent.scale3.every((x) => Number.isFinite(x) && x !== 0) ? ent.scale3 : null,
});
