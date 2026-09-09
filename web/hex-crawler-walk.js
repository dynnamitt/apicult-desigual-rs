/**
 * The crawler's state machine: one character creeping from hex to hex.
 *
 * Pure logic — no Phaser, no GL, no wasm — so it runs under node
 * (`web/hex-crawler-walk.test.mjs`) and the scene only has to copy the result
 * into uniforms.
 *
 * ## The cycle
 *
 * ```
 *   ENTER ──▶ REST ──▶ AIM ──▶ EXIT ──▶ GAP ──▶ ENTER (next cell)
 * ```
 *
 * - **ENTER** — the fill fans out from the tri at the door it came through:
 *   that tri, then its two neighbours, then theirs, then the far one.
 * - **REST** — the character fully fills the hex.
 * - **AIM** — the tri it is about to leave through shades differently, so the
 *   choice is telegraphed a beat before the move.
 * - **EXIT** — the fill collapses inward with the exit tri emptying *last*, so
 *   the character visibly pours out through the chosen door.
 * - **GAP** — the gap quad fills and yellow bands sweep across it.
 *
 * The stage names are all this module publishes about the animation; how far
 * through a stage it is arrives as `phase` in `0..1` and the shader does the
 * rest.
 *
 * ## Height is speed, not a wall
 *
 * Every in-grid step is legal. A step's whole duration (EXIT + GAP + the next
 * ENTER) is scaled by `exp(climbK * Δheight / spacing)`, so climbing drags and
 * descending snaps, and the bands in the gap inherit the same rate — the gap
 * itself telegraphs the cost before the character is committed to it.
 *
 * Routing reuses `hex-units-grid.js` untouched: `findPath` with an infinite
 * climb limit makes every neighbour passable while its `1 + 4·|Δh|/spacing` step
 * cost still prefers level ground, so the crawler mostly follows contours and
 * only grinds over a ridge when the target is on the other side.
 */
import { cellHeight, findPath, reachableFrom } from "./hex-units-grid.js";
import { slotBetween } from "./hex-crawler-board.js";

export const STAGE = {
  ENTER: "enter",
  REST: "rest",
  AIM: "aim",
  EXIT: "exit",
  GAP: "gap",
};

/** Stage lengths in seconds at tempo 1, before the climb factor. */
export const STAGE_SECONDS = {
  [STAGE.ENTER]: 0.45,
  [STAGE.REST]: 0.25,
  [STAGE.AIM]: 0.35,
  [STAGE.EXIT]: 0.35,
  [STAGE.GAP]: 0.40,
};

/** Stages whose duration is scaled by the current step's climb factor. */
const CLIMB_SCALED = new Set([STAGE.EXIT, STAGE.GAP, STAGE.ENTER]);

/** Bounds on the climb factor, so a cliff cannot stall the demo outright. */
const MIN_FACTOR = 0.35;
const MAX_FACTOR = 3.0;

