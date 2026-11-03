// bun test tools/structure-diagonal-parity.test.ts
import { expect, test } from "bun:test";
import { planStructure, segmentEnds, APERTURES } from "../shared/structure.js";

for (const axis of [2, 3]) for (const aperture of [null, "door", "window", "arch"]) {
  test("axis " + axis + " " + (aperture ?? "solid") + " shares authored cell, visible geometry and collider, opening included", () => {
    const plan = planStructure({ tile: 2, levels: [{ tiles: [[4, -3]],
      walls: [[axis, 4, -3]], apertures: aperture ? [[axis, 4, -3, aperture]] : [] }] });
    const level = plan.levels[0], g = plan.grid;
    const [a, b] = segmentEnds({ axis, x: 4, z: -3 }, g);
    expect([a,b]).toEqual(axis === 2 ? [[8,-6],[10,-4]] : [[10,-6],[8,-4]]);
    const parts = level.sweeps;
    expect(parts.length).toBeGreaterThan(0);
    const xs: number[] = [], zs: number[] = [];
    for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) {
      xs.push(p.positions[i]); zs.push(p.positions[i+2]);
    }
    // The visual profile may protrude by its wall/skirting thickness, but
    // cannot be shifted into the adjacent cell.
    expect(Math.min(...xs)).toBeGreaterThan(7.7);
    expect(Math.min(...xs)).toBeLessThan(8.2);
    expect(Math.max(...xs)).toBeGreaterThan(9.8);
    expect(Math.max(...xs)).toBeLessThan(10.3);
    expect(Math.min(...zs)).toBeGreaterThan(-6.3);
    expect(Math.max(...zs)).toBeLessThan(-3.7);
    const boxes = plan.boxes.filter(b => b.kind === "wall");
    expect(boxes.length).toBe(9);
    for (const box of boxes) {
      const x = (box.x0 + box.x1) / 2, z = (box.z0 + box.z1) / 2;
      expect(axis === 2 ? (x - 8) - (z + 6) : (x - 8) + (z + 6)).toBeCloseTo(axis === 2 ? 0 : 2, 10);
    }
    // The opening: a door or arch is open below its lintel in the collider and
    // in the visible wall alike. A window is a visible opening only; its
    // collider stays solid from the floor up.
    const floorY = level.y, ys: number[] = [];
    for (const p of parts) for (let i = 1; i < p.positions.length; i += 3) ys.push(p.positions[i]);
    const open = aperture === "door" || aperture === "arch";
    const lintel = open ? floorY + APERTURES[aperture].top : floorY;
    for (const box of boxes) expect(box.y0).toBeCloseTo(lintel, 10);
    expect(Math.min(...ys)).toBeCloseTo(lintel, 10);
    if (aperture === "window") {
      const sill = floorY + APERTURES.window.bottom, head = floorY + APERTURES.window.top;
      expect(ys.some(y => y > sill + 1e-9 && y < head - 1e-9)).toBe(false);
    }
  });
}
