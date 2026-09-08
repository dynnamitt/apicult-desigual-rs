/**
 * Babylon.js scene for `hex-units.html` — a small game-engine demo driven by
 * the same wasm geometry as the three.js terrain page.
 *
 * What the engine is actually doing here (as opposed to the terrain page,
 * which is a renderer showcase):
 *
 * - **Scene graph** — every unit is a `TransformNode` with a body and a nose
 *   mesh parented to it, so heading and position are set once on the parent.
 * - **Update loop** — `onBeforeRenderObservable` advances each unit along its
 *   path by `deltaTime`, frame-rate independent.
 * - **Picking** — clicking the terrain casts a ray, maps the hit point to the
 *   nearest hex cell and rallies every unit there.
 *
 * The pathfinding itself lives in `hex-units-grid.js`, which is engine-free and
 * unit-tested under node.
 *
 * Babylon arrives as a UMD global (`window.BABYLON`) rather than an ES module:
 * `@babylonjs/core` ships hundreds of ESM files and expects a bundler, which
 * this build deliberately does not have. The terrain page's three.js importmap
 * has no equivalent here.
 */
import { weldTris } from "./weld.js";
import { randomU32, seedSequence } from "./seed.js";
import { buildCellGraph, findPath, reachableFrom } from "./hex-units-grid.js";

const BG_COLOR = "#0a0e1a";
const TERRAIN_COLOR = "#66cc99";
// Warm hues so units read against the cold green terrain; the glow layer
// picks them up from their emissive channel.
const UNIT_COLORS = [
  "#ffcc66", "#ff8a9b", "#8fd4ff", "#ffee88",
  "#ff9ae0", "#c8ff88", "#ffab7a", "#99ffd0",
];
const MAX_UNITS = 24;

// Unit body size and hover, as fractions of the lattice spacing, so the demo
// stays proportional at any `nominal hex radius`.
const UNIT_WIDTH = 0.34;
const UNIT_HEIGHT = 0.55;
const UNIT_HOVER = 0.12;
/** Peak of the arc a unit traces while stepping across a gap. */
const HOP_HEIGHT = 0.16;
/** Trail / goal-marker lift above the hex face, to avoid z-fighting. */
const TRAIL_LIFT = 0.06;
/** Base movement rate in lattice steps per second, scaled by the speed knob. */
const STEPS_PER_SECOND = 0.9;

const STATS_INTERVAL_MS = 250;

const clampUnits = (n) => Math.max(1, Math.min(MAX_UNITS, n | 0));
const color3 = (hex) => window.BABYLON.Color3.FromHexString(hex);
const pickRandom = (arr) => arr[(Math.random() * arr.length) | 0];

/**
 * Mounts the demo on a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl Paragraph the stats line is written into.
 * @param {object} opts
 * @param {object} opts.initialSettings Snapshot from the sidebar.
 * @param {Function} opts.WasmLayout The wasm `WasmLayout` class export.
 * @returns {{regenerate: Function, updateLive: Function, setToggle: Function}}
 */
