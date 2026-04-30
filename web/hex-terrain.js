import * as THREE from 'three';

const keyOf = (x, y, z) => `${x},${y},${z}`;

/**
 * Builds a single indexed `THREE.BufferGeometry` from quad and tri faces,
 * welding (deduplicating) shared vertex positions so neighboring faces meet
 * seamlessly and `computeVertexNormals()` produces continuous shading across
 * the seam.
 *
 * Inputs are flat Float32Arrays as emitted by the wasm module:
 *   - `quadsBuf` is `n * 12` floats (4 corners × 3 components, CCW).
 *     Each quad is triangulated as `(a, b, c)` + `(a, c, d)`.
 *   - `trisBuf` is `m * 9` floats (3 corners × 3 components, CCW).
 *
 * Welding is exact: vertices are matched by stringified coordinates, so
 * inputs must already share identical floats at seams (no epsilon merge).
 *
 * @param {Float32Array} quadsBuf
 * @param {Float32Array} trisBuf
 * @returns {THREE.BufferGeometry} Indexed geometry with `position` attribute,
 *   computed vertex normals, and computed bounding box.
 */
export function weldedMesh(quadsBuf, trisBuf) {
  const positions = [];
  const indices = [];
  const lookup = new Map();

  const indexOf = (x, y, z) => {
    const k = keyOf(x, y, z);
    let idx = lookup.get(k);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      lookup.set(k, idx);
    }
    return idx;
  };

  for (let i = 0; i + 12 <= quadsBuf.length; i += 12) {
    const ia = indexOf(quadsBuf[i],     quadsBuf[i + 1],  quadsBuf[i + 2]);
    const ib = indexOf(quadsBuf[i + 3], quadsBuf[i + 4],  quadsBuf[i + 5]);
    const ic = indexOf(quadsBuf[i + 6], quadsBuf[i + 7],  quadsBuf[i + 8]);
    const id = indexOf(quadsBuf[i + 9], quadsBuf[i + 10], quadsBuf[i + 11]);
    indices.push(ia, ib, ic, ia, ic, id);
  }
  for (let i = 0; i + 9 <= trisBuf.length; i += 9) {
    const ia = indexOf(trisBuf[i],     trisBuf[i + 1], trisBuf[i + 2]);
    const ib = indexOf(trisBuf[i + 3], trisBuf[i + 4], trisBuf[i + 5]);
    const ic = indexOf(trisBuf[i + 6], trisBuf[i + 7], trisBuf[i + 8]);
    indices.push(ia, ib, ic);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  return geom;
}

/**
 * Number of vertices in the (welded) position buffer.
 * @param {THREE.BufferGeometry} geom
 * @returns {number}
 */
export function vertexCount(geom) {
  return geom.attributes.position.count;
}

/**
 * Number of triangles in the indexed mesh — assumes `geom` is indexed (as
 * produced by {@link weldedMesh}).
 * @param {THREE.BufferGeometry} geom
 * @returns {number}
 */
export function triangleCount(geom) {
  return geom.index.count / 3;
}
