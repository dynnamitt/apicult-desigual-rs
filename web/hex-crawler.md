# The crawler demo (`hex-crawler.html`)

The third demo page, and the one that inverts the other two. `hex-terrain.html`
and `hex-units.html` both draw the grid and put *things* on top of it. Here there
is no sprite at all: the character **is** the fill. It occupies one hex or one
gap quad completely, and it moves by draining out of one shape and pouring into
the next, using the grid's own triangles as the animation primitive.

## The cycle

```
  ENTER ──▶ REST ──▶ AIM ──▶ EXIT ──▶ GAP ──▶ ENTER (next cell)
```

- **ENTER** — the fill fans out from the triangle at the door it came through:
  that one, then its two neighbours, then theirs, then the far one.
- **REST** — the character fully fills the hex.
- **AIM** — the triangle it is about to leave through shades orange, so the
  choice is telegraphed a beat before the move.
- **EXIT** — the fill collapses inward with the exit triangle emptying *last*,
  so the character visibly pours out through the door it picked.
- **GAP** — the gap quad fills and yellow bands sweep across it.

`hex-crawler-walk.js` owns that machine and publishes only a stage name and a
`phase` in `0..1`; the shader does the rest. It has no Phaser, no GL and no wasm
in it, so the whole cycle is unit-tested under plain node.

## Height is speed, not a wall

Every in-grid step is legal. A step's whole duration is scaled by
`exp(climbK · Δheight / spacing)` — symmetric and monotone, so climbing drags,
descending snaps, and level ground is exactly 1. The yellow bands inherit the
same rate, so an uphill gap visibly crawls and the gap itself telegraphs the cost
before the character is committed to it.

Routing reuses `hex-units-grid.js` **untouched**: `findPath` with an infinite
climb limit makes every neighbour passable, while its existing
`1 + 4·|Δh|/spacing` step cost still prefers level ground. The crawler therefore
follows contours by default and only grinds over a ridge when its target is on
the other side.

## No new wasm exports

Everything comes out of the three streams that already exist.

- **Hex faces** are `face_tris(false)`, grouped 54 floats per hex.
- **Gaps** are `face_bridge_quads(false)`, 6 slots × 13 floats
  (`[flag, q0, q1, q2, q3]`), unpacked exactly as
  `hex-terrain-shader.js::bridgeGeometry` does — split on the canonical
  `[q0, q2]` diagonal, weights `0` on the source side and `1` on the neighbour
  side.
- **The dim base layer** is `tris(false)`, which already carries the 3-hex
  junction triangles that neither per-hex stream reports — so no `gap_tris()`
  export was needed just to draw a complete board.
- **Cell centres and adjacency** come from `hex-units-grid.js::buildCellGraph`,
  as on the units page.

`aWeight` follows the convention the terrain page's ring overlay established:
`1.0` at the fan centre, `0.0` at the rim. In a gap it doubles as the band
coordinate, so the bands need no attribute of their own.

## Two things that had to be got right

**The tri↔edge offset.** A hex's 6 fan triangles and its 6 bridge slots are both
indexed `0..5`, but off different `hexx` direction tables — `VertexDirection` for
corners, `EdgeDirection` for bridges — so fan triangle `t` may sit on bridge slot
`t + k`. Guessing `k` wrong sends the character out of a different door than the
one it aimed at, silently. `buildBoard` derives it instead: the Rust side
guarantees a slot's source-side corners are *bit-exact* the rim corners of the
fan triangle on that edge (both go through `HGridLayout::vertex`), so matching
those pairs by exact float equality recovers `k`, and any disagreement between
hexes throws rather than rendering something subtly wrong.

**One quad per gap.** `face_bridge_quads` applies no ownership rule — it reports
every face edge of every hex, so each interior gap arrives twice, as two exactly
coincident quads. With no depth test and no blending, the second copy overdraws
the first, which made the character *disappear* every time it crossed. The board
builder now emits each gap once, owned by the lower-indexed hex, and stores both
endpoint cells; the shader matches a crossing on the unordered cell pair and
flips the weight when the character is travelling the other way, so one stored
quad serves both directions.

## Why raw GL rather than a Phaser pipeline

`Phaser.Renderer.WebGL.WebGLPipeline` exists to re-batch dynamic vertices every
frame. This page wants the opposite: the board uploads **once** and the entire
animation is a handful of uniforms, plus one trail buffer touched only when a
cell is entered. Subclassing a batcher in order to bypass its buffer would be
more moving parts, not fewer, so the two programs and their buffers are ours and
the draw hangs off the game's `postrender` event.

What Phaser genuinely provides here: the WebGL context and canvas management, the
game loop and its delta, the scene lifecycle, `Phaser.Math.Easing` shaping each
stage's raw linear phase, and the FPS counter. Because Phaser owns the context,
`draw` explicitly disables depth/blend/cull/scissor rather than inheriting
whatever state was left, and hands its vertex attribute arrays back afterwards.

## Trail

A fading tint on visited cells, stored as one `aVisitedAt` float per vertex in
its own dynamic buffer, `bufferSubData`'d only on cell entry (18 floats) and
faded shader-side as `exp(-(now - visitedAt) / decay)`. Deliberately not a
`uniform float[]` — a compile-time-sized array would cap the grid radius and can
exceed fragment uniform limits on weak GPUs. The subtraction runs in the vertex
shader at `highp`, which WebGL 1 guarantees, so the trail stays accurate as the
clock grows.

## Shared with the other pages

`demo.css`, `seed.js` (`splitmix32` seed fan-out) and `hex-controls.js` are used
by all three pages; the crawler adds `CRAWLER_SCHEMA` to that module rather than
its own binder. Sidebar: **grid** (radius, seed — rebuild), **crawl** (tempo,
climb penalty, band speed — live), **view** (trail, bands, base layer).
