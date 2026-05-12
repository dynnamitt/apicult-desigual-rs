# apicult-desigual

[![Rust 2024](https://img.shields.io/badge/Rust-2024-CE422B?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/wasm--bindgen-654FF0?style=for-the-badge&logo=webassembly&logoColor=white)](https://rustwasm.github.io/wasm-bindgen/)
[![Live WebGL Demo](https://img.shields.io/badge/Live_Demo-WebGL-0A6CB1?style=for-the-badge&logo=webgl&logoColor=white&labelColor=000000)](https://dynnamitt.github.io/apicult-desigual-rs/)

**apicult(desigual)** is a hexagonal layout system where each cell can shrink below its normal-form (100%) size — controlled by `min_radius_ratio` / `max_radius_ratio` in `[0.0, 1.0]` — with bridge geometry filling the gaps to its neighbors. Random seeds drive per-cell size and 3D height.

- _apicult_ — from **apiculture** (beekeeping); the honeycomb.
- _desigual_ — Spanish for "uneven", in the spirit of Norwegian _kupert_: hilly, uneasy terrain.

---

A Rust hex-grid geometry library — noise-driven terrain layout, spatial math, gap analysis, and SVG/JSON serialization. Compiles to a `wasm32-unknown-unknown` target via `wasm-bindgen` for zero-copy mesh streaming into browser renderers.

Zero game-engine dependencies — `glam` for vectors, `hexx` for hex coordinates, `noise` for Fbm terrain generation.

The [live demo](https://dynnamitt.github.io/apicult-desigual-rs/) constructs the layout entirely inside the wasm module on page load and pulls flat `Float32Array` buffers (welded mesh + wireframe edges) straight into a thin three.js viewer — no JSON round-trip, no JS-side geometry. The same page also shows the plain and rich SVG variants for comparison.

## What it does

- **`HGridLayout`** -- builds a hex grid from `HGridSettings`, sampling Fbm noise for per-hex heights and radii. Provides vertex computation, coordinate conversion, IDW height interpolation, and triangulated geometry: `gap_quads`, `gap_tris`, `hex_face_tris(entangled)`, `gap_quad_tris(entangled)`, and the unified `all_tris(entangled)` stream (gap quads split along the canonical `[v0, v2]` diagonal). The per-cell `entangled: bool` flag is set via `HGridLayout::new`'s `entangle: &[Hex]` arg and partitions the hex-face / gap-quad output streams so two materials can render entangled vs non-entangled cells separately.
- **Gap analysis** -- `gap_filler` counts quad/tri gaps using even-edge ownership rules. `quad_corner_indices` maps edge indices to the four corners forming each quad.
- **Serialization** -- `SerializeGeo` trait with three implementors: `SvgPlain`, `SvgRich`, `JsonV1` (`{hexes, edges, quads, tris}`). The web 3D demo bypasses JSON entirely and pulls geometry through the wasm module instead.
- **Wasm bindings** -- `WasmLayout` exposes flat `Float32Array` buffers for the welded fill mesh (`tris`), gap-quad perimeter segments (`wire_edges`), and per-hex face fans grouped 54 floats at a time (`face_tris`) — all filtered by `entangled: bool`. Inputs are `OverrideSpec` (per-hex pinned values) and `EntangleSpec` (entangle marker).
- **Pure math helpers** -- `edge_cuboid_transform`, `gap_vertex_data`, `map_noise_to_range`, `idw_interpolate_height`.

## Usage

```rust
use apicult_desigual::{HGridLayout, HGridSettings};

let settings = HGridSettings { radius: 10, ..HGridSettings::default() };
let layout = HGridLayout::from_settings(&settings);

let height = layout.height(&hexx::Hex::ZERO);
let vertex = layout.vertex(hexx::Hex::ZERO, 0);
let ground = layout.interpolate_height(glam::Vec2::new(5.0, 3.0));

// Unified triangle stream — diagonal choice owned here, not on the client.
// Pass `false` to get only non-entangled cells (the default for a freshly built layout).
let tris = layout.all_tris(false);
```

## Preview example

The `geo_export` example streams the grid to stdout in any of the supported formats. It's the same binary that drives the [live WebGL demo](https://dynnamitt.github.io/apicult-desigual-rs/):

```sh
cargo run --example geo_export                                   # plain SVG (gray, no labels)
cargo run --example geo_export -- 5 2.0 --format svg-rich        # green fill, outlined strokes, height labels
cargo run --example geo_export -- 5 2.0 --format json-v1         # {hexes, edges, quads, tris}
cargo run --example geo_export -- --seed 7                       # override the height-noise seed
```

`--rich` and `--json` remain as backward-compat aliases for `--format svg-rich` and `--format json-v1`.

The web 3D demo loads geometry directly from a `wasm-bindgen` build of the lib (no JSON fetch at runtime). Build the wasm bindings with:

```sh
rustup target add wasm32-unknown-unknown      # one-time setup
wasm-pack build --target web --features wasm  # writes web/pkg/{apicult_desigual.js, _bg.wasm, .d.ts}
```

To build the whole preview page (SVGs + v1 JSON + wasm pkg + HTML) locally, use the root Makefile target:

```sh
make preview                        # writes into target/www-preview/ with a random HSEED
make HSEED=42 preview               # pin the seed for a reproducible bundle
make RADIUS=4 PAD=1.0 preview       # override grid params
```

## Dependencies

| Crate       | Purpose                          |
| ----------- | -------------------------------- |
| `glam` 0.30 | Vec2, Vec3, Quat                 |
| `hexx` 0.24 | Hex coordinates, layouts, shapes |
| `noise` 0.9 | Fbm/Perlin terrain generation    |
