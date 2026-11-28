# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`apicult-desigual` — a single-crate Rust library for hex grid geometry: noise-driven terrain layout, spatial math, gap analysis, and SVG/JSON serialization. Zero game-engine dependencies (just `glam`, `hexx`, `noise`). Edition 2024.

## Commands

```sh
cargo build
cargo test                                           # runs unit tests in src/ + doctests
make test                                            # cargo test (also the wasm module's, with `--features wasm`) + `node --test web/*.test.mjs`
cargo test <name>                                    # single test by name substring
cargo test --doc                                     # doctests only (math.rs has executable examples)
cargo run --example geo_export                       # plain SVG to stdout
cargo run --example geo_export -- 5 2.0 --format svg-rich   # args: <radius> <pad> [--format svg|svg-plain|svg-rich|json-v1]
cargo run --example geo_export -- --seed 7                  # override the height-noise seed
cargo run --example geo_export -- --radius-seed 9           # override the radius-noise seed

cargo build --features wasm --target wasm32-unknown-unknown # build the wasm bindings (needs `rustup target add wasm32-unknown-unknown`)
wasm-pack build --target web --features wasm --release      # writes web/pkg/{apicult_desigual.js, _bg.wasm, .d.ts}

make preview                                         # build full preview bundle into target/www-preview/ (random seed)
make RADIUS=4 PAD=1.0 preview                        # override grid params (SVG/JSON previews)
make UNITS_RADIUS=6 preview                          # grid radius for the units page only
make CRAWLER_RADIUS=2 preview                        # grid radius for the crawler page only
make STREAM_CHUNK_RADIUS=2 preview                   # rings of cells per chunk on the treadmill page
make HSEED=42 preview                                # pin the seed for a reproducible preview
make serve                                           # `preview` + `python3 -m http.server` in target/www-preview/
```

`Cargo.toml` denies all `unused` and `clippy::all` lints — code must be warning-clean to compile.

The `wasm` Makefile target auto-installs `wasm-pack` via `cargo install` if it isn't on PATH, using the reusable `$(call ENSURE,<cmd>,<install-recipe>)` macro at the top of the Makefile. Apply it to any other tool the build needs.

## Architecture

The target API (cell state first) is agreed in `docs/design/cell-state.md`, with its flow chart `docs/design/cell-state-flow.svg`. The modules below are the current code; change the note and the chart when a decision changes.

Four modules, exported flat from `lib.rs`, plus an optional `wasm` module gated behind the `wasm` feature:

- **`layout`** — `HGridSettings` holds the noise and size settings every grid or chunk of a world shares (two `NoiseParams { seed, octaves, scale }` channels, `height_noise` and `radius_noise`, plus hex size and ranges); the extent is not a setting but `HGridLayout::new(g, radius)`'s `radius` or `for_chunk`'s `chunk_radius`. `HGridLayout` owns the `HexLayout` (from `hexx`), a `HexagonalMap<HexCell>` of per-hex `{hex, height, radius}` state populated from Fbm/Perlin noise on construction, and the cached unit corner offsets. `for_chunk(g, coord, chunk_radius, overrides) -> Result<HGridLayout, ChunkError>` applies absolute `Override = (NoiseType, Hex, f32)` edits after sampling, and fails on an override outside the layout, a non-finite value, or a chunk too far out for `to_lower_res`'s `f32`. `is_entangled(hex)` is derived, not stored: true only for a chunk layout's outer ring. `all_tris()` is the canonical unified stream, the concatenation of `owned_tris_into(hex, out)` in `shapes::hexagon` order — gap quads are split along the `[v0, v2]` diagonal *here*, so consumers that take `all_tris` never decide tessellation. An entangled cell emits only what touches an own cell: no face, no quad to another entangled cell. `hex_face_tris()`, `gap_quad_tris()`, `gap_tris()` and `gap_quads()` cover the whole layout. (Consumers that take `gap_quads` separately must NOT also consume `all_tris`, or the gap geometry will double-count.)
- **`math`** — pure functions over `glam`/`hexx` types, no `HGridLayout` dependency. Contains the ownership rules used by both layout (`quad_corner_indices`) and analysis (`gap_filler` counts via the same even-edge `[0,2,4]` + canonical-vertex `[0,1]` rules), plus `idw_interpolate_height`, `map_noise_to_range`, `gap_vertex_data`, `edge_cuboid_transform`.
- **`chunk`** — streaming terrain for an unbounded world. A chunk is the hexagon of cells with `hex.to_lower_res(chunk_radius) == coord`; `HGridLayout::for_chunk(g, coord, chunk_radius, overrides)` builds it with one extra **entangled ring** of neighbour cells (noise sampled at world positions, so chunks built alone fit exactly). There is no chunk type: the dump is a set of layout functions — `own_cells()` / `own_cell_states()` / `own_tris()` (14 tris per own cell, its `tri_sequence`), `entangled_ring()`, `entangled_seam_tris()` (per ring cell, quads then junctions) and `entangled_seam_counts()`. `chunk.rs` holds `entangled_seam_keys(coord, chunk_radius) -> Result<Vec<EntangledSeam>, ChunkError>`, which keys each seam tri `{ owner, also }` from hex math alone (no layout), sharing `layout::owned_gaps` (the ownership rules by coordinates) and `layout::chunk_center_hex` (which chunks can be built) with the layout — `also` names the third chunk a corner junction tri touches, which carries the same copy. Consumer rules: always draw own tris; draw a seam tri only while `EntangledSeam::drawn(carrier, loaded)` (owner not loaded, and `also` not loaded or after the carrier in `(q, r)` order — so two loaded carriers never both draw a corner; its cases live in `testdata/entangled_seam_drawn.tsv`, which the Rust and treadmill JS tests both read, embedded as `ENTANGLED_SEAM_DRAWN_TABLE` for zig-fatmile's copy); entangled cells are never state; a changed cell rebuilds 1 / 2 / 3 chunks (interior / edge / corner). `delta(g, coord, chunk_radius, overrides, hex)` (and `HGridLayout::delta`) gives the changed `TriSequence` values (`cell`, `offset`, `tris`) of an edited cell and its 6 neighbours in `own_tris` / `entangled_seam_tris`, each at its old length and offset, for overwriting in place. `grid_tris_golden_checksum` pins a `new` grid's `all_tris` byte-for-byte; `chunk_tris_golden_checksum` pins one chunk's `own_tris` then `entangled_seam_tris`.
- **`serialize`** — `SerializeGeo` trait + three implementors (`SvgPlain`, `SvgRich`, `JsonV1`) that stream to any `io::Write`. `examples/geo_export.rs` is a thin CLI wrapper around them. The web 3D demo no longer fetches JSON — it computes meshes in-browser via the wasm module — so `JsonV1` survives mainly for `make preview`'s SVG/JSON parity bundle and any external consumer that wants the raw `{hexes, edges, quads, tris}` payload.
- **`wasm`** (feature-gated) — `wasm-bindgen` surface for the web demos. Exposes `WasmLayout::new(radius, height_seed, radius_seed)` (opaque handle wrapping a `new` grid) with four flat-buffer methods:
  - `tris()` — canonical welded fill stream (`all_tris` flattened to `n_tris * 9`).
  - `wire_edges()` — gap-quad perimeter segments (`n_edges * 6`, walking `q[0]→q[1]→q[2]→q[3]→q[0]`, no diagonal). Quad-local edges 0/2 are bridge (cross-gap), 1/3 are rim.
  - `face_tris()` — per-hex face fans grouped `n_hexes * 54` floats (6 center-fan tris × 3 verts × 3 floats); the i-th 54-float slice owns the 6 tris of the i-th hex. Lets JS address whole hex cells without reconstructing the grouping from the flat `tris` stream.
  - `face_bridge_quads()` — per-hex face-edge bridge quads grouped `n_hexes * 78` floats (6 edge slots × 13 floats: `[flag, v0, n0, n1, v1]`). `flag` is `1.0` when the neighbor on that face edge exists in-grid, `0.0` for border edges (followed by 12 sentinel zeros). Same hex ordering as `face_tris`; corner layout matches `gap_quads` (`v0`/`v1` on source hex, `n0`/`n1` on neighbor).

  Chunks cross as stateless functions, one per layout function: `chunk_own_tris`, `chunk_own_cell_states` (`[q, r, height, radius]` per cell) and `chunk_entangled_seam_tris` take `(chunk_radius, height_seed, radius_seed, q, r)` and rebuild the chunk per call; `chunk_entangled_seam_keys(chunk_radius, q, r)` is `[owner_q, owner_r, also_q, also_r, …]` per seam tri (no `also` repeats the owner) and `chunk_center(chunk_radius, q, r)` the centre cell's world `[x, z]`. All throw a `ChunkError` message for a chunk `for_chunk` rejects.

  The renderable split keeps the boundary at the renderable level — clients never see `gap_quads` or the tessellation diagonal, sidestepping the "must NOT consume both `all_tris` + `gap_quads`" footgun.

### Critical invariants

- **Gap ownership rules** are the heart of the geometry: each gap quad is emitted by exactly one of the two adjacent hexes (the one whose edge index is in `[0, 2, 4]`); each junction tri is emitted by the one hex whose corner 0 or 1 it sits on (every lattice vertex is corner 0 or 1 of exactly one of its three hexes; the code's `coordinates()[0] == hex` check is redundant, since hexx puts `origin` first). `gap_filler`, `quad_bridge_edges`, `gap_quads`, and `gap_tris` all share these rules — change them in lockstep or the unit tests in `math.rs` and `layout.rs` will catch the drift.
- **JSON output is v1 only**: `{hexes, edges, quads, tris}`. The SVG previews share the v1 payload; the web 3D demo no longer fetches JSON — it calls the wasm module directly. (Earlier v2/v3 streams were removed when the wasm path replaced JSON-based mesh upload.)
- **Coordinate convention**: hex world positions live in `Vec2(x, z)`; `HGridLayout::vertex` lifts them to `Vec3(x, y=height, z)`. Triangle outputs are world-space `Vec3`; `gap_vertex_data` re-localizes to origin-relative positions for mesh upload.
- **Entanglement is position, not state**: only a chunk layout's outer ring is entangled (`is_entangled`), and it only trims what `owned_tris_into` emits for those cells. A `new` grid has no entangled cells.

## Preview pipeline

`make preview` runs `geo_export` three times (plain SVG, rich SVG, JSON v1 — all using `HSEED`), runs `wasm-pack build` once to produce `web/pkg/`, then templates `web/svg-preview.html` (with the short git SHA), `web/hex-units.html` (with the short SHA + `UNITS_RADIUS`) and `web/hex-crawler.html` (with the short SHA + `CRAWLER_RADIUS`) and `web/hex-stream.html` (with the short SHA + `STREAM_CHUNK_RADIUS`, published as `index.html`, the landing page) into `target/www-preview/`, and copies `docs/guide.html` (a static geometry guide with inline SVG figures) alongside them. The guide is generated: edit `docs/guide/guide.tmpl.html` (prose, `{{fN}}` figure slots) or `docs/guide/gen.py` (figures), then `make guide`; never hand-edit `docs/guide.html`. Pin `HSEED` for a reproducible build (the chosen seed is echoed at the end); the SVG previews and `apicult-desigual.json` (v1) all share it.

The flower demo (`hex-terrain.html`, a 7-mesh cluster stitched with copied overrides and entangle lists) was deleted; the treadmill supersedes it as the landing page.

## The units demo (`hex-units.html`)

A page, `hex-units.html`, drives the same wasm geometry through **Babylon.js** instead of three.js — a game engine rather than a renderer. Deep dive in `web/hex-units.md`; the load-bearing facts:

- **Babylon loads as a UMD `<script>`, not an importmap entry** — `@babylonjs/core` is hundreds of ES modules expecting a bundler, and this pipeline has none. The page reads the `BABYLON` global; a `<script onerror>` flag makes CDN failure show an `.error-msg` rather than a blank canvas.
- **`scene.useRightHandedSystem = true`** — the wasm stream is right-handed with CCW front faces, so Babylon is told up front instead of mirroring the terrain and its normals.
- **No new wasm exports were needed.** `web/hex-units-grid.js` derives everything from `face_tris()`: floats `[0..3)` of each 54-float group are the hex's world centre (every fan triangle starts there), and adjacency falls out of the lattice — `hex_to_world_pos` ignores per-cell `radius`, so centres are exactly one spacing apart and the next ring is `sqrt(3)` away. It imports neither the engine nor the wasm module, so its A* is unit-tested under plain node.
- **Movement** costs `1 + 4 * |Δheight| / spacing` per step and refuses steps taller than the `max climb` knob, so terrain fences units in; crossings add a `sin(π t)` arc so the gap between hexes reads as a hop.

Its sidebar has three fieldsets: **grid** (radius, seed, apply/re-roll — rebuild), **units** (count, speed, max climb — all live), **view** (trails, glow, wireframe).

## The crawler demo (`hex-crawler.html`)

A page on **Phaser** that inverts the units page: there is no sprite, the character *is* the fill. It occupies one hex or one gap quad completely and moves by draining out of one and pouring into the next, cycling `ENTER → REST → AIM → EXIT → GAP`. Deep dive in `web/hex-crawler.md`; the load-bearing facts:

- **Two invariants of the wasm streams are load-bearing here, and both bit once.** (1) Fan-triangle indices and bridge-slot indices come off *different* hexx direction tables (`VertexDirection` vs `EdgeDirection`), so they can differ by a fixed rotation `k`; `hex-crawler-board.js` derives `k` from the bit-exact corner sharing `hex_face_bridge_quads` guarantees, and throws on disagreement, rather than hardcoding a guess that would silently send the character out of the wrong door. (2) `face_bridge_quads` applies **no ownership rule**, so every interior gap arrives twice as coincident quads — with no depth test the duplicate overdrew the lit crossing and the character vanished mid-gap. The board builder emits each gap once (lower-indexed hex owns it), stores both endpoint cells, and the shader matches a crossing on the unordered pair, flipping the weight for the reverse direction.
- **No new wasm exports.** Faces from `face_tris()`, gaps from `face_bridge_quads()` split as `gap_quad_tris` splits them, and the dim base layer from `tris()` — which already carries the junction triangles, so no `gap_tris()` export was needed to draw a complete board.
- **Height is speed, not a wall.** Step duration scales by `exp(climbK · Δh / spacing)`; the yellow gap bands inherit the same rate. Routing reuses `hex-units-grid.js` untouched — `findPath(..., Infinity)` makes every neighbour passable while its `1 + 4·|Δh|/spacing` cost still prefers level ground.
- **Raw GL, not a `WebGLPipeline`.** That class re-batches dynamic vertices every frame; this page uploads once and animates entirely through uniforms plus a trail buffer touched only on cell entry. Phaser supplies the context, loop, scene lifecycle and `Phaser.Math.Easing`; because it owns the context, `draw` explicitly disables depth/blend/cull/scissor and hands its attribute arrays back afterwards.
- **2D projection** is `(x, z)` with `y` dropped and used as a tint — the same convention `src/serialize.rs` uses for the SVG previews, which makes this page the animated twin of `svg-preview.html`.

Sidebar: **grid** (radius, seed — rebuild), **crawl** (tempo, climb penalty, band speed — live), **view** (trail, bands, base layer).

## The chunk treadmill (`hex-stream.html`, published as `index.html`)

The landing page, on **three.js**, built on the `chunk` module: seven chunks (an anchor + its 6 lattice neighbours) around a camera parked at the origin, the world group drifting at `speed` in one of 6 chunk directions. Load-bearing facts:

- **One set of seeds per world.** Both seeds come from the seed box once per build (`seedSequence(seed, 2)`, or two `randomU32` when blank) — never per chunk, or chunks stop fitting.
- **Stepping is pure JS** (`web/hex-stream.js`, node-tested): `nearestStep` compares the camera's world `(x, z)` against chunk centres from `chunkCenter(coord, u, v)`, where `u`, `v` are `chunk_center` of chunks `(1,0)` / `(0,1)` — valid because `to_higher_res` and `hex_to_world_pos` are both linear. Each step is `stepFootprint`: 3 spawn, 3 despawn, 4 kept untouched.
- **Seams follow consumer rule 1**: every chunk groups its seam tris by key (`groupSeams`, node-tested) and builds a mesh per group up front; `visibleSeamGroups(keys, self, loaded)` applies the same tie-break as `EntangledSeam::drawn`, with every chunk in the scene counted as loaded at any opacity, so no gap is ever drawn twice (the stats line counts `seam overlaps` across all chunks; it should read 0). The price: a strip owned by a fading or ghost chunk shows at that chunk's opacity, so the 1+6's outline is only closed between opaque chunks. Seams wear their own chunk's tint, not the owner's (which is often not loaded yet); `highlight seams` paints them amber.
- **Despawns linger as ghosts**: `ageGhost` (pure, node-tested) moves a despawned chunk to 10%, then 5% on the next step, then out and dropped. Below full opacity a chunk stops writing depth, so ghosts never hide live terrain.
- Float precision far from the origin is not handled (the group offset grows without rebasing).

Sidebar: **world** (chunk radius, seed — rebuild), **motion** (speed, direction — live), **view** (tint chunks, highlight seams).

### Shared web modules

All the pages share `web/demo.css`, `web/page-nav.js` (the topbar page `<select>`, auto-mounted into `[data-page-nav]` by its own `<script type="module" src="page-nav.js">` so it survives a failing page module; `PAGES` is the one list of pages — a new page adds itself there, and `page-nav.test.mjs` fails until every `web/*.html` and the guide template are listed and mount the nav; `svg-preview.html` and `guide.html` load it too), `web/weld.js` (engine-agnostic `weldTris` → `{positions, indices}`; `three-weld.js::weldedMesh` and the Babylon `VertexData` path both wrap it), `web/three-weld.js` (`weldedMesh` → indexed `THREE.BufferGeometry`, for the three.js pages), `web/canvas.js` (`showError`; `needsResize`, which compares device px to device px so high-DPI screens don't reallocate every frame; `runFrames`, the rAF loop that shows a throwing frame's error once and clears it on recovery — use it for a new page's loop), `web/seed.js` (`randomU32` / `splitmix32` / `seedSequence`) and `web/hex-controls.js`. The last is schema-driven: `UNITS_SCHEMA`, `CRAWLER_SCHEMA` and `STREAM_SCHEMA` declare each page's inputs, toggles and which fields rebuild vs. update live, so a new page adds a schema rather than a binder. Live number fields are clamped to their input's own `min`/`max` (the HTML is the one source of the limits); rebuild fields aren't, so Makefile overrides past `max` (`make STREAM_CHUNK_RADIUS=9`) survive. `make` copies them via the `COMMON_WEB` variable (per-page modules go in `UNITS_WEB` / `CRAWLER_WEB` / `STREAM_WEB`) — **any new shared module must be added there or it will 404 on gh-pages.**

The pure-JS units are tested with `node --test web/*.test.mjs` (the `test-js` make target, which `make test` and CI both run).

The `.github/workflows/svg-preview.yml` CI installs the `wasm32-unknown-unknown` target and `wasm-pack`, runs `make test` (cargo tests + the node tests) then the same `make preview` target on push to `main` and on PRs, and publishes the result to the `gh-pages` branch only on push to `main` — so the live demo at https://dynnamitt.github.io/apicult-desigual-rs/ tracks `main` automatically.