/** Targets closer than this many cells are re-rolled, to avoid trivial hops. */
const MIN_GOAL_DISTANCE = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @typedef {object} Walk
 * @property {string} stage One of {@link STAGE}.
 * @property {number} phase Progress through the current stage, `0..1`.
 * @property {number} cell Cell currently occupied (also the gap's source cell).
 * @property {number} entrySlot Bridge slot the character arrived through, `-1`
 *   at spawn. The ENTER fan radiates from here.
 * @property {number} exitSlot Bridge slot it will leave through, `-1` when it
 *   has nowhere to go.
 * @property {number} climbFactor Duration multiplier for the current step.
 * @property {number} now Seconds since the walk started.
 * @property {Float64Array} visitedAt Per-cell timestamp of the last entry, for
 *   the fading trail. `-Infinity` for never-visited.
 * @property {number[]|null} path Current route, cell indices.
 * @property {number} pathAt Index of `cell` within `path`.
 * @property {number} goal Destination cell, `-1` when idle.
 * @property {number} steps Completed cell-to-cell moves, for the stats line.
 */

/**
 * Creates a walk parked on a random cell, ready for its first ENTER.
 *
 * @param {object} opts
 * @param {object} opts.board From `hex-crawler-board.js::buildBoard`.
 * @param {object} opts.graph From `hex-units-grid.js::buildCellGraph`.
 * @param {object} opts.tuning `{ tempo, climbK }`, live-editable afterwards.
 * @param {() => number} [opts.rng] Injectable for deterministic tests.
 * @returns {Walk}
 */
export function createWalk({ board, graph, tuning, rng = Math.random }) {
  const start = Math.min(graph.count - 1, (rng() * graph.count) | 0);
  const visitedAt = new Float64Array(graph.count).fill(-Infinity);
  visitedAt[start] = 0;

  const walk = {
    board, graph, tuning, rng,
    stage: STAGE.ENTER,
    phase: 0,
    elapsed: 0,
    cell: start,
    entrySlot: -1,
    exitSlot: -1,
    climbFactor: 1,
    now: 0,
    visitedAt,
    path: null,
    pathAt: 0,
    goal: -1,
    steps: 0,
  };
  walk.duration = stageDuration(walk, STAGE.ENTER);
  return walk;
}

/** Seconds the given stage should last under the current tuning. */
function stageDuration(walk, stage) {
  const tempo = Math.max(0.05, walk.tuning.tempo);
  const factor = CLIMB_SCALED.has(stage) ? walk.climbFactor : 1;
  return (STAGE_SECONDS[stage] / tempo) * factor;
}

/**
 * How much slower this step is than a level one.
 *
 * Symmetric and monotone in the height delta: uphill returns `> 1`, downhill
 * `< 1`, level exactly `1`.
 */
export function climbFactorFor(walk, from, to) {
  const dh = cellHeight(walk.graph, to) - cellHeight(walk.graph, from);
  const k = walk.tuning.climbK;
  return clamp(Math.exp((k * dh) / walk.graph.spacing), MIN_FACTOR, MAX_FACTOR);
}

/**
 * Chooses a fresh destination and route, preferring somewhere worth walking to.
 *
 * @returns {boolean} whether a usable route was found.
 */
function retarget(walk) {
  const { graph, rng } = walk;
  // Infinite climb: nothing is impassable, so this is every cell in the
  // connected grid. The distance filter keeps it from picking next door.
  const candidates = reachableFrom(graph, walk.cell, Infinity)
    .filter((c) => c !== walk.cell);
  if (candidates.length === 0) {
    walk.path = null;
    walk.goal = -1;
    return false;
  }

  const far = candidates.filter((c) => {
    const dx = graph.centers[c * 3] - graph.centers[walk.cell * 3];
    const dz = graph.centers[c * 3 + 2] - graph.centers[walk.cell * 3 + 2];
    return Math.hypot(dx, dz) >= MIN_GOAL_DISTANCE * graph.spacing;
  });
  const pool = far.length ? far : candidates;
  walk.goal = pool[Math.min(pool.length - 1, (rng() * pool.length) | 0)];
  walk.path = findPath(graph, walk.cell, walk.goal, Infinity);
  walk.pathAt = 0;
  return !!(walk.path && walk.path.length > 1);
}

/**
 * Picks the bridge slot for the next step, routing again when the current path
 * is spent (or was never usable).
 *
 * @returns {number} slot `0..5`, or `-1` if the character has nowhere to go.
 */
function chooseExit(walk) {
  const hasNext = walk.path && walk.pathAt < walk.path.length - 1;
  if (!hasNext && !retarget(walk)) return -1;

  const next = walk.path[walk.pathAt + 1];
  const slot = slotBetween(walk.board, walk.cell, next);
  if (slot < 0) {
    // The route stepped somewhere with no gap quad between the two cells, which
    // means the graph and the board disagree. Drop the path and try again next
    // REST rather than walking into nothing.
    walk.path = null;
    return -1;
  }
  walk.climbFactor = climbFactorFor(walk, walk.cell, next);
  return slot;
}

/** Moves into the cell across `exitSlot`, starting a new ENTER there. */
function stepThroughGap(walk) {
  const arrived = walk.board.neighborOf[walk.cell * 6 + walk.exitSlot];
  const back = slotBetween(walk.board, arrived, walk.cell);
  walk.cell = arrived;
  walk.entrySlot = back;
  walk.exitSlot = -1;
  walk.pathAt += 1;
  walk.steps += 1;
  walk.visitedAt[arrived] = walk.now;
}

/** The stage that follows `stage`, applying its side effects. */
function transition(walk) {
  switch (walk.stage) {
    case STAGE.ENTER:
      return STAGE.REST;
    case STAGE.REST:
      walk.exitSlot = chooseExit(walk);
      // Nowhere to go (a one-cell board, or a broken route): rest again rather
      // than aiming at nothing. The next REST re-routes.
      return walk.exitSlot < 0 ? STAGE.REST : STAGE.AIM;
    case STAGE.AIM:
      return STAGE.EXIT;
    case STAGE.EXIT:
      return STAGE.GAP;
    case STAGE.GAP:
      stepThroughGap(walk);
      return STAGE.ENTER;
    default:
      return STAGE.REST;
  }
}

/**
 * Advances the walk by `dt` seconds.
 *
 * Carries leftover time across stage boundaries, so a long frame (or a big
 * tempo) advances several stages in one call instead of stretching one.
 *
 * @param {Walk} walk
 * @param {number} dt Seconds; clamp tab-switch jumps before calling.
 * @returns {Walk} the same object, mutated.
 */
export function advanceWalk(walk, dt) {
  walk.now += dt;
  let remaining = dt;
  // Bounded so a degenerate duration can never spin here forever.
  for (let guard = 0; guard < 64 && remaining > 0; guard++) {
    const left = walk.duration - walk.elapsed;
    if (remaining < left) {
      walk.elapsed += remaining;
      remaining = 0;
      break;
    }
    remaining -= left;
    walk.stage = transition(walk);
    walk.elapsed = 0;
    walk.duration = Math.max(1e-4, stageDuration(walk, walk.stage));
  }
  walk.phase = clamp(walk.elapsed / walk.duration, 0, 1);
  return walk;
}

/**
 * Snapshot for the renderer — the uniforms the shader needs, and nothing else.
 *
 * `gapSlot` is `-1` unless the character is actually crossing, so the shader
 * can skip the gap pass entirely outside the GAP stage.
 */
export function walkUniforms(walk) {
  return {
    stage: walk.stage,
    phase: walk.phase,
    cell: walk.cell,
    entrySlot: walk.entrySlot,
    exitSlot: walk.exitSlot,
    gapSlot: walk.stage === STAGE.GAP ? walk.exitSlot : -1,
    climbFactor: walk.climbFactor,
    now: walk.now,
  };
}
