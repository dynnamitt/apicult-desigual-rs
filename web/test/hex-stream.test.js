import { test } from "node:test";
import assert from "node:assert/strict";
import { AXIAL_NEIGHBORS, axialDirToSide, axialKey } from "../hex-stream.js";

test("axialKey serializes (q,r) deterministically", () => {
  assert.equal(axialKey({ q: 0, r: 0 }), "0,0");
  assert.equal(axialKey({ q: 2, r: -1 }), "2,-1");
});

test("AXIAL_NEIGHBORS lists 6 unit offsets in dir order", () => {
  assert.equal(AXIAL_NEIGHBORS.length, 6);
  assert.deepEqual(AXIAL_NEIGHBORS[0], { q: 1, r: 0 });
  assert.deepEqual(AXIAL_NEIGHBORS[3], { q: -1, r: 0 });
});

test("axialDirToSide maps each unit offset to its dir index", () => {
  for (let d = 0; d < 6; d++) {
    assert.equal(axialDirToSide(AXIAL_NEIGHBORS[d]), d);
  }
});

test("axialDirToSide returns null for non-unit offsets", () => {
  assert.equal(axialDirToSide({ q: 2, r: 0 }), null);
  assert.equal(axialDirToSide({ q: 0, r: 0 }), null);
});
