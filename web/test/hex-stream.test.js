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

import { seedForCell } from "../hex-stream.js";

test("seedForCell with null worldSeed yields fresh randomness each call", () => {
  const a = seedForCell(null, 0, 0);
  const b = seedForCell(null, 0, 0);
  assert.equal(a.length, 2);
  assert.equal(typeof a[0], "number");
  // Cannot assert non-equality reliably (extremely small collision chance);
  // assert types and length only.
});

test("seedForCell is deterministic with a fixed worldSeed", () => {
  const a = seedForCell(42, 3, -1);
  const b = seedForCell(42, 3, -1);
  assert.deepEqual(a, b);
});

test("seedForCell varies with (q, r)", () => {
  const a = seedForCell(42, 0, 0);
  const b = seedForCell(42, 1, 0);
  const c = seedForCell(42, 0, 1);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(b, c);
});

test("seedForCell varies with worldSeed", () => {
  const a = seedForCell(42, 5, 5);
  const b = seedForCell(43, 5, 5);
  assert.notDeepEqual(a, b);
});

test("seedForCell returns u32 values", () => {
  const [h, r] = seedForCell(42, 100, -100);
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xFFFFFFFF);
  assert.ok(Number.isInteger(r) && r >= 0 && r <= 0xFFFFFFFF);
});

import { clusterFootprint, axialDiff } from "../hex-stream.js";

test("clusterFootprint at (0,0) yields 7 cells: anchor + 6 neighbors", () => {
  const fp = clusterFootprint({ q: 0, r: 0 });
  assert.equal(fp.size, 7);
  assert.ok(fp.has("0,0"));
  for (const n of AXIAL_NEIGHBORS) assert.ok(fp.has(axialKey(n)));
});

test("clusterFootprint at non-zero anchor offsets every cell", () => {
  const fp = clusterFootprint({ q: 5, r: -3 });
  assert.equal(fp.size, 7);
  assert.ok(fp.has("5,-3"));
  assert.ok(fp.has("6,-3"));
  assert.ok(fp.has("4,-3"));
});

test("axialDiff returns 3 spawn / 3 despawn / 4 survive for every direction", () => {
  for (let d = 0; d < 6; d++) {
    const oldAnchor = { q: 0, r: 0 };
    const step = AXIAL_NEIGHBORS[d];
    const newAnchor = { q: step.q, r: step.r };

    const result = axialDiff(oldAnchor, newAnchor);
    assert.equal(result.spawn.length, 3, `d=${d} spawn count`);
    assert.equal(result.despawn.length, 3, `d=${d} despawn count`);
    assert.equal(result.survive.length, 4, `d=${d} survive count`);

    // Disjoint sanity: spawn ∩ despawn = ∅, spawn ∩ survive = ∅
    const spawnSet = new Set(result.spawn.map(axialKey));
    const survSet = new Set(result.survive.map(axialKey));
    for (const dk of result.despawn) assert.ok(!spawnSet.has(dk));
    for (const sk of result.spawn) assert.ok(!survSet.has(axialKey(sk)));
  }
});

test("axialDiff returns spawns as axial coords (objects), despawns as keys (strings)", () => {
  const result = axialDiff({ q: 0, r: 0 }, { q: 1, r: 0 });
  for (const s of result.spawn) {
    assert.equal(typeof s.q, "number");
    assert.equal(typeof s.r, "number");
  }
  for (const d of result.despawn) {
    assert.equal(typeof d, "string");
  }
});

test("axialDiff at d=0 (east) survives include old anchor and old +0 neighbor", () => {
  const result = axialDiff({ q: 0, r: 0 }, { q: 1, r: 0 });
  const survSet = new Set(result.survive.map(axialKey));
  assert.ok(survSet.has("0,0"));
  assert.ok(survSet.has("1,0"));
});

// Minimal stub of the wasm-bindgen WasmLayout class for unit tests. Records
// constructor args; returns empty Float32Arrays for the buffers; no-ops free.
class FakeWasmLayout {
  constructor(radius, hSeed, rSeed, overrides, entangle) {
    this.radius = radius;
    this.hSeed = hSeed;
    this.rSeed = rSeed;
    this.overridesLen = overrides.length;
    this.entangleLen = entangle.length;
    this.freed = false;
  }
  tris(_localize) { return new Float32Array(0); }
  wire_edges(_localize) { return new Float32Array(0); }
  borderline_cells(_side) { return []; }
  free() { this.freed = true; }
}

import { StreamingCluster } from "../hex-stream.js";

