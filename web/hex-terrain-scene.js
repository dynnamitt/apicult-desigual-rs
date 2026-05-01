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

const BG_COLOR = 0x0a0e1a;
// One color per cluster slot (center=0, petals=1..6). Subtle hue rotation
// across petals keeps the 7 pieces individually legible while still reading
// as one mesh. LINE_COLORS are the HSL complements of FILL_COLORS so each
// wireframe sits opposite its fill on the color wheel — saturation and
// lightness are boosted so the small per-petal hue spread (which the eye
// barely registers in the magenta range at the fill's mid-saturation) reads
// as distinct, vivid line colors instead of a single uniform purple.
const COMPLEMENT_SATURATION = 0.95;
const COMPLEMENT_LIGHTNESS  = 0.70;
const complementHex = (hex) => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + 0.5) % 1, COMPLEMENT_SATURATION, COMPLEMENT_LIGHTNESS);
  return c.getHex();
};
const FILL_COLORS = [
  0x66cc99, 0x6cd0a4, 0x72d4af, 0x78d8ba, 0x7ed4c0, 0x84c9c2, 0x8abec4,
];
const LINE_COLORS = FILL_COLORS.map(complementHex);
const SHADER_LINE_COLORS = [
  0x99ffd0, 0x33fff0, 0x66ffe0, 0x99ffd0, 0xccffc0, 0xeeffac, 0xffff80,
];
const LINE_OPACITY = 0.95;
const DASH_SIZE_FACTOR = 0.08, DASH_GAP_FACTOR = 0.15;
// Shader-wire dots are punchier than the Line2 dashes: longer, more spaced,
// HDR-bright so UnrealBloom blooms them harder.
const SHADER_DASH_SIZE_FACTOR = 0.22, SHADER_DASH_GAP_FACTOR = 0.28;
const SHADER_INTENSITY = 2.8;
const CAMERA_FOV = 45;

const TOGGLE_KEYS = ["fill", "wire", "shader", "flat"];

const randomU32 = () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

// SplitMix32 — cheap reversible mixer used to derive 14 stable per-mesh seeds
// (center + 6 petals × {h_seed, r_seed}) from one user-typed seed, so the same
// input always reproduces the same cluster.
const splitmix32 = (s) => {
  s = (s + 0x9E3779B9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35) >>> 0;
  return (s ^ (s >>> 16)) >>> 0;
};

const seedSequence = (root, n) => {
  const out = new Array(n);
  let s = root >>> 0;
  for (let i = 0; i < n; i++) {
    s = splitmix32(s);
    out[i] = s;
  }
  return out;
};

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
  const p = document.createElement("p");
  p.className = "error-msg";
  p.textContent = msg;
  canvas.insertAdjacentElement("afterend", p);
};

/**
 * Build a 7-mesh "flower" cluster: 1 center + 6 petals around it. Each petal
 * shares its inward-facing ring of cells with the center via WFC-style
 * overrides + entangle markers, so the center owns those seams visually.
 *
 * @param {object} opts
 * @param {number} opts.radius
 * @param {number} opts.nominalHexRadius
 * @param {number} opts.petalDistanceFactor
 * @param {number|null} opts.seed - null = fresh random per mesh; integer = reproducible.
 * @param {Function} opts.WasmLayout
 */
