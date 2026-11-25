import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_DIRS, chunkKey, footprint, stepFootprint, chunkCenter, nearestStep,
  visibleSeamGroups, duplicateTris, advancePos, clampChunkRadius, MAX_FRAME_DT, MAX_CHUNK_RADIUS,
  advanceFade, ageGhost, FADE_IN_S, FADE_OUT_S, GHOST_ALPHAS, chunkHash,
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
  // No `also`: the key repeats the owner.
  const keys = Int32Array.from([1, 0, 1, 0, 5, 5, 5, 5, -2, 3, -2, 3]);
  const loaded = new Set([chunkKey(1, 0), chunkKey(-2, 3)]);
  assert.deepEqual(visibleSeamGroups(keys, [0, 0], loaded), [1]);
  assert.deepEqual(visibleSeamGroups(keys, [0, 0], new Set()), [0, 1, 2]);
});

test("visibleSeamGroups follows the corner tie-break table", () => {
  // Corner tri owned by X = (1, -1), touching A = (0, 0) < B = (1, 0).
  const A = [0, 0], B = [1, 0], X = [1, -1];
  const inA = [...X, ...B], inB = [...X, ...A];
  const drawers = (...on) => {
    const loaded = new Set(on.map((c) => chunkKey(...c)));
    return [[A, inA], [B, inB]].filter(([c, k]) => loaded.has(chunkKey(...c)) && visibleSeamGroups(k, c, loaded).length);
  };
  const names = (...on) => drawers(...on).map(([c]) => (c === A ? "A" : "B"));
  assert.deepEqual(names(X, A, B), []);
  assert.deepEqual(names(A), ["A"]);
  assert.deepEqual(names(B), ["B"]);
  assert.deepEqual(names(A, B), ["A"]);
  assert.deepEqual(names(), []);
});

test("duplicateTris counts exact repeats across buffers", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8], u = t.map((x) => x + 0.5);
  assert.equal(duplicateTris([Float32Array.from([...t, ...u])]), 0);
  assert.equal(duplicateTris([Float32Array.from(t), Float32Array.from([...u, ...t])]), 1);
  assert.equal(duplicateTris([]), 0);
});

test("advancePos caps a long frame so a backgrounded tab doesn't replay hours of steps", () => {
  const speed = 10;
  const [x, z] = advancePos([0, 0], [3, 4], speed, 3600);
  assert.ok(Math.abs(Math.hypot(x, z) - speed * MAX_FRAME_DT) < 1e-9);
  const [x1, z1] = advancePos([1, 1], [0, 2], speed, 0.05);
  assert.ok(Math.abs(x1 - 1) < 1e-9 && Math.abs(z1 - 1.5) < 1e-9);
});

test("advancePos settles onto the rail, so a direction change doesn't zig-zag the anchor", () => {
  // Off the row of centres by 0.4 chunk spacings (inside the zig-zag band) heading +q.
  const dir = chunkCenter(CHUNK_DIRS[0], U, V);
  const side = chunkCenter(CHUNK_DIRS[1], U, V);
  let pos = side.map((s) => s * 0.4), anchor = [0, 0];
  const taken = [];
  for (let i = 0; i < 2000; i += 1) {
    pos = advancePos(pos, dir, 20, 1 / 60, chunkCenter(anchor, U, V));
    for (let d = nearestStep(pos, anchor, U, V); d !== -1; d = nearestStep(pos, anchor, U, V)) {
      anchor = [anchor[0] + CHUNK_DIRS[d][0], anchor[1] + CHUNK_DIRS[d][1]];
      taken.push(d);
    }
  }
  assert.ok(taken.length > 10);
  assert.ok(taken.slice(-10).every((d) => d === 0), `tail of steps: ${taken.slice(-10)}`);
});