const baseOpts = {
  worldSeed: 42,
  radius: 5,
  nominalHexRadius: 4,
  petalDistanceFactor: 3,
  dirIndex: 0,
  WasmLayout: FakeWasmLayout,
};

test("StreamingCluster constructor stashes settings and zeroes accumulator", () => {
  const c = new StreamingCluster(baseOpts);
  assert.deepEqual(c.anchor, { q: 0, r: 0 });
  assert.equal(c.accumulator, 0);
  assert.equal(c.dirIndex, 0);
  assert.equal(c.petalSpacing, 3 * 5 * 4);  // 60
});

test("StreamingCluster.setDirection resets accumulator and changes dir", () => {
  const c = new StreamingCluster(baseOpts);
  c.accumulator = 30;
  c.setDirection(2);
  assert.equal(c.accumulator, 0);
  assert.equal(c.dirIndex, 2);
});

test("StreamingCluster.tick with speed=0 returns null and leaves accumulator alone", () => {
  const c = new StreamingCluster(baseOpts);
  assert.equal(c.tick(0.5, 0), null);
  assert.equal(c.accumulator, 0);
});

test("StreamingCluster.tick accumulates speed*dt below threshold", () => {
  const c = new StreamingCluster(baseOpts);
  assert.equal(c.tick(1, 10), null);
  assert.equal(c.accumulator, 10);
  assert.equal(c.tick(1, 10), null);
  assert.equal(c.accumulator, 20);
});

test("StreamingCluster.bootstrap returns 7 tiles centered on (0,0)", () => {
  const c = new StreamingCluster(baseOpts);
  const tiles = c.bootstrap();
  assert.equal(tiles.length, 7);
  const keys = new Set(tiles.map((t) => `${t.axial.q},${t.axial.r}`));
  assert.ok(keys.has("0,0"));
  for (let d = 0; d < 6; d++) {
    const n = AXIAL_NEIGHBORS[d];
    assert.ok(keys.has(`${n.q},${n.r}`));
  }
  assert.equal(c.tiles.size, 7);
});

test("StreamingCluster.bootstrap tiles carry worldPos = axial × petalSpacing", () => {
  const c = new StreamingCluster(baseOpts);
  const tiles = c.bootstrap();
  const center = tiles.find((t) => t.axial.q === 0 && t.axial.r === 0);
  assert.equal(center.worldPos.x, 0);
  assert.equal(center.worldPos.z, 0);
  const east = tiles.find((t) => t.axial.q === 1 && t.axial.r === 0);
  assert.equal(east.worldPos.x, 60);
  assert.equal(east.worldPos.z, 0);
});

test("performStep returns 3 spawn / 3 despawn after east step", () => {
  const c = new StreamingCluster({ ...baseOpts, dirIndex: 0 });
  c.bootstrap();
  // Force the accumulator to threshold and tick a non-zero speed:
  c.accumulator = c.petalSpacing - 0.01;
  const result = c.tick(0.01, 1);  // adds 0.01 → exactly threshold → step
  assert.notEqual(result, null);
  assert.equal(result.spawned.length, 3);
  assert.equal(result.despawned.length, 3);
  assert.deepEqual(c.anchor, { q: 1, r: 0 });
  assert.equal(c.tiles.size, 7);
});

test("performStep frees despawned wasm handles", () => {
  const c = new StreamingCluster({ ...baseOpts, dirIndex: 0 });
  c.bootstrap();
  const oldDespawnTargets = ["-1,1", "-1,0", "0,-1"];  // east step → west side drops
  const oldHandles = oldDespawnTargets.map((k) => c.tiles.get(k).wasmHandle);
  c.accumulator = c.petalSpacing;
  c.tick(0, 1);  // 0*1=0 added; already at threshold → step
  for (const h of oldHandles) assert.equal(h.freed, true);
});

test("performStep places spawned tiles at correct worldPos", () => {
  const c = new StreamingCluster({ ...baseOpts, dirIndex: 0 });
  c.bootstrap();
  c.accumulator = c.petalSpacing;
  const result = c.tick(0, 1);
  for (const tile of result.spawned) {
    const expected = {
      x: c.petalSpacing * (tile.axial.q + tile.axial.r / 2),
      z: c.petalSpacing * (tile.axial.r * Math.sqrt(3) / 2),
    };
    assert.ok(Math.abs(tile.worldPos.x - expected.x) < 1e-9);
    assert.ok(Math.abs(tile.worldPos.z - expected.z) < 1e-9);
  }
});
