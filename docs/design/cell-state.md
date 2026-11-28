# Design note: cell state first

The target API for the cell-state-first rework. This note is the agreed version. Change it when a decision changes, and update the flow chart with it.

![Target flow: inputs build cell state; tris are derived one way; the consumer keeps edits and passes them back as overrides](cell-state-flow.svg)

## Principle

- Cell state (`height`, `radius`) is the source of truth.
- Edits made while a game runs must be kept as cell state.
- Triangles are a one-way serialization of state. They can't give the state back.

`entangled` is not state: it is derived from a cell's position (see *the term "entangled"* below).

## Target rules

1. A consumer's FFI is a C ABI over apicult calls, with no geometry or grouping logic of its own.
2. Chunking returns an `HGridLayout` (state) before any tris are made.
3. Tri generation takes a layout as input.
4. When a cell is dug (a game action that lowers a cell), apicult answers with a mesh delta.
5. Tri output is a plain dump with no relationship data. Relationships are queries.

## Terms

| term | meaning |
|---|---|
| own cells | the radius-`chunk_radius` hexagon of cells with `hex.to_lower_res(chunk_radius) == coord` |
| `entangled_ring` | the cells at distance `chunk_radius + 1` from the chunk centre. Every chunk layout holds them, so the gaps along its edge have both sides. Each one is an own cell of its own chunk and sits in the entangled ring of 1 or 2 others (chunk edge or corner); it is never state in those other chunks |
| `is_entangled(h)` | `center.unsigned_distance_to(h) == chunk_radius + 1`. Replaces the `HexCell.entangled` field |
| `tri_sequence` | the 14 tris an own cell owns: 6 face, 6 gap-quad (3 quads), 2 junction. Replaces the old names "run", `owned_runs` and `first_tri`. `TriSequence` (type), `triSequence` (JS, Zig) |
| `entangled_seam_tris` | the tris the entangled ring gives a chunk: per entangled cell, its quads, then its junctions |
| `entangled_seam_counts` | per entangled cell, its count of quad tris, then of junction tris |
| `EntangledSeam` | a seam key `(owner, also)`. `also` is the third chunk a junction tri touches, or none |
| carrier | the chunk whose entangled seam tris hold the copy being drawn |

## Decisions

### Layout and state

- **Stateless calls.** There are no Rust-side handles across the FFI. Each call builds a layout from settings, coordinate and edits, and returns. A whole chunk (`chunk_radius` 6) takes 0.22 ms. In code: `HGridLayout::for_chunk` and `chunk::delta` (`src/layout.rs`, `src/chunk.rs`), and the `chunk_*` functions in `src/wasm.rs`.
- **The consumer stores edits.** zig-fatmile keeps `hex → height`, keyed by owning chunk, and passes a chunk's own and entangled-ring edits on every call. apicult stays pure: noise + given state → layout → tris. Saving is the game's job. In code: consumer rule 2 in the `chunk` module docs (`src/chunk.rs`).
- **State goes in as an override list.** `Override = (NoiseType, Hex, f32)`, applied by `build` after sampling. It covers height and radius. In code: `layout::Override` and `NoiseType`; `for_chunk` applies them, tested by `overrides_replace_noise_values`.
- **No cell setter.** A built layout is immutable. Edits go in only through overrides, so the same inputs always give the same tris. In code: `HGridLayout` has no `pub` field or setter.
- **An override is absolute.** It sets the final height or radius, not an offset from noise. In code: `HGridLayout::for_chunk`'s `overrides` parameter.
- **Two constructors, and `radius` leaves the settings.** `HGridLayout::new(g, radius)` builds a bounded grid (geo_export, the SVG previews, `WasmLayout` for the units and crawler pages). `for_chunk` builds a chunk. `HGridSettings` holds only noise and size settings, so no constructor ignores a field. In code: `HGridLayout::new`, `HGridLayout::for_chunk`, `HGridSettings` and `NoiseParams` (`src/layout.rs`). The `NoiseParams` change is amended to match and lands early (see order below).
- **One entry point for chunks.** `for_chunk(g, coord, chunk_radius, overrides) -> Result<HGridLayout, ChunkError>`. `ChunkSource` and `NoiseWorld` are deleted. The consumer keeps settings and `chunk_radius` together. In code: `HGridLayout::for_chunk`.
- **The term "entangled" stays, and narrows to the chunk ring.** It no longer names a flag a caller sets per cell: a cell is entangled only in a chunk layout, and only because it sits in that layout's entangled ring (`is_entangled`). The new and replaced names are in the Terms table above. In code: `HGridLayout::is_entangled` and the `HexCell` docs; tested by `new_grid_has_no_entangled_cells`.
- **The flower demo is deleted.** `hex-terrain.html`, `hex-terrain-scene.js` and `hex-seam.js` go. So do the `entangled: bool` filter on every geometry method and `new`'s `overrides` / `entangle` lists.

### Tris

- **The dump: cells, flat tris, entangled seam counts.**
  - The own cells' state `(q, r, height, radius)`, in `shapes::hexagon(center, chunk_radius)` order.
  - Own tris: cell *i* owns `tris[14·i .. 14·i + 14]`. Own cells always have all their neighbours, so this holds for every own cell. apicult documents and tests it as an invariant (`HGridLayout::own_tris`, `own_and_seam_tris_split_all_tris`).
  - `entangled_seam_tris` in `center.ring(chunk_radius + 1)` order, with `entangled_seam_counts` (two per entangled cell: quad tris, then junction tris).
  - No byte format or hash in apicult.
