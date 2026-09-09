/**
 * Board geometry for the Phaser crawler page.
 *
 * Turns the wasm buffers into the two vertex arrays the custom WebGL pipeline
 * draws, plus the lookup tables the walk state machine needs. Deliberately
 * engine-free — no Phaser, no GL, no wasm import — so it runs under plain node
 * (`web/hex-crawler-board.test.mjs`).
 *
 * ## Projection
 *
 * `src/serialize.rs` already fixes the 2D convention for this grid: the SVG
 * exporter drops `y` and draws `(v.x, v.z)`, tinting fills by `height / max_h`.
 * This module does the same — world `(x, z)` goes into the buffer and `y` rides
 * along as a per-vertex attribute for the tint. Fitting those world units to the
 * canvas is left to a uniform in the vertex shader, so a resize never rebuilds
 * the buffer.
 *
 * ## The tri↔edge offset
 *
 * A hex's 6 fan triangles (`face_tris`) and its 6 bridge slots
 * (`face_bridge_quads`) are both indexed `0..6`, but they are indexed off
 * different `hexx` direction tables — `VertexDirection` for the corners,
 * `EdgeDirection` for the bridges — so fan tri `t` may sit on bridge slot
 * `t + k` for some fixed rotation `k`.
 *
 * Rather than hardcode `k`, {@link buildBoard} derives it: the Rust side
 * guarantees a slot's source-side corners (`q0`/`q3`) are *bit-exact* the two
 * rim corners of the fan tri sharing that edge (both go through
 * `HGridLayout::vertex`), so matching those pairs by exact float equality
 * recovers `k`, and disagreement between hexes is a thrown error rather than a
 * character that walks out of the wrong door.
 */

/** Floats per hex in `face_tris`: 6 tris × 3 verts × 3 floats. */
export const FLOATS_PER_HEX_FANS = 54;
/** Floats per hex in `face_bridge_quads`: 6 slots × 13 floats. */
export const FLOATS_PER_HEX_BRIDGES = 78;
/** Floats per bridge slot: `[flag, q0, q1, q2, q3]`. */
export const BRIDGE_SLOT_STRIDE = 13;

/**
 * Interleaved attribute layout of the interactive layer, in floats:
 * `[x, z, cell, cellB, slot, kind, weight, height]`.
 *
 * - `kind` — `0` = hex fan triangle, `1` = gap quad.
 * - `cell` / `cellB` — for a hex face, the owning hex and `-1`. For a gap quad,
 *   the two cells it joins: `cell` is the source side (`q0`/`q3`) and `cellB`
 *   the far side. A gap is emitted **once**, by the lower-indexed of the two
 *   hexes — `face_bridge_quads` reports every face edge of every hex with no
 *   ownership rule, so both copies would be exactly coincident and, with no
 *   depth test, the later one would overdraw a lit crossing.
 * - `slot` — fan tri index for `kind 0`, in bridge-slot space (see the offset
 *   note above); unused for `kind 1`, which is matched by its cell pair instead
 *   so that a crossing is found whichever way the character is going.
 * - `weight` — the convention `web/hex-terrain-shader.js` established: `1.0` at
 *   the fan centre and `0.0` at the rim for hex faces; `0.0` on the source side
 *   (`q0`/`q3`) and `1.0` on the neighbour side (`q1`/`q2`) for gap quads. In
 *   the gap it doubles as the band coordinate, so no extra attribute is needed.
 */
export const FLOATS_PER_VERTEX = 8;

/** Floats per vertex of the dim base layer: `[x, z, height]`. */
export const FLOATS_PER_BASE_VERTEX = 3;

const KIND_FACE = 0;
const KIND_GAP = 1;

/** Exact 3-component equality — the Rust side promises bit-identical corners. */
const sameVertex = (buf, a, other, b) =>
  buf[a] === other[b] && buf[a + 1] === other[b + 1] && buf[a + 2] === other[b + 2];

/**
 * Recovers the fixed rotation between fan-tri indices and bridge-slot indices.
 *
 * For every hex and every fan tri, the tri's two rim corners are matched against
 * each flagged bridge slot's source-side corners. Border edges simply produce no
 * match and are skipped.
 *
 * @throws if two hexes disagree, which would mean the bit-exactness guarantee in
 *   `HGridLayout::hex_face_bridge_quads` no longer holds.
 * @returns {number} `k` in `slot = (tri + k) % 6`, or `0` for a grid with no
 *   bridges at all (a radius-0 board).
 */