test("advanceFade: spawns fade in first, despawns wait for them then fade out faster", () => {
  const run = (f, secs) => {
    const n = Math.round(secs / 0.01);
    return Array.from({ length: n }).reduce((g) => advanceFade(g, 0.01), f);
  };
  const spawn = { alpha: 0, target: 1, delay: 0 }, despawn = { alpha: 1, target: 0, delay: FADE_IN_S };
  assert.ok(FADE_OUT_S < FADE_IN_S);
  assert.ok(Math.abs(run(spawn, FADE_IN_S / 2).alpha - 0.5) < 1e-6);
  assert.equal(run(spawn, FADE_IN_S).alpha, 1);
  assert.ok(run(despawn, FADE_IN_S).alpha > 1 - 1e-9, "despawn still solid while spawns fade in");
  assert.equal(run(despawn, FADE_IN_S + FADE_OUT_S).alpha, 0);
  // One long frame spends the rest of the delay, then fades with what is left.
  assert.ok(Math.abs(advanceFade({ alpha: 1, target: 0, delay: 0.1 }, 0.1 + FADE_OUT_S / 2).alpha - 0.5) < 1e-9);
});

test("advanceFade: stops at a ghost's partial target, and a ghost can fade back in", () => {
  const [first, second] = GHOST_ALPHAS;
  const ghost = advanceFade({ alpha: 1, target: first, delay: 0 }, 10);
  assert.equal(ghost.alpha, first);
  assert.equal(advanceFade({ ...ghost, target: second }, 10).alpha, second);
  assert.equal(advanceFade({ ...ghost, target: 1 }, 10).alpha, 1);
});

test("ageGhost: 10% → 5% → out, each stage waiting for that step's despawns", () => {
  const settle = (c) => ({ ...c, fade: advanceFade(c.fade, 10) });
  const solid = { fade: { alpha: 1, target: 1, delay: 0 }, ghost: 0 };
  const stages = [1, 2, 3].reduce((acc) => [...acc, settle(ageGhost(acc.at(-1)))], [solid]);
  assert.deepEqual(stages.map((c) => c.fade.alpha), [1, ...GHOST_ALPHAS, 0]);
  assert.equal(ageGhost(solid).fade.delay, FADE_IN_S, "a fresh despawn waits for the spawns");
  assert.equal(ageGhost(stages[1]).fade.delay, FADE_IN_S, "a settled ghost fades with the new despawns");
});

test("ageGhost: steps faster than FADE_IN_S still get every ghost out", () => {
  // A step every 0.1 s, about radius-0 chunks at speed 60: no ghost may linger.
  const STEP_S = 0.1;
  const end = Array.from({ length: 40 }).reduce((c) => {
    const aged = ageGhost(c);
    return { ...aged, fade: advanceFade(aged.fade, STEP_S) };
  }, { fade: { alpha: 1, target: 1, delay: 0 }, ghost: 0 });
  assert.equal(end.fade.alpha, 0);
});

test("ageGhost: never fades a chunk up, so one despawned before it showed stays hidden", () => {
  const unseen = ageGhost({ fade: { alpha: 0, target: 1, delay: 0 }, ghost: 0 });
  assert.equal(unseen.fade.target, 0);
  assert.equal(advanceFade(unseen.fade, 10).alpha, 0);
});

test("chunkHash is stable, u32, and differs across a chunk's neighbours", () => {
  assert.equal(chunkHash(...ANCHOR), chunkHash(...ANCHOR));
  const hashes = footprint(ANCHOR).map(([q, r]) => chunkHash(q, r));
  assert.equal(new Set(hashes).size, 7);
  assert.ok(hashes.every((h) => Number.isInteger(h) && h >= 0 && h < 2 ** 32));
  assert.notEqual(chunkHash(1, -1), chunkHash(-1, 1));
  assert.notEqual(chunkHash(2, 3), chunkHash(3, 2));
});

test("clampChunkRadius keeps typed values inside 0..MAX_CHUNK_RADIUS", () => {
  assert.equal(clampChunkRadius(-1), 0);
  assert.equal(clampChunkRadius(NaN), 0);
  assert.equal(clampChunkRadius(99), MAX_CHUNK_RADIUS);
  assert.equal(clampChunkRadius(3), 3);
});