- **`Chunk` is deleted.** The dump is a set of functions of a layout: `own_cell_states`, `own_tris`, `entangled_seam_tris`, `entangled_seam_counts`. Each consumer assembles its own bundle. In code: those four methods on `HGridLayout` (`src/layout.rs`), described together in the `chunk` module docs.
- **The seam cut is its own rule.** Before the flower demo was deleted, the `entangled` filter made the cut: `owned_tris_into(h, false, …)` on an entangled cell dropped its face fan and the quads between two entangled cells, and the layout ended at `chunk_radius + 1`. Now the rule is stated directly: *an entangled cell emits only the quads and junctions that touch an own cell.* At `chunk_radius` 6 the 42 entangled cells emit 0 face tris, 78 quad tris (39 quads) and 40 junction tris. The ring and the own cells share the 78 quads between them: the ring owns 39, the own cells 39. In code: `HGridLayout::owned_tris_into` states the rule and `HGridLayout::owned_gaps` applies it; tested by `entangled_cells_emit_only_what_touches_the_chunk`.
- **A stateless delta.** `delta(g, coord, chunk_radius, overrides, hex) -> Result<Delta, ChunkError>` (and `HGridLayout::delta(hex)`) returns the `TriSequence { cell, offset, tris }` values of the changed cell and its 6 neighbours, built by the same code as the full chunk.
  - `Delta.own` holds at most 7 × 14 own tris, at offsets 14·i.
  - `Delta.entangled_seams` holds any entangled seam tris they own, at their offsets in `entangled_seam_tris`.

  A height or radius edit keeps the topology, so the consumer overwrites those ranges in place. An edit on a chunk's edge or corner also changes the 1 or 2 neighbour chunks holding the cell in their entangled ring: the consumer calls `delta` for each. No reactive or observer plumbing. In code: `chunk::delta`, `HGridLayout::delta`, `Delta` and `TriSequence`; tested by `delta_matches_a_full_rebuild` and `delta_covers_the_neighbour_chunks`.

### Seams

- **`entangled_seam_keys(coord, chunk_radius)`.** A pure function: one `(owner, also)` per entangled seam tri, parallel to `entangled_seam_tris`. Which tris exist depends only on the chunk shape, not on heights, so no layout is built. It takes `coord` and returns absolute keys (amended from relative keys, which every consumer would have had to shift itself). It shares the ownership rules with `owned_tris_into` through one function, so consumers never copy the corner-0/1 rule. In code: `chunk::entangled_seam_keys` and `layout::owned_gaps`; tested by `seam_keys_match_vertex_positions`.
- **One draw rule with a shared test table.** `key.drawn(carrier, loaded)` on an `EntangledSeam` key is a pure function over hex coordinates: draw while the owner isn't loaded, and `also` isn't loaded or sorts after the carrier in `(q, r)` order, so two loaded carriers never both draw a corner. A table of test cases lives in the repo (`testdata/entangled_seam_drawn.tsv`, exported as the `ENTANGLED_SEAM_DRAWN_TABLE` string so a dependent crate can check its copy). zig-fatmile's port and the treadmill's JS are tested against the same table. In code: `EntangledSeam::drawn` (`src/chunk.rs`), tested by `drawn_follows_the_shared_table` and `drawn_seams_cover_loaded_chunks_once`; the JS port is `visibleSeamGroups` in `web/hex-stream.js`.

### Errors, exports, process

- **`Result` everywhere.** `for_chunk`, the dump functions and `delta` return `Result<_, ChunkError>`. The remaining `expect`s become errors. The C ABI turns an error into null plus an error code (zig-fatmile parks that chunk in `TerrainStream.broken`). In code: `ChunkError` (`src/layout.rs`).
- **The treadmill (the `hex-stream.html` demo) assembles chunks in JS.** `wasm.rs` exports the free functions one to one, and `WasmChunk` goes. `hex-stream.js` builds its seam groups from `entangled_seam_tris` and `entangled_seam_keys`, under node tests. Other demo packing (54-float `face_tris`, 78-float `face_bridge_quads`) also lives in the wasm or JS layer, not in `layout`. In code: the `chunk_*` functions in `src/wasm.rs`, and `groupSeams` in `web/hex-stream.js`.
- **The golden checksum is bridged.** A second checksum, in its own PR (step 2 below), hashes one `for_chunk` chunk: each own cell's 14 tris in `shapes::hexagon` order, then `entangled_seam_tris` in `center.ring(chunk_radius + 1)` order. Step 4 deletes `all_tris_golden_checksum`, which deleting the flower demo would otherwise change without any change to the geometry. In code: `chunk_tris_golden_checksum` and `grid_tris_golden_checksum` in `src/layout.rs`'s tests.
- **This note lives here.** `docs/design/cell-state.md`, with the flow chart as `cell-state-flow.svg`, linked from CLAUDE.md.

## Order of work

1. This note.
2. The chunk checksum PR.
3. `NoiseParams` in the settings, with `radius` moved out of them.
4. `for_chunk` with overrides and `Result`, the flower deleted, `entangled` derived from position.
5. The seam cut as functions of a layout, by hex coordinates: the cut rule, `entangled_seam_keys` and the draw rule.
6. The dump, with `Chunk`, `ChunkSource`, `NoiseWorld` and `WasmChunk` deleted.
7. `delta`, tested against a full rebuild bit for bit.
8. zig-fatmile's `apicult-ffi` down to a C ABI shim, then bump its pinned rev.

The chunk checksum stays green from step 2 on, and `all_tris_golden_checksum` until step 4 deletes it. Each step's PR adapts the demo pages it touches, and the JS tests stay green.

## Not in scope

- A `TriStream` trait: waits for a second geometry producer.
- A CLI chunk export: zig-fatmile builds chunks at runtime.
