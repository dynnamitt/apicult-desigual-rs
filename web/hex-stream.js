// hex-stream.js — streaming-cluster state machine and pure helpers.
// Browser + Node compatible: imports nothing from `three` or `./pkg/*`.
// WasmLayout is always passed in; never imported here.

export const axialKey = ({ q, r }) => `${q},${r}`;

// 6 axial neighbor offsets, indexed by hex direction d ∈ 0..5.
// d=0 is +x ("right"), CCW from there: matches petal placement angles d*60°.
export const AXIAL_NEIGHBORS = [
  { q:  1, r:  0 },
  { q:  0, r:  1 },
  { q: -1, r:  1 },
  { q: -1, r:  0 },
  { q:  0, r: -1 },
  { q:  1, r: -1 },
];

const NEIGHBOR_LOOKUP = new Map(
  AXIAL_NEIGHBORS.map((n, d) => [axialKey(n), d]),
);

// Returns dir index 0..5 if {q, r} is a unit hex neighbor offset; null otherwise.
export const axialDirToSide = (delta) => {
  const idx = NEIGHBOR_LOOKUP.get(axialKey(delta));
  return idx === undefined ? null : idx;
};

// Petal-axial (q, r) → world (x, z). Each unit step in petal-axial is one
// petal-spacing in the world. The basis is petal-dir-0 along +x and
// petal-dir-1 at +60° (CCW), giving the standard pointy-top axial → cartesian
// transform scaled by petalSpacing.
export const petalAxialToWorld = ({ q, r }, petalSpacing) => ({
  x: petalSpacing * (q + r / 2),
  z: petalSpacing * (r * Math.sqrt(3) / 2),
});

// Cheap reversible mixer. Same shape as the splitmix32 already in
// hex-terrain-scene.js (kept here as a self-contained copy so this module has
// zero browser-only deps and is Node-testable).
const splitmix32 = (s) => {
  s = (s + 0x9E3779B9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35) >>> 0;
  return (s ^ (s >>> 16)) >>> 0;
};

const randomU32 = () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

// Hash (worldSeed, q, r) into a stable pair of u32 seeds: one for the height
// channel, one for the radius channel. With worldSeed=null we fall back to
// fresh randomness per call (the current showcase behavior — non-reproducible).
export const seedForCell = (worldSeed, q, r) => {
  if (worldSeed === null || worldSeed === undefined) {
    return [randomU32(), randomU32()];
  }
  const w = worldSeed >>> 0;
  // Pack (q, r) into a single u32. The mask + shift loses information for
  // |q| or |r| > 2^15, but that is far beyond any realistic streaming run
  // and the splitmix32 cascade still produces well-distributed outputs.
  const packed = ((q & 0xFFFF) << 16) | (r & 0xFFFF);
  return [
    splitmix32(splitmix32(w ^ packed)),
    splitmix32(splitmix32((w + 1) ^ packed)),
  ];
};

// 7-cell footprint of a cluster anchored at `anchor`: anchor itself plus the
// 6 unit neighbors. Returned as a Set<axialKey> for O(1) intersection.
export const clusterFootprint = (anchor) => {
  const fp = new Set();
  fp.add(axialKey(anchor));
  for (const n of AXIAL_NEIGHBORS) {
    fp.add(axialKey({ q: anchor.q + n.q, r: anchor.r + n.r }));
  }
  return fp;
};

// Set diff of old footprint vs new footprint. Returns:
//   spawn:   axial coords {q, r} that are in new but not old (3 of them)
//   despawn: axial keys (strings) that are in old but not new (3 of them)
//   survive: axial coords {q, r} that are in both (4 of them)
// Note: this is the raw set-diff; StreamingCluster.tick exposes the same
// data to the scene under the past-tense names `spawned` / `despawned`.
// The plural shapes are intentionally distinct: this layer is pure math,
// the cluster's return is a step-result.
// Caller passes both anchors; this function recomputes both footprints.
export const axialDiff = (oldAnchor, newAnchor) => {
  const oldFp = clusterFootprint(oldAnchor);
  const newFpCells = [
    newAnchor,
    ...AXIAL_NEIGHBORS.map((n) => ({
      q: newAnchor.q + n.q,
      r: newAnchor.r + n.r,
    })),
  ];
  const newFpKeys = new Set(newFpCells.map(axialKey));

  const spawn = newFpCells.filter((c) => !oldFp.has(axialKey(c)));
  const survive = newFpCells.filter((c) => oldFp.has(axialKey(c)));
  const despawn = [...oldFp].filter((k) => !newFpKeys.has(k));
  return { spawn, despawn, survive };
};

// Streaming-cluster state machine. Owns the axial map of live tiles, the
// integration accumulator, and the step-trigger / spawn-despawn diff. Holds
// no Three.js objects: returns plain ClusterTile records and lets the scene
// translate them into renderable trios.
//
// `seamFn` is injected so unit tests can pass a no-op while the browser
// passes seamSpecForCell from hex-seam.js. Default no-op makes constructor
// usable without seam plumbing for the diff-only test surface.
export class StreamingCluster {
  constructor({
    worldSeed,
    radius,
    nominalHexRadius,
    petalDistanceFactor,
    dirIndex,
    WasmLayout,
    seamFn = () => ({ overrides: [], entangle: [] }),
  }) {
    this.worldSeed = worldSeed;
    this.radius = radius;
    this.nominalHexRadius = nominalHexRadius;
    this.petalDistanceFactor = petalDistanceFactor;
    this.dirIndex = dirIndex;
    this.WasmLayout = WasmLayout;
    this.seamFn = seamFn;

    this.petalSpacing = petalDistanceFactor * radius * nominalHexRadius;
    this.anchor = { q: 0, r: 0 };
    this.accumulator = 0;
    this.tiles = new Map();  // axialKey → ClusterTile
  }

