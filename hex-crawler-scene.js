/**
 * Phaser scene for `hex-crawler.html` — the board where the character *is* the
 * shader.
 *
 * There is no sprite. A single crawler occupies one hex or one gap quad
 * completely, and moves by draining out of one shape and pouring into the next.
 * The grid's own triangles are the animation primitive, so the whole character
 * is a function of a handful of uniforms over static geometry.
 *
 * ## Why raw GL instead of a batching pipeline
 *
 * Phaser's `WebGLPipeline` exists to re-batch dynamic vertices every frame. This
 * page wants the exact opposite: the board uploads **once**, and the entire
 * animation is uniforms plus one rarely-touched trail buffer. Subclassing a
 * batcher only to bypass its buffer would be more moving parts, not fewer, so
 * the two programs and their buffers are ours and the draw happens on the game's
 * `postrender` event.
 *
 * What Phaser genuinely provides, stated plainly: the WebGL context and canvas
 * management, the game loop and its delta, the scene lifecycle, `Phaser.Math`'s
 * easing curves shaping each stage, and the FPS counter. The geometry, the
 * shaders and the `drawArrays` are this file's.
 *
 * ## Projection
 *
 * `(x, z)` straight from the wasm stream, y dropped — the same 2D projection
 * `src/serialize.rs` uses for the SVG previews — fitted to the canvas by a
 * scale/centre uniform pair, so a resize never rebuilds a buffer.
 *
 * Phaser arrives as a UMD global (`window.Phaser`), same as Babylon on the units
 * page: this pipeline has no bundler.
 */
import { randomU32, seedSequence } from "./seed.js";
import { buildCellGraph } from "./hex-units-grid.js";
import { FLOATS_PER_VERTEX, buildBoard } from "./hex-crawler-board.js";
import { STAGE, advanceWalk, createWalk } from "./hex-crawler-walk.js";

const BG_COLOR = "#0a0e1a";
/** Board fill at height 0 and at max height — the SvgRich tint, ported. */
const BOARD_LOW = [0.11, 0.18, 0.20];
const BOARD_HIGH = [0.40, 0.80, 0.60];
/** Character: rim colour and centroid colour of the fill. */
const CHAR_RIM = [0.35, 1.00, 0.82];
const CHAR_CORE = [0.85, 1.00, 0.95];
/** The aim telegraph, and the yellow bands crossing a gap. */
const AIM_COLOR = [1.00, 0.62, 0.35];
const BAND_COLOR = [1.00, 0.90, 0.30];
const TRAIL_COLOR = [0.45, 0.70, 1.00];

/** How far gap quads and junction triangles sit below hex faces in brightness. */
const GAP_DIM = 0.45;
const TRAIL_DECAY_SECONDS = 6.0;
const BAND_COUNT = 4.0;
/** Fraction of the canvas the board is fitted into. */
const BOARD_FIT = 0.92;
const STATS_INTERVAL_MS = 250;

/** Stage → the `uStage` int the shaders branch on. */
const STAGE_ID = {
  [STAGE.ENTER]: 0, [STAGE.REST]: 1, [STAGE.AIM]: 2,
  [STAGE.EXIT]: 3, [STAGE.GAP]: 4,
};

// ── shaders ─────────────────────────────────────────────────────────

