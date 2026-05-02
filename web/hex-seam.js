// Seam math for the hexagonal "flower" of 7 WasmLayouts.
//
// Layout slots: center + 6 petals, one per VertexDirection (d = 0..5).
// Each petal placed at slot d sits at world angle d * 60° around the center,
// at distance 3 * R * nominal_hex_radius — exactly the offset that makes its
// OPPOSITE[d] side coincide with center's d side, sharing R+1 cells.
//
// As petals are placed CCW around the ring, each one entangles every side
// that already has a placed neighbor:
//   slot 0 (first petal):     1 entangled side  (vs center)
//   slots 1..4:                2 entangled sides (vs center, vs petal d-1)
//   slot 5 (closing the ring): 3 entangled sides (vs center, vs petal 4, vs petal 0)
//
// Cell pairing across every seam is REVERSE: the i-th cell in one side's
// borderline_cells walk pairs with the (R-i)-th cell in the other side's walk.
// This was verified empirically against hexx 0.24's flat-top default layout —
// see the in-source assert in `seamFromNeighbor`.

import { OverrideSpec, EntangleSpec, NoiseChannel } from "./pkg/apicult_desigual.js";

// Display labels for the 6 hex directions, indexed 0..5 in CCW order from +x.
// Currently no JS consumer — the HTML hardcodes the same labels in the dir-picker
// buttons (web/hex-terrain.html). Kept exported so future code can `[d]` into the
// table; if you change either end, sync the other.
export const VERTEX_DIR_NAMES = [
  "right", "down-right", "down-left", "left", "up-left", "up-right",
];

// 180° opposite of each side. side d midpoint is at world angle d*60°.
export const OPPOSITE = [3, 4, 5, 0, 1, 2];

// Side of petal d that faces the previous-placed petal at slot (d-1) mod 6.
// Derived from: vector from petal d → petal d-1 has angle (d-2)*60°.
export const RING_FACING_PREV = [4, 5, 0, 1, 2, 3]; // (d + 4) % 6

// Side of petal d that faces the next petal at slot (d+1) mod 6.
// Derived from: vector from petal d → petal d+1 has angle (d+2)*60°.
export const RING_FACING_NEXT = [2, 3, 4, 5, 0, 1]; // (d + 2) % 6

// hexx uses VertexDir indices 0..5; WasmLayout.borderline_cells(VertexDir)
// returns cells in CCW order. With flat-top default orientation the
// midpoint of side d sits at world angle d*60°, so the petal-translation
// magnitude that makes side d (center) coincide with side OPPOSITE[d] (petal)
// is just twice the world distance from center to that midpoint cell.
// For an R-radius hex grid, the midpoint cell of any side sits at world
// distance 1.5 * R * nominal_hex_radius. So petal distance = 3 * R * nominal_hex_radius.
export const PETAL_DISTANCE_FACTOR = 3.0;

/**
 * World-space (X, Z) translation for the petal at slot `dir`.
 * Returns 3D-friendly { tx, tz } — y stays at 0, terrain heights handle Y.
 * `petalDistanceFactor` defaults to the geometrically-derived 3.0; raising it
 * spaces petals farther apart (visible gaps), lowering it overlaps them.
 */
export const petalTranslation = (
  dir, radius, nominalHexRadius, petalDistanceFactor = PETAL_DISTANCE_FACTOR,
) => {
  const mag = petalDistanceFactor * radius * nominalHexRadius;
  const a = (dir * Math.PI) / 3;
  return { tx: mag * Math.cos(a), tz: mag * Math.sin(a) };
};

/**
 * Cache of per-side (q, r) coordinate lists in any layout's local hex frame.
 * Built lazily on first call by probing a throwaway layout. Keyed by radius.
 */
const LOCAL_BORDER_CACHE = new Map();

const ensureLocalBorder = (radius, WasmLayout) => {
  const cached = LOCAL_BORDER_CACHE.get(radius);
  if (cached) return cached;
  const probe = new WasmLayout(radius, 0, 0, [], []);
  const sides = [];
  for (let s = 0; s < 6; s++) {
    const cells = probe.borderline_cells(s);
    sides.push(cells.map((c) => ({ q: c.q, r: c.r })));
    for (const c of cells) c.free();
  }
  probe.free();
  LOCAL_BORDER_CACHE.set(radius, sides);
  return sides;
};

/**
 * Given an already-built `neighborLayout` and the side of *that* layout that
 * faces the new petal (`neighborSide`), plus the side of the new petal that
 * faces the neighbor (`mySide`), produce overrides + entangle entries for
 * the new petal's local hex frame. Caller passes accumulator arrays.
 *
 * Pairing is REVERSE: srcCells[i] ↔ localCells[R - i]. This was derived by
 * working out the geometry in flat-top hexx-default orientation; the
 * `console.assert` below catches any winding mismatch.
 */
