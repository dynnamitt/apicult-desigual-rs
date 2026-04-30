//! WebAssembly bindings for `apicult-desigual`. Gated behind the `wasm`
//! feature so native builds don't pull `wasm-bindgen`.
//!
//! Two renderable buffers cross the boundary, both filtered by an
//! `entangled` bool so callers can drive separate materials/passes:
//!   - `tris(entangled)` — the unified mesh stream (`all_tris`): hex faces
//!     + tessellated gap quads matching the flag, plus 3-way junction tris
//!     when `entangled = false` (junction tris are never entangled).
//!   - `wire_edges(entangled)` — gap-quad perimeter segments matching the
//!     flag, no internal tessellation diagonal. Drops straight into a
//!     `LineSegments` geometry for shader-driven wireframes.
//!
//! Numeric layout: tris are flat `n_tris * 9` floats (3 verts × 3 floats);
//! wire_edges are flat `n_edges * 6` floats (2 endpoints × 3 floats). Both
//! arrive as `Float32Array` on the JS side.
//!
//! Mirror types (`OverrideSpec`, `EntangleSpec`, `NoiseChannel`, `VertexDir`,
//! `HexCellView`) exist because `#[wasm_bindgen]` can't attach to foreign
//! types (`hexx::Hex`, `hexx::VertexDirection`) or to structs/tuples
//! containing them. Keeping them in this module localizes the bridge code.

use glam::Vec3;
use hexx::{Hex, VertexDirection};
use wasm_bindgen::prelude::*;

use crate::layout::{GapQuad, HGridLayout, HGridSettings, NoiseType, Override};

/// Mirror of `crate::NoiseType` exposed as a C-like enum for `wasm-bindgen`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseChannel {
    Height,
    Size,
}

impl From<NoiseChannel> for NoiseType {
    fn from(c: NoiseChannel) -> Self {
        match c {
            NoiseChannel::Height => NoiseType::Height,
            NoiseChannel::Size => NoiseType::Size,
        }
    }
}

/// Mirror of `hexx::VertexDirection` (a tuple struct in hexx, so re-expressed
/// here as a 6-variant enum). Indices match `VertexDirection::ALL_DIRECTIONS`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexDir {
    East = 0,
    SouthEast = 1,
    SouthWest = 2,
    West = 3,
    NorthWest = 4,
    NorthEast = 5,
}

impl From<VertexDir> for VertexDirection {
    fn from(v: VertexDir) -> Self {
        VertexDirection::ALL_DIRECTIONS[v as usize]
    }
}

/// Per-hex override input from JS. Maps to `crate::Override = (NoiseType, Hex, f32)`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct OverrideSpec {
    pub kind: NoiseChannel,
    pub q: i32,
    pub r: i32,
    pub value: f32,
}

#[wasm_bindgen]
impl OverrideSpec {
    #[wasm_bindgen(constructor)]
    pub fn new(kind: NoiseChannel, q: i32, r: i32, value: f32) -> Self {
        Self { kind, q, r, value }
    }
}

impl From<OverrideSpec> for Override {
    fn from(o: OverrideSpec) -> Self {
        (o.kind.into(), Hex::new(o.q, o.r), o.value)
    }
}

/// Per-hex entangle marker from JS. Maps to `hexx::Hex::new(q, r)`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct EntangleSpec {
    pub q: i32,
    pub r: i32,
}

#[wasm_bindgen]
impl EntangleSpec {
    #[wasm_bindgen(constructor)]
    pub fn new(q: i32, r: i32) -> Self {
        Self { q, r }
    }
}

impl From<EntangleSpec> for Hex {
    fn from(e: EntangleSpec) -> Self {
        Hex::new(e.q, e.r)
    }
}

/// Flattened `HexCell` (`hex` decomposed into `q`/`r` since `Hex` is foreign
/// and can't carry `#[wasm_bindgen]`).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct HexCellView {
    pub q: i32,
    pub r: i32,
    pub height: f32,
    pub radius: f32,
    pub entangled: bool,
}

/// Opaque handle wrapping `HGridLayout`. Build once, query repeatedly.
#[wasm_bindgen]
pub struct WasmLayout {
    inner: HGridLayout,
}

#[wasm_bindgen]
impl WasmLayout {
    /// Build a layout with project defaults (`HGridSettings::default()`)
    /// overridden by the explicit `radius` and noise seeds. `overrides`
    /// pin per-hex height/radius values after noise sampling; `entangle`
    /// marks the listed hexes as entangled.
    #[wasm_bindgen(constructor)]
    pub fn new(
        radius: u32,
        height_seed: u32,
        radius_seed: u32,
        overrides: Vec<OverrideSpec>,
        entangle: Vec<EntangleSpec>,
    ) -> Self {
        let settings = HGridSettings {
            radius,
            height_noise_seed: height_seed,
            radius_noise_seed: radius_seed,
            ..HGridSettings::default()
        };
        let mapped_overrides: Vec<Override> =
            overrides.into_iter().map(Override::from).collect();
        let mapped_entangle: Vec<Hex> = entangle.into_iter().map(Hex::from).collect();
        Self {
            inner: HGridLayout::new(&settings, &mapped_overrides, &mapped_entangle),
        }
    }

    /// Unified mesh stream filtered by entanglement. Flat `n_tris * 9` floats:
    /// gap quad tris + hex face fans matching `entangled`, plus junction tris
    /// when `entangled = false`.
    pub fn tris(&self, entangled: bool) -> Vec<f32> {
        flatten_tris(self.inner.all_tris(entangled))
    }

    /// Gap-quad perimeter segments matching `entangled`. Flat `n_edges * 6`
    /// floats (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
    /// `q[0]→q[1]→q[2]→q[3]→q[0]`. No tessellation diagonal — feed straight
    /// into a `THREE.LineSegments` geometry.
    pub fn wire_edges(&self, entangled: bool) -> Vec<f32> {
        flatten_wire_edges(self.inner.gap_quads(), entangled)
    }

    /// Cells along one outer side of the hexagon-shaped grid (see
    /// `HGridLayout::borderline_cells`). Returns `grid_radius + 1` views.
    pub fn borderline_cells(&self, direction: VertexDir) -> Vec<HexCellView> {
        self.inner
            .borderline_cells(direction.into())
            .map(|c| HexCellView {
                q: c.hex.x,
                r: c.hex.y,
                height: c.height,
                radius: c.radius,
                entangled: c.entangled,
            })
            .collect()
    }
}

fn flatten_tris(tris: Vec<[Vec3; 3]>) -> Vec<f32> {
    let mut out = Vec::with_capacity(tris.len() * 9);
    for [a, b, c] in tris {
        out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
    out
}

fn flatten_wire_edges(quads: Vec<GapQuad>, entangled: bool) -> Vec<f32> {
    let matching = quads.iter().filter(|q| q.entangled == entangled).count();
    let mut out = Vec::with_capacity(matching * 24);
    for q in quads {
        if q.entangled != entangled {
            continue;
        }
        let [a, b, c, d] = q.corners;
        out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z]);
        out.extend_from_slice(&[b.x, b.y, b.z, c.x, c.y, c.z]);
        out.extend_from_slice(&[c.x, c.y, c.z, d.x, d.y, d.z]);
        out.extend_from_slice(&[d.x, d.y, d.z, a.x, a.y, a.z]);
    }
    out
}
