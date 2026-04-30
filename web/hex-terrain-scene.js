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

const MESH_COUNT = 3;
const BG_COLOR = 0x0a0e1a,
  FILL_COLOR = 0x6c9,
  LINE_COLOR = 0xffee44;
const LINE_WIDTH = 2,
  LINE_OPACITY = 0.95;
const DASH_SIZE_FACTOR = 0.08,
  DASH_GAP_FACTOR = 0.15,
  DASH_SPEED = 0.6;
const BLOOM_STRENGTH = 1.1,
  BLOOM_RADIUS = 0.5,
  BLOOM_THRESHOLD = 0.75;
const CAMERA_FOV = 45;

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
 * Build `count` mesh payloads in-browser via the wasm `WasmLayout`. Each
 * call picks fresh random u32 seeds for height + radius noise.
 *
 * @param {object} opts
 * @param {number} opts.radius - hex grid radius (number of rings).
 * @param {Function} opts.WasmLayout - the `WasmLayout` class export.
 * @param {number} [opts.count=MESH_COUNT]
 * @returns {Array<{index: number, tris: Float32Array, wireEdges: Float32Array}>}
 */
const generatePayloads = ({ radius, WasmLayout, count = MESH_COUNT }) => {
  const payloads = [];
  for (let i = 0; i < count; i++) {
    const layout = new WasmLayout(radius, randomU32(), randomU32(), []);
    payloads.push({
      index: i + 1,
      tris: layout.tris(),
      wireEdges: layout.wire_edges(),
    });
    layout.free();
  }
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
    const payloads = generatePayloads({ radius, WasmLayout });

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
      p.geom = weldedMesh(p.tris);
      p.medianEdge = medianTriEdgeLength(p.tris);
    }

    const gap =
      payloads.reduce((s, p) => s + p.medianEdge, 0) / payloads.length;
    let cursor = 0;
    for (const p of payloads) {
      const bb = p.geom.boundingBox;
      p.offsetX = cursor - bb.min.x;
      cursor += bb.max.x - bb.min.x + gap;
    }
    const recenter = -(cursor - gap) / 2;
    for (const p of payloads) p.offsetX += recenter;

    for (const p of payloads) {
      const mat = new THREE.MeshStandardMaterial({
        color: FILL_COLOR,
        flatShading: state.flat,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0.05,
      });
      const m = new THREE.Mesh(p.geom, mat);
      m.position.x = p.offsetX;
      scene.add(m);
      meshes.push(m);

      const wireGeom = new THREE.WireframeGeometry(p.geom);
      const segGeom = new LineSegmentsGeometry().fromWireframeGeometry(
        wireGeom,
      );
      wireGeom.dispose();
      const lineMat = new LineMaterial({
        color: LINE_COLOR,
        linewidth: LINE_WIDTH,
        dashed: true,
        dashSize: p.medianEdge * DASH_SIZE_FACTOR,
        gapSize: p.medianEdge * DASH_GAP_FACTOR,
        transparent: true,
        opacity: LINE_OPACITY,
      });
      lineMat.resolution.set(canvas.clientWidth, canvas.clientHeight);
      const w = new LineSegments2(segGeom, lineMat);
      w.computeLineDistances();
      w.position.x = p.offsetX;
      scene.add(w);
      wireOverlays.push(w);

      const sg = wireEdgesGeometry(p.wireEdges);
      const sm = createWireShader({
        color: LINE_COLOR,
        dashSize: p.medianEdge * DASH_SIZE_FACTOR,
        gapSize: p.medianEdge * DASH_GAP_FACTOR,
        speed: DASH_SPEED,
      });
      const sw = new THREE.LineSegments(sg, sm);
      sw.position.x = p.offsetX;
      sw.visible = state.shader;
      scene.add(sw);
      shaderWireOverlays.push(sw);
    }

    const totalVerts = payloads.reduce((s, p) => s + vertexCount(p.geom), 0);
    const totalTris = payloads.reduce((s, p) => s + triangleCount(p.geom), 0);
    const sourceTris = payloads.reduce((s, p) => s + ((p.tris.length / 9) | 0), 0);
    statsEl.textContent =
      `meshes: ${payloads.length} · welded vertices: ${totalVerts} · ` +
      `triangles: ${totalTris} · source tris: ${sourceTris}`;

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
    // wire and shader are mutually exclusive — turning one on flips the other off.
    const wireExclusivePair = { wire: "shader", shader: "wire" };
    const buttons = Object.fromEntries(
      ["fill", "wire", "shader", "flat"].map((k) => [
        k,
        document.getElementById(`btn-${k}`),
      ]),
    );
    for (const k of ["fill", "wire", "shader", "flat"]) {
      buttons[k].addEventListener("click", () => {
        state[k] = !state[k];
        buttons[k].classList.toggle("on", state[k]);
        effects[k]();
        const peer = wireExclusivePair[k];
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
