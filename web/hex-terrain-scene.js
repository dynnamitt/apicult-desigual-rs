import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { weldedMesh, vertexCount, triangleCount } from "./hex-terrain.js";
import { wireEdgesGeometry, createWireShader } from "./hex-terrain-shader.js";
import { seamSpec, VERTEX_DIR_NAMES } from "./hex-seam.js";

const POINT_SPACING = 4.0; // matches HGridSettings::default().point_spacing
const BG_COLOR = 0x0a0e1a;
// One color per cluster slot (center=0, petals=1..6). Subtle hue rotation
// keeps the 7 pieces individually legible while still reading as one mesh.
const FILL_COLORS = [
  0x66cc99, 0x6cd0a4, 0x72d4af, 0x78d8ba, 0x7ed4c0, 0x84c9c2, 0x8abec4,
];
const LINE_COLORS = [
  0xffee44, 0xfde35a, 0xfbd870, 0xf9cd86, 0xf7c29c, 0xf5b7b2, 0xf3acc8,
];
const SHADER_LINE_COLORS = [
  0x00ffff, 0x33fff0, 0x66ffe0, 0x99ffd0, 0xccffc0, 0xeeffac, 0xffff80,
];
const LINE_WIDTH = 2,
  LINE_OPACITY = 0.95;
const DASH_SIZE_FACTOR = 0.08,
  DASH_GAP_FACTOR = 0.15,
  DASH_SPEED = 0.6;
// Shader-wire dots are punchier than the Line2 dashes: longer, more spaced,
// HDR-bright so UnrealBloom blooms them harder.
const SHADER_DASH_SIZE_FACTOR = 0.22,
  SHADER_DASH_GAP_FACTOR = 0.28,
  SHADER_INTENSITY = 2.8;
const BLOOM_STRENGTH = 1.1,
  BLOOM_RADIUS = 0.5,
  BLOOM_THRESHOLD = 0.75;
const CAMERA_FOV = 45;

const TOGGLE_KEYS = ["fill", "wire", "shader", "flat"];
// wire and shader are mutually exclusive — turning one on flips the other off.
const WIRE_EXCLUSIVE_PAIR = { wire: "shader", shader: "wire" };

const randomU32 = () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

const medianTriEdgeLength = (trisBuf) => {
  const n = (trisBuf.length / 9) | 0;
  const lens = new Array(n * 3);
  for (let i = 0, k = 0; i < trisBuf.length; i += 9, k += 3) {
    const ax = trisBuf[i],     ay = trisBuf[i + 1], az = trisBuf[i + 2];
    const bx = trisBuf[i + 3], by = trisBuf[i + 4], bz = trisBuf[i + 5];
    const cx = trisBuf[i + 6], cy = trisBuf[i + 7], cz = trisBuf[i + 8];
    lens[k]     = Math.hypot(bx - ax, by - ay, bz - az);
    lens[k + 1] = Math.hypot(cx - bx, cy - by, cz - bz);
    lens[k + 2] = Math.hypot(ax - cx, ay - cy, az - cz);
  }
  lens.sort((x, y) => x - y);
  return lens[lens.length >> 1];
};

const showError = (canvas, msg) => {
  canvas.insertAdjacentHTML(
    "afterend",
    `<p style="color:#f77;text-align:center;padding:0.6rem">${msg}</p>`,
  );
};

/**
 * Build a 7-mesh "flower" cluster: 1 center + 6 petals around it. Each petal
 * shares its inward-facing ring of cells with the center via WFC-style
 * overrides + entangle markers, so the center owns those seams visually.
 * Petals 1..4 also seam to the previous-placed petal in the ring; petal 5
 * (closing the ring) seams to both petal 4 and petal 0. The result is a
 * single continuous-looking landscape across all 7 layouts with no
 * z-fighting or doubled triangles.
 *
 * @param {object} opts
 * @param {number} opts.radius
 * @param {Function} opts.WasmLayout
 * @returns {Array<{index, label, tris, wireEdges, tx, tz}>}
 */
const generateClusterPayloads = ({ radius, WasmLayout }) => {
  const center = new WasmLayout(radius, randomU32(), randomU32(), [], []);
  const payloads = [{
    index: 0, label: "center",
    tris: center.tris(false),
    wireEdges: center.wire_edges(false),
    tx: 0, tz: 0,
  }];
  // Keep all WasmLayouts alive while building so later petals can query
  // borderline_cells on previously-placed neighbors. Free at the end.
  const ringSoFar = new Array(6);
  for (let dir = 0; dir < 6; dir++) {
    const { overrides, entangle, tx, tz } = seamSpec({
      centerLayout: center, ringSoFar, dir,
      radius, pointSpacing: POINT_SPACING, WasmLayout,
    });
    const petal = new WasmLayout(
      radius, randomU32(), randomU32(), overrides, entangle,
    );
    payloads.push({
      index: dir + 1, label: VERTEX_DIR_NAMES[dir],
      tris: petal.tris(false),
      wireEdges: petal.wire_edges(false),
      tx, tz,
    });
    ringSoFar[dir] = petal;
  }
  center.free();
  for (const p of ringSoFar) p.free();
  return payloads;
};

