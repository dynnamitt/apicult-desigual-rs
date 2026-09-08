/**
 * `node --test web/hex-crawler-walk.test.mjs`
 *
 * Runs the crawler's state machine over the synthetic board from
 * `hex-crawler-fixture.mjs` — no Phaser, no GL, no wasm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCellGraph } from "./hex-units-grid.js";
import { buildBoard, slotBetween } from "./hex-crawler-board.js";
import { STAGE, advanceWalk, climbFactorFor, createWalk, walkUniforms } from "./hex-crawler-walk.js";
import { fixture, seededRng } from "./hex-crawler-fixture.mjs";

const CYCLE = [STAGE.ENTER, STAGE.REST, STAGE.AIM, STAGE.EXIT, STAGE.GAP];

/** A walk on a fresh board, with a deterministic RNG. */
function setup({ radius = 2, seed = 1, height, tempo = 1, climbK = 1 } = {}) {
  const fx = fixture(radius, { slotShift: 2, height });
  const graph = buildCellGraph(fx.faceTris);
  const board = buildBoard(fx, graph);
  const walk = createWalk({ board, graph, tuning: { tempo, climbK }, rng: seededRng(seed) });
  return { fx, graph, board, walk };
}

/** Steps in small slices, returning the stage sequence with repeats collapsed. */
function run(walk, seconds, dt = 1 / 60) {
  const stages = [walk.stage];
  for (let t = 0; t < seconds; t += dt) {
    advanceWalk(walk, dt);
    if (walk.stage !== stages[stages.length - 1]) stages.push(walk.stage);
  }
  return stages;
}

test("cycles enter → rest → aim → exit → gap, forever", () => {
  const { walk } = setup();
  const stages = run(walk, 12);
  assert.ok(stages.length > 10, `only saw ${stages.length} stages`);
  stages.forEach((stage, i) => {
    if (i === 0) return;
    const prev = CYCLE.indexOf(stages[i - 1]);
    assert.equal(stage, CYCLE[(prev + 1) % CYCLE.length], `after ${stages[i - 1]}`);
  });
});

test("the cell changes exactly once per cycle, at the end of the gap", () => {
  const { board, walk } = setup();
  let last = { cell: walk.cell, stage: walk.stage };
  let moves = 0;
  for (let t = 0; t < 12; t += 1 / 60) {
    advanceWalk(walk, 1 / 60);
    if (walk.cell !== last.cell) {
      moves++;
      assert.equal(last.stage, STAGE.GAP, "moved out of the gap stage");
      assert.equal(walk.stage, STAGE.ENTER, "and straight into an enter");
      assert.ok(
        slotBetween(board, last.cell, walk.cell) >= 0,
        "only ever steps to a cell it shares a gap quad with",
      );
    }
    last = { cell: walk.cell, stage: walk.stage };
  }
  assert.ok(moves >= 2, `expected several moves, got ${moves}`);
  assert.equal(moves, walk.steps);
});

test("arrives facing back the way it came", () => {
  const { board, walk } = setup();
  let from = null;
  let checked = 0;
  for (let t = 0; t < 12; t += 1 / 60) {
    const before = { cell: walk.cell, exit: walk.exitSlot };
    advanceWalk(walk, 1 / 60);
    if (walk.cell !== before.cell) {
      from = before;
      assert.equal(
        board.neighborOf[walk.cell * 6 + walk.entrySlot], from.cell,
        "entrySlot points back at the cell it left",
      );
      assert.equal(board.neighborOf[from.cell * 6 + from.exit], walk.cell);
      checked++;
    }
  }
  assert.ok(checked >= 2);
});

test("aims before it moves, and only at a real neighbour", () => {
  const { board, walk } = setup();
  let aimed = 0;
  for (let t = 0; t < 12; t += 1 / 60) {
    advanceWalk(walk, 1 / 60);
    if (walk.stage === STAGE.AIM || walk.stage === STAGE.EXIT || walk.stage === STAGE.GAP) {
      assert.ok(walk.exitSlot >= 0 && walk.exitSlot < 6, `exitSlot ${walk.exitSlot}`);
      assert.ok(board.neighborOf[walk.cell * 6 + walk.exitSlot] >= 0, "aims at an in-grid cell");
      if (walk.stage === STAGE.AIM) aimed++;
    }
  }
  assert.ok(aimed > 0);
});

