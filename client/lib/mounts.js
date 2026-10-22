// mounts — bodies on seats (an occupant: sitting, standing at a station), as presence: bodies aren't entities, so their
// mounts live in this map for remotes/controller to consume. {to: <socket id>, pose?, at?, in?}. world.js's setBodySeat
// writes it. A leaf with no imports, so net.js can read it without pulling world.js, and through it core.js and the
// WebGPU renderer, into the lite client (house I10, #260).
export const avatarMounts = new Map();
