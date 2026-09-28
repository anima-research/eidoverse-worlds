// Pure placement evaluator, shared by browser and native scene projection.
// Structural plants (species with footRadius) claim their canopy footprint
// here as they place; later fields skip candidates that would clip an
// existing claim. One registry per render process = per scene build.
// Shrub canopies may touch (×0.75 of summed radii); grasses ignore it all.
const _placedPlants = [];
export function resetFloraOccupancy() { _placedPlants.length = 0; }
function occupancyConflict(x, z, r) {
    for (let i = 0; i < _placedPlants.length; i++) {
        const p = _placedPlants[i];
        const rr = (r + p.r) * 0.75;
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
}

// ── placement — jittered grid, slope rejection, bare patches (CK42BB) ───────
export function valueNoise2D(seed) {
    const h = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return s - Math.floor(s); };
    return (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf);
        return (h(xi, yi) * (1 - ux) + h(xi + 1, yi) * ux) * (1 - uy)
            + (h(xi, yi + 1) * (1 - ux) + h(xi + 1, yi + 1) * ux) * uy;
    };
}

export function placeInstances(o, spec) {
    const rng = (() => { let s = (o.seed ?? 7) * 2654435761 % 2147483647;
        return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    const noise = valueNoise2D(o.seed ?? 7);
    const W = o.width, D = o.depth, cx = o.center[0], cz = o.center[1];
    // `density` means the stand's INTERIOR fullness in every footprint mode:
    // the organic mask culls ~1/3 of placements, so it samples finer to keep
    // the same plants-per-square-metre as the circular default
    const step = 1 / Math.sqrt(spec.density * (o.density ?? 1) * (o.footprint === 'organic' ? 1.45 : 1));
    const out = [];
    // footprint: a stand is never square. Default cuts the W×D rectangle to
    // its inscribed ellipse with a feathered rim; footprint: 'organic' further
    // masks it with low-frequency noise so the stand reads as an irregular
    // lobed patch. (The rim feather is what keeps either shape from reading
    // as a stamped outline.)
    const organic = o.footprint === 'organic';
    const sstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    // the rim has no line: density feathers from 60% of the radius out, and a
    // sparse STRAGGLER tail runs past the nominal edge to 1.25R — isolated
    // outliers are what stop a foreshortened arc from reading as a stamped
    // boundary from a low camera
    const EXT = 1.25;
    for (let gx = -W * EXT / 2; gx < W * EXT / 2; gx += step) for (let gz = -D * EXT / 2; gz < D * EXT / 2; gz += step) {
        const x = cx + gx + (rng() - 0.5) * step, z = cz + gz + (rng() - 0.5) * step;
        if (o.clipFn && o.clipFn(x, z)) continue;
        const r = Math.sqrt(((x - cx) / (W / 2)) ** 2 + ((z - cz) / (D / 2)) ** 2);
        if (r > EXT) continue;
        if (r > 1) {
            if (rng() > 0.055 * (1 - (r - 1) / (EXT - 1))) continue;   // stragglers
        } else if (rng() < sstep(0.82, 1.04, r)) continue;             // feathered rim (outer ~18%)
        if (organic) {
            // lobe scale ADAPTS to the field: ~4 lobes per stand at any size.
            // A fixed wavelength made small stands lose half their area to a
            // single mask gap (and aligned gaps across stands left holes).
            const f = 3.4 / Math.max(W, D);
            const m = noise(x * f + 31.7, z * f + 17.3);
            if (m < 0.4 + 0.28 * Math.min(1, r)) continue;             // lobes shrink toward the rim
        }
        // bare patches + clumping via low-frequency noise (their density gate)
        const dN = noise(x * 0.05, z * 0.05);
        if (dN < 0.5 - spec.clump && rng() < 0.85) continue;
        const p = finishPlacement(x, z, o, spec, rng, step, true);
        // Optional streaming sink for bounded native/LOD reservoirs. It must
        // not consume the placement RNG: default browser output stays exact.
        if (p) { if (o.placementSink) o.placementSink(p); else out.push(p); }
    }
    return out;
}

// the shared placement tail — surface raycast / heightFn, slope gate, scale,
// occupancy, tilt + jitter. Grid placement self-checks the occupancy registry
// (selfCheck true); row planting only CLAIMS (a planted field is authored, the
// way explicit `placements` are — later strokes avoid it, it avoids nothing).
function finishPlacement(x, z, o, spec, rng, step, selfCheck) {
    let y, ntx = 0, ntz = 0;
    if (o._surfaceAt) {
        const hit = o._surfaceAt(x, z);
        if (!hit) return null;                           // off the geometry
        if (o.maxSlope && hit.slope > o.maxSlope) return null;
        y = hit.y;
        // follow the geometry: tilt world-up toward the hit normal by the
        // stroke's align share (grass hugs its ground, shrubs grow to sky)
        const k = o._align;
        if (k > 0) {
            ntx = Math.atan2(hit.nz, hit.ny) * k;
            ntz = -Math.atan2(hit.nx, hit.ny) * k;
        }
    } else {
        y = o.heightFn ? o.heightFn(x, z) : (o.y ?? 0);
        if (o.heightFn && o.maxSlope) {
            const eps = step * 0.5;
            const sx = (o.heightFn(x + eps, z) - y) / eps, sz = (o.heightFn(x, z + eps) - y) / eps;
            if (Math.atan(Math.hypot(sx, sz)) > o.maxSlope) return null;
        }
    }
    const [s0, s1] = spec.baseScale;
    const scale = s0 + rng() * (s1 - s0);
    if (spec.footRadius && o.avoid !== false) {
        const r = spec.footRadius * scale;
        if (selfCheck && occupancyConflict(x, z, r)) return null;
        _placedPlants.push({ x, z, r });
    }
    const leanAz = rng() * Math.PI * 2, lean = (rng() - 0.5) * 0.16;
    // `heading` locks instance yaw to a shared world azimuth (± headingJitter,
    // default 0.15 rad) — sunflower fields face one way; omit for the usual
    // random spin. ONE rng draw either way so the stream stays aligned.
    const spin = rng();
    const yaw = o.heading != null
        ? o.heading + (spin - 0.5) * 2 * (o.headingJitter ?? 0.15)
        : spin * Math.PI * 2;
    return {
        x, y, z, yaw,
        scale, tilt: 0,
        tx: ntx + Math.cos(leanAz) * lean, tz: ntz + Math.sin(leanAz) * lean,
        colorVar: rng(), phase: rng() * Math.PI * 2,
    };
}

// ── row planting — the cultivated footprint ─────────────────────────────────
// A planted field IS rectangular: rows at `spacing`, plants every `plant`
// metres along them, small sowing jitter, a few misses (`skip` + the density
// deficit), ragged headlands where each row starts and stops a little short.
// No ellipse cut, no stragglers — those are wild-stand manners. `angle` turns
// the whole planting; stride/phase interleave two strokes through one field
// (e.g. every 4th row from a peeled-ear variant call).
export function placeRows(o, spec) {
    const rng = (() => { let s = ((o.seed ?? 7) + 5) * 2654435761 % 2147483647;
        return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    const r = typeof o.rows === 'object' ? o.rows : {};
    // `density` works BOTH ways on a planted field, because a grid cannot
    // simply be told to hold more plants: below 1 it drops plants (skip),
    // above 1 it tightens the IN-ROW spacing — which is how a real field's
    // population is set, the row gap being fixed by the machinery. Without
    // the second half, every density >= 1 rendered the identical field.
    const k = o.density ?? 1;
    const gap = r.spacing ?? 0.76, inRow = (r.plant ?? 0.24) / Math.max(1, k);
    const ang = r.angle ?? 0, jit = r.jitter ?? 0.05;
    const skip = Math.min(0.95, (r.skip ?? 0.03) + Math.max(0, 1 - k));
    const stride = Math.max(1, r.stride ?? 1), phase = r.phase ?? 0;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const W = o.width, D = o.depth, cx = o.center[0], cz = o.center[1];
    const out = [];
    let rowI = 0;
    for (let rz = -D / 2 + gap * 0.5; rz <= D / 2 - gap * 0.2; rz += gap, rowI++) {
        if ((rowI + phase) % stride !== 0) continue;
        const end0 = -W / 2 + rng() * inRow * 1.6, end1 = W / 2 - rng() * inRow * 1.6;
        for (let rx = end0 + inRow * 0.5; rx <= end1; rx += inRow) {
            if (rng() < skip) continue;                   // the missing plants
            const lxx = rx + (rng() - 0.5) * jit * 2, lzz = rz + (rng() - 0.5) * jit * 2;
            const x = cx + lxx * ca - lzz * sa, z = cz + lxx * sa + lzz * ca;
            if (o.clipFn && o.clipFn(x, z)) continue;
            const p = finishPlacement(x, z, o, spec, rng, inRow, false);
            if (p) out.push(p);
        }
    }
    return out;
}

