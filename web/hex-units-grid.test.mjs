/**
 * `node --test web/hex-units-grid.test.mjs`
 *
 * Exercises the cell graph against a synthetic `face_tris` buffer laid out on
 * the same flat-top lattice `hexx` produces, so the adjacency-by-distance
 * derivation is checked without a wasm build.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOATS_PER_HEX,
  buildCellGraph,
  findPath,
  reachableFrom,
} from "./hex-units-grid.js";

const SIZE = 4; // nominal hex radius
const SPACING = Math.sqrt(3) * SIZE;

/** Flat-top axial → world XZ, matching `hexx`'s `hex_to_world_pos`. */
const worldPos = (q, r) => [1.5 * SIZE * q, Math.sqrt(3) * SIZE * (r + q / 2)];

/**
 * Synthesizes a `face_tris(false)` buffer for a hexagon of the given radius.
 * Only the fan-center vertex of each triangle is read by the graph builder;
 * the perimeter corners are filled with plausible junk.
 *
 * @param {number} radius
 * @param {(q: number, r: number) => number} height
 */
function fakeFaceTris(radius, height = () => 0) {
  const coords = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      coords.push([q, r]);
    }
  }
  const buf = new Float32Array(coords.length * FLOATS_PER_HEX);
  const index = new Map();
  coords.forEach(([q, r], i) => {
    index.set(`${q},${r}`, i);
    const [x, z] = worldPos(q, r);
    const y = height(q, r);
    for (let tri = 0; tri < 6; tri++) {
      const at = i * FLOATS_PER_HEX + tri * 9;
      buf.set([x, y, z, x + 1, y, z + 1, x - 1, y, z + 1], at);
    }
  });
  return { buf, index, count: coords.length };
}

test("builds one cell per hex with the lattice spacing", () => {
  const { buf } = fakeFaceTris(2);
  const graph = buildCellGraph(buf);
  assert.equal(graph.count, 19);
  assert.ok(Math.abs(graph.spacing - SPACING) < 1e-3, `spacing ${graph.spacing}`);
});

test("recovers hex adjacency: 6 neighbors inside, 3 at the corners", () => {
  const { buf, index } = fakeFaceTris(2);
  const graph = buildCellGraph(buf);
  assert.equal(graph.neighbors[index.get("0,0")].length, 6);
  assert.equal(graph.neighbors[index.get("1,0")].length, 6);
  assert.equal(graph.neighbors[index.get("2,0")].length, 3, "corner cell");
  assert.equal(graph.neighbors[index.get("2,-1")].length, 4, "side cell");
  // Every adjacency is mutual and no cell is its own neighbor.
  graph.neighbors.forEach((nbs, a) => {
    assert.ok(!nbs.includes(a));
    nbs.forEach((b) => assert.ok(graph.neighbors[b].includes(a)));
  });
});

test("A* over flat terrain takes the straight run", () => {
  const { buf, index } = fakeFaceTris(2);
  const graph = buildCellGraph(buf);
  const path = findPath(graph, index.get("-2,0"), index.get("2,0"), 10);
  assert.equal(path.length, 5, "4 hex steps = 5 cells");
  assert.equal(path[0], index.get("-2,0"));
  assert.equal(path.at(-1), index.get("2,0"));
});

test("A* detours around a step it cannot climb", () => {
  // A single tall cell at the midpoint of the straight run.
  const { buf, index } = fakeFaceTris(2, (q, r) => (q === 0 && r === 0 ? 9 : 0));
  const graph = buildCellGraph(buf);
  const path = findPath(graph, index.get("-2,0"), index.get("2,0"), 1);
  assert.ok(path, "a route around the pillar exists");
  assert.ok(!path.includes(index.get("0,0")), "route avoids the impassable cell");
  assert.equal(path.length, 6, "one extra step to go around");
});

test("an impassable ridge cuts the grid in two", () => {
  const ridge = (q) => (q === 0 ? 9 : 0);
  const { buf, index } = fakeFaceTris(2, ridge);
  const graph = buildCellGraph(buf);
  const start = index.get("-2,0");
  assert.equal(findPath(graph, start, index.get("2,0"), 1), null);
  const reachable = reachableFrom(graph, start, 1);
  assert.equal(reachable.length, 7, "only the q < 0 half is reachable");
  assert.ok(reachable.every((i) => graph.centers[i * 3] < 0));
  // Every reachable cell is routable, which is what the goal picker relies on.
  reachable.forEach((goal) => assert.ok(findPath(graph, start, goal, 1)));
});

test("a lone cell has no neighbors and no crash", () => {
  const graph = buildCellGraph(fakeFaceTris(0).buf);
  assert.equal(graph.count, 1);
  assert.deepEqual(graph.neighbors, [[]]);
  assert.deepEqual(findPath(graph, 0, 0, 1), [0]);
});
