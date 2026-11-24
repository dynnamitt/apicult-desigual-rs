import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_DIRS, chunkKey, footprint, stepFootprint, chunkCenter, nearestStep,
  visibleSeamGroups,
} from "./hex-stream.js";

const ANCHOR = [2, -1];
// Any non-degenerate lattice basis; the real one comes from WasmChunk.center().
const U = [17.3, -6.0], V = [3.0, 15.5];
const PART_WAY = 0.6;
const keys = (coords) => new Set(coords.map(([q, r]) => chunkKey(q, r)));

test("footprint is the anchor plus 6 distinct neighbours", () => {
  const fp = footprint(ANCHOR);
  assert.equal(fp.length, 7);
  assert.deepEqual(fp[0], ANCHOR);
  assert.equal(keys(fp).size, 7);
});

test("stepping one chunk spawns 3, despawns 3 and keeps 4 in every direction", () => {
  const old = keys(footprint(ANCHOR));
  CHUNK_DIRS.forEach((_, d) => {
    const { anchor, spawn, despawn, keep } = stepFootprint(ANCHOR, d);
    assert.equal(spawn.length, 3, `dir ${d}`);
    assert.equal(despawn.length, 3, `dir ${d}`);
    assert.equal(keep.length, 4, `dir ${d}`);
    assert.deepEqual(keys([...keep, ...spawn]), keys(footprint(anchor)), `dir ${d}`);
    assert.deepEqual(keys([...keep, ...despawn]), old, `dir ${d}`);
  });
});

test("stepping back the opposite way restores the anchor", () => {
  CHUNK_DIRS.forEach((_, d) => {
    const there = stepFootprint(ANCHOR, d).anchor;
    assert.deepEqual(stepFootprint(there, (d + 3) % 6).anchor, ANCHOR, `dir ${d}`);
  });
});

test("nearestStep stays put at the anchor centre and steps towards a nearer neighbour", () => {
  const c = chunkCenter(ANCHOR, U, V);
  assert.equal(nearestStep(c, ANCHOR, U, V), -1);
  CHUNK_DIRS.forEach(([dq, dr], d) => {
    const n = chunkCenter([ANCHOR[0] + dq, ANCHOR[1] + dr], U, V);
    const pos = [c[0] + PART_WAY * (n[0] - c[0]), c[1] + PART_WAY * (n[1] - c[1])];
    assert.equal(nearestStep(pos, ANCHOR, U, V), d, `dir ${d}`);
  });
});

test("visibleSeamGroups hides groups whose owner is loaded", () => {
  const owners = Int32Array.from([1, 0, 5, 5, -2, 3]);
  const loaded = new Set([chunkKey(1, 0), chunkKey(-2, 3)]);
  assert.deepEqual(visibleSeamGroups(owners, loaded), [1]);
  assert.deepEqual(visibleSeamGroups(owners, new Set()), [0, 1, 2]);
});
