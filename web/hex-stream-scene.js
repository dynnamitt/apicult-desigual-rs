import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { weldedMesh } from "./three-weld.js";
import { showError, needsResize, runFrames } from "./canvas.js";
import {
  CHUNK_DIRS, chunkKey, footprint, stepFootprint, chunkCenter, nearestStep,
  visibleSeamGroups, duplicateTris, SEAM_KEY_STRIDE, advancePos, clampChunkRadius, advanceFade, FADE_IN_S, GHOST_ALPHAS, chunkHash,
} from "./hex-stream.js";
import { randomU32, seedSequence } from "./seed.js";

const BG_COLOR = 0x0a0e1a;
const FILL_COLOR = 0x66cc99, SEAM_COLOR = 0xffb347;
// Per-chunk colour when `tint` is on: hue, saturation and lightness all come off chunkHash.
const TINT_SAT_MIN = 0.45, TINT_SAT_SPAN = 0.45, TINT_LIGHT_MIN = 0.4, TINT_LIGHT_SPAN = 0.25;
const AMBIENT_INTENSITY = 0.6, SUN_INTENSITY = 1.0;
const ROUGHNESS = 0.85, METALNESS = 0.05;
const ORBIT_DAMPING = 0.08;
const SUN_POS = [15, 25, 10];
const CAMERA_FOV = 45;
// Camera distance in chunk spacings, so every chunk radius frames the same 1+6.
const CAMERA_BACK = 2.4, CAMERA_UP = 3.2;
// Mirrors `HGridSettings::default().max_height`; keeps small chunks from putting the camera in the hills.
const TERRAIN_MAX_HEIGHT = 20;
const STATS_INTERVAL_MS = 250;
const TOGGLE_KEYS = ["tint", "seams"];

const tintColor = ([q, r]) => {
  const h = chunkHash(q, r);
  const byte = (shift) => ((h >>> shift) & 0xff) / 0xff;
  return new THREE.Color().setHSL(
    (h & 0xffff) / 0x10000,
    TINT_SAT_MIN + TINT_SAT_SPAN * byte(16),
    TINT_LIGHT_MIN + TINT_LIGHT_SPAN * byte(24),
  );
};

// Always transparent so fading needs no shader recompile.
const material = (color) => new THREE.MeshStandardMaterial({
  color, flatShading: true, side: THREE.DoubleSide, roughness: ROUGHNESS, metalness: METALNESS,
  transparent: true,
});