// highp in the vertex shader is guaranteed in WebGL 1 and is what keeps the
// trail's `uNow - aVisitedAt` subtraction accurate as the clock grows.
const BOARD_VERT = `
precision highp float;
attribute vec2 aPos;
attribute float aCell;
attribute float aCellB;
attribute float aSlot;
attribute float aKind;
attribute float aWeight;
attribute float aHeight;
attribute float aVisitedAt;

uniform vec2 uScale;
uniform vec2 uCenter;
uniform float uCell, uEntrySlot, uExitSlot;
// The crossing, as the pair of cells it joins. Matching on the pair rather than
// on a slot means one stored quad serves both directions of travel.
uniform float uGapFrom, uGapTo;
uniform float uPhase, uStage, uNow, uMaxHeight;

varying float vFill, vWeight, vKind, vTerrain, vAim, vTrail;

// Steps around the 6-ring from a reference slot: 0, 1, 1, 2, 2, 3.
float ringDist(float slot, float ref) {
  return abs(mod(slot - ref + 3.0, 6.0) - 3.0);
}

void main() {
  vWeight = aWeight;
  vKind = aKind;
  vTerrain = uMaxHeight > 0.0 ? clamp(aHeight / uMaxHeight, 0.0, 1.0) : 0.0;
  vTrail = clamp(exp(-(uNow - aVisitedAt) / ${TRAIL_DECAY_SECONDS.toFixed(1)}), 0.0, 1.0);
  vAim = 0.0;
  vFill = 0.0;

  if (aKind < 0.5) {
    bool here = abs(aCell - uCell) < 0.5;
    // Hex face fan. All three vertices of a triangle share aCell and aSlot, so
    // this is constant across the triangle — the fan steps, it does not blur.
    if (here) {
      if (uStage < 0.5) {
        // ENTER: four waves out from the door — that tri, its two neighbours,
        // theirs, then the far one.
        vFill = clamp(uPhase * 4.0 - ringDist(aSlot, uEntrySlot), 0.0, 1.0);
      } else if (uStage < 2.5) {
        vFill = 1.0;                                   // REST and AIM: full hex
        if (uStage > 1.5 && ringDist(aSlot, uExitSlot) < 0.5) vAim = 1.0;
      } else if (uStage < 3.5) {
        // EXIT: collapses inward with the exit tri emptying last, so the
        // character pours out through the door it aimed at.
        vFill = 1.0 - clamp(uPhase * 4.0 - (3.0 - ringDist(aSlot, uExitSlot)), 0.0, 1.0);
      }
      // GAP: the hex is empty, the character is between cells.
    }
  } else if (uGapFrom >= 0.0) {
    bool forward = abs(aCell - uGapFrom) < 0.5 && abs(aCellB - uGapTo) < 0.5;
    bool reverse = abs(aCell - uGapTo) < 0.5 && abs(aCellB - uGapFrom) < 0.5;
    if (forward || reverse) {
      // The gap being crossed fills quickly, then the bands carry the motion.
      vFill = smoothstep(0.0, 0.2, uPhase);
      // The stored weight runs source → neighbour of the *owning* hex; flip it
      // when the character is going the other way, so the bands always travel
      // with it.
      vWeight = forward ? aWeight : 1.0 - aWeight;
    }
  }

  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

const BOARD_FRAG = `
precision mediump float;
varying float vFill, vWeight, vKind, vTerrain, vAim, vTrail;
uniform float uBandPhase, uBandRate, uTrailOn, uBandsOn;

void main() {
  // Gap quads and junctions sit dimmer than hex faces, matching the base
  // layer, so the grid reads as separated cells — and so the character lighting
  // one up on its way across actually pops against them.
  vec3 board = mix(vec3(${BOARD_LOW}), vec3(${BOARD_HIGH}), vTerrain)
             * mix(1.0, ${GAP_DIM.toFixed(2)}, vKind);
  vec3 col = mix(board, vec3(${TRAIL_COLOR}), vTrail * uTrailOn * 0.35);

  // The character: rim → centroid gradient, the same weight the terrain page's
  // ring overlay uses.
  vec3 body = mix(vec3(${CHAR_RIM}), vec3(${CHAR_CORE}), vWeight);
  col = mix(col, body, vFill);
  col = mix(col, vec3(${AIM_COLOR}), vAim * 0.75);

  // Yellow bands sweeping source → neighbour, at the crossing's own rate, so an
  // uphill gap visibly crawls.
  float band = fract(vWeight * ${BAND_COUNT.toFixed(1)} - uBandPhase * uBandRate);
  float pulse = smoothstep(0.55, 0.95, band) * (1.0 - smoothstep(0.95, 1.0, band));
  col = mix(col, vec3(${BAND_COLOR}), pulse * vFill * vKind * uBandsOn);

  gl_FragColor = vec4(col, 1.0);
}`;

const BASE_VERT = `
precision highp float;
attribute vec2 aPos;
attribute float aHeight;
uniform vec2 uScale, uCenter;
uniform float uMaxHeight;
varying float vTerrain;
void main() {
  vTerrain = uMaxHeight > 0.0 ? clamp(aHeight / uMaxHeight, 0.0, 1.0) : 0.0;
  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

const BASE_FRAG = `
precision mediump float;
varying float vTerrain;
void main() {
  gl_FragColor = vec4(mix(vec3(${BOARD_LOW}), vec3(${BOARD_HIGH}), vTerrain) * ${GAP_DIM.toFixed(2)}, 1.0);
}`;

// ── GL helpers ──────────────────────────────────────────────────────

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

/** Links a program and pre-resolves every attribute and uniform location. */
function buildProgram(gl, vertSrc, fragSrc, attribNames, uniformNames) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const attribs = {};
  for (const name of attribNames) attribs[name] = gl.getAttribLocation(program, name);
  const uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, attribs, uniforms };
}

