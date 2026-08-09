// Raw world-log shape (#88).
//
// `world_verb` forwards args VERBATIM into the world log — nothing between
// the tool call and the sequencer re-shapes them, so a convenience-shaped
// packet becomes durable history that every replayer must survive forever.
// The typed tools normalize ({x,y,z} -> pos:[x,y,z]); raw speaks the log's
// own vocabulary — and the door's job is to refuse a packet that is not in
// it, WITH THE EXPECTED SHAPE NAMED, before it becomes history. That is the
// incident: a raw place carrying {x,y,z} was accepted, folded as a no-op,
// and crashed every agent that later replayed it.
//
// Validation is deliberately minimal — the shape of what is present, not
// policy. Rank, locks and rate stay the server's; this only answers "is
// that even a place".

export const isFiniteVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Why these raw args cannot enter the log as this verb — null when they can. */
export function rawShapeError(verb: string, args: Record<string, unknown>): string | null {
  if (verb === "place") {
    if (typeof args.id !== "string" || !args.id)
      return "raw place wants {id, pos:[x,y,z], yaw?, scale?} — missing id";
    if ("x" in args || "y" in args || "z" in args)
      return "raw place takes pos:[x,y,z] — the {x,y,z} convenience shape belongs to the typed place tool, not the log";
    if (args.pos !== undefined && !isFiniteVec3(args.pos))
      return `raw place pos must be a finite [x,y,z] — got ${JSON.stringify(args.pos)?.slice(0, 80)}`;
    if (args.yaw !== undefined && !Number.isFinite(args.yaw))
      return "raw place yaw must be a finite number";
    if (args.scale !== undefined && !Number.isFinite(args.scale))
      return "raw place scale must be a finite number";
  } else if (verb === "spawn" || verb === "dismount" || verb === "light") {
    // same trap, other doors: pos is optional on these, but a pos that IS
    // given must be the log's shape
    if (args.pos !== undefined && !isFiniteVec3(args.pos))
      return `raw ${verb} pos must be a finite [x,y,z]`;
  }
  return null;
}
