# The units demo (`hex-units.html`)

A second web page, next to the three.js terrain viewer, that puts the same
wasm geometry under a **game engine** instead of a renderer: Babylon.js scene
graph, per-frame update loop, and mouse picking, with agents pathfinding across
the hex grid.

## Why Babylon, and why a `<script>` tag

The terrain page loads three.js as an ES module through an importmap, because
three ships a single-file `three.module.js`. Babylon has no equivalent: the
modular `@babylonjs/core` package is hundreds of ES modules that assume a
bundler, and this repo's preview pipeline is deliberately bundler-free (`make
preview` is `sed` + `cp`). So the page loads the UMD bundle from jsDelivr and
reads the `BABYLON` global:

```html
<script src="https://cdn.jsdelivr.net/npm/babylonjs@8/babylon.js"></script>
```

Classic scripts run before module scripts, so `window.BABYLON` is set by the
time the page's own module executes. It is pinned to the 8.x line rather than
an exact patch. The cost is bundle size — the UMD build is a few MB, versus
three's ~600 KB — which is the honest trade for getting an engine (scene graph,
`TransformNode` hierarchy, `GlowLayer`, picking) rather than a renderer.

If the CDN is unreachable the page fails loudly: the `<script onerror>` sets a
flag and the bootstrapper renders an `.error-msg` instead of a blank canvas.

## Handedness

`scene.useRightHandedSystem = true` is set before anything is built. The wasm
stream is right-handed with +Y up and CCW front faces (that is what the three.js
page assumes), so telling Babylon up front keeps winding, computed normals and
`TransformNode.lookAt` all consistent — the alternative is a mirrored terrain
and units that face backwards.

## Getting a walkable graph out of the wasm module

The demo needs, per hex: a world position, a terrain height, and its neighbors.
None of that needs a new wasm export.

- **Position and height** come from `face_tris(false)`. That stream is grouped
  per hex — 54 floats, being 6 centre-fan triangles — and every one of those
  triangles *starts at the fan centre*, so floats `[0..3)` of each group are the
  hex's world-space centre `(x, height, z)`.
- **Adjacency** comes from the lattice. `hex_to_world_pos` ignores the per-cell
  `radius` (only the corner offsets scale with it), so hex centres sit on an
  exact triangular lattice: neighbours are one spacing apart and the next ring
  is `sqrt(3) ≈ 1.732` times farther. `buildCellGraph` measures the smallest
  centre-to-centre distance and links everything within 1.15× of it, which
  recovers hex adjacency exactly.

The upshot is that `hex-units-grid.js` never imports an engine or the wasm
module — it takes a `Float32Array` and returns plain arrays, so its A* and its
adjacency derivation are unit-tested under plain node
(`node --test web/hex-units-grid.test.mjs`, wired into `make test`).

## Movement and the climb limit

Step cost is `1 + 4 * |Δheight| / spacing` and a step is impassable when the
height difference exceeds the **max climb** knob, so units prefer level routes
and treat noise peaks as walls. Lowering max climb visibly fences them into
basins; at very low values `reachableFrom` collapses to a handful of cells and
units simply stand still (the loop keeps retrying, it does not wedge).

Between two cells the unit interpolates position and adds a `sin(π t)` arc, so
the crossing of the gap between hexes reads as a hop rather than a slide — the
gaps in this geometry are a feature, and the units acknowledge them.

## What each engine feature is doing

| Engine feature | Used for |
| --- | --- |
| `TransformNode` hierarchy | one node per unit carrying body + nose mesh; heading and position set once on the parent |
| `onBeforeRenderObservable` | the update loop, advancing each unit by `engine.getDeltaTime()` (clamped, so a backgrounded tab doesn't teleport anyone) |
| `scene.onPointerDown` | ray picking against the terrain mesh; the hit point maps to the nearest cell and rallies the squad onto it and its neighbours |
| `GlowLayer` | bloom on the units' emissive channel, standing in for the terrain page's `UnrealBloomPass` |
| `MeshBuilder.CreateLines` | the route trails and goal markers |

## Shared with the terrain page

`weld.js` (indexed-mesh welding, see [hex-terrain.md](hex-terrain.md) for why
welding matters), `seed.js` (`splitmix32` seed fan-out) and `hex-controls.js`
(the schema-driven sidebar binder) are used by both pages; `demo.css` styles
both. Each page contributes its own schema to `hex-controls.js`, so a third page
would only add one.
