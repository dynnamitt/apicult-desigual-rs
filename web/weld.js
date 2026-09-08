/**
 * Engine-agnostic vertex welding for the canonical triangle stream.
 *
 * `WasmLayout.tris()` emits a flat `n * 9` Float32Array (3 corners × 3
 * components, CCW) with every triangle standing alone — hex face fans,
 * junction tris and tessellated gap quads all repeat the vertices they share.
 * Welding deduplicates those positions so neighboring faces meet seamlessly
 * and a normal pass produces continuous shading across the seam.
 *
 * Welding is exact: vertices are matched by stringified coordinates, so inputs
 * must already share identical floats at seams (no epsilon merge). The Rust
 * side guarantees this — every shared corner goes through `HGridLayout::vertex`.
 *
 * Output is plain arrays so each renderer can wrap them in its own buffer type
 * (`THREE.BufferGeometry` in {@link ./hex-terrain.js}, `BABYLON.VertexData` in
 * {@link ./hex-units-scene.js}).
 *
 * @param {Float32Array} trisBuf Flat `n * 9` triangle stream.
 * @returns {{positions: number[], indices: number[]}} Indexed mesh data.
 */
export function weldTris(trisBuf) {
  const positions = [];
  const indices = [];
  const lookup = new Map();

  const indexOf = (x, y, z) => {
    const k = `${x},${y},${z}`;
    let idx = lookup.get(k);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      lookup.set(k, idx);
    }
    return idx;
  };

  for (let i = 0; i + 9 <= trisBuf.length; i += 9) {
    indices.push(
      indexOf(trisBuf[i], trisBuf[i + 1], trisBuf[i + 2]),
      indexOf(trisBuf[i + 3], trisBuf[i + 4], trisBuf[i + 5]),
      indexOf(trisBuf[i + 6], trisBuf[i + 7], trisBuf[i + 8]),
    );
  }
  return { positions, indices };
}
