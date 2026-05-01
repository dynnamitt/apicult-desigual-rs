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
import { seamSpecForCell } from "./hex-seam.js";
import { StreamingCluster, axialKey } from "./hex-stream.js";

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
 * Build the visible objects for a single cluster tile (mesh, wire overlay,
 * shader-wire overlay) and add them to the group. Returns the trio so the
 * caller can dispose them later.
 */
const buildClusterObjects = ({
  group, tile, slotIndex, lineWidth, canvas,
  fillVisible, wireVisible, shaderVisible, flatShading,
}) => {
  const geom = weldedMesh(tile.payload.tris);
  const medianEdge = medianTriEdgeLength(tile.payload.tris);

  const mat = new THREE.MeshStandardMaterial({
    color: FILL_COLORS[slotIndex % FILL_COLORS.length],
    flatShading,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(tile.worldPos.x, 0, tile.worldPos.z);
  mesh.visible = fillVisible;
  group.add(mesh);

  const wireGeom = new THREE.WireframeGeometry(geom);
  const segGeom = new LineSegmentsGeometry().fromWireframeGeometry(wireGeom);
  wireGeom.dispose();
  const lineMat = new LineMaterial({
    color: LINE_COLORS[slotIndex % LINE_COLORS.length],
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
  wireOverlay.position.set(tile.worldPos.x, 0, tile.worldPos.z);
  wireOverlay.visible = wireVisible;
  group.add(wireOverlay);

  const shaderGeom = wireEdgesGeometry(tile.payload.wireEdges);
  const shaderMat = createWireShader({
    color: new THREE.Color(SHADER_LINE_COLORS[slotIndex % SHADER_LINE_COLORS.length])
      .multiplyScalar(SHADER_INTENSITY),
    dashSize: medianEdge * SHADER_DASH_SIZE_FACTOR,
    gapSize: medianEdge * SHADER_DASH_GAP_FACTOR,
    speed: 0,
  });
  const shaderOverlay = new THREE.LineSegments(shaderGeom, shaderMat);
  shaderOverlay.position.set(tile.worldPos.x, 0, tile.worldPos.z);
  shaderOverlay.visible = shaderVisible;
  group.add(shaderOverlay);

  return { mesh, wireOverlay, shaderOverlay, geom };
};

const disposeClusterObjects = (group, threeObjs) => {
  const { mesh, wireOverlay, shaderOverlay, geom } = threeObjs;
  group.remove(mesh);
  group.remove(wireOverlay);
  group.remove(shaderOverlay);
  mesh.material.dispose();
  geom.dispose();
  wireOverlay.geometry.dispose();
  wireOverlay.material.dispose();
  shaderOverlay.geometry.dispose();
  shaderOverlay.material.dispose();
};

const writeStats = (statsEl, cluster) => {
  let verts = 0, tris = 0, source = 0;
  for (const tile of cluster.tiles.values()) {
    if (!tile.threeObjs) continue;
    verts += vertexCount(tile.threeObjs.geom);
    tris  += triangleCount(tile.threeObjs.geom);
    source += (tile.payload.tris.length / 9) | 0;
  }
  statsEl.textContent =
    `cluster: ${cluster.tiles.size} tiles · welded vertices: ${verts} · ` +
    `triangles: ${tris} · source tris: ${source}`;
};

/**
 * Mount the welded-hex-terrain scene onto a canvas. Returns an imperative API
 * the host page (sidebar controls) drives: regenerate to rebuild the cluster
 * with new shape settings, updateLive to mutate purely visual props (bloom,
 * dash speed, line width) without rebuilding, setToggle for display flags,
 * setDirection to change the streaming direction.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl - element receiving the per-cluster stats line.
 * @param {object} opts
 * @param {object} opts.initialSettings - all knob values + display flags.
 * @param {Function} opts.WasmLayout - wasm `WasmLayout` class export.
 * @returns {{ regenerate: (s: object) => void, updateLive: (s: object) => void, setToggle: (k: string, on: boolean) => void, setDirection: (d: number) => void }}
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

    const clusterGroup = new THREE.Group();
    scene.add(clusterGroup);

    let cluster = null;
    let slotCounter = 0;

    // Mirrors cluster.tiles for despawn cleanup: cluster.performStep removes
    // a tile from its own map before returning, so the scene needs a parallel
    // lookup to find the threeObjs trio for the despawned key.
    const threeObjsByKey = new Map();

    const attachThree = (tile) => {
      tile.threeObjs = buildClusterObjects({
        group: clusterGroup,
        tile,
        slotIndex: slotCounter++,
        lineWidth: state.lineWidth,
        canvas,
        fillVisible: state.fill,
        wireVisible: state.wire,
        shaderVisible: state.shader,
        flatShading: state.flat,
      });
      tile.threeObjs.shaderOverlay.material.uniforms.uSpeed.value = state.dashSpeed;
      threeObjsByKey.set(axialKey(tile.axial), tile.threeObjs);
    };

    const buildCluster = () => {
      cluster = new StreamingCluster({
        worldSeed: state.seed,
        radius: state.radius,
        nominalHexRadius: state.nominalHexRadius,
        petalDistanceFactor: state.petalDistanceFactor,
        dirIndex: state.dirIndex ?? 0,
        WasmLayout,
        seamFn: seamSpecForCell,
      });
      slotCounter = 0;
      const tiles = cluster.bootstrap();
      for (const tile of tiles) attachThree(tile);
      writeStats(statsEl, cluster);
    };

    const tearDownCluster = () => {
      if (!cluster) return;
      for (const objs of threeObjsByKey.values()) {
        disposeClusterObjects(clusterGroup, objs);
      }
      threeObjsByKey.clear();
      cluster.dispose();
      clusterGroup.position.set(0, 0, 0);
      cluster = null;
    };

    buildCluster();

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const frameCamera = () => {
      const combined = new THREE.Box3();
      for (const tile of cluster.tiles.values()) {
        if (tile.threeObjs) combined.expandByObject(tile.threeObjs.mesh);
      }
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

    // Unit vector in the world-frame direction the cluster group drifts.
    // Layout flow is in -D; +D is what the viewer perceives moving toward.
    const directionWorldVec = (dirIndex) => {
      const angle = dirIndex * Math.PI / 3;
      return { x: -Math.cos(angle), z: -Math.sin(angle) };
    };

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
        for (const tile of cluster.tiles.values()) {
          if (tile.threeObjs) tile.threeObjs.wireOverlay.material.resolution.set(w, h);
        }
      }

      // Group-level scroll: layouts flow past the (parked) camera.
      const speed = state.speed ?? 0;
      if (speed > 0) {
        const v = directionWorldVec(cluster.dirIndex);
        clusterGroup.position.x += v.x * speed * dt;
        clusterGroup.position.z += v.z * speed * dt;

        const diff = cluster.tick(dt, speed);
        if (diff) {
          for (const key of diff.despawned) {
            const objs = threeObjsByKey.get(key);
            if (objs) {
              disposeClusterObjects(clusterGroup, objs);
              threeObjsByKey.delete(key);
            }
          }
          for (const tile of diff.spawned) attachThree(tile);
          writeStats(statsEl, cluster);
        }
      }

      for (const tile of cluster.tiles.values()) {
        if (!tile.threeObjs) continue;
        tile.threeObjs.wireOverlay.material.dashOffset -= dt * state.dashSpeed;
        tile.threeObjs.shaderOverlay.material.uniforms.uTime.value += dt;
      }
      controls.update();
      composer.render();
    };

    animate();

    const applyDisplayState = () => {
      for (const tile of cluster.tiles.values()) {
        if (!tile.threeObjs) continue;
        tile.threeObjs.mesh.visible = state.fill;
        tile.threeObjs.wireOverlay.visible = state.wire;
        tile.threeObjs.shaderOverlay.visible = state.shader;
        if (tile.threeObjs.mesh.material.flatShading !== state.flat) {
          tile.threeObjs.mesh.material.flatShading = state.flat;
          tile.threeObjs.mesh.material.needsUpdate = true;
        }
      }
    };

    return {
      regenerate(settings) {
        Object.assign(state, settings);
        tearDownCluster();
        buildCluster();
      },

      updateLive(settings) {
        Object.assign(state, settings);
        bloomPass.strength  = state.bloomStrength;
        bloomPass.radius    = state.bloomRadius;
        bloomPass.threshold = state.bloomThreshold;
        for (const tile of cluster.tiles.values()) {
          if (!tile.threeObjs) continue;
          tile.threeObjs.wireOverlay.material.linewidth = state.lineWidth;
          tile.threeObjs.shaderOverlay.material.uniforms.uSpeed.value = state.dashSpeed;
        }
      },

      setToggle(key, on) {
        if (!TOGGLE_KEYS.includes(key)) return;
        state[key] = on;
        applyDisplayState();
      },

      setDirection(dirIndex) {
        state.dirIndex = dirIndex;
        if (cluster) cluster.setDirection(dirIndex);
      },
    };
  } catch (e) {
    console.error(e);
    showError(canvas, `terrain init failed: ${e.message}`);
    return { regenerate() {}, updateLive() {}, setToggle() {}, setDirection() {} };
  }
}