const generateClusterPayloads = ({
  radius, nominalHexRadius, petalDistanceFactor, seed, WasmLayout,
}) => {
  // 14 seeds: 7 layouts × {h_seed, r_seed}, deterministic when seed is set.
  const seeds = seed === null
    ? Array.from({ length: 14 }, randomU32)
    : seedSequence(seed, 14);
  const seedAt = (i) => [seeds[i * 2], seeds[i * 2 + 1]];

  const [hSeed0, rSeed0] = seedAt(0);
  const center = new WasmLayout(radius, hSeed0, rSeed0, [], []);
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
      radius, nominalHexRadius, petalDistanceFactor, WasmLayout,
    });
    const [hSeedI, rSeedI] = seedAt(dir + 1);
    const petal = new WasmLayout(
      radius, hSeedI, rSeedI, overrides, entangle,
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
 * Build the visible objects for a single cluster payload (mesh, wire overlay,
 * shader-wire overlay) and add them to the scene. Returns the trio so the
 * caller can dispose them later.
 */
const buildClusterObjects = ({ scene, payload, lineWidth, canvas, fillVisible, wireVisible, shaderVisible, flatShading }) => {
  const geom = weldedMesh(payload.tris);
  const medianEdge = medianTriEdgeLength(payload.tris);

  const mat = new THREE.MeshStandardMaterial({
    color: FILL_COLORS[payload.index],
    flatShading,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(payload.tx, 0, payload.tz);
  mesh.visible = fillVisible;
  scene.add(mesh);

  const wireGeom = new THREE.WireframeGeometry(geom);
  const segGeom = new LineSegmentsGeometry().fromWireframeGeometry(wireGeom);
  wireGeom.dispose();
  const lineMat = new LineMaterial({
    color: LINE_COLORS[payload.index],
    linewidth: lineWidth,
    dashed: true,
    dashSize: medianEdge * DASH_SIZE_FACTOR,
    gapSize: medianEdge * DASH_GAP_FACTOR,
    transparent: true,
    opacity: LINE_OPACITY,
  });
  lineMat.resolution.set(canvas.clientWidth, canvas.clientHeight);
  const wireOverlay = new LineSegments2(segGeom, lineMat);
  wireOverlay.computeLineDistances();
  wireOverlay.position.set(payload.tx, 0, payload.tz);
  wireOverlay.visible = wireVisible;
  scene.add(wireOverlay);

  const shaderGeom = wireEdgesGeometry(payload.wireEdges);
  const shaderMat = createWireShader({
    color: new THREE.Color(SHADER_LINE_COLORS[payload.index]).multiplyScalar(SHADER_INTENSITY),
    dashSize: medianEdge * SHADER_DASH_SIZE_FACTOR,
    gapSize: medianEdge * SHADER_DASH_GAP_FACTOR,
    speed: 0,
  });
  const shaderOverlay = new THREE.LineSegments(shaderGeom, shaderMat);
  shaderOverlay.position.set(payload.tx, 0, payload.tz);
  shaderOverlay.visible = shaderVisible;
  scene.add(shaderOverlay);

  return { mesh, wireOverlay, shaderOverlay, geom };
};

const disposeClusterObjects = (scene, objs) => {
  for (const { mesh, wireOverlay, shaderOverlay, geom } of objs) {
    scene.remove(mesh);
    scene.remove(wireOverlay);
    scene.remove(shaderOverlay);
    mesh.material.dispose();
    geom.dispose();
    wireOverlay.geometry.dispose();
    wireOverlay.material.dispose();
    shaderOverlay.geometry.dispose();
    shaderOverlay.material.dispose();
  }
};

const writeStats = (statsEl, payloads, objs) => {
  const acc = objs.reduce(
    (s, o, i) => ({
      verts: s.verts + vertexCount(o.geom),
      tris:  s.tris  + triangleCount(o.geom),
      source: s.source + ((payloads[i].tris.length / 9) | 0),
    }),
    { verts: 0, tris: 0, source: 0 },
  );
  statsEl.textContent =
    `cluster: 1+6 · welded vertices: ${acc.verts} · ` +
    `triangles: ${acc.tris} · source tris: ${acc.source}`;
};

/**
 * Mount the welded-hex-terrain scene onto a canvas. Returns an imperative API
 * the host page (sidebar controls) drives: regenerate to rebuild the cluster
 * with new shape settings, updateLive to mutate purely visual props (bloom,
 * dash speed, line width) without rebuilding, setToggle for display flags.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl - element receiving the per-cluster stats line.
 * @param {object} opts
 * @param {object} opts.initialSettings - all knob values + display flags.
 * @param {Function} opts.WasmLayout - wasm `WasmLayout` class export.
 * @returns {{ regenerate: (s: object) => void, updateLive: (s: object) => void, setToggle: (k: string, on: boolean) => void }}
 */
export function mount(canvas, statsEl, { initialSettings, WasmLayout }) {
  try {
    const state = { ...initialSettings };

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

    let payloads = [];
    let objs = [];

    const buildCluster = () => {
      payloads = generateClusterPayloads({
        radius: state.radius,
        nominalHexRadius: state.nominalHexRadius,
        petalDistanceFactor: state.petalDistanceFactor,
        seed: state.seed,
        WasmLayout,
      });
      objs = payloads.map((p) => buildClusterObjects({
        scene, payload: p,
        lineWidth: state.lineWidth,
        canvas,
        fillVisible: state.fill,
        wireVisible: state.wire,
        shaderVisible: state.shader,
        flatShading: state.flat,
      }));
      // Initial uniform / dash state (the live updater handles subsequent changes).
      for (const o of objs) {
        o.shaderOverlay.material.uniforms.uSpeed.value = state.dashSpeed;
      }
      writeStats(statsEl, payloads, objs);
    };

    buildCluster();

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const frameCamera = () => {
      const combined = new THREE.Box3();
      for (const { mesh } of objs) combined.expandByObject(mesh);
      const target = combined.getCenter(new THREE.Vector3());
      const span = combined.getSize(new THREE.Vector3()).length();
      camera.position.set(
        target.x + span * 0.7,
        target.y + span * 0.5,
        target.z + span * 0.7,
      );
      controls.target.copy(target);
      controls.update();
    };
    frameCamera();

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
      state.bloomStrength,
      state.bloomRadius,
      state.bloomThreshold,
    );
    composer.addPass(bloomPass);
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
        for (const o of objs) o.wireOverlay.material.resolution.set(w, h);
      }
      for (const o of objs) {
        o.wireOverlay.material.dashOffset -= dt * state.dashSpeed;
        o.shaderOverlay.material.uniforms.uTime.value += dt;
      }
      controls.update();
      composer.render();
    };
    animate();

    const applyDisplayState = () => {
      for (const o of objs) {
        o.mesh.visible = state.fill;
        o.wireOverlay.visible = state.wire;
        o.shaderOverlay.visible = state.shader;
        if (o.mesh.material.flatShading !== state.flat) {
          o.mesh.material.flatShading = state.flat;
          o.mesh.material.needsUpdate = true;
        }
      }
    };

    return {
      regenerate(settings) {
        Object.assign(state, settings);
        disposeClusterObjects(scene, objs);
        buildCluster();
        frameCamera();
      },

      updateLive(settings) {
        Object.assign(state, settings);
        bloomPass.strength  = state.bloomStrength;
        bloomPass.radius    = state.bloomRadius;
        bloomPass.threshold = state.bloomThreshold;
        for (const o of objs) {
          o.wireOverlay.material.linewidth = state.lineWidth;
          o.shaderOverlay.material.uniforms.uSpeed.value = state.dashSpeed;
        }
      },

      setToggle(key, on) {
        if (!TOGGLE_KEYS.includes(key)) return;
        state[key] = on;
        applyDisplayState();
      },
    };
  } catch (e) {
    console.error(e);
    showError(canvas, `terrain init failed: ${e.message}`);
    return { regenerate() {}, updateLive() {}, setToggle() {} };
  }
}
