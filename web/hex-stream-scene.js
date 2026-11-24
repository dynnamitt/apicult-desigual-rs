import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { weldedMesh } from "./hex-terrain.js";
import {
  CHUNK_DIRS, chunkKey, footprint, stepFootprint, chunkCenter, nearestStep,
  visibleSeamGroups, advancePos, clampChunkRadius,
} from "./hex-stream.js";
import { randomU32, seedSequence } from "./seed.js";

const BG_COLOR = 0x0a0e1a;
const FILL_COLOR = 0x66cc99, SEAM_COLOR = 0xffb347;
// Per-chunk hue when `tint` is on: golden-ratio steps keep neighbours apart.
const TINT_Q = 0.381966, TINT_R = 0.618034, TINT_SAT = 0.45, TINT_LIGHT = 0.55;
const AMBIENT_INTENSITY = 0.6, SUN_INTENSITY = 1.0;
const SUN_POS = [15, 25, 10];
const CAMERA_FOV = 45;
// Camera distance in chunk spacings, so every chunk radius frames the same 1+6.
const CAMERA_BACK = 2.4, CAMERA_UP = 3.2;
// Mirrors `HGridSettings::default().max_height`; keeps small chunks from putting the camera in the hills.
const TERRAIN_MAX_HEIGHT = 20;
const STATS_INTERVAL_MS = 250;
const TOGGLE_KEYS = ["tint", "seams"];

const tintColor = ([q, r]) => {
  const hue = (((q * TINT_Q + r * TINT_R) % 1) + 1) % 1;
  return new THREE.Color().setHSL(hue, TINT_SAT, TINT_LIGHT);
};

const material = (color) => new THREE.MeshStandardMaterial({
  color, flatShading: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.05,
});

const disposeMesh = (group, mesh) => {
  group.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
};

const showError = (canvas, msg) => {
  const p = document.createElement("p");
  p.className = "error-msg";
  p.textContent = msg;
  canvas.insertAdjacentElement("afterend", p);
};

/**
 * Mount the 1+6 chunk treadmill: seven chunks around an anchor chunk, the
 * world drifting under a camera parked at the origin. Each step past a chunk
 * boundary despawns 3 chunks, spawns 3 and keeps 4; seam groups are drawn only
 * while their owning chunk isn't loaded.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl
 * @param {object} opts
 * @param {object} opts.initialSettings `STREAM_SCHEMA` snapshot.
 * @param {Function} opts.WasmChunkWorld wasm-bindgen class.
 * @returns {{regenerate: (s: object) => void, updateLive: (s: object) => void,
 *   setToggle: (k: string, on: boolean) => void}}
 */