test("height scales the step: uphill drags, downhill snaps, level is 1", () => {
  const { graph, board, walk } = setup({
    height: (q) => q * 2, // a constant slope across the board
  });
  const flat = setup({ height: () => 3 }).walk;

  // Find an adjacent pair going uphill and read the factor both ways.
  const [a, b] = (() => {
    for (let h = 0; h < board.hexCount; h++) {
      for (let s = 0; s < 6; s++) {
        const n = board.neighborOf[h * 6 + s];
        if (n >= 0 && graph.centers[n * 3 + 1] > graph.centers[h * 3 + 1]) return [h, n];
      }
    }
    throw new Error("no uphill pair in the fixture");
  })();

  assert.ok(climbFactorFor(walk, a, b) > 1, "uphill is slower");
  assert.ok(climbFactorFor(walk, b, a) < 1, "downhill is faster");
  assert.equal(climbFactorFor(flat, 0, 1), 1, "level ground is unscaled");
  // Symmetric: the two directions are reciprocal.
  const up = climbFactorFor(walk, a, b);
  assert.ok(Math.abs(up * climbFactorFor(walk, b, a) - 1) < 1e-9);
});

test("the climb factor stretches the gap but not the rest", () => {
  const { walk } = setup({ height: (q) => q * 2 });
  const seen = { rest: new Set(), gap: new Set() };
  for (let t = 0; t < 30; t += 1 / 60) {
    advanceWalk(walk, 1 / 60);
    if (walk.stage === STAGE.REST) seen.rest.add(walk.duration.toFixed(4));
    if (walk.stage === STAGE.GAP) seen.gap.add(walk.duration.toFixed(4));
  }
  assert.equal(seen.rest.size, 1, "rest is a fixed beat regardless of terrain");
  assert.ok(seen.gap.size > 1, "gap crossings vary with the climb");
});

test("tempo scales every stage", () => {
  const slow = setup({ tempo: 1 }).walk;
  const fast = setup({ tempo: 4 }).walk;
  advanceWalk(slow, 1 / 60);
  advanceWalk(fast, 1 / 60);
  assert.ok(Math.abs(slow.duration / fast.duration - 4) < 1e-9);
});

test("records visit times for the fading trail", () => {
  const { walk } = setup();
  assert.equal(walk.visitedAt[walk.cell], 0, "spawn cell counts as visited");
  const visitedCells = () => walk.visitedAt.reduce((n, v) => n + (v > -Infinity ? 1 : 0), 0);
  const before = visitedCells();
  run(walk, 12);
  assert.ok(visitedCells() > before, "more cells marked as it walks");
  assert.ok(walk.visitedAt[walk.cell] <= walk.now);
});

test("a big frame carries leftover time across stages instead of stalling", () => {
  const { walk } = setup();
  const stages = [];
  for (let i = 0; i < 8; i++) {
    advanceWalk(walk, 1.0); // ~2-3 stages' worth in one call
    stages.push(walk.stage);
  }
  assert.ok(new Set(stages).size > 1, "did not get stuck in one stage");
  assert.ok(walk.steps > 0, "and actually moved");
  assert.ok(walk.phase >= 0 && walk.phase <= 1);
});

test("a one-cell board rests forever rather than throwing", () => {
  const { walk } = setup({ radius: 0 });
  run(walk, 10);
  assert.equal(walk.cell, 0);
  assert.equal(walk.steps, 0);
  assert.equal(walk.exitSlot, -1);
  assert.ok([STAGE.ENTER, STAGE.REST].includes(walk.stage));
});

test("uniforms expose the gap slot only while crossing", () => {
  const { walk } = setup();
  let sawGap = false;
  for (let t = 0; t < 12; t += 1 / 60) {
    advanceWalk(walk, 1 / 60);
    const u = walkUniforms(walk);
    assert.equal(u.stage, walk.stage);
    assert.ok(u.phase >= 0 && u.phase <= 1);
    if (walk.stage === STAGE.GAP) {
      assert.equal(u.gapSlot, walk.exitSlot);
      sawGap = true;
    } else {
      assert.equal(u.gapSlot, -1);
    }
  }
  assert.ok(sawGap);
});