function deriveSlotOffset(faceTris, bridges, hexCount) {
  let found = null;
  for (let h = 0; h < hexCount; h++) {
    for (let t = 0; t < 6; t++) {
      // Fan tri = [centre, rimA, rimB]; the rim pair is what an edge shares.
      const rimA = h * FLOATS_PER_HEX_FANS + t * 9 + 3;
      const rimB = rimA + 3;
      for (let s = 0; s < 6; s++) {
        const slot = h * FLOATS_PER_HEX_BRIDGES + s * BRIDGE_SLOT_STRIDE;
        if (bridges[slot] !== 1) continue;
        const q0 = slot + 1;
        const q3 = slot + 1 + 9;
        const match =
          (sameVertex(faceTris, rimA, bridges, q0) && sameVertex(faceTris, rimB, bridges, q3)) ||
          (sameVertex(faceTris, rimA, bridges, q3) && sameVertex(faceTris, rimB, bridges, q0));
        if (!match) continue;
        const k = (s - t + 6) % 6;
        if (found === null) found = k;
        else if (found !== k) {
          throw new Error(
            `inconsistent fan-tri/bridge-slot offset: saw ${found} and ${k} ` +
            `(hex ${h}, tri ${t}, slot ${s})`,
          );
        }
      }
    }
  }
  return found ?? 0;
}

/**
 * @typedef {object} Board
 * @property {Float32Array} vertices Interleaved interactive layer,
 *   {@link FLOATS_PER_VERTEX} floats per vertex.
 * @property {number} vertexCount Vertices in `vertices`.
 * @property {Float32Array} base Dim full-board layer (includes the 3-hex
 *   junction triangles), {@link FLOATS_PER_BASE_VERTEX} floats per vertex.
 * @property {number} baseVertexCount Vertices in `base`.
 * @property {number} hexCount
 * @property {number} slotOffset `k` in `slot = (tri + k) % 6`.
 * @property {Int32Array} neighborOf `hexCount * 6`; cell index across each
 *   bridge slot, or `-1` on a border edge.
 * @property {number} maxHeight Largest cell height, for the SVG-style tint.
 * @property {{minX: number, maxX: number, minZ: number, maxZ: number}} bounds
 *   World-space extent of the drawn geometry, for fitting to the canvas.
 */

/**
 * Builds every buffer and table the crawler page needs.
 *
 * @param {object} buffers
 * @param {Float32Array} buffers.faceTris `WasmLayout.face_tris(false)`.
 * @param {Float32Array} buffers.bridges `WasmLayout.face_bridge_quads(false)`.
 * @param {Float32Array} buffers.tris `WasmLayout.tris(false)` — the unified
 *   stream, used only for the dim base layer since it already carries the
 *   junction triangles that neither per-hex stream reports.
 * @param {{centers: Float32Array, count: number}} graph Cell graph from
 *   `hex-units-grid.js::buildCellGraph`, reused for centres.
 * @returns {Board}
 */
