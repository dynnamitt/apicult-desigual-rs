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

const MAX_PAYLOADS = 16;
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

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const medianEdgeLength = (tris) => {
  const lens = [];
  for (const [a, b, c] of tris) lens.push(dist(a, b), dist(b, c), dist(c, a));
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
 * Speculatively fetch all candidate slots in parallel, then walk in order
 * and stop at the first 404. Cuts cold-load latency from N*RTT to ~1 RTT;
 * wasted 404s for empty slots are negligible on a static host.
 *
 * @param {number} [max=MAX_PAYLOADS]
 * @returns {Promise<Array<{index: number, tris: Array<[Vec3, Vec3, Vec3]>}>>}
 */
const loadPayloads = async (max = MAX_PAYLOADS) => {
  const names = Array.from(
    { length: max },
    (_, i) => `apicult-${String(i + 1).padStart(2, "0")}.json`,
  );
  const responses = await Promise.all(names.map((n) => fetch(n)));
  const payloads = [];
  for (let i = 0; i < responses.length; i++) {
    if (!responses[i].ok) break;
    const payload = await responses[i].json();
    if (payload.version !== 2 || !Array.isArray(payload.tris)) {
      throw new Error(
        `${names[i]} is not a v2 payload — rebuild via \`make preview\``,
      );
    }
    payloads.push({ index: i + 1, tris: payload.tris });
  }
  if (payloads.length === 0) {
    throw new Error(
      "no apicult-NN.json files found (start with apicult-01.json)",
    );
  }
  return payloads;
};

/**
 * Mount the welded-hex-terrain scene onto a canvas. Loads `apicult-NN.json`
 * v2 payloads, builds welded meshes laid out side-by-side, and runs an
 * animation loop with dashed glowing wireframes via post-process bloom.
 * Errors are caught and rendered as a message after the canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl - element receiving the per-mesh stats line.
 * @returns {Promise<void>}
 */
export async function mount(canvas, statsEl) {
  try {
    const payloads = await loadPayloads();

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

    const state = { fill: true, wire: true, flat: true };
    const meshes = [];
    const wireOverlays = [];

    for (const p of payloads) {
      p.geom = weldedMesh([], p.tris);
      p.medianEdge = medianEdgeLength(p.tris);
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
    }

    const totalVerts = payloads.reduce((s, p) => s + vertexCount(p.geom), 0);
    const totalTris = payloads.reduce((s, p) => s + triangleCount(p.geom), 0);
    const sourceTris = payloads.reduce((s, p) => s + p.tris.length, 0);
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
      flat: () => {
        for (const m of meshes) {
          m.material.flatShading = state.flat;
          m.material.needsUpdate = true;
        }
      },
    };
    for (const k of ["fill", "wire", "flat"]) {
      const btn = document.getElementById(`btn-${k}`);
      btn.addEventListener("click", () => {
        state[k] = !state[k];
        btn.classList.toggle("on", state[k]);
        effects[k]();
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
      controls.update();
      composer.render();
    };
    animate();
  } catch (e) {
    console.error(e);
    showError(canvas, `terrain load failed: ${e.message}`);
  }
}