export function mount(canvas, statsEl, { initialSettings, WasmChunkWorld }) {
  try {
    const state = { ...initialSettings };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV, canvas.clientWidth / canvas.clientHeight, 0.1, 2000,
    );
    scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
    const sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
    sun.position.set(...SUN_POS);
    scene.add(sun);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // World-space terrain lives in `group`; moving it by -pos parks the camera.
    const group = new THREE.Group();
    scene.add(group);

    let world = null;
    let loaded = new Map(); // chunkKey → { coord, owned: Mesh, seams: {owner, mesh}[] }
    let anchor = [0, 0], pos = [0, 0], u = [0, 0], v = [0, 0], steps = 0;

    const chunkColor = (coord) => (state.tint ? tintColor(coord) : new THREE.Color(FILL_COLOR));

    const buildChunk = (coord) => {
      const wc = world.chunk(coord[0], coord[1]);
      const owned = new THREE.Mesh(weldedMesh(wc.owned()), material(chunkColor(coord)));
      group.add(owned);
      const owners = wc.seam_owners();
      const seams = Array.from({ length: owners.length / 2 }, (_, i) => {
        const owner = [owners[2 * i], owners[2 * i + 1]];
        const mesh = new THREE.Mesh(weldedMesh(wc.seam(i)), material(SEAM_COLOR));
        group.add(mesh);
        return { owner, mesh };
      });
      const center = Array.from(wc.center());
      wc.free();
      loaded.set(chunkKey(...coord), { coord, center, owned, seams, owners });
    };

    const dropChunk = (coord) => {
      const key = chunkKey(...coord);
      const c = loaded.get(key);
      disposeMesh(group, c.owned);
      c.seams.forEach(({ mesh }) => disposeMesh(group, mesh));
      loaded.delete(key);
    };

    // Seam colour follows the owner it stands in for, unless `seams` highlights it.
    const refreshSeams = () => {
      const keys = new Set(loaded.keys());
      loaded.forEach((c) => {
        const shown = new Set(visibleSeamGroups(c.owners, keys));
        c.seams.forEach(({ owner, mesh }, i) => {
          mesh.visible = shown.has(i);
          mesh.material.color.copy(state.seams ? new THREE.Color(SEAM_COLOR) : chunkColor(owner));
        });
        c.owned.material.color.copy(chunkColor(c.coord));
      });
    };

    const step = (dir) => {
      const diff = stepFootprint(anchor, dir);
      diff.despawn.forEach(dropChunk);
      diff.spawn.forEach(buildChunk);
      anchor = diff.anchor;
      steps += 1;
      refreshSeams();
    };

    const frameCamera = () => {
      const spacing = Math.hypot(...u);
      camera.position.set(0, TERRAIN_MAX_HEIGHT + spacing * CAMERA_UP, spacing * CAMERA_BACK);
      controls.target.set(0, TERRAIN_MAX_HEIGHT / 2, 0);
      controls.update();
    };

    const buildWorld = () => {
      const [hSeed, rSeed] = state.seed === null
        ? [randomU32(), randomU32()]
        : seedSequence(state.seed, 2);
      world = new WasmChunkWorld(clampChunkRadius(state.chunkRadius), hSeed, rSeed);
      anchor = [0, 0];
      pos = [0, 0];
      steps = 0;
      footprint(anchor).forEach(buildChunk);
      // to_higher_res and hex_to_world_pos are linear: two centres span the lattice.
      u = loaded.get(chunkKey(1, 0)).center;
      v = loaded.get(chunkKey(0, 1)).center;
      refreshSeams();
    };

    const dropWorld = () => {
      [...loaded.values()].forEach((c) => dropChunk(c.coord));
      world?.free();
      world = null;
    };

    buildWorld();
    frameCamera();

    let lastStats = 0;
    const writeStats = (now) => {
      if (now - lastStats < STATS_INTERVAL_MS) return;
      lastStats = now;
      const all = [...loaded.values()];
      const seamTotal = all.reduce((n, c) => n + c.seams.length, 0);
      const seamShown = all.reduce((n, c) => n + c.seams.filter((s) => s.mesh.visible).length, 0);
      const tris = all.reduce((n, c) => n + c.owned.geometry.index.count / 3, 0);
      statsEl.textContent =
        `${loaded.size} chunks · anchor (${anchor[0]}, ${anchor[1]}) · ${steps} steps · ` +
        `${tris} owned tris · seams ${seamShown}/${seamTotal} groups`;
    };

    const clock = new THREE.Clock();
    const animate = (now) => {
      requestAnimationFrame(animate);
      const dt = clock.getDelta();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      if (state.speed > 0) {
        const dirVec = chunkCenter(CHUNK_DIRS[state.direction], u, v);
        pos = advancePos(pos, dirVec, state.speed, dt, chunkCenter(anchor, u, v));
        for (let d = nearestStep(pos, anchor, u, v); d !== -1; d = nearestStep(pos, anchor, u, v)) {
          step(d);
        }
      }
      group.position.set(-pos[0], 0, -pos[1]);
      controls.update();
      renderer.render(scene, camera);
      writeStats(now ?? 0);
    };
    animate();

    return {
      regenerate(settings) {
        Object.assign(state, settings);
        dropWorld();
        buildWorld();
        frameCamera();
      },
      updateLive(settings) {
        Object.assign(state, settings);
      },
      setToggle(key, on) {
        if (!TOGGLE_KEYS.includes(key)) return;
        state[key] = on;
        refreshSeams();
      },
    };
  } catch (e) {
    console.error(e);
    showError(canvas, `stream init failed: ${e.message}`);
    return { regenerate() {}, updateLive() {}, setToggle() {} };
  }
}