// ── mount ───────────────────────────────────────────────────────────

/**
 * Mounts the crawler on a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} statsEl
 * @param {object} opts
 * @param {object} opts.initialSettings Sidebar snapshot.
 * @param {Function} opts.WasmLayout The wasm `WasmLayout` class export.
 * @returns {{regenerate: Function, updateLive: Function, setToggle: Function}}
 */
export function mount(canvas, statsEl, { initialSettings, WasmLayout }) {
  const Phaser = window.Phaser;
  if (!Phaser) throw new Error("Phaser did not load — check the CDN <script> tag.");

  const state = {
    settings: { ...initialSettings },
    board: null,
    walk: null,
    bandPhase: 0,
    gl: null,
    programs: null,
    buffers: null,
  };

  // Easing per stage. This is the Phaser maths library doing real work: the raw
  // linear phase from the walk machine is shaped here, so the fan accelerates
  // out of the door and the drain eases into it.
  const EASING = {
    [STAGE.ENTER]: Phaser.Math.Easing.Cubic.Out,
    [STAGE.REST]: Phaser.Math.Easing.Linear,
    [STAGE.AIM]: Phaser.Math.Easing.Sine.InOut,
    [STAGE.EXIT]: Phaser.Math.Easing.Cubic.In,
    [STAGE.GAP]: Phaser.Math.Easing.Linear,
  };

  /** Rebuilds the board, its GPU buffers and the walk from a fresh layout. */
  const rebuild = (settings) => {
    const [heightSeed, radiusSeed] = settings.seed === null
      ? [randomU32(), randomU32()]
      : seedSequence(settings.seed, 2);

    const layout = new WasmLayout(settings.radius, heightSeed, radiusSeed, [], []);
    const buffers = {
      faceTris: layout.face_tris(false),
      bridges: layout.face_bridge_quads(false),
      tris: layout.tris(false),
    };
    layout.free();

    const graph = buildCellGraph(buffers.faceTris);
    state.board = buildBoard(buffers, graph);
    state.walk = createWalk({
      board: state.board,
      graph,
      tuning: { tempo: settings.tempo, climbK: settings.climbK },
    });
    uploadBoard();
  };

  /** (Re)uploads both static buffers and resets the per-vertex trail buffer. */
  const uploadBoard = () => {
    const { gl, board } = state;
    if (!gl || !board) return;
    const b = state.buffers;

    gl.bindBuffer(gl.ARRAY_BUFFER, b.vertices);
    gl.bufferData(gl.ARRAY_BUFFER, board.vertices, gl.STATIC_DRAW);

    // One float per vertex, far enough in the past that exp() lands on zero.
    b.visited = new Float32Array(board.vertexCount).fill(-1e6);
    b.visited.fill(0, state.walk.cell * 18, state.walk.cell * 18 + 18);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.visitedAt);
    gl.bufferData(gl.ARRAY_BUFFER, b.visited, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, b.base);
    gl.bufferData(gl.ARRAY_BUFFER, board.base, gl.STATIC_DRAW);
  };

  /**
   * Stamps the visit time onto one hex's 18 face vertices. Called once per cell
   * entry, never per frame — the fade itself is shader-side.
   */
  const markVisited = (cell, now) => {
    const { gl, buffers } = state;
    const at = cell * 18;
    buffers.visited.fill(now, at, at + 18);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.visitedAt);
    gl.bufferSubData(gl.ARRAY_BUFFER, at * 4, buffers.visited.subarray(at, at + 18));
  };

  /** World → clip transform fitting the board into the current drawing buffer. */
  const projection = () => {
    const { bounds } = state.board;
    const w = canvas.width || 1;
    const h = canvas.height || 1;
    const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
    const spanZ = Math.max(1e-6, bounds.maxZ - bounds.minZ);
    const k = BOARD_FIT * Math.min(w / spanX, h / spanZ);
    return {
      // Negative Y so world +z runs down the screen, matching the SVG previews.
      scale: [(2 * k) / w, (-2 * k) / h],
      center: [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2],
    };
  };

  /** Enabled attribute slots, so `draw` can hand them back when it is done. */
  const enabled = new Set();

  const bindAttrib = (loc, buffer, size, stride, offset) => {
    const { gl } = state;
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    enabled.add(loc);
  };

  const draw = () => {
    const { gl, board, walk, programs, buffers } = state;
    if (!gl || !board) return;

    const { scale, center } = projection();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // Phaser owns this context and may have left culling on; our winding comes
    // straight from the wasm stream and is not guaranteed to agree with it.
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    // Dim full board first, junction triangles included — `tris(false)` already
    // carries those, so no extra wasm export is needed just to draw them.
    if (state.settings.base) {
      const { program, attribs, uniforms } = programs.base;
      gl.useProgram(program);
      gl.uniform2fv(uniforms.uScale, scale);
      gl.uniform2fv(uniforms.uCenter, center);
      gl.uniform1f(uniforms.uMaxHeight, board.maxHeight);
      bindAttrib(attribs.aPos, buffers.base, 2, 12, 0);
      bindAttrib(attribs.aHeight, buffers.base, 1, 12, 8);
      gl.drawArrays(gl.TRIANGLES, 0, board.baseVertexCount);
    }

    const { program, attribs, uniforms } = programs.board;
    const stride = FLOATS_PER_VERTEX * 4;
    gl.useProgram(program);
    gl.uniform2fv(uniforms.uScale, scale);
    gl.uniform2fv(uniforms.uCenter, center);
    gl.uniform1f(uniforms.uMaxHeight, board.maxHeight);
    gl.uniform1f(uniforms.uCell, walk.cell);
    gl.uniform1f(uniforms.uEntrySlot, walk.entrySlot);
    gl.uniform1f(uniforms.uExitSlot, walk.exitSlot);
    const crossing = walk.stage === STAGE.GAP;
    gl.uniform1f(uniforms.uGapFrom, crossing ? walk.cell : -1);
    gl.uniform1f(uniforms.uGapTo,
      crossing ? board.neighborOf[walk.cell * 6 + walk.exitSlot] : -1);
    gl.uniform1f(uniforms.uPhase, EASING[walk.stage](walk.phase));
    gl.uniform1f(uniforms.uStage, STAGE_ID[walk.stage]);
    gl.uniform1f(uniforms.uNow, walk.now);
    gl.uniform1f(uniforms.uBandPhase, state.bandPhase);
    // Bands inherit the crossing's own rate, so the gap telegraphs the climb.
    gl.uniform1f(uniforms.uBandRate, 1 / walk.climbFactor);
    gl.uniform1f(uniforms.uTrailOn, state.settings.trail ? 1 : 0);
    gl.uniform1f(uniforms.uBandsOn, state.settings.bands ? 1 : 0);

    bindAttrib(attribs.aPos, buffers.vertices, 2, stride, 0);
    bindAttrib(attribs.aCell, buffers.vertices, 1, stride, 8);
    bindAttrib(attribs.aCellB, buffers.vertices, 1, stride, 12);
    bindAttrib(attribs.aSlot, buffers.vertices, 1, stride, 16);
    bindAttrib(attribs.aKind, buffers.vertices, 1, stride, 20);
    bindAttrib(attribs.aWeight, buffers.vertices, 1, stride, 24);
    bindAttrib(attribs.aHeight, buffers.vertices, 1, stride, 28);
    bindAttrib(attribs.aVisitedAt, buffers.visitedAt, 1, 4, 0);
    gl.drawArrays(gl.TRIANGLES, 0, board.vertexCount);

    // Phaser owns this context; don't leave our attribute arrays enabled on it.
    for (const loc of enabled) gl.disableVertexAttribArray(loc);
    enabled.clear();
  };

  let lastStats = -Infinity;
  const reportStats = () => {
    const now = performance.now();
    if (now - lastStats < STATS_INTERVAL_MS) return;
    lastStats = now;
    const { board, walk } = state;
    statsEl.textContent = [
      `${board.hexCount} hexes`,
      `${(board.vertexCount / 3).toLocaleString()} tris`,
      `cell ${walk.cell} · ${walk.stage}`,
      `${walk.steps} steps`,
      `${(state.scene?.game.loop.actualFps ?? 0).toFixed(0)} fps`,
    ].join("  ·  ");
  };

  const scene = {
    create() {
      state.scene = this;
      state.gl = this.game.renderer.gl;
      const gl = state.gl;
      if (!gl) throw new Error("no WebGL context — the crawler needs Phaser.WEBGL");

      state.programs = {
        board: buildProgram(gl, BOARD_VERT, BOARD_FRAG,
          ["aPos", "aCell", "aCellB", "aSlot", "aKind", "aWeight", "aHeight", "aVisitedAt"],
          ["uScale", "uCenter", "uCell", "uEntrySlot", "uExitSlot", "uGapFrom",
            "uGapTo", "uPhase", "uStage", "uNow", "uMaxHeight", "uBandPhase",
            "uBandRate", "uTrailOn", "uBandsOn"]),
        base: buildProgram(gl, BASE_VERT, BASE_FRAG,
          ["aPos", "aHeight"], ["uScale", "uCenter", "uMaxHeight"]),
      };
      state.buffers = {
        vertices: gl.createBuffer(),
        visitedAt: gl.createBuffer(),
        base: gl.createBuffer(),
        visited: new Float32Array(0),
      };
      uploadBoard();
      // Our draw runs after Phaser's own render pass has cleared the frame.
      this.game.events.on("postrender", draw);
    },

    update(_time, deltaMs) {
      const { walk } = state;
      if (!walk) return;
      const dt = Math.min(deltaMs / 1000, 0.1); // clamp tab-switch jumps
      const before = walk.cell;
      advanceWalk(walk, dt);
      if (walk.cell !== before) markVisited(walk.cell, walk.now);
      state.bandPhase = (state.bandPhase + dt * (state.settings.bandSpeed || 1)) % 1;
      reportStats();
    },
  };

  rebuild(state.settings);

  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    canvas,
    width: canvas.clientWidth || 800,
    height: canvas.clientHeight || 600,
    backgroundColor: BG_COLOR,
    scene,
  });

  const onResize = () => {
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    game.scale?.resize(w, h);
  };
  window.addEventListener("resize", onResize);

  return {
    /** Rebuild knobs: a new grid means new buffers and a new walk. */
    regenerate(settings) {
      state.settings = { ...settings };
      rebuild(state.settings);
    },
    /** Live knobs, applied to the walk in flight. */
    updateLive(settings) {
      state.settings = { ...state.settings, ...settings };
      if (state.walk) {
        state.walk.tuning.tempo = state.settings.tempo;
        state.walk.tuning.climbK = state.settings.climbK;
      }
    },
    setToggle(key, on) {
      state.settings[key] = on;
    },
  };
}