export const seamFromNeighbor = ({
  neighborLayout, neighborSide, mySide, radius, WasmLayout,
  overrides, entangle,
}) => {
  const srcCells = neighborLayout.borderline_cells(neighborSide);
  const localBorder = ensureLocalBorder(radius, WasmLayout)[mySide];
  if (srcCells.length !== localBorder.length) {
    throw new Error(
      `seam length mismatch: neighbor=${srcCells.length} local=${localBorder.length}`,
    );
  }
  const n = srcCells.length;
  for (let i = 0; i < n; i++) {
    const src = srcCells[i];
    const m = localBorder[n - 1 - i];
    overrides.push(new OverrideSpec(NoiseChannel.Height, m.q, m.r, src.height));
    overrides.push(new OverrideSpec(NoiseChannel.Size, m.q, m.r, src.radius));
    entangle.push(new EntangleSpec(m.q, m.r));
  }
  for (const c of srcCells) c.free();
};

/**
 * Build the full seam spec for the petal at slot `dir`: overrides + entangle
 * arrays accumulated from every already-placed neighbor (center always; the
 * previous ring petal when present; the first ring petal too when closing
 * the ring at d=5), plus the world-XZ translation for placement.
 *
 * **Reserved API — no current consumer.** The streaming cluster bootstraps
 * via `seamSpecForCell` (order-agnostic), which subsumes this function for
 * the live demo. Kept exported so external embedders that build a static
 * 1+6 cluster CCW-style still have a one-shot helper available.
 *
 * @param {object} args
 * @param {WasmLayout} args.centerLayout
 * @param {Array<WasmLayout|undefined>} args.ringSoFar - ringSoFar[i] is the
 *   already-placed petal at slot i (undefined until slot i is placed).
 * @param {number} args.dir - this petal's slot, 0..5.
 * @param {number} args.radius
 * @param {number} args.nominalHexRadius
 * @param {Function} args.WasmLayout
 */
export const seamSpec = ({
  centerLayout, ringSoFar, dir, radius, nominalHexRadius, WasmLayout,
  petalDistanceFactor = PETAL_DISTANCE_FACTOR,
}) => {
  const overrides = [];
  const entangle = [];

  // Center seam — always present.
  seamFromNeighbor({
    neighborLayout: centerLayout,
    neighborSide: dir,
    mySide: OPPOSITE[dir],
    radius, WasmLayout, overrides, entangle,
  });

  // Previous-ring seam (slots 1..5).
  if (dir > 0) {
    const prev = ringSoFar[dir - 1];
    seamFromNeighbor({
      neighborLayout: prev,
      neighborSide: RING_FACING_NEXT[dir - 1],
      mySide: RING_FACING_PREV[dir],
      radius, WasmLayout, overrides, entangle,
    });
  }

  // Closing seam (only at slot 5, joining back to slot 0).
  if (dir === 5) {
    const first = ringSoFar[0];
    seamFromNeighbor({
      neighborLayout: first,
      neighborSide: RING_FACING_PREV[0],
      mySide: RING_FACING_NEXT[5],
      radius, WasmLayout, overrides, entangle,
    });
  }

  const { tx, tz } = petalTranslation(
    dir, radius, nominalHexRadius, petalDistanceFactor,
  );
  return { overrides, entangle, tx, tz };
};

// Order-agnostic seam builder for the streaming cluster. Unlike `seamSpec`
// (which assumes the strict CCW center→d0→d1→…→d5 build order), this walks
// the 6 axial neighbors of `myAxial` and seams against any that are already
// present in `existingTiles`. Each existing neighbor contributes one
// `seamFromNeighbor` call.
//
// `existingTiles` is a Map<axialKey, { axial, wasmHandle }>. The map must
// already contain any sibling tiles built earlier in the current spawn batch
// (see Build Order in the design spec).
//
// Returns { overrides, entangle } accumulator arrays ready to pass into
// `new WasmLayout(...)`.
//
// @param {object} args
// @param {{q:number,r:number}} args.myAxial - the cell about to be built.
// @param {Map<string, {axial:{q,r}, wasmHandle:WasmLayout}>} args.existingTiles
// @param {number} args.radius
// @param {Function} args.WasmLayout
export const seamSpecForCell = ({
  myAxial, existingTiles, radius, WasmLayout,
}) => {
  const overrides = [];
  const entangle = [];

  // 6 neighbor offsets are imported from hex-stream.js indirectly via the
  // dir indices: dir d's offset is the same { q, r } in axial space we use
  // there. Inline the literal table here so hex-seam.js stays standalone.
  const neighborOffsets = [
    { q:  1, r:  0 },
    { q:  0, r:  1 },
    { q: -1, r:  1 },
    { q: -1, r:  0 },
    { q:  0, r: -1 },
    { q:  1, r: -1 },
  ];

  for (let d = 0; d < 6; d++) {
    const off = neighborOffsets[d];
    const neighborAxial = { q: myAxial.q + off.q, r: myAxial.r + off.r };
    const key = `${neighborAxial.q},${neighborAxial.r}`;
    const tile = existingTiles.get(key);
    if (!tile) continue;
    // d is the direction from me to this neighbor. My side facing the
    // neighbor is therefore side d; the neighbor's side facing me is the
    // opposite, (d+3)%6. (The previous version had these swapped, breaking
    // every seam on both the bootstrap and step paths — visible as height
    // discontinuities at every shared edge.)
    const mySide = d;
    const neighborSide = (d + 3) % 6;  // OPPOSITE[d]
    seamFromNeighbor({
      neighborLayout: tile.wasmHandle,
      neighborSide,
      mySide,
      radius,
      WasmLayout,
      overrides,
      entangle,
    });
  }

  return { overrides, entangle };
};
