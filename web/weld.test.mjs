/** `node --test web/weld.test.mjs` */
import test from "node:test";
import assert from "node:assert/strict";
import { weldTris } from "./weld.js";

test("welds shared corners into one vertex", () => {
  // Two triangles sharing the edge (1,0,0)–(0,0,1): 6 loose corners, 4 unique.
  const tris = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 1, 0, 1, 0, 0, 1,
  ]);
  const { positions, indices } = weldTris(tris);
  assert.equal(positions.length / 3, 4);
  assert.equal(indices.length, 6);
  assert.deepEqual(indices, [0, 1, 2, 1, 3, 2]);
});

test("ignores a trailing partial triangle and handles an empty stream", () => {
  assert.deepEqual(weldTris(new Float32Array([])), { positions: [], indices: [] });
  const { indices } = weldTris(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 5]));
  assert.equal(indices.length, 3);
});
