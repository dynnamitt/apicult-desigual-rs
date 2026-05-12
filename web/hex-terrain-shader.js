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

const FACE_TRIS_PER_HEX = 6;
export const FLOATS_PER_TRI = 9;
export const FLOATS_PER_HEX = FACE_TRIS_PER_HEX * FLOATS_PER_TRI;

/**
 * Builds a non-indexed `THREE.BufferGeometry` for the band shader from a flat
 * hex-face-fan buffer (as emitted by `WasmLayout.face_tris(entangled)`),
 * keeping only the hexes selected by `selectedHexIdx`. Each hex contributes
 * 54 floats (6 tris × 3 verts × 3 floats); selection is whole-hex.
 *
 * Each vertex carries an `aWeight` float — `1.0` at the fan's center vertex
 * (the first vert of every triangle in the rust-side `hex_face_tris` emission
 * order) and `0.0` at the two perimeter corners. The band shader treats this
 * as the triangle's "UV-Y": min at the perimeter edge, max at the centroid.
 * Because all six fan tris share the same center vertex with weight `1.0`,
 * the bands resolve as concentric rings inside the hex.
 *
 * @param {Float32Array} faceTrisBuf - flat `n_hexes * 54` floats.
 * @param {number[]} selectedHexIdx - hex indices to emit.
 * @returns {THREE.BufferGeometry} non-indexed geometry with `position` (vec3)
 *   and `aWeight` (float) attributes plus a computed bounding box.
 */
export const bandGeometry = (faceTrisBuf, selectedHexIdx) => {
  const nVerts = selectedHexIdx.length * FACE_TRIS_PER_HEX * 3;
  const positions = new Float32Array(nVerts * 3);
  const weights = new Float32Array(nVerts);
  let p = 0, w = 0;
  for (const idx of selectedHexIdx) {
    const hexOff = idx * FLOATS_PER_HEX;
    for (let t = 0; t < FACE_TRIS_PER_HEX; t++) {
      const triOff = hexOff + t * FLOATS_PER_TRI;
      for (let v = 0; v < 3; v++) {
        positions[p]     = faceTrisBuf[triOff + v * 3];
        positions[p + 1] = faceTrisBuf[triOff + v * 3 + 1];
        positions[p + 2] = faceTrisBuf[triOff + v * 3 + 2];
        weights[w++] = v === 0 ? 1.0 : 0.0;
        p += 3;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aWeight', new THREE.BufferAttribute(weights, 1));
  g.computeBoundingBox();
  return g;
};

/**
 * Returns a `ShaderMaterial` that paints each fan triangle with `bands`
 * discrete steps along the per-vertex `aWeight` attribute (set up by
 * {@link bandGeometry}) — `0.0` at the perimeter edge, `1.0` at the fan's
 * center vertex. Smooth varying interpolation across the triangle is then
 * quantized into N flat bands, giving concentric ring-bands inside each
 * hex with `baseColor` at the rim fading toward `bgColor` at the centroid.
 * No animation. `polygonOffset` keeps the overlay z-clean over the fill.
 *
 * @param {object} opts
 * @param {THREE.ColorRepresentation} opts.baseColor - rim color (weight 0).
 * @param {THREE.ColorRepresentation} opts.bgColor   - center color (weight 1).
 * @param {number} [opts.bands=5] - number of discrete color steps.
 * @returns {THREE.ShaderMaterial}
 */
export const createBandShader = ({ baseColor, bgColor, bands = 5 }) =>
  new THREE.ShaderMaterial({
    uniforms: {
      uBase:  { value: new THREE.Color(baseColor) },
      uBg:    { value: new THREE.Color(bgColor) },
      uBands: { value: bands },
    },
    vertexShader: `
      attribute float aWeight;
      varying float vWeight;
      void main() {
        vWeight = aWeight;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uBands;
      uniform vec3  uBase, uBg;
      varying float vWeight;
      void main() {
        float n = clamp(floor(vWeight * uBands), 0.0, uBands - 1.0);
        gl_FragColor = vec4(mix(uBase, uBg, n / (uBands - 1.0)), 1.0);
      }
    `,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
