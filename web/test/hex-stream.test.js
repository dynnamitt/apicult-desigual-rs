import { test } from "node:test";
import assert from "node:assert/strict";
import { AXIAL_NEIGHBORS, axialDirToSide, axialKey, petalAxialToWorld } from "../hex-stream.js";

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

test("petalAxialToWorld places (1,0) at +x, no z", () => {
  const p = petalAxialToWorld({ q: 1, r: 0 }, 60);
  assert.equal(p.x, 60);
  assert.equal(p.z, 0);
});

test("petalAxialToWorld places (0,1) at 60° CCW", () => {
  const p = petalAxialToWorld({ q: 0, r: 1 }, 60);
  assert.ok(Math.abs(p.x - 30) < 1e-9);
  assert.ok(Math.abs(p.z - 60 * Math.sqrt(3) / 2) < 1e-9);
});

test("petalAxialToWorld is linear in axial", () => {
  const a = petalAxialToWorld({ q: 2, r: -1 }, 60);
  const b = petalAxialToWorld({ q: 1, r: 0 }, 60);
  const c = petalAxialToWorld({ q: 1, r: -1 }, 60);
  assert.ok(Math.abs(a.x - (b.x + c.x)) < 1e-9);
  assert.ok(Math.abs(a.z - (b.z + c.z)) < 1e-9);
});

test("petalAxialToWorld(neighbor d, 60) matches angle d*60°", () => {
  for (let d = 0; d < 6; d++) {
    const p = petalAxialToWorld(AXIAL_NEIGHBORS[d], 60);
    const angle = d * Math.PI / 3;
    assert.ok(Math.abs(p.x - 60 * Math.cos(angle)) < 1e-9, `d=${d} x`);
    assert.ok(Math.abs(p.z - 60 * Math.sin(angle)) < 1e-9, `d=${d} z`);
  }
});