const disposeMesh = (group, mesh) => {
  group.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
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
    controls.dampingFactor = ORBIT_DAMPING;

    // World-space terrain lives in `group`; moving it by -pos parks the camera.
    const group = new THREE.Group();
    scene.add(group);

    let world = null;
    let loaded = new Map(); // chunkKey → { coord, owned: Mesh, seams: {mesh, tris}[], keys, fade, ghost }
    let anchor = [0, 0], pos = [0, 0], u = [0, 0], v = [0, 0], steps = 0;
    let overlaps = 0, drawnSig = ""; // recount only when the drawn seams change

    const chunkColor = (coord) => (state.tint ? tintColor(coord) : new THREE.Color(FILL_COLOR));

    const applyAlpha = (c) => [c.owned, ...c.seams.map((s) => s.mesh)].forEach(({ material: m }) => {
      m.opacity = c.fade.alpha;
    });

    const buildChunk = (coord, alpha = 1) => {
      const wc = world.chunk(coord[0], coord[1]);
      const owned = new THREE.Mesh(weldedMesh(wc.owned()), material(chunkColor(coord)));
      group.add(owned);
      const keys = wc.seam_keys();
      const seams = Array.from({ length: keys.length / SEAM_KEY_STRIDE }, (_, i) => {
        const tris = wc.seam(i);
        const mesh = new THREE.Mesh(weldedMesh(tris), material(SEAM_COLOR));
        group.add(mesh);
        return { mesh, tris };
      });
      const center = Array.from(wc.center());
      wc.free();
      const c = { coord, center, owned, seams, keys, fade: { alpha, target: 1, delay: 0 }, ghost: 0 };
      applyAlpha(c);
      loaded.set(chunkKey(...coord), c);
    };

    const dropChunk = (coord) => {
      const key = chunkKey(...coord);
      const c = loaded.get(key);
      disposeMesh(group, c.owned);
      c.seams.forEach(({ mesh }) => disposeMesh(group, mesh));
      loaded.delete(key);
    };

    // A seam wears its own chunk's colour (unless `seams` highlights it), not the
    // owner's: it must not preview the chunk that has not loaded yet (c3fc7e8).
    // Every chunk in the scene counts as loaded at any opacity (ghosts and fade-ins
    // included), as Seam::drawn requires: otherwise a neighbour's seam doubles its owned strips.
    const refreshSeams = () => {
      const keys = new Set(loaded.keys());
      loaded.forEach((c) => {
        const shown = new Set(visibleSeamGroups(c.keys, c.coord, keys));
        const color = chunkColor(c.coord);
        c.seams.forEach(({ mesh }, i) => {
          mesh.visible = shown.has(i);
          mesh.material.color.copy(state.seams ? new THREE.Color(SEAM_COLOR) : color);
        });
        c.owned.material.color.copy(color);
      });
      // Seams doubling up is #27; owned streams are disjoint by construction (owned_streams_partition_world).
      const chunks = [...loaded.values()];
      const sig = chunks.map((c) => chunkKey(...c.coord) + c.seams.map((s) => +s.mesh.visible).join("")).join(" ");
      if (sig === drawnSig) return;
      drawnSig = sig;
      overlaps = duplicateTris(chunks.flatMap((c) => c.seams.filter((s) => s.mesh.visible).map((s) => s.tris)));
    };

    const step = (dir) => {
      const diff = stepFootprint(anchor, dir);
      // Spawns fade in first; despawns stay solid until they are in, then fade to a
      // ghost. Each step after that, older ghosts fade on with them: 10% → 5% → dropped.
      const fadeOut = (c) => {
        c.ghost += 1;
        c.fade = { ...c.fade, target: GHOST_ALPHAS[c.ghost - 1] ?? 0, delay: FADE_IN_S };
      };
      loaded.forEach((c) => { if (c.ghost) fadeOut(c); });
      diff.despawn.forEach((coord) => fadeOut(loaded.get(chunkKey(...coord))));
      diff.spawn.forEach((coord) => {
        const c = loaded.get(chunkKey(...coord)); // still a ghost after a reversal
        if (c) Object.assign(c, { fade: { ...c.fade, target: 1, delay: 0 }, ghost: 0 });
        else buildChunk(coord, 0);
      });
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
      drawnSig = ""; // new geometry, same keys
      footprint(anchor).forEach((c) => buildChunk(c));
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
        `${tris} owned tris · seams ${seamShown}/${seamTotal} groups · ${overlaps} seam overlaps`;
    };

    const clock = new THREE.Clock();
    runFrames(canvas, "stream frame failed", (now) => {
      const dt = clock.getDelta();
      if (needsResize(canvas, renderer.getPixelRatio())) {
        const w = canvas.clientWidth, h = canvas.clientHeight;
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
      const fading = [...loaded.values()]
        .filter(({ fade: f }) => f.alpha !== f.target || f.delay > 0);
      fading.forEach((c) => {
        c.fade = advanceFade(c.fade, dt);
        applyAlpha(c);
        if (c.fade.target === 0 && c.fade.alpha === 0) dropChunk(c.coord);
      });
      if (fading.length) refreshSeams();
      group.position.set(-pos[0], 0, -pos[1]);
      controls.update();
      renderer.render(scene, camera);
      writeStats(now ?? 0);
    });

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
