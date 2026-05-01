# Infinite Terrain Sim — Design

**Status:** Draft, awaiting GitHub-issue gate.
**Scope:** Web 3D demo only. Rust crate, wasm bindings, Make pipeline unchanged.
**Files touched:** `web/hex-terrain-scene.js`, `web/hex-terrain-controls.js`, `web/hex-seam.js`. New file: `web/hex-stream.js`. CSS: small additions to `web/hex-terrain.css` for the new sidebar controls.

## Goal

Convert the static 1-center + 6-petal "flower" cluster into a streaming treadmill: the cluster scrolls in one of the 6 hex directions at a constant `SPEED`, and every time accumulated motion equals one petal-spacing, 3 new layouts spawn at the leading edge (in the direction the camera is "looking forward"), 3 old layouts despawn at the trailing edge, and the 4 surviving layouts keep their geometry as-is. The viewer never sees a re-bake; the world appears continuous.

## Conventions

- "Movement direction" `D` is the hex direction the **viewer perceives travel toward**. The layouts' actual world velocity is in `-D` (the world flows past a stationary camera).
- `D` is one of 6 indices (East, NE, NW, West, SW, SE) — same indices `hex-seam.js` already uses for petal `dir`.
- "Petal-spacing" = `petalDistanceFactor * radius * nominalHexRadius` (same formula as `petalTranslation`).

## Architecture

```
hex-terrain.html
  └─ hex-terrain-scene.js   (Three setup, animate loop, dispose, group offset)
       ├─ hex-stream.js     (NEW — axial map, anchor, step diff)
       ├─ hex-seam.js       (extended — generalized neighbor lookup)
       ├─ hex-terrain.js    (unchanged — weldedMesh)
       └─ hex-terrain-shader.js (unchanged)
```

The scene gains a single `THREE.Group` (`clusterGroup`) parenting all per-tile mesh/wire/shader trios. Per-frame translation happens at the group level; per-tile transforms set once at spawn and never updated.

## Components

### `hex-stream.js` (new module)

Owns the streaming state. Exports `StreamingCluster`:

```js
new StreamingCluster({
  worldSeed,            // u32 | null
  radius,
  nominalHexRadius,
  petalDistanceFactor,
  dirIndex,             // 0..5, the movement direction D
  WasmLayout,
})
```

Internal state:
- `anchor: { q, r }` — current logical center in **petal-axial** coords (each unit = one petal-spacing).
- `tiles: Map<axialKey, ClusterTile>` — currently-live tiles keyed by axial coord.
- `accumulator: number` — scalar, distance traveled along D since last step boundary.
- `petalSpacing: number` — cached `petalDistanceFactor * radius * nominalHexRadius`.

Public methods:
- `bootstrap() → ClusterTile[]` — build the initial 7 tiles around `(0, 0)`. Returns the array so the scene can build Three objects for each.
- `tick(dt, speed) → { spawned: ClusterTile[], despawned: axialKey[] } | null` — integrate; if a step boundary is crossed, advance anchor by one petal-step in `D`, compute the set diff (always 3 in / 3 out / 4 survive), build the wasm layouts for the 3 spawns in **mutual-neighbor-aware order** (see Build order below), and return them. Otherwise return `null`.
- `setDirection(dirIndex)` — reset accumulator to 0, change `D`. (No mid-step geometry change; current 7 tiles stay.)
- `dispose()` — frees every wasm handle.

`ClusterTile` shape:
```js
{
  axial: { q, r },        // petal-axial position
  worldPos: { x, z },     // axial × petal-spacing in world frame
  payload: { tris, wireEdges, label },
  threeObjs: null,        // attached by the scene after spawn
  wasmHandle: WasmLayout, // freed on despawn
}
```

### `hex-seam.js` extension

Add a generalized seam builder that doesn't assume CCW build order:

```js
seamSpecForCell({
  myAxial,                // {q, r} in petal-axial coords (relative to cluster anchor)
  existingTiles,          // Map<axialKey, ClusterTile>
  radius,
  WasmLayout,
})
```

Walks the 6 axial neighbors of `myAxial`; for each one present in `existingTiles`, calls `seamFromNeighbor` with `mySide = axialDirToSide(neighbor - me)` and `neighborSide = OPPOSITE[mySide]`. Returns `{ overrides, entangle }`.

`axialDirToSide` is a 6-entry lookup over the canonical neighbor offsets (East `(1,0)` → 0, NE `(0,1)` → 1, NW `(-1,1)` → 2, etc.). The existing `petalTranslation`, `OPPOSITE`, and `seamFromNeighbor` exports stay; the existing `seamSpec` (CCW-order specific) is preserved for the **bootstrap** path.

### Build order for the 3 new tiles per step

Two of the 3 new spawns are mutual neighbors (e.g., for `D = East`, the spawns are at `(2, 0)`, `(1, 1)`, `(2, -1)` — and `(2, 0)` is adjacent to both of the others). To make sure each new tile can seam to any earlier-built sibling that already exists, build them in this order: **(1) the spawn that has the most surviving-tile neighbors, (2) the next one with the most neighbors among already-built spawns, (3) the rest.** Each newly-built tile is added to the streaming cluster's `tiles` map before the next one is built, so `seamSpecForCell` naturally finds it.

### `hex-terrain-scene.js` changes

