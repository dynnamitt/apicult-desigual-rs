import * as THREE from 'three';

/**
 * Builds a non-indexed `THREE.BufferGeometry` of line segments straight from a
 * flat edge buffer. Used with `THREE.LineSegments` (gl.LINES draw mode) for
 * shader-driven wireframes.
 *
 * Each vertex carries an `aArc` Float32 attribute encoding its position along
 * the segment (0 at the start endpoint, world-space length at the end). The
 * fragment shader uses this as the "distance along the line" for dash-pattern
 * animation.
 *
 * @param {Float32Array} edgesBuf - flat `n_edges * 6` floats
 *   (`x1,y1,z1, x2,y2,z2` per segment), as emitted by `WasmLayout.wire_edges()`.
 *   Already perimeter-walked Rust-side; no in-quad diagonals.
 * @returns {THREE.BufferGeometry} non-indexed geometry with `position` (vec3)
 *   and `aArc` (float) attributes plus a computed bounding box.
 */
export const wireEdgesGeometry = (edgesBuf) => {
  const nEdges = (edgesBuf.length / 6) | 0;
  const positions = new Float32Array(nEdges * 6);
  const arcs = new Float32Array(nEdges * 2);
  positions.set(edgesBuf);
  for (let ei = 0; ei < nEdges; ei++) {
    const o = ei * 6;
    const dx = edgesBuf[o + 3] - edgesBuf[o];
    const dy = edgesBuf[o + 4] - edgesBuf[o + 1];
    const dz = edgesBuf[o + 5] - edgesBuf[o + 2];
    arcs[ei * 2 + 1] = Math.hypot(dx, dy, dz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aArc', new THREE.BufferAttribute(arcs, 1));
  g.computeBoundingBox();
  return g;
};

/**
 * Returns a `ShaderMaterial` that draws walking-dot dashes along
 * gl.LINES segments — bright `uColor` where `mod(aArc - uTime*uSpeed, cycle)`
 * falls inside `uDashSize`, transparent in the gap. Combine with an
 * UnrealBloomPass for the glow.
 *
 * @param {object} opts
 * @param {THREE.ColorRepresentation} opts.color - dash color (HDR-bright values bloom harder).
 * @param {number} opts.dashSize - dash length in world units.
 * @param {number} opts.gapSize  - gap length in world units.
 * @param {number} opts.speed    - dash travel speed in world-units / second.
 * @returns {THREE.ShaderMaterial}
 */
export const createWireShader = ({ color, dashSize, gapSize, speed }) =>
  new THREE.ShaderMaterial({
    uniforms: {
      uTime:     { value: 0 },
      uColor:    { value: new THREE.Color(color) },
      uDashSize: { value: dashSize },
      uGapSize:  { value: gapSize },
      uSpeed:    { value: speed },
    },
    vertexShader: `
      attribute float aArc;
      varying float vArc;
      void main() {
        vArc = aArc;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime, uDashSize, uGapSize, uSpeed;
      uniform vec3  uColor;
      varying float vArc;
      void main() {
        float cycle = uDashSize + uGapSize;
        float phase = mod(vArc - uTime * uSpeed, cycle);
        float aa = fwidth(phase);
        float on = 1.0 - smoothstep(uDashSize, uDashSize + aa, phase);
        if (on < 0.01) discard;
        gl_FragColor = vec4(uColor * on, on);
      }
    `,
    transparent: true,
    extensions: { derivatives: true },
  });
