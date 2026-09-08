/**
 * Hex-cell graph + A* pathfinding for the Babylon units demo.
 *
 * Deliberately engine-free: it takes the raw `Float32Array` from
 * `WasmLayout.face_tris(false)` and returns plain objects/arrays, so it runs
 * unchanged under node (see `web/hex-units-grid.test.mjs`).
 *
 * ## Where the cell centers come from
 *
 * `face_tris` is grouped per hex — 54 floats per cell, 6 center-fan triangles
 * of 3 vertices of 3 floats. Every one of those triangles starts at the fan
 * center, so floats `[0..3)` of each 54-float slice are the hex's world-space
 * center `(x, height, z)`: position *and* terrain height in one read, with no
 * second wasm call.
 *
 * ## Where adjacency comes from
 *
 * `hex_to_world_pos` ignores the per-cell `radius` (only the corner offsets
 * scale with it), so centers sit on an exact triangular lattice: every pair of
 * neighbors is one lattice spacing apart, and the next ring out is `sqrt(3)`
 * times farther. Measuring the smallest center-to-center distance and keeping
 * everything within {@link NEIGHBOR_TOLERANCE} of it therefore recovers hex
 * adjacency exactly — no axial coordinates needed on this side of the wasm
 * boundary.
 */

/** Floats per hex in the `face_tris` stream: 6 tris × 3 verts × 3 floats. */
export const FLOATS_PER_HEX = 54;

/**
 * Neighbor cutoff as a multiple of the lattice spacing. Comfortably above 1
 * (float noise in the f32 centers) and far below `sqrt(3) ≈ 1.732`, the
 * distance to the next ring of cells.
 */
export const NEIGHBOR_TOLERANCE = 1.15;

/** Extra path cost per world unit climbed or dropped between two cells. */
const CLIMB_COST = 4;

/**
 * @typedef {object} CellGraph
 * @property {Float32Array} centers Flat `n * 3` world-space cell centers.
 * @property {number[][]} neighbors Adjacency list, indices into `centers`.
 * @property {number} spacing Lattice spacing (center-to-center, in world units).
 * @property {number} count Number of cells.
 */

/** Squared XZ distance between cells `a` and `b` (height ignored). */
const planarDistSq = (c, a, b) => {
  const dx = c[a * 3] - c[b * 3];
  const dz = c[a * 3 + 2] - c[b * 3 + 2];
  return dx * dx + dz * dz;
};

/**
 * Builds the cell graph from a per-hex face-fan stream.
 *
 * @param {Float32Array} faceTris `WasmLayout.face_tris(entangled)` output.
 * @returns {CellGraph}
 */
export function buildCellGraph(faceTris) {
  const count = Math.floor(faceTris.length / FLOATS_PER_HEX);
  const centers = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const at = i * FLOATS_PER_HEX;
    centers[i * 3] = faceTris[at];
    centers[i * 3 + 1] = faceTris[at + 1];
    centers[i * 3 + 2] = faceTris[at + 2];
  }

  // Lattice spacing = the smallest center-to-center distance in the grid.
  let minSq = Infinity;
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const d = planarDistSq(centers, a, b);
      if (d < minSq) minSq = d;
    }
  }
  const spacing = Number.isFinite(minSq) ? Math.sqrt(minSq) : 0;

  const neighbors = Array.from({ length: count }, () => []);
  const cutoffSq = (spacing * NEIGHBOR_TOLERANCE) ** 2;
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      if (planarDistSq(centers, a, b) <= cutoffSq) {
        neighbors[a].push(b);
        neighbors[b].push(a);
      }
    }
  }
  return { centers, neighbors, spacing, count };
}

/** Height (world Y) of cell `i`. */
export const cellHeight = (graph, i) => graph.centers[i * 3 + 1];

/** True when the step `a → b` is within the unit's climbing ability. */
const passable = (graph, a, b, maxClimb) =>
  Math.abs(cellHeight(graph, b) - cellHeight(graph, a)) <= maxClimb;

/**
 * Every cell reachable from `start` by steps no steeper than `maxClimb`.
 * Used to pick destinations that are known-routable before running A*.
 *
 * @returns {number[]} Cell indices, including `start` itself.
 */
export function reachableFrom(graph, start, maxClimb) {
  const seen = new Uint8Array(graph.count);
  const out = [];
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const cur = queue.pop();
    out.push(cur);
    for (const nb of graph.neighbors[cur]) {
      if (!seen[nb] && passable(graph, cur, nb, maxClimb)) {
        seen[nb] = 1;
        queue.push(nb);
      }
    }
  }
  return out;
}

/**
 * A* from `start` to `goal` over passable steps.
 *
 * Step cost is `1 + CLIMB_COST * |Δheight| / spacing`, so units prefer level
 * routes and only climb when the detour would be longer. The heuristic is the
 * planar distance in lattice steps — admissible, since every step costs at
 * least 1 and advances exactly one spacing.
 *
 * @returns {number[] | null} Cell indices from `start` to `goal` inclusive, or
 *   `null` when no passable route exists.
 */
export function findPath(graph, start, goal, maxClimb) {
  if (start === goal) return [start];
  const { count, spacing } = graph;
  const gScore = new Float64Array(count).fill(Infinity);
  const fScore = new Float64Array(count).fill(Infinity);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const heuristic = (i) => Math.sqrt(planarDistSq(graph.centers, i, goal)) / spacing;

  gScore[start] = 0;
  fScore[start] = heuristic(start);
  const open = [start];

  while (open.length) {
    // Linear scan is fine: the grid tops out at a few hundred cells.
    let bestAt = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestAt]]) bestAt = i;
    }
    const cur = open.splice(bestAt, 1)[0];
    if (cur === goal) {
      const path = [cur];
      for (let p = cameFrom[cur]; p !== -1; p = cameFrom[p]) path.push(p);
      return path.reverse();
    }
    closed[cur] = 1;

    for (const nb of graph.neighbors[cur]) {
      if (closed[nb] || !passable(graph, cur, nb, maxClimb)) continue;
      const climb = Math.abs(cellHeight(graph, nb) - cellHeight(graph, cur));
      const tentative = gScore[cur] + 1 + (CLIMB_COST * climb) / spacing;
      if (tentative >= gScore[nb]) continue;
      cameFrom[nb] = cur;
      gScore[nb] = tentative;
      fScore[nb] = tentative + heuristic(nb);
      if (!open.includes(nb)) open.push(nb);
    }
  }
  return null;
}