- Replace `payloads: []` and `objs: []` with `cluster: StreamingCluster` and `clusterGroup: THREE.Group`.
- Coordinate model: **axial keys are absolute, never re-zeroed.** Each tile's local position inside the group is fixed at its `axial × petalSpacing` for the entire life of the tile. The group's position drifts in `-D` indefinitely. There is **no counter-shift** at step boundaries — the group keeps drifting smoothly, surviving tiles keep their fixed local positions, and newly-spawned tiles get placed at their absolute `axial × petalSpacing`. This keeps the math trivial; the only cost is unbounded float magnitudes over very long runs (see "Out of scope" / float-precision note).
- `buildCluster()` becomes:
  1. `const tiles = cluster.bootstrap();`
  2. For each tile: `tile.threeObjs = buildClusterObjects({...})`, position the trio at `tile.worldPos` (= axial × petalSpacing), add to `clusterGroup`.
  3. `scene.add(clusterGroup)`.
- New per-frame logic (replaces the orbit-only loop):
  ```js
  const v = directionVector(state.dirIndex);  // unit vec in -D world frame
  clusterGroup.position.x += v.x * speed * dt;
  clusterGroup.position.z += v.z * speed * dt;

  const result = cluster.tick(dt, speed);
  if (result) {
    for (const key of result.despawned) disposeAndRemove(scene, key);
    for (const tile of result.spawned) {
      tile.threeObjs = buildClusterObjects({...});
      positionTile(tile, clusterGroup);   // tile.worldPos = absolute axial × petalSpacing
    }
    // No counter-shift: surviving tiles already at correct local positions,
    // new tiles placed in the same absolute frame, group keeps drifting.
  }
  ```
- `frameCamera()` runs only at mount. From then on the camera is parked.

### `hex-terrain-controls.js` additions

- New range slider: **`speed`** (world units / sec, default 0 = paused, max ~5).
- New 6-way picker: **`direction`** — radio group or segmented control with the labels from `VERTEX_DIR_NAMES`.

Both are `liveProps` (no full `regenerate`); changes call `cluster.setDirection(...)` or just update `state.speed`.

## Data flow per frame

```
animate(dt):
  applyResize()
  velocity = directionVector(dirIndex)         // unit vector in -D
  clusterGroup.position += velocity * speed * dt

  diff = cluster.tick(dt, speed)
  if diff:
    despawn 3 trios (dispose Three objects + wasm free)
    spawn 3 trios in mutual-neighbor-aware order
      (each new wasm layout via seamSpecForCell against surviving + already-built siblings)
    place each new trio at its absolute axial × petalSpacing inside clusterGroup

  shader/wire dash uniforms update (existing)
  composer.render()
```

## Determinism / seeds

```js
seedForCell(worldSeed, q, r) → [hSeed, rSeed]
```

If `worldSeed === null`: `[randomU32(), randomU32()]` (current showcase behavior; not reproducible).
Otherwise: deterministic via `splitmix32` over `(worldSeed, q, r)`. Two seeds per cell (height + radius), keyed off `worldSeed` and `worldSeed + 1` respectively, so panning a direction then reversing brings back the same terrain when reproducible.

## Error handling

- Wasm allocation failure during a spawn: `console.error` and skip. Cluster runs degraded for one step (4–6 tiles visible) until next step retries. No retry inside `tick` — the next tick brings a fresh diff.
- Direction change mid-flight: `setDirection` zeros the accumulator. Existing tiles stay; the next step boundary is now in the new direction.
- `speed === 0`: tick still runs but accumulator doesn't advance; effectively pauses streaming. Direction picker still works but has no visible effect until speed > 0.

## Testing

### Pure-function unit tests (in a new `web/test/hex-stream.test.js`, run with `node --test`)

- `seedForCell(seed, q, r)` is stable and distinct per (q, r).
- `axialDirToSide` round-trips with `OPPOSITE` for all 6 directions.
- `axialDiff(oldFootprint, newFootprint)` returns `{ spawn: 3, despawn: 3, survive: 4 }` for every starting anchor and every D ∈ 0..5.
- Petal-axial → world-XZ converter agrees with `petalTranslation` at integer axial coords.

### Integration (manual, one-time at PR review)

- Open the demo, set `speed = 2`, eyeball: no flicker / no jump at step boundaries.
- Toggle direction mid-flight: cluster keeps existing tiles, accumulator visibly resets, next step is in new direction.
- Set a fixed `worldSeed`, scroll East ten steps then West ten steps: terrain reappears identical.
- Verify Rust crate still builds: `cargo test` — no Rust changes, so should be a no-op.

## Out of scope (v1)

- Keyboard / WASD input. Direction is a UI knob only.
- Camera follow modes other than parked-on-origin.
- Cluster sizes other than 1+6.
- Diagonal / multi-direction motion. `D` is always one of 6 hex axes at any moment.
- Persisting `worldSeed` across page reloads beyond the existing sidebar field.
- **Float-precision rebasing.** Because group position drifts in `-D` forever, after very long runs (say, hours of streaming) shading / shadow buffers may degrade due to large world-space coordinates. v2 can periodically subtract a constant from every tile's local position and the group's position simultaneously, which is invisible to the viewer. Not addressed in v1; the demo's intended use is short-to-medium sessions.
