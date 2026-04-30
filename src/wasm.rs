//! WebAssembly bindings for `apicult-desigual`. Gated behind the `wasm`
//! feature so native builds don't pull `wasm-bindgen`.
//!
//! Surface mirrors the geometry the web demo needs: gap quads (boundary edge
//! data and welded-mesh fill source) plus non-quad tris (junction tris and
//! hex face fans). `HGridLayout::all_tris` is intentionally NOT exposed —
//! it splits quads internally, so combining it with `gap_quads` would
//! double-count the gap geometry. Consumers triangulate quads on the JS
//! side.
//!
//! Numeric layout: tris are flat `n * 9` floats (3 verts × 3 components);
//! quads are flat `n * 12` floats (4 verts × 3 components). Both come back
//! as `Float32Array` on the JS side.

use glam::Vec3;
use hexx::{Hex, VertexDirection};
use wasm_bindgen::prelude::*;

use crate::layout::{HGridLayout, HGridSettings, NoiseType, Override};

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

/// Flattened `HexCell` (`hex` decomposed into `q`/`r` since `Hex` is foreign
/// and can't carry `#[wasm_bindgen]`).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct HexCellView {
    pub q: i32,
    pub r: i32,
    pub height: f32,
    pub radius: f32,
}

/// One-shot geometry payload returned by `generate_geometry`.
#[wasm_bindgen]
pub struct Geometry {
    tris: Vec<f32>,
    quads: Vec<f32>,
}

#[wasm_bindgen]
impl Geometry {
    #[wasm_bindgen(getter)]
    pub fn tris(&self) -> Vec<f32> {
        self.tris.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn quads(&self) -> Vec<f32> {
        self.quads.clone()
    }
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
    /// pin per-hex height/radius values after noise sampling.
    #[wasm_bindgen(constructor)]
    pub fn new(
        radius: u32,
        height_seed: u32,
        radius_seed: u32,
        overrides: Vec<OverrideSpec>,
    ) -> Self {
        let settings = HGridSettings {
            radius,
            height_noise_seed: height_seed,
            radius_noise_seed: radius_seed,
            ..HGridSettings::default()
        };
        let mapped: Vec<Override> = overrides.into_iter().map(Override::from).collect();
        Self {
            inner: HGridLayout::from_settings(&settings, &mapped),
        }
    }

    /// Non-quad triangles: `gap_tris` (3-hex junctions) + `hex_face_tris`
    /// (per-hex center fans). Flat `n * 9` floats. Quads must be
    /// triangulated separately by the consumer (see `quads`).
    pub fn tris(&self) -> Vec<f32> {
        let mut out = Vec::new();
        push_tris(&mut out, self.inner.gap_tris());
        push_tris(&mut out, self.inner.hex_face_tris());
        out
    }

    /// Gap quads as flat `n * 12` floats. Each 4 corners are CCW.
    pub fn quads(&self) -> Vec<f32> {
        flatten_quads(self.inner.gap_quads())
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
            })
            .collect()
    }
}

/// One-shot convenience: build a `WasmLayout`, return its `tris` + `quads`,
/// drop the layout. Use `WasmLayout` directly if you need additional queries.
#[wasm_bindgen]
pub fn generate_geometry(
    radius: u32,
    height_seed: u32,
    radius_seed: u32,
    overrides: Vec<OverrideSpec>,
) -> Geometry {
    let layout = WasmLayout::new(radius, height_seed, radius_seed, overrides);
    Geometry {
        tris: layout.tris(),
        quads: layout.quads(),
    }
}

fn push_tris(out: &mut Vec<f32>, tris: Vec<[Vec3; 3]>) {
    for [a, b, c] in tris {
        out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
}

fn flatten_quads(quads: Vec<[Vec3; 4]>) -> Vec<f32> {
    let mut out = Vec::with_capacity(quads.len() * 12);
    for [a, b, c, d] in quads {
        out.extend_from_slice(&[
            a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z,
        ]);
    }
    out
}
