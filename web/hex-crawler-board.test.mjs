/**
 * `node --test web/hex-crawler-board.test.mjs`
 *
 * Drives the board builder against `hex-crawler-fixture.mjs`, which synthesizes
 * the flat-top lattice `HGridLayout` would emit — bit-exact shared corners and
 * all — so the attribute layout, the derived tri↔edge offset and the neighbour
 * table are all checked without a wasm build.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCellGraph } from "./hex-units-grid.js";
import {
  BRIDGE_SLOT_STRIDE,
  FLOATS_PER_BASE_VERTEX,
  FLOATS_PER_HEX_BRIDGES,
  FLOATS_PER_VERTEX,
  buildBoard,
  slotBetween,
} from "./hex-crawler-board.js";
import { fixture } from "./hex-crawler-fixture.mjs";

const boardOf = (fx) => buildBoard(fx, buildCellGraph(fx.faceTris));

test("derives the fan-tri to bridge-slot offset, whatever it is", () => {
  for (const slotShift of [0, 1, 2, 3, 4, 5]) {
    const board = boardOf(fixture(2, { slotShift }));
    assert.equal(board.slotOffset, slotShift, `slotShift ${slotShift}`);
  }
});

test("throws rather than guessing when the offset is inconsistent", () => {
  const fx = fixture(2);
  // Corrupt one hex's slot 0 corners so it matches no fan tri, then move a
  // valid quad into a slot that disagrees with every other hex.
  const good = fx.bridges.slice(
    1 * FLOATS_PER_HEX_BRIDGES,
    1 * FLOATS_PER_HEX_BRIDGES + BRIDGE_SLOT_STRIDE,
  );
  fx.bridges.set(good, 1 * FLOATS_PER_HEX_BRIDGES + 2 * BRIDGE_SLOT_STRIDE);
  assert.throws(() => boardOf(fx), /inconsistent fan-tri\/bridge-slot offset/);
});

test("emits each gap quad once, not once per adjacent hex", () => {
  const fx = fixture(2);
  const board = boardOf(fx);
  let flagged = 0;
  for (let h = 0; h < board.hexCount; h++) {
    for (let s = 0; s < 6; s++) {
      if (fx.bridges[h * FLOATS_PER_HEX_BRIDGES + s * BRIDGE_SLOT_STRIDE] === 1) flagged++;
    }
  }
  assert.equal(board.hexCount, 19);
  assert.equal(flagged, 42 * 2, "the wasm stream reports every edge from both sides");
  // Coincident duplicates would overdraw a lit crossing, since nothing here
  // depth-tests or blends.
  assert.equal(board.vertexCount, 19 * 18 + 42 * 6, "one quad per interior edge");
  assert.equal(board.vertices.length, board.vertexCount * FLOATS_PER_VERTEX);
  assert.equal(board.base.length, board.baseVertexCount * FLOATS_PER_BASE_VERTEX);

  // Every gap carries both endpoints, and every adjacent pair appears exactly once.
  const CELL = 2, CELL_B = 3;
  const seen = new Set();
  for (let v = board.hexCount * 18; v < board.vertexCount; v += 6) {
    const a = board.vertices[v * FLOATS_PER_VERTEX + CELL];
    const b = board.vertices[v * FLOATS_PER_VERTEX + CELL_B];
    assert.ok(a >= 0 && b >= 0, "a gap knows both cells it joins");
    assert.ok(b > a, "owned by the lower-indexed hex");
    assert.equal(board.neighborOf[a * 6 + board.vertices[v * FLOATS_PER_VERTEX + 4]], b);
    const key = `${a},${b}`;
    assert.ok(!seen.has(key), `gap ${key} emitted twice`);
    seen.add(key);
  }
  assert.equal(seen.size, 42);
});

test("hex faces carry no second cell", () => {
  const board = boardOf(fixture(2));
  for (let v = 0; v < board.hexCount * 18; v++) {
    assert.equal(board.vertices[v * FLOATS_PER_VERTEX + 3], -1);
  }
});

test("weights follow the terrain page's convention", () => {
  const board = boardOf(fixture(1));
  const at = (v, f) => board.vertices[v * FLOATS_PER_VERTEX + f];
  const KIND = 5, WEIGHT = 6;

  // Hex faces: 1.0 at the fan centre, 0.0 at both rim corners.
  for (let v = 0; v < board.hexCount * 18; v += 3) {
    assert.equal(at(v, KIND), 0);
    assert.deepEqual([at(v, WEIGHT), at(v + 1, WEIGHT), at(v + 2, WEIGHT)], [1, 0, 0]);
  }
  // Gap quads: 0 on the source side (q0/q3), 1 on the neighbour side (q1/q2),
  // split on the [q0, q2] diagonal.
  for (let v = board.hexCount * 18; v < board.vertexCount; v += 6) {
    assert.equal(at(v, KIND), 1);
    const got = Array.from({ length: 6 }, (_, i) => at(v + i, WEIGHT));
    assert.deepEqual(got, [0, 1, 1, 0, 1, 0]);
  }
});

test("stores fan triangles in bridge-slot space", () => {
  const board = boardOf(fixture(2, { slotShift: 4 }));
  const SLOT = 4;
  for (let h = 0; h < board.hexCount; h++) {
    for (let t = 0; t < 6; t++) {
      const v = (h * 6 + t) * 3;
      assert.equal(board.vertices[v * FLOATS_PER_VERTEX + SLOT], (t + 4) % 6);
    }
  }
});

test("neighbour table resolves each slot to the cell across the gap", () => {
  const fx = fixture(2, { slotShift: 3 });
  const board = boardOf(fx);
  const centre = fx.index.get("0,0");
  const slots = Array.from({ length: 6 }, (_, s) => board.neighborOf[centre * 6 + s]);

  assert.equal(slots.filter((c) => c >= 0).length, 6, "the middle hex borders six cells");
  assert.equal(new Set(slots).size, 6, "and they are six distinct cells");
  assert.ok(!slots.includes(centre), "never itself");

  const cornerCell = fx.index.get("2,0");
  const cornerSlots = Array.from({ length: 6 }, (_, s) => board.neighborOf[cornerCell * 6 + s]);
  assert.equal(cornerSlots.filter((c) => c === -1).length, 3, "corner hex has 3 border edges");

  // Adjacency is mutual and slotBetween round-trips through it.
  for (let h = 0; h < board.hexCount; h++) {
    for (let s = 0; s < 6; s++) {
      const n = board.neighborOf[h * 6 + s];
      if (n < 0) continue;
      assert.ok(slotBetween(board, n, h) >= 0, "the neighbour points back");
      assert.equal(board.neighborOf[h * 6 + slotBetween(board, h, n)], n);
    }
  }
  assert.equal(slotBetween(board, centre, cornerCell), -1, "not adjacent");
});

test("carries height and world bounds for the tint and the camera fit", () => {
  const board = boardOf(fixture(2, { height: (q, r) => (q === 0 && r === 0 ? 5 : 1) }));
  assert.equal(board.maxHeight, 5);
  assert.ok(board.bounds.maxX > board.bounds.minX);
  assert.ok(board.bounds.maxZ > board.bounds.minZ);
  // Base layer drops y into the third slot, keeping (x, z) as the position.
  assert.equal(board.base[0], board.vertices[0]);
  assert.equal(board.base[1], board.vertices[1]);
});

test("a single hex with no bridges builds cleanly", () => {
  const board = boardOf(fixture(0));
  assert.equal(board.hexCount, 1);
  assert.equal(board.slotOffset, 0);
  assert.equal(board.vertexCount, 18);
  assert.ok(board.neighborOf.every((c) => c === -1));
});
