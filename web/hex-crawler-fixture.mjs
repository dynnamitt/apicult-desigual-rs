/**
 * Test-only fixture (not shipped — `make` never copies it into the preview).
 *
 * Synthesizes the `face_tris` / `face_bridge_quads` / `tris` triple that
 * `WasmLayout` would emit for a flat-top hexagon grid with real gaps, including
 * the property the board builder leans on: a bridge slot's source-side corners
 * are bit-identical to the rim corners of the fan triangle on the same edge.
 *
 * Lets both crawler suites run without a cargo/wasm build.
 */
import {
  BRIDGE_SLOT_STRIDE,
  FLOATS_PER_HEX_BRIDGES,
  FLOATS_PER_HEX_FANS,
} from "./hex-crawler-board.js";

/** Lattice half-width; neighbour centres sit `sqrt(3) * SIZE` apart. */
export const SIZE = 4;
/** Hex circumradius. Below SIZE, so hexes never touch and every edge has a gap. */
export const CELL_R = 3.2;

export const axialToWorld = (q, r) => [
  1.5 * SIZE * q,
  Math.sqrt(3) * SIZE * (r + q / 2),
];

/** Corner `i` of a flat-top hex: angle `60i`, in the (x, z) plane. */
export const corner = (cx, cz, i) => [
  cx + CELL_R * Math.cos((Math.PI / 3) * i),
  cz + CELL_R * Math.sin((Math.PI / 3) * i),
];

/** Axial deltas for edges 0..5, matching the corner ordering above. */
const NEIGHBOR_AXIAL = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

/**
 * @param {number} radius
 * @param {object} [opts]
 * @param {number} [opts.slotShift] Writes the quad for the edge between corners
 *   `e` and `e+1` into bridge slot `e + slotShift`, emulating the rotation
 *   between hexx's VertexDirection and EdgeDirection tables. `buildBoard` must
 *   recover exactly this number.
 * @param {(q: number, r: number) => number} [opts.height]
 */
export function fixture(radius, { slotShift = 0, height = () => 0 } = {}) {
  const coords = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      coords.push([q, r]);
    }
  }
  const index = new Map(coords.map(([q, r], i) => [`${q},${r}`, i]));
  const n = coords.length;
  const faceTris = new Float32Array(n * FLOATS_PER_HEX_FANS);
  const bridges = new Float32Array(n * FLOATS_PER_HEX_BRIDGES);

  // Fan triangles: [centre, corner e, corner e+1].
  coords.forEach(([q, r], h) => {
    const [cx, cz] = axialToWorld(q, r);
    const y = height(q, r);
    for (let e = 0; e < 6; e++) {
      const [ax, az] = corner(cx, cz, e);
      const [bx, bz] = corner(cx, cz, e + 1);
      faceTris.set([cx, y, cz, ax, y, az, bx, y, bz], h * FLOATS_PER_HEX_FANS + e * 9);
    }
  });

  // Bridge quads: [flag, q0, q1, q2, q3], q0/q3 on the source hex (exactly the
  // fan tri's rim corners) and q1/q2 on the neighbour, q1 nearest q0.
  coords.forEach(([q, r], h) => {
    const [cx, cz] = axialToWorld(q, r);
    for (let e = 0; e < 6; e++) {
      const [dq, dr] = NEIGHBOR_AXIAL[e];
      const nh = index.get(`${q + dq},${r + dr}`);
      if (nh === undefined) continue;
      const [nq, nr] = coords[nh];
      const [nx, nz] = axialToWorld(nq, nr);
      const q0 = corner(cx, cz, e);
      const q3 = corner(cx, cz, e + 1);
      // The neighbour's facing edge is three steps round its own ring.
      const candidates = [corner(nx, nz, e + 3), corner(nx, nz, e + 4)];
      const distTo = (p) => Math.hypot(p[0] - q0[0], p[1] - q0[1]);
      const [q1, q2] = distTo(candidates[0]) < distTo(candidates[1])
        ? candidates
        : [candidates[1], candidates[0]];
      const y = height(q, r);
      const ny = height(nq, nr);
      bridges.set([
        1,
        q0[0], y, q0[1],
        q1[0], ny, q1[1],
        q2[0], ny, q2[1],
        q3[0], y, q3[1],
      ], h * FLOATS_PER_HEX_BRIDGES + ((e + slotShift) % 6) * BRIDGE_SLOT_STRIDE);
    }
  });

  // The base layer only needs a well-formed triangle stream; the fans are one.
  return { faceTris, bridges, tris: faceTris, index, hexCount: n };
}

/** Deterministic [0, 1) generator, so walk tests are reproducible. */
export function seededRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 0x1_0000_0000;
  };
}
