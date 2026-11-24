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
 * produced by `weldedMesh` in `three-weld.js`).
 * @param {THREE.BufferGeometry} geom
 * @returns {number}
 */
export function triangleCount(geom) {
  return geom.index.count / 3;
}
