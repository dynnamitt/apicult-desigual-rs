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
cargo run --example geo_export -- 5 2.0 --format svg-rich   # args: <radius> <pad> [--format svg|svg-plain|svg-rich|json-v1]
cargo run --example geo_export -- --seed 7                  # override the height-noise seed

cargo build --features wasm --target wasm32-unknown-unknown # build the wasm bindings (needs `rustup target add wasm32-unknown-unknown`)
wasm-pack build --target web --features wasm --release      # writes web/pkg/{apicult_desigual.js, _bg.wasm, .d.ts}

make preview                                         # build full preview bundle into target/www-preview/ (random seed)
make RADIUS=4 PAD=1.0 preview                        # override grid params
make HSEED=42 preview                                # pin the seed for a reproducible preview
make serve                                           # `preview` + `python3 -m http.server` in target/www-preview/
```

`Cargo.toml` denies all `unused` and `clippy::all` lints — code must be warning-clean to compile.

The `wasm` Makefile target auto-installs `wasm-pack` via `cargo install` if it isn't on PATH, using the reusable `$(call ENSURE,<cmd>,<install-recipe>)` macro at the top of the Makefile. Apply it to any other tool the build needs.

## Architecture

Three modules, exported flat from `lib.rs`, plus an optional `wasm` module gated behind the `wasm` feature:

- **`layout`** — `HGridLayout` owns the `HexLayout` (from `hexx`), a `HexagonalMap<HexCell>` of per-hex `{hex, height, radius, entangled}` data populated from Fbm/Perlin noise on construction, and the cached unit corner offsets. The `entangled: bool` per-cell flag is set via the `entangle: &[Hex]` arg to `HGridLayout::new`; the hex-face-fan and gap-quad geometry methods filter by it: `hex_face_tris(entangled)`, `gap_quad_tris(entangled)`, `all_tris(entangled)` emit only the cells (or quads, by the same flag on `GapQuad`) matching the bool — letting two materials drive entangled vs non-entangled cells separately. `gap_tris()` (3-hex junction tris) and `gap_quads()` are unfiltered. `all_tris(entangled)` is still the canonical unified stream — gap quads are split along the `[v0, v2]` diagonal *here*, so consumers that take `all_tris` never decide tessellation. (Consumers that take `gap_quads` separately must NOT also consume `all_tris`, or the gap geometry will double-count.)
- **`math`** — pure functions over `glam`/`hexx` types, no `HGridLayout` dependency. Contains the ownership rules used by both layout (`quad_corner_indices`) and analysis (`gap_filler` counts via the same even-edge `[0,2,4]` + canonical-vertex `[0,1]` rules), plus `idw_interpolate_height`, `map_noise_to_range`, `gap_vertex_data`, `edge_cuboid_transform`.
- **`serialize`** — `SerializeGeo` trait + three implementors (`SvgPlain`, `SvgRich`, `JsonV1`) that stream to any `io::Write`. `examples/geo_export.rs` is a thin CLI wrapper around them. The web 3D demo no longer fetches JSON — it computes meshes in-browser via the wasm module — so `JsonV1` survives mainly for `make preview`'s SVG/JSON parity bundle and any external consumer that wants the raw `{hexes, edges, quads, tris}` payload.
- **`wasm`** (feature-gated) — `wasm-bindgen` surface for the web demo. Exposes `WasmLayout` (opaque handle wrapping `HGridLayout`) with three renderable flat-buffer methods plus one structured query, all the renderables filtered by `entangled: bool`:
  - `tris(entangled)` — canonical welded fill stream (`all_tris` flattened to `n_tris * 9`).
  - `wire_edges(entangled)` — gap-quad perimeter segments (`n_edges * 6`, walking `q[0]→q[1]→q[2]→q[3]→q[0]`, no diagonal). Quad-local edges 0/2 are bridge (cross-gap), 1/3 are rim.
  - `face_tris(entangled)` — per-hex face fans grouped `n_hexes * 54` floats (6 center-fan tris × 3 verts × 3 floats); the i-th 54-float slice owns the 6 tris of the i-th matching hex. Lets JS address whole hex cells (e.g. the band shader's random-subset overlay) without reconstructing the grouping from the flat `tris` stream.
  - `borderline_cells(VertexDir)` returns `Vec<HexCellView>` for seam construction.

  The renderable split keeps the boundary at the renderable level — clients never see `gap_quads` or the tessellation diagonal, sidestepping the "must NOT consume both `all_tris` + `gap_quads`" footgun. Inputs flow through `OverrideSpec { kind, q, r, value }` (pins per-hex height/radius post-noise; mapped to `Override`), `EntangleSpec { q, r }` (marks a hex as entangled; mapped to `Hex`), `NoiseChannel` (mirrors `NoiseType`), `VertexDir` (mirrors `hexx::VertexDirection` indices East..NorthEast). Outputs flow through `HexCellView { q, r, height, radius, entangled }` (Hex decomposed since foreign types can't carry `#[wasm_bindgen]`).

