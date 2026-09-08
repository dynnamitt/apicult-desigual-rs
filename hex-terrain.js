import * as THREE from 'three';
import { weldTris } from './weld.js';

/**
 * Builds a single indexed `THREE.BufferGeometry` from the canonical unified
 * mesh stream (`WasmLayout.tris()`), welded by {@link weldTris} so
 * `computeVertexNormals()` shades continuously across shared edges. The stream
 * already includes hex face fans, junction tris and tessellated gap quads, so
 * no separate quad pass is needed.
 *
 * @param {Float32Array} trisBuf
 * @returns {THREE.BufferGeometry} Indexed geometry with `position` attribute,
 *   computed vertex normals, and computed bounding box.
 */
export function weldedMesh(trisBuf) {
  const { positions, indices } = weldTris(trisBuf);
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