  setDirection(dirIndex) {
    this.dirIndex = dirIndex;
    this.accumulator = 0;
  }

  // Returns null if no step boundary crossed this frame; otherwise an object
  // { spawned, despawned } merging every step that fits in the elapsed time.
  // The while-loop guards against tab-catch-up frames (browser hidden, GC
  // pause) where dt can spike high enough to span multiple petalSpacings —
  // a single-step tick would silently drop visited cells in that case.
  tick(dt, speed) {
    if (speed === 0) return null;
    this.accumulator += speed * dt;
    if (this.accumulator < this.petalSpacing) return null;
    const spawned = [];
    const despawned = [];
    while (this.accumulator >= this.petalSpacing) {
      const diff = this.performStep();
      spawned.push(...diff.spawned);
      despawned.push(...diff.despawned);
    }
    return { spawned, despawned };
  }

  // Build the initial 7 tiles centered on (0, 0). Returns the tile array so
  // the scene can attach Three objects per tile. Each tile's wasm layout is
  // already constructed and stored in the tiles map by the time we return.
  bootstrap() {
    const cells = [
      this.anchor,
      ...AXIAL_NEIGHBORS.map((n) => ({
        q: this.anchor.q + n.q,
        r: this.anchor.r + n.r,
      })),
    ];
    // Center first, then petals in CCW order. Each new tile may seam against
    // any already-built tile (center seams to nothing; petal d seams to
    // center + petal d-1; petal 5 closes the ring against petal 0).
    // buildTile returns null on wasm-alloc failure (logged); skip those — a
    // failed bootstrap leaves a partial cluster but doesn't kill the loop.
    const result = [];
    for (const cell of cells) {
      const tile = this.buildTile(cell);
      if (tile === null) continue;
      result.push(tile);
      this.tiles.set(axialKey(cell), tile);
    }
    return result;
  }

  // Accumulator already crossed one petal-spacing. Compute the diff, despawn
  // the 3 trailing tiles (free wasm handles), build the 3 leading tiles in
  // mutual-neighbor-aware order so seamSpecForCell finds every existing
  // sibling. Returns { spawned: ClusterTile[], despawned: axialKey[] } for
  // the scene to apply.
  performStep() {
    this.accumulator -= this.petalSpacing;
    const step = AXIAL_NEIGHBORS[this.dirIndex];
    const newAnchor = {
      q: this.anchor.q + step.q,
      r: this.anchor.r + step.r,
    };

    const diff = axialDiff(this.anchor, newAnchor);
    this.anchor = newAnchor;

    // Despawn first so seamSpecForCell during spawn doesn't accidentally pull
    // from a tile that's about to disappear.
    const despawned = [];
    for (const key of diff.despawn) {
      const tile = this.tiles.get(key);
      tile.wasmHandle.free();
      this.tiles.delete(key);
      despawned.push(key);
    }

    // Sort the 3 spawn targets so the one with the most existing-tile
    // neighbors is built first; that lets later spawns in the same step
    // chain through it. (Two of the three spawns are mutual neighbors.)
    const sortedSpawn = [...diff.spawn].sort((a, b) =>
      this.countExistingNeighbors(b) - this.countExistingNeighbors(a),
    );

    // Per spec error-handling: a wasm allocation failure during a spawn is
    // logged and skipped, leaving the cluster degraded for one step rather
    // than killing the animation loop. The next tick's diff will retry.
    const spawned = [];
    for (const cell of sortedSpawn) {
      const tile = this.buildTile(cell);
      if (tile === null) continue;
      this.tiles.set(axialKey(cell), tile);
      spawned.push(tile);
    }

    return { spawned, despawned };
  }

  countExistingNeighbors(cell) {
    let n = 0;
    for (const off of AXIAL_NEIGHBORS) {
      if (this.tiles.has(axialKey({ q: cell.q + off.q, r: cell.r + off.r }))) n++;
    }
    return n;
  }

  // Construct a single ClusterTile, seaming against whatever is already in
  // this.tiles. Caller is responsible for inserting the tile into the map
  // *after* this returns (so seamSpecForCell doesn't see the tile-being-built
  // as its own neighbor — though the math would tolerate it).
  //
  // Returns null on wasm allocation failure (per spec: log + skip, let the
  // next step retry). Caller must skip null tiles.
  buildTile(cell) {
    const [hSeed, rSeed] = seedForCell(this.worldSeed, cell.q, cell.r);
    const seamArgs = {
      myAxial: cell,
      existingTiles: this.tiles,
      radius: this.radius,
      WasmLayout: this.WasmLayout,
    };
    const { overrides, entangle } = this.seamFn(seamArgs);
    let wasmHandle;
    try {
      wasmHandle = new this.WasmLayout(
        this.radius, hSeed, rSeed, overrides, entangle,
      );
    } catch (e) {
      console.error(`buildTile failed at axial (${cell.q},${cell.r}):`, e);
      return null;
    }
    return {
      axial: cell,
      worldPos: petalAxialToWorld(cell, this.petalSpacing),
      payload: {
        tris: wasmHandle.tris(false),
        wireEdges: wasmHandle.wire_edges(false),
        label: axialKey(cell),
      },
      threeObjs: null,
      wasmHandle,
    };
  }

  dispose() {
    for (const tile of this.tiles.values()) tile.wasmHandle.free();
    this.tiles.clear();
  }
}