/**
 * Mount the welded-hex-terrain scene onto a canvas. Generates `MESH_COUNT`
 * meshes via the supplied wasm `WasmLayout` class, lays them out
 * side-by-side, and runs an animation loop with dashed glowing wireframes
 * via post-process bloom.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl - element receiving the per-mesh stats line.
 * @param {object} opts
 * @param {number} opts.radius
 * @param {Function} opts.WasmLayout - wasm `WasmLayout` class export.
 */
export function mount(canvas, statsEl, { radius, WasmLayout }) {
  try {
    const payloads = generateClusterPayloads({ radius, WasmLayout });

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      500,
    );

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(15, 25, 10);
    scene.add(sun);

    const state = { fill: true, wire: true, shader: false, flat: true };
    const meshes = [];
    const wireOverlays = [];
    const shaderWireOverlays = [];

    for (const p of payloads) {
      const geom = weldedMesh(p.tris);
      const medianEdge = medianTriEdgeLength(p.tris);
      p.geom = geom;

      const mat = new THREE.MeshStandardMaterial({
        color: FILL_COLORS[p.index],
        flatShading: state.flat,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0.05,
      });
      const m = new THREE.Mesh(geom, mat);
      m.position.set(p.tx, 0, p.tz);
      scene.add(m);
      meshes.push(m);

      const wireGeom = new THREE.WireframeGeometry(geom);
      const segGeom = new LineSegmentsGeometry().fromWireframeGeometry(
        wireGeom,
      );
      wireGeom.dispose();
      const lineMat = new LineMaterial({
        color: LINE_COLORS[p.index],
        linewidth: LINE_WIDTH,
        dashed: true,
        dashSize: medianEdge * DASH_SIZE_FACTOR,
        gapSize: medianEdge * DASH_GAP_FACTOR,
        transparent: true,
        opacity: LINE_OPACITY,
      });
      lineMat.resolution.set(canvas.clientWidth, canvas.clientHeight);
      const w = new LineSegments2(segGeom, lineMat);
      w.computeLineDistances();
      w.position.set(p.tx, 0, p.tz);
      scene.add(w);
      wireOverlays.push(w);

      const sg = wireEdgesGeometry(p.wireEdges);
      const sm = createWireShader({
        color: new THREE.Color(SHADER_LINE_COLORS[p.index]).multiplyScalar(
          SHADER_INTENSITY,
        ),
        dashSize: medianEdge * SHADER_DASH_SIZE_FACTOR,
        gapSize: medianEdge * SHADER_DASH_GAP_FACTOR,
        speed: DASH_SPEED,
      });
      const sw = new THREE.LineSegments(sg, sm);
      sw.position.set(p.tx, 0, p.tz);
      sw.visible = state.shader;
      scene.add(sw);
      shaderWireOverlays.push(sw);
    }

    const stats = payloads.reduce(
      (s, p) => ({
        verts: s.verts + vertexCount(p.geom),
        tris: s.tris + triangleCount(p.geom),
        source: s.source + ((p.tris.length / 9) | 0),
      }),
      { verts: 0, tris: 0, source: 0 },
    );
    statsEl.textContent =
      `cluster: 1+6 · welded vertices: ${stats.verts} · ` +
      `triangles: ${stats.tris} · source tris: ${stats.source}`;

    const effects = {
      fill: () => {
        for (const m of meshes) m.visible = state.fill;
      },
      wire: () => {
        for (const w of wireOverlays) w.visible = state.wire;
      },
      shader: () => {
        for (const s of shaderWireOverlays) s.visible = state.shader;
      },
      flat: () => {
        for (const m of meshes) {
          m.material.flatShading = state.flat;
          m.material.needsUpdate = true;
        }
      },
    };
    const buttons = Object.fromEntries(
      TOGGLE_KEYS.map((k) => [k, document.getElementById(`btn-${k}`)]),
    );
    for (const k of TOGGLE_KEYS) {
      buttons[k].addEventListener("click", () => {
        state[k] = !state[k];
        buttons[k].classList.toggle("on", state[k]);
        effects[k]();
        const peer = WIRE_EXCLUSIVE_PAIR[k];
        if (peer && state[k] && state[peer]) {
          state[peer] = false;
          buttons[peer].classList.remove("on");
          effects[peer]();
        }
      });
    }

    const combined = new THREE.Box3();
    for (const m of meshes) combined.expandByObject(m);
    const target = combined.getCenter(new THREE.Vector3());
    const span = combined.getSize(new THREE.Vector3()).length();
    camera.position.set(
      target.x + span * 0.7,
      target.y + span * 0.5,
      target.z + span * 0.7,
    );

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      ),
    );
    composer.addPass(new OutputPass());

    const clock = new THREE.Clock();

    const animate = () => {
      requestAnimationFrame(animate);
      const dt = clock.getDelta();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        renderer.setSize(w, h, false);
        composer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        for (const o of wireOverlays) o.material.resolution.set(w, h);
      }
      for (const o of wireOverlays) o.material.dashOffset -= dt * DASH_SPEED;
      for (const s of shaderWireOverlays) s.material.uniforms.uTime.value += dt;
      controls.update();
      composer.render();
    };
    animate();
  } catch (e) {
    console.error(e);
    showError(canvas, `terrain init failed: ${e.message}`);
  }
}
