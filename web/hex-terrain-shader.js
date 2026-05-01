import * as THREE from 'three';

/**
 * Builds a non-indexed `THREE.BufferGeometry` of line segments from a flat
 * edge buffer. Used with `THREE.LineSegments` (gl.LINES draw mode) for
 * shader-driven wireframes.
 *
 * Each vertex carries an `aArc` Float32 attribute encoding its position along
 * the segment (0 at the start endpoint, world-space length at the end). The
 * fragment shader uses this as the "distance along the line" for dash-pattern
 * animation.
 *
 * The input buffer is `WasmLayout.wire_edges()` which emits 4 perimeter
 * segments per gap quad in CCW order. Two of those are **bridge** edges
 * (cross-gap, hex→neighbor, quad-local indices 0 and 2) and two are **rim**
 * edges (along one hex's side, indices 1 and 3). This function keeps only
 * the **rim** edges — bridges are intentionally undecorated so the dotted
 * shader effect reads as "pinned along each hex's outline" rather than
 * smearing across the gaps. The split is purely topological; relative
 * lengths flip when hex radius dwarfs gap padding.
 *
 * @param {Float32Array} edgesBuf - flat `n_quads * 24` floats (4 edges × 6
 *   floats per quad), as emitted by `WasmLayout.wire_edges()`.
 * @returns {THREE.BufferGeometry} non-indexed geometry with `position` (vec3)
 *   and `aArc` (float) attributes plus a computed bounding box. Vertex count
 *   is `nQuads * 4` (2 rim edges × 2 endpoints per quad).
 */
const QUAD_FLOATS = 24;
const RIM_EDGE_OFFSETS = [6, 18];

export const wireEdgesGeometry = (edgesBuf) => {
  const nQuads = (edgesBuf.length / QUAD_FLOATS) | 0;
  const nEdges = nQuads * RIM_EDGE_OFFSETS.length;
  const positions = new Float32Array(nEdges * 6);
  const arcs = new Float32Array(nEdges * 2);
  for (let qi = 0; qi < nQuads; qi++) {
    const inBase = qi * QUAD_FLOATS;
    RIM_EDGE_OFFSETS.forEach((edgeOffset, k) => {
      const src = inBase + edgeOffset;
      const dst = (qi * RIM_EDGE_OFFSETS.length + k) * 6;
      for (let i = 0; i < 6; i++) positions[dst + i] = edgesBuf[src + i];
      const dx = edgesBuf[src + 3] - edgesBuf[src];
      const dy = edgesBuf[src + 4] - edgesBuf[src + 1];
      const dz = edgesBuf[src + 5] - edgesBuf[src + 2];
      arcs[(qi * RIM_EDGE_OFFSETS.length + k) * 2 + 1] = Math.hypot(dx, dy, dz);
    });
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