export function buildBoard({ faceTris, bridges, tris }, graph) {
  const hexCount = Math.floor(faceTris.length / FLOATS_PER_HEX_FANS);
  const slotOffset = deriveSlotOffset(faceTris, bridges, hexCount);
  const neighborOf = buildNeighborTable(bridges, hexCount, graph);

  // One quad per gap: the lower-indexed hex of each adjacent pair owns it.
  const owned = [];
  for (let h = 0; h < hexCount; h++) {
    for (let s = 0; s < 6; s++) {
      const n = neighborOf[h * 6 + s];
      if (n > h) owned.push([h, s, n]);
    }
  }

  // 6 fan tris per hex + 2 tris per owned gap quad, 3 verts each.
  const vertexCount = hexCount * 18 + owned.length * 6;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  let at = 0;
  let maxHeight = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  const push = (x, y, z, cell, cellB, slot, kind, weight) => {
    vertices[at++] = x;
    vertices[at++] = z;
    vertices[at++] = cell;
    vertices[at++] = cellB;
    vertices[at++] = slot;
    vertices[at++] = kind;
    vertices[at++] = weight;
    vertices[at++] = y;
    if (y > maxHeight) maxHeight = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  // Hex faces. The fan centre carries weight 1, the two rim corners 0, so the
  // fill reads as rim → centroid exactly like the terrain page's ring overlay.
  for (let h = 0; h < hexCount; h++) {
    for (let t = 0; t < 6; t++) {
      const slot = (t + slotOffset) % 6;
      const tri = h * FLOATS_PER_HEX_FANS + t * 9;
      for (let v = 0; v < 3; v++) {
        const p = tri + v * 3;
        push(faceTris[p], faceTris[p + 1], faceTris[p + 2], h, -1, slot, KIND_FACE, v === 0 ? 1 : 0);
      }
    }
  }

  // Gap quads, split on the canonical [q0, q2] diagonal to match
  // `gap_quad_tris` — the same unpacking as `hex-terrain-shader.js::bridgeGeometry`.
  const QUAD_TRIS = [[0, 1, 2], [0, 2, 3]];
  const CORNER_WEIGHT = [0, 1, 1, 0];
  for (const [h, s, n] of owned) {
    const slot = h * FLOATS_PER_HEX_BRIDGES + s * BRIDGE_SLOT_STRIDE;
    for (const corners of QUAD_TRIS) {
      for (const c of corners) {
        const p = slot + 1 + c * 3;
        push(bridges[p], bridges[p + 1], bridges[p + 2], h, n, s, KIND_GAP, CORNER_WEIGHT[c]);
      }
    }
  }

  // Dim base layer: the whole board including 3-hex junction tris, which
  // neither per-hex stream reports and which `tris(false)` already contains.
  const baseVertexCount = Math.floor(tris.length / 3);
  const base = new Float32Array(baseVertexCount * FLOATS_PER_BASE_VERTEX);
  for (let i = 0, b = 0; i + 3 <= tris.length; i += 3) {
    base[b++] = tris[i];
    base[b++] = tris[i + 2];
    base[b++] = tris[i + 1];
  }

  return {
    vertices,
    vertexCount,
    base,
    baseVertexCount,
    hexCount,
    slotOffset,
    neighborOf,
    maxHeight,
    bounds: { minX, maxX, minZ, maxZ },
  };
}

/**
 * Which cell lies across each bridge slot.
 *
 * The slot's far corners (`q1`/`q2`) sit on the neighbour's perimeter, so their
 * midpoint is nearer that neighbour's centre than any other cell's — the gaps
 * guarantee a cell's radius is below half the lattice spacing, so the nearest
 * centre is unambiguous.
 *
 * @returns {Int32Array} `hexCount * 6`, `-1` where the edge is a border.
 */
function buildNeighborTable(bridges, hexCount, graph) {
  const out = new Int32Array(hexCount * 6).fill(-1);
  const { centers, count } = graph;
  for (let h = 0; h < hexCount; h++) {
    for (let s = 0; s < 6; s++) {
      const slot = h * FLOATS_PER_HEX_BRIDGES + s * BRIDGE_SLOT_STRIDE;
      if (bridges[slot] !== 1) continue;
      const q1 = slot + 1 + 3;
      const q2 = slot + 1 + 6;
      const mx = (bridges[q1] + bridges[q2]) / 2;
      const mz = (bridges[q1 + 2] + bridges[q2 + 2]) / 2;
      let best = -1;
      let bestSq = Infinity;
      for (let c = 0; c < count; c++) {
        const dx = centers[c * 3] - mx;
        const dz = centers[c * 3 + 2] - mz;
        const d = dx * dx + dz * dz;
        if (d < bestSq) { bestSq = d; best = c; }
      }
      out[h * 6 + s] = best;
    }
  }
  return out;
}

/**
 * The bridge slot of `from` that leads to `to`.
 *
 * @returns {number} slot `0..5`, or `-1` if the cells are not adjacent.
 */
export function slotBetween(board, from, to) {
  for (let s = 0; s < 6; s++) {
    if (board.neighborOf[from * 6 + s] === to) return s;
  }
  return -1;
}
