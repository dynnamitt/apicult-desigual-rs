import * as THREE from 'three';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Builds a non-indexed `THREE.BufferGeometry` of line segments — one segment
 * per quad boundary edge (a→b, b→c, c→d, d→a). Used with `THREE.LineSegments`
 * (gl.LINES draw mode) for shader-driven wireframes that should ignore the
 * in-quad triangulation diagonal.
 *
 * Each vertex carries an `aArc` Float32 attribute encoding its position along
 * the segment (0 at start, world-space length at end). The fragment shader
 * uses this as the "distance along the line" for dash-pattern animation.
 *
 * @param {Array<[Vec3, Vec3, Vec3, Vec3]>} quads - CCW quads, each four
 *   `[x, y, z]` corners (as emitted by Rust `gap_quads()` / JSON v3 `quads`).
 * @returns {THREE.BufferGeometry} non-indexed geometry with `position` (vec3)
 *   and `aArc` (float) attributes plus a computed bounding box.
 *
 * @typedef {[number, number, number]} Vec3
 */
export const quadEdgesGeometry = (quads) => {
  const positions = new Float32Array(quads.length * 24);
  const arcs = new Float32Array(quads.length * 8);
  for (let qi = 0; qi < quads.length; qi++) {
    const q = quads[qi];
    for (let ei = 0; ei < 4; ei++) {
      const p = q[ei];
      const r = q[(ei + 1) & 3];
      const off = qi * 24 + ei * 6;
      positions.set(p, off);
      positions.set(r, off + 3);
      arcs[qi * 8 + ei * 2] = 0;
      arcs[qi * 8 + ei * 2 + 1] = dist(p, r);
    }
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
