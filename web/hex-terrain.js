import * as THREE from 'three';

const keyOf = (x, y, z) => `${x},${y},${z}`;

/**
 * Builds a single indexed `THREE.BufferGeometry` from a flat triangle stream,
 * welding (deduplicating) shared vertex positions so neighboring faces meet
 * seamlessly and `computeVertexNormals()` produces continuous shading across
 * the seam.
 *
 * Input is the canonical unified mesh stream as emitted by
 * `WasmLayout.tris()` — a flat `n * 9` Float32Array (3 corners × 3 components,
 * CCW). Includes hex face fans, junction tris, and tessellated gap quads, so
 * no separate quad pass is needed.
 *
 * Welding is exact: vertices are matched by stringified coordinates, so
 * inputs must already share identical floats at seams (no epsilon merge).
 *
 * @param {Float32Array} trisBuf
 * @returns {THREE.BufferGeometry} Indexed geometry with `position` attribute,
 *   computed vertex normals, and computed bounding box.
 */
export function weldedMesh(trisBuf) {
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
