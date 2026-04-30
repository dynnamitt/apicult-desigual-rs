# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`apicult-desigual` — a single-crate Rust library for hex grid geometry: noise-driven terrain layout, spatial math, gap analysis, and SVG/JSON serialization. Zero game-engine dependencies (just `glam`, `hexx`, `noise`). Edition 2024.

## Commands

```sh
cargo build
cargo test                                           # runs unit tests in src/ + doctests
cargo test <name>                                    # single test by name substring
cargo test --doc                                     # doctests only (math.rs has executable examples)
cargo run --example geo_export                       # plain SVG to stdout
cargo run --example geo_export -- 5 2.0 --format svg-rich   # args: <radius> <pad> [--format svg|svg-rich|json-v1|json-v2|json-v3]
cargo run --example geo_export -- --seed 7                  # override the height-noise seed

cargo build --features wasm --target wasm32-unknown-unknown # build the wasm bindings (needs `rustup target add wasm32-unknown-unknown`)
wasm-pack build --target web --features wasm --release      # writes web/pkg/{apicult_desigual.js, _bg.wasm, .d.ts}

make preview                                         # build full preview bundle into target/svg-preview/ (random seed)
make RADIUS=4 PAD=1.0 preview                        # override grid params
make HSEED=42 preview                                # pin the seed for a reproducible preview
```

`Cargo.toml` denies all `unused` and `clippy::all` lints — code must be warning-clean to compile.

## Architecture

Three modules, exported flat from `lib.rs`, plus an optional `wasm` module gated behind the `wasm` feature:

- **`layout`** — `HGridLayout` owns the `HexLayout` (from `hexx`), a `HexagonalMap<HexCell>` of per-hex `{hex, height, radius}` data populated from Fbm/Perlin noise on construction, and the cached unit corner offsets. Its compute methods (`gap_quads`, `gap_tris`, `hex_face_tris`, `all_tris`, `quad_long_edges`) are the geometry surface area. `all_tris` is the canonical unified stream — gap quads are split along the `[v0, v2]` diagonal *here*, so consumers that take `all_tris` never decide tessellation. (Consumers that take `gap_quads` separately must NOT also consume `all_tris`, or the gap geometry will double-count.)
- **`math`** — pure functions over `glam`/`hexx` types, no `HGridLayout` dependency. Contains the ownership rules used by both layout (`quad_corner_indices`) and analysis (`gap_filler` counts via the same even-edge `[0,2,4]` + canonical-vertex `[0,1]` rules), plus `idw_interpolate_height`, `map_noise_to_range`, `gap_vertex_data`, `edge_cuboid_transform`.
- **`serialize`** — `SerializeGeo` trait + five implementors (`SvgPlain`, `SvgRich`, `JsonV1`, `JsonV2`, `JsonV3`) that stream to any `io::Write`. `examples/geo_export.rs` is a thin CLI wrapper around them. v3 (`{version: 3, tris, quads}`) is retained for `--format json-v3` parity but not consumed by `make preview` (the demo computes meshes in-browser via the wasm module).
- **`wasm`** (feature-gated) — `wasm-bindgen` surface for the web demo. Exposes `WasmLayout` (opaque handle wrapping `HGridLayout`) with two renderable buffers and one structured query: `tris()` is the canonical unified mesh stream (`all_tris` flattened to `n_tris * 9`); `wire_edges()` is gap-quad perimeters only (`n_edges * 6`, walking `q[0]→q[1]→q[2]→q[3]→q[0]`, no diagonal); `borderline_cells(VertexDir)` returns `Vec<HexCellView>`. The split keeps the boundary at the renderable level — clients never see `gap_quads` or the tessellation diagonal, sidestepping the "must NOT consume both `all_tris` + `gap_quads`" footgun. Inputs flow through `OverrideSpec { kind, q, r, value }` (mapped to `Override`), `NoiseChannel` (mirrors `NoiseType`), `VertexDir` (mirrors `hexx::VertexDirection` indices East..NorthEast). Outputs flow through `HexCellView { q, r, height, radius }` (Hex decomposed since foreign types can't carry `#[wasm_bindgen]`).

### Critical invariants

- **Gap ownership rules** are the heart of the geometry: each gap quad is emitted by exactly one of the two adjacent hexes (the one whose edge index is in `[0, 2, 4]`); each junction tri is emitted only when the origin hex is `GridVertex::coordinates()[0]`. `gap_filler`, `quad_long_edges`, `gap_quads`, and `gap_tris` all share these rules — change them in lockstep or the unit tests in `math.rs` and `layout.rs` will catch the drift.
- **JSON v1 vs v2 vs v3** are not interchangeable: v1 (`{hexes, edges, quads, tris}`) is the legacy payload; v2 (`{version: 2, tris}`) is the welded-mesh stream from `all_tris`; v3 (`{version: 3, tris, quads}`) carries both `all_tris` and `gap_quads`. The SVG previews use the v1 payload; the web 3D demo no longer fetches JSON — it calls the wasm module directly.
- **Coordinate convention**: hex world positions live in `Vec2(x, z)`; `HGridLayout::vertex` lifts them to `Vec3(x, y=height, z)`. Triangle outputs are world-space `Vec3`; `gap_vertex_data` re-localizes to origin-relative positions for mesh upload.

## Preview pipeline

`make preview` runs `geo_export` three times (plain SVG, rich SVG, JSON v1 — all using `HSEED`), runs `wasm-pack build` once to produce `web/pkg/`, then templates `web/svg-preview.html` (with the short git SHA) and `web/hex-terrain.html` (with the short SHA + `RADIUS`) into `target/svg-preview/`. The terrain page imports `pkg/apicult_desigual.js` and constructs `new WasmLayout(RADIUS, h_seed, r_seed, [])` once per mesh at page load with fresh random u32 seeds, calling `.tris()` and `.wire_edges()` to fill the welded mesh + shader-wireframe overlay. Each refresh produces a visually different multi-mesh layout — no JSON files involved at runtime. The SVG previews and `apicult-desigual.json` (v1) still share `HSEED` for grid/mesh consistency; pin it with `make HSEED=N preview` for a reproducible build (the chosen seed is echoed at the end). The `.github/workflows/svg-preview.yml` CI installs the `wasm32-unknown-unknown` target and `wasm-pack`, runs `cargo test` then the same `make` target on push to `main` and on PRs, and publishes the result to the `gh-pages` branch only on push to `main` — so the live demo at https://dynnamitt.github.io/apicult-desigual-rs/ tracks `main` automatically.
