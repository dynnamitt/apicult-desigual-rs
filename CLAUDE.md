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
cargo run --example geo_export -- 5 2.0 --format svg-rich   # args: <radius> <pad> [--format svg|svg-rich|json-v1|json-v2]
cargo run --example geo_export -- --seed 7                  # override the height-noise seed

make preview                                         # build full preview bundle into target/svg-preview/ (random seed)
make RADIUS=4 PAD=1.0 preview                        # override grid params
make HSEED=42 preview                                # pin the seed for a reproducible preview
```

`Cargo.toml` denies all `unused` and `clippy::all` lints — code must be warning-clean to compile.

## Architecture

Three modules, exported flat from `lib.rs`:

- **`layout`** — `HGridLayout` owns the `HexLayout` (from `hexx`), per-hex `heights`/`radii` `HashMap`s populated from Fbm/Perlin noise on construction, and the cached unit corner offsets. Its compute methods (`gap_quads`, `gap_tris`, `hex_face_tris`, `all_tris`, `quad_long_edges`) are the geometry surface area. `all_tris` is the canonical unified stream — gap quads are split along the `[v0, v2]` diagonal *here*, so consumers never decide tessellation.
- **`math`** — pure functions over `glam`/`hexx` types, no `HGridLayout` dependency. Contains the ownership rules used by both layout (`quad_corner_indices`) and analysis (`gap_filler` counts via the same even-edge `[0,2,4]` + canonical-vertex `[0,1]` rules), plus `idw_interpolate_height`, `map_noise_to_range`, `gap_vertex_data`, `edge_cuboid_transform`.
- **`serialize`** — `SerializeGeo` trait + four implementors (`SvgPlain`, `SvgRich`, `JsonV1`, `JsonV2`) that stream to any `io::Write`. `examples/geo_export.rs` is a thin CLI wrapper around them.

### Critical invariants

- **Gap ownership rules** are the heart of the geometry: each gap quad is emitted by exactly one of the two adjacent hexes (the one whose edge index is in `[0, 2, 4]`); each junction tri is emitted only when the origin hex is `GridVertex::coordinates()[0]`. `gap_filler`, `quad_long_edges`, `gap_quads`, and `gap_tris` all share these rules — change them in lockstep or the unit tests in `math.rs` and `layout.rs` will catch the drift.
- **JSON v1 vs v2** are not interchangeable: v1 (`{hexes, edges, quads, tris}`) is the legacy payload; v2 (`{version: 2, tris}`) is the welded-mesh stream from `all_tris`. The web demo (`web/hex-terrain.js`) consumes v2; the SVG previews don't use JSON at all.
- **Coordinate convention**: hex world positions live in `Vec2(x, z)`; `HGridLayout::vertex` lifts them to `Vec3(x, y=height, z)`. Triangle outputs are world-space `Vec3`; `gap_vertex_data` re-localizes to origin-relative positions for mesh upload.

## Preview pipeline

`make preview` runs `geo_export` four times (plain SVG, rich SVG, JSON v1, JSON v2), then templates `web/svg-preview.html` and `web/hex-terrain.html` with the short git SHA into `target/svg-preview/`. A random `HSEED` is generated once per invocation and passed to all four `geo_export` calls so the bundle is internally consistent; pin it with `make HSEED=N preview` for a reproducible build (the chosen seed is echoed at the end). The `.github/workflows/svg-preview.yml` CI runs the same `make` target on push to `main` and publishes the result to the `gh-pages` branch — so the live demo at https://dynnamitt.github.io/apicult-desigual-rs/ tracks `main` automatically (each commit publishes a freshly seeded terrain).