export function mount(canvas, statsEl, { initialSettings, WasmLayout }) {
  const BABYLON = window.BABYLON;
  if (!BABYLON) {
    throw new Error("Babylon.js did not load — check the CDN <script> tag.");
  }
  const { Vector3, Color4, MeshBuilder, StandardMaterial, VertexData } = BABYLON;

  const engine = new BABYLON.Engine(canvas, true, { stencil: false }, true);
  const scene = new BABYLON.Scene(engine);
  // The wasm stream is right-handed (+Y up, CCW front faces) like the three.js
  // page assumes. Telling Babylon so keeps winding, normals and `lookAt` all
  // consistent instead of mirroring the terrain.
  scene.useRightHandedSystem = true;
  scene.clearColor = Color4.FromHexString(`${BG_COLOR}ff`);

  const camera = new BABYLON.ArcRotateCamera(
    "camera", -Math.PI / 2, 0.95, 60, Vector3.Zero(), scene,
  );
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 6;
  camera.panningSensibility = 40;
  camera.lowerBetaLimit = 0.05;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;

  const ambient = new BABYLON.HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.55;
  ambient.groundColor = color3("#101828");
  const sun = new BABYLON.DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), scene);
  sun.intensity = 1.0;

  const glow = new BABYLON.GlowLayer("glow", scene);
  glow.intensity = 0.7;

  const terrainMat = new StandardMaterial("terrain", scene);
  terrainMat.diffuseColor = color3(TERRAIN_COLOR);
  terrainMat.specularColor = color3("#223044");
  // The mesh is a surface, not a solid: gap quads and the underside are both
  // worth seeing when the camera dips below the rim.
  terrainMat.backFaceCulling = false;

  /** @type {{settings: object, graph: object|null, terrain: object|null, units: object[]}} */
  const state = {
    settings: { ...initialSettings },
    graph: null,
    terrain: null,
    units: [],
    triangles: 0,
  };

  // ── terrain ──────────────────────────────────────────────────────

  /** Rebuilds the terrain mesh and the cell graph from a fresh `WasmLayout`. */
  const buildTerrain = (settings) => {
    const [heightSeed, radiusSeed] = settings.seed === null
      ? [randomU32(), randomU32()]
      : seedSequence(settings.seed, 2);

    const layout = new WasmLayout(settings.radius, heightSeed, radiusSeed, [], []);
    const tris = layout.tris(false);
    const faceTris = layout.face_tris(false);
    layout.free();

    const { positions, indices } = weldTris(tris);
    const normals = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new BABYLON.Mesh("terrain", scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.applyToMesh(mesh);
    mesh.material = terrainMat;

    state.terrain?.dispose();
    state.terrain = mesh;
    state.graph = buildCellGraph(faceTris);
    state.triangles = indices.length / 3;
    terrainMat.wireframe = !!settings.wire;

    // Frame the grid: the hexagon's circumradius is roughly the grid radius in
    // lattice steps, plus one for the rim.
    const span = state.graph.spacing * (settings.radius + 1);
    camera.setTarget(Vector3.Zero());
    camera.radius = Math.max(12, span * 2.1);
    camera.lowerRadiusLimit = span * 0.4;
    camera.upperRadiusLimit = span * 8;
  };

  // ── units ────────────────────────────────────────────────────────

  const cellCenter = (i) => {
    const c = state.graph.centers;
    return new Vector3(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
  };

  /**
   * Builds one unit: a `TransformNode` carrying a hexagonal body and a nose
   * cone. Heading comes from `lookAt` on the parent, so the nose is what makes
   * the direction of travel readable.
   */
  const createUnit = (index) => {
    const { spacing } = state.graph;
    const hex = color3(UNIT_COLORS[index % UNIT_COLORS.length]);
    const material = new StandardMaterial(`unit-${index}`, scene);
    material.diffuseColor = hex;
    material.emissiveColor = hex.scale(0.55);
    material.specularColor = color3("#000000");

    const root = new BABYLON.TransformNode(`unit-root-${index}`, scene);
    const body = MeshBuilder.CreateCylinder(`unit-body-${index}`, {
      diameterTop: spacing * UNIT_WIDTH * 0.45,
      diameterBottom: spacing * UNIT_WIDTH,
      height: spacing * UNIT_HEIGHT,
      tessellation: 6,
    }, scene);
    body.material = material;
    body.parent = root;
    body.position.y = (spacing * UNIT_HEIGHT) / 2;

    const nose = MeshBuilder.CreateSphere(`unit-nose-${index}`, {
      diameter: spacing * UNIT_WIDTH * 0.42, segments: 6,
    }, scene);
    nose.material = material;
    nose.parent = root;
    // Local +Z is `lookAt`'s forward axis.
    nose.position.set(0, spacing * UNIT_HEIGHT * 0.72, spacing * UNIT_WIDTH * 0.42);

    const trailMat = new StandardMaterial(`trail-${index}`, scene);
    trailMat.emissiveColor = hex;
    trailMat.disableLighting = true;

    const marker = MeshBuilder.CreateTorus(`goal-${index}`, {
      diameter: spacing * 0.62, thickness: spacing * 0.055, tessellation: 6,
    }, scene);
    marker.material = trailMat;
    marker.isPickable = false;

    return {
      root, body, nose, marker, material, trailMat,
      trail: null,
      path: null,
      leg: 0,      // index of the current step's origin within `path`
      t: 0,        // progress along the current step, 0..1
      cell: 0,     // cell the unit currently occupies
    };
  };

  /** Draws (or redraws) the polyline for a unit's remaining route. */
  const drawTrail = (unit) => {
    unit.trail?.dispose();
    unit.trail = null;
    if (!unit.path || !state.settings.trails) return;

    const lift = state.graph.spacing * TRAIL_LIFT;
    const points = unit.path.map((i) => {
      const p = cellCenter(i);
      p.y += lift;
      return p;
    });
    const trail = MeshBuilder.CreateLines(`trail-${unit.root.name}`, { points }, scene);
    trail.color = unit.trailMat.emissiveColor;
    trail.isPickable = false;
    unit.trail = trail;
  };

  /** Assigns a route to `goal`; falls back to a random reachable cell. */
  const routeTo = (unit, goal) => {
    const { maxClimb } = state.settings;
    let path = goal === null ? null : findPath(state.graph, unit.cell, goal, maxClimb);
    if (!path || path.length < 2) {
      const reachable = reachableFrom(state.graph, unit.cell, maxClimb)
        .filter((i) => i !== unit.cell);
      path = reachable.length
        ? findPath(state.graph, unit.cell, pickRandom(reachable), maxClimb)
        : null;
    }
    unit.path = path;
    unit.leg = 0;
    unit.t = 0;

    const destination = path ? path[path.length - 1] : unit.cell;
    const marker = cellCenter(destination);
    marker.y += state.graph.spacing * TRAIL_LIFT;
    unit.marker.position = marker;
    unit.marker.setEnabled(!!path && !!state.settings.trails);
    drawTrail(unit);
  };

  /** Drops a unit onto a cell, cancelling whatever it was doing. */
  const placeUnit = (unit, cell) => {
    unit.cell = cell;
    const at = cellCenter(cell);
    at.y += state.graph.spacing * UNIT_HOVER;
    unit.root.position = at;
    routeTo(unit, null);
  };

  const disposeUnit = (unit) => {
    unit.trail?.dispose();
    unit.marker.dispose();
    unit.body.dispose();
    unit.nose.dispose();
    unit.root.dispose();
    unit.material.dispose();
    unit.trailMat.dispose();
  };

  /** Spawns or despawns units so the scene matches the requested count. */
  const syncUnitCount = (count) => {
    const wanted = clampUnits(count);
    while (state.units.length > wanted) disposeUnit(state.units.pop());
    while (state.units.length < wanted) {
      const unit = createUnit(state.units.length);
      state.units.push(unit);
      placeUnit(unit, (Math.random() * state.graph.count) | 0);
    }
  };

  /** Tears down every unit — used before a rebuild, since sizes are grid-relative. */
  const clearUnits = () => {
    state.units.forEach(disposeUnit);
    state.units = [];
  };

  // ── update loop ──────────────────────────────────────────────────

  /**
   * Advances one unit by `dt` seconds. A unit walks its path leg by leg,
   * interpolating position between the two cell centers and adding a sine arc
   * so the step across the gap between hexes reads as a hop. On arrival it
   * picks a fresh random destination, which is what keeps the grid busy.
   */
  const advance = (unit, dt) => {
    if (!unit.path || unit.path.length < 2) {
      if (Math.random() < dt) routeTo(unit, null); // retry an unroutable unit
      return;
    }
    const { spacing } = state.graph;
    unit.t += dt * STEPS_PER_SECOND * state.settings.speed;

    while (unit.t >= 1) {
      unit.t -= 1;
      unit.leg += 1;
      unit.cell = unit.path[Math.min(unit.leg, unit.path.length - 1)];
      if (unit.leg >= unit.path.length - 1) {
        unit.t = 0;
        routeTo(unit, null);
        return;
      }
    }

    const from = unit.path[unit.leg];
    const to = unit.path[unit.leg + 1];
    const a = cellCenter(from);
    const b = cellCenter(to);
    const pos = Vector3.Lerp(a, b, unit.t);
    pos.y += spacing * UNIT_HOVER + spacing * HOP_HEIGHT * Math.sin(Math.PI * unit.t);
    unit.root.position = pos;

    // Look one step ahead, held flat so the body stays upright on slopes.
    unit.root.lookAt(new Vector3(b.x, pos.y, b.z));
  };

  scene.onBeforeRenderObservable.add(() => {
    if (!state.graph) return;
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1); // clamp tab-switch jumps
    for (const unit of state.units) advance(unit, dt);
  });

  // ── picking: click the terrain to rally ──────────────────────────

  /** Nearest cell to a world-space point, by planar distance. */
  const nearestCell = (point) => {
    const c = state.graph.centers;
    let best = 0;
    let bestSq = Infinity;
    for (let i = 0; i < state.graph.count; i++) {
      const dx = c[i * 3] - point.x;
      const dz = c[i * 3 + 2] - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = i; }
    }
    return best;
  };

  scene.onPointerDown = (_evt, pickInfo) => {
    if (!state.graph || !pickInfo.hit || pickInfo.pickedMesh !== state.terrain) return;
    const rally = nearestCell(pickInfo.pickedPoint);
    // Fan the squad out over the rally cell and its neighbors so units don't
    // all pile onto one hex.
    const spots = [rally, ...state.graph.neighbors[rally]];
    state.units.forEach((unit, i) => routeTo(unit, spots[i % spots.length]));
  };

  // ── stats ────────────────────────────────────────────────────────

  let lastStats = -Infinity; // write the first stats line on the very first frame
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - lastStats < STATS_INTERVAL_MS) return;
    lastStats = now;
    const walking = state.units.filter((u) => u.path).length;
    statsEl.textContent = [
      `${state.graph.count} hexes`,
      `${state.triangles.toLocaleString()} tris`,
      `${walking}/${state.units.length} units walking`,
      `${engine.getFps().toFixed(0)} fps`,
    ].join("  ·  ");
  });

  // ── public API ───────────────────────────────────────────────────

  /** Full rebuild: new terrain, new cell graph, units re-seeded onto it. */
  const regenerate = (settings) => {
    state.settings = { ...settings };
    clearUnits();
    buildTerrain(state.settings);
    syncUnitCount(state.settings.unitCount);
  };

  /** Knobs that do not touch the wasm meshes. */
  const updateLive = (settings) => {
    state.settings = { ...state.settings, ...settings };
    syncUnitCount(state.settings.unitCount);
  };

  const setToggle = (key, on) => {
    state.settings[key] = on;
    if (key === "wire") terrainMat.wireframe = on;
    if (key === "glow") glow.intensity = on ? 0.7 : 0;
    if (key === "trails") {
      for (const unit of state.units) {
        drawTrail(unit);
        unit.marker.setEnabled(on && !!unit.path);
      }
    }
  };

  regenerate(state.settings);
  setToggle("glow", !!state.settings.glow);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  return { regenerate, updateLive, setToggle };
}