### Critical invariants

- **Gap ownership rules** are the heart of the geometry: each gap quad is emitted by exactly one of the two adjacent hexes (the one whose edge index is in `[0, 2, 4]`); each junction tri is emitted only when the origin hex is `GridVertex::coordinates()[0]`. `gap_filler`, `quad_bridge_edges`, `gap_quads`, and `gap_tris` all share these rules — change them in lockstep or the unit tests in `math.rs` and `layout.rs` will catch the drift.
- **JSON output is v1 only**: `{hexes, edges, quads, tris}`. The SVG previews share the v1 payload; the web 3D demo no longer fetches JSON — it calls the wasm module directly. (Earlier v2/v3 streams were removed when the wasm path replaced JSON-based mesh upload.)
- **Coordinate convention**: hex world positions live in `Vec2(x, z)`; `HGridLayout::vertex` lifts them to `Vec3(x, y=height, z)`. Triangle outputs are world-space `Vec3`; `gap_vertex_data` re-localizes to origin-relative positions for mesh upload.
- **Entanglement is opt-in**: cells default to `entangled: false`. The flag filters which face fans and gap-quad tris a given `tris(entangled)` / `face_tris(entangled)` / `wire_edges(entangled)` call emits, but never affects the 3-hex junction tris (`gap_tris()` is unfiltered).

## Preview pipeline

`make preview` runs `geo_export` three times (plain SVG, rich SVG, JSON v1 — all using `HSEED`), runs `wasm-pack build` once to produce `web/pkg/`, then templates `web/svg-preview.html` (with the short git SHA) and `web/hex-terrain.html` (with the short SHA + `RADIUS`) into `target/www-preview/`. Pin `HSEED` for a reproducible build (the chosen seed is echoed at the end); the SVG previews and `apicult-desigual.json` (v1) all share it.

The terrain page imports `pkg/apicult_desigual.js` and builds a **7-mesh flower cluster** on load: one center `WasmLayout` + six petal layouts arranged around it, each with its own fresh random u32 seeds (or seeded via the `seed` input for reproducibility — `splitmix32` derives 14 stable per-mesh seeds from one root). Each petal shares its inward-facing ring of hex cells with the center via WFC-style overrides + entangle markers, constructed by `web/hex-seam.js::seamSpec` — so the center owns those seams visually and the petal's mirror cells are skipped when its `tris(false)` / `face_tris(false)` / `wire_edges(false)` streams are pulled. The wasm handles are `.free()`'d after the buffers are extracted.

The terrain controls sidebar groups its inputs into five fieldsets:

- **grid** — radius, seed, nominal hex radius, petal distance, plus `apply` / `re-roll` buttons (rebuild required).
- **mesh** — `filled`, `flat shading` toggles.
- **wires** — `wireframe` (Line2 dashed) + `shader wire` (GLSL dashed; bloom-driven) toggles, plus `line width` and `dash speed` sliders affecting them. The two toggles are independent (no XOR).
- **shaders** — `ringed-entities` toggle. This is the band shader: concentric color rings on a random ~10% of hex face fans, base color (`FILL_COLORS[index]`) at the rim fading to `BG_COLOR` at the centroid via a per-vertex barycentric weight (`aWeight = 1.0` at fan-center vertex, `0.0` at perimeter corners; smooth varying interpolation + `floor(vWeight * uBands) / (uBands - 1.0)` quantizes into 5 steps). A `uBrightness` uniform pre-multiplies the band color by `ambient + sun_intensity * max(0, sun_dir.y)` so the overlay matches the lit `MeshStandardMaterial` fill — valid because flat-top hex face fans have a constant normal `(0, 1, 0)`.
- **post-fx** — bloom strength / radius / threshold.

The `.github/workflows/svg-preview.yml` CI installs the `wasm32-unknown-unknown` target and `wasm-pack`, runs `cargo test` then the same `make` target on push to `main` and on PRs, and publishes the result to the `gh-pages` branch only on push to `main` — so the live demo at https://dynnamitt.github.io/apicult-desigual-rs/ tracks `main` automatically.
