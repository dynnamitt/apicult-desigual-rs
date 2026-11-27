//! Hex grid layout: spatial mapping, noise-driven heights/radii, vertex computation.

use glam::{Vec2, Vec3};
use hexx::{
    EdgeDirection, GridVertex, Hex, HexLayout, VertexDirection, shapes,
    storage::{HexStore, HexagonalMap},
};
use noise::{Fbm, MultiFractal, NoiseFn, Perlin};

use crate::math;

/// One noise channel: an Fbm over Perlin, sampled at world positions divided by `scale`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NoiseParams {
    /// Noise seed.
    pub seed: u32,
    /// Number of Fbm octaves.
    pub octaves: usize,
    /// Spatial scale divisor: world units per noise unit.
    pub scale: f64,
}

impl NoiseParams {
    /// The Fbm generator for this channel. Build it once and [`sample`](Self::sample) it per cell.
    pub fn build(&self) -> Fbm<Perlin> {
        Fbm::new(self.seed).set_octaves(self.octaves)
    }

    /// Raw noise at world position `pos`, roughly in `[-1, 1]`.
    ///
    /// @param fbm — the generator from [`build`](Self::build) on these same params.
    pub fn sample(&self, fbm: &Fbm<Perlin>, pos: Vec2) -> f64 {
        fbm.get([pos.x as f64 / self.scale, pos.y as f64 / self.scale])
    }
}

/// Noise and size settings, shared by every grid or chunk of a world.
///
/// The grid's extent isn't a setting: it is [`HGridLayout::new`]'s `radius`,
/// or [`HGridLayout::for_chunk`]'s `chunk_radius`.
#[derive(Clone, Debug)]
pub struct HGridSettings {
    /// Hex size — center-to-corner distance of a 100% / normal-form cell, in world units.
    /// Pointy-top width is √3·nominal_hex_radius; flat-top width is 2·nominal_hex_radius.
    /// Drives `HexLayout.scale`.
    pub nominal_hex_radius: f32,
    /// Height noise, mapped to `0..=max_height`.
    pub height_noise: NoiseParams,
    /// Per-hex radius noise, mapped to `min_radius_ratio..=max_radius_ratio` of `nominal_hex_radius`.
    pub radius_noise: NoiseParams,
    /// Maximum terrain elevation produced by the noise function.
    pub max_height: f32,
    /// Lower bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0`. Cell radii below 1.0 leave room for bridge geometry.
    pub min_radius_ratio: f32,
    /// Upper bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0` (`> 1.0` causes neighbor overlap).
    pub max_radius_ratio: f32,
}

impl Default for HGridSettings {
    fn default() -> Self {
        Self {
            nominal_hex_radius: 4.0,
            height_noise: NoiseParams {
                seed: 43,
                octaves: 4,
                scale: 50.0,
            },
            radius_noise: NoiseParams {
                seed: 137,
                octaves: 3,
                scale: 30.0,
            },
            max_height: 20.0,
            min_radius_ratio: 0.05,
            max_radius_ratio: 0.90,
        }
    }
}

/// Bundled per-hex state: axial position, terrain height and visual radius.
///
/// Whether a cell is entangled is not state: it follows from the cell's
/// position, see [`HGridLayout::is_entangled`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexCell {
    pub hex: Hex,
    pub height: f32,
    pub radius: f32,
}

/// Why [`HGridLayout::for_chunk`] can't build a chunk.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChunkError {
    /// An override names a hex outside the chunk and its entangled ring.
    OverrideOutsideChunk(Hex),
    /// An override's value is NaN or infinite.
    NonFiniteOverride(Hex),
    /// The chunk is so far from the origin that `to_lower_res` (which divides
    /// in `f32`) maps one of its own cells to another chunk.
    TooFarFromOrigin(Hex),
}

impl std::fmt::Display for ChunkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OverrideOutsideChunk(h) => {
                let (q, r) = (h.x, h.y);
                write!(f, "override at ({q}, {r}) is outside the chunk and its entangled ring")
            }
            Self::NonFiniteOverride(h) => write!(f, "override at ({}, {}) is not finite", h.x, h.y),
            Self::TooFarFromOrigin(c) => {
                write!(f, "chunk ({}, {}) is too far from the origin to build exactly", c.x, c.y)
            }
        }
    }
}

impl std::error::Error for ChunkError {}

/// Encapsulates the hex layout, per-cell data, and vertex computation.
///
/// Owns only the data needed for grid generation and height interpolation —
/// no ECS dependencies.
pub struct HGridLayout {
    layout: HexLayout,
    unit_corners: [Vec2; 6],
    center: Hex,
    grid_radius: u32,
    /// `true` for a chunk layout: its outer ring is the entangled ring.
    chunk: bool,
    cells: HexagonalMap<HexCell>,
}

/// Selects which per-hex channel an [`Override`] targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseType {
    Height,
    Size,
}

/// Per-hex override applied after noise sampling: sets the final value at
/// `hex` for the given channel (an absolute value, not an offset from noise).
pub type Override = (NoiseType, Hex, f32);

impl HGridLayout {
    /// Constructs a bounded grid of `radius` rings around the origin, sampling
    /// noise for heights and radii. Border cells miss neighbours, so they own
    /// fewer gap tris. No cell is entangled.
    pub fn new(g: &HGridSettings, radius: u32) -> Self {
        Self::build(g, Hex::ZERO, radius, false)
    }

    /// Builds chunk `coord`: the radius-`chunk_radius` hexagon of cells with
    /// `hex.to_lower_res(chunk_radius) == coord`, centred on
    /// `coord.to_higher_res(chunk_radius)`, plus the entangled ring at
    /// `chunk_radius + 1`. The ring cells belong to neighbour chunks: they are
    /// never state here, their faces are never drawn, and they only exist so
    /// every gap touching a chunk cell can be built. Noise is sampled at world
    /// positions, so a chunk built alone matches its neighbours exactly.
    ///
    /// @param g — seeds, noise and size settings.
    /// @param coord — the chunk's coordinate on the chunk lattice.
    /// @param chunk_radius — rings of cells per chunk; the same for every chunk of a world.
    /// @param overrides — stored edits for the chunk's own cells and its
    ///   entangled ring (the neighbours' edits), applied after sampling.
    /// @returns a layout of radius `chunk_radius + 1` around the chunk centre,
    ///   or why it can't be built: an override outside it or not finite, or a
    ///   chunk so far out that `to_lower_res`'s `f32` division puts an own or
    ///   ring cell in the wrong chunk (past roughly `16.7M / (3·chunk_radius + 2)`
    ///   cells), or that its centre doesn't fit in `i32`.
    pub fn for_chunk(
        g: &HGridSettings,
        coord: Hex,
        chunk_radius: u32,
        overrides: &[Override],
    ) -> Result<Self, ChunkError> {
        let center = chunk_center_hex(coord, chunk_radius)?;
        let mut layout = Self::build(g, center, chunk_radius + 1, true);
        layout.apply(overrides)?;
        Ok(layout)
    }

    /// Sets each override's channel on its cell.
    fn apply(&mut self, overrides: &[Override]) -> Result<(), ChunkError> {
        for &(channel, hex, value) in overrides {
            if !value.is_finite() {
                return Err(ChunkError::NonFiniteOverride(hex));
            }
            let cell = self.cells.get_mut(hex).ok_or(ChunkError::OverrideOutsideChunk(hex))?;
            match channel {
                NoiseType::Height => cell.height = value,
                NoiseType::Size => cell.radius = value,
            }
        }
        Ok(())
    }

    fn build(g: &HGridSettings, center: Hex, radius: u32, chunk: bool) -> Self {
        let layout = HexLayout {
            scale: Vec2::splat(g.nominal_hex_radius),
            ..HexLayout::default()
        };
        let unit_layout = HexLayout {
            scale: Vec2::splat(1.0),
            ..HexLayout::default()
        };
        let unit_corners_slice = unit_layout.center_aligned_hex_corners();
        let unit_corners: [Vec2; 6] = std::array::from_fn(|i| unit_corners_slice[i]);

        let height_fbm = g.height_noise.build();
        let radius_fbm = g.radius_noise.build();

        let radius_lo = g.nominal_hex_radius * g.min_radius_ratio;
        let radius_hi = g.nominal_hex_radius * g.max_radius_ratio;

        let cells = HexagonalMap::new(center, radius, |hex| {
            let pos = layout.hex_to_world_pos(hex);
            let h_noise = g.height_noise.sample(&height_fbm, pos);
            let r_noise = g.radius_noise.sample(&radius_fbm, pos);
            HexCell {
                hex,
                height: math::map_noise_to_range(h_noise, 0.0, g.max_height),
                radius: math::map_noise_to_range(r_noise, radius_lo, radius_hi),
            }
        });

        Self {
            layout,
            unit_corners,
            center,
            grid_radius: radius,
            chunk,
            cells,
        }
    }

    // ── Coordinate conversion ──────────────────────────────────────

    /// World-space 2D position of a hex center.
    pub fn hex_to_world_pos(&self, hex: Hex) -> Vec2 {
        self.layout.hex_to_world_pos(hex)
    }

    /// Hex coordinate from a world-space 2D position.
    pub fn world_pos_to_hex(&self, pos: Vec2) -> Hex {
        self.layout.world_pos_to_hex(pos)
    }

    // ── Per-hex data access ────────────────────────────────────────

    /// Bundled read view for a hex — `Some` only when the hex is in-grid.
    pub fn cell(&self, hex: &Hex) -> Option<HexCell> {
        self.cells.get(*hex).copied()
    }

    /// Whether `hex` is in a chunk layout's entangled ring (distance
    /// `chunk_radius + 1` from the centre): a neighbour chunk's cell, held here
    /// only so the gaps along the chunk's edge have both sides. Always `false`
    /// for a [`HGridLayout::new`] grid.
    pub fn is_entangled(&self, hex: Hex) -> bool {
        self.chunk && self.center.unsigned_distance_to(hex) == self.grid_radius
    }

    /// Computed world-space vertex position for `hex` at corner `index` (0..5).
    pub fn vertex(&self, hex: Hex, index: u8) -> Option<Vec3> {
        let cell = self.cells.get(hex)?;
        let center = self.layout.hex_to_world_pos(hex);
        let offset = self.unit_corners[index as usize] * cell.radius;
        Some(Vec3::new(center.x + offset.x, cell.height, center.y + offset.y))
    }

    /// Unit corner offset for a given corner index (0..5).
    pub fn unit_corner(&self, index: usize) -> Vec2 {
        self.unit_corners[index]
    }

    // ── Compute methods ────────────────────────────────────────────

    /// Returns the two **bridge** edges of each gap quad as `(from, to)` pairs:
    /// the edges that span across the gap connecting hex→neighbor (v0→n0 and
    /// v1→n1). The other two perimeter edges of a gap quad — the **rim** edges
    /// — run along one hex's side and are not returned here. Uses the even-edge
    /// `[0,2,4]` ownership rule so each gap is emitted exactly once.
    ///
    /// "Bridge" vs "rim" is a topological distinction (cross-gap vs along-hex),
    /// independent of relative size — the rim can be longer than the bridge
    /// when the hex radius is much larger than the gap padding.
    pub fn quad_bridge_edges(&self) -> Vec<(Vec3, Vec3)> {
        let mut edges = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for edge_index in [0u8, 2, 4] {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                if self.cells.get(neighbor).is_none() {
                    continue;
                }
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(hex, v1_idx),
                    self.vertex(neighbor, n1_idx),
                ) {
                    edges.push((a, b));
                    edges.push((c, d));
                }
            }
        }
        edges
    }

    /// Returns every gap quad as `[hex.v0, neighbor.n0, neighbor.n1, hex.v1]`
    /// in CCW order. Same `[0,2,4]` even-edge ownership as
    /// [`quad_bridge_edges`].
    pub fn gap_quads(&self) -> Vec<[Vec3; 4]> {
        let mut quads = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for edge_index in [0u8, 2, 4] {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(neighbor, n1_idx),
                    self.vertex(hex, v1_idx),
                ) {
                    quads.push([a, b, c, d]);
                }
            }
        }
        quads
    }

    /// Returns the six center-fan triangles of every hex's flat top face, in
    /// `shapes::hexagon` order. Hard-coded fan — no earcut needed for the
    /// flat-top case.
    pub fn hex_face_tris(&self) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            let Some(cell) = self.cells.get(hex) else {
                continue;
            };
            let height = cell.height;
            let center2 = self.layout.hex_to_world_pos(hex);
            let center = Vec3::new(center2.x, height, center2.y);
            for i in 0..6u8 {
                let j = (i + 1) % 6;
                if let (Some(a), Some(b)) = (self.vertex(hex, i), self.vertex(hex, j)) {
                    tris.push([center, a, b]);
                }
            }
        }
        tris
    }

    /// For each hex (same iteration / ordering as
    /// [`HGridLayout::hex_face_tris`]), returns the 6 face-edge bridge
    /// quads as a fixed-size array indexed by edge `0..6`:
    /// `Some([v0, n0, n1, v1])` if the neighbor on that edge exists in
    /// the grid, `None` for border edges.
    ///
    /// Quad-corner order matches [`HGridLayout::gap_quads`]:
    /// `corners[0]` / `corners[3]` lie on the source hex perimeter (the
    /// near edge of the bridge), `corners[1]` / `corners[2]` on the
    /// neighbor (the far edge). The two source-side corners are
    /// bit-exact the perimeter corners of the face-fan tri sharing that
    /// edge (both go through [`HGridLayout::vertex`]), so a band-shader
    /// overlay that paints both surfaces with `aWeight = 0` at the
    /// shared edge has no seam.
    ///
    /// Unlike [`gap_quads`], the even-edge ownership rule is **not**
    /// applied here — every face-edge of every hex is
    /// reported, so callers picking a random one of a hex's 6 tris can
    /// always recover its bridge geometry.
    pub fn hex_face_bridge_quads(&self) -> Vec<[Option<[Vec3; 4]>; 6]> {
        let mut out = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            let mut bridges: [Option<[Vec3; 4]>; 6] = [None; 6];
            for edge_index in 0..6u8 {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                if self.cells.get(neighbor).is_none() {
                    continue;
                }
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(neighbor, n1_idx),
                    self.vertex(hex, v1_idx),
                ) {
                    bridges[edge_index as usize] = Some([a, b, c, d]);
                }
            }
            out.push(bridges);
        }
        out
    }

    /// Returns the two triangles of every gap quad, split along the
    /// rust-canonical `[v0, v2]` diagonal: `[a, b, c]` then `[a, c, d]`.
    pub fn gap_quad_tris(&self) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for [a, b, c, d] in self.gap_quads() {
            tris.push([a, b, c]);
            tris.push([a, c, d]);
        }
        tris
    }

    /// Unified triangle stream: the concatenation of
    /// [`HGridLayout::owned_tris_into`] over every cell in `shapes::hexagon`
    /// order. All tessellation decisions are owned here, so clients consume
    /// one flat list with no per-source branching. Gap quads are split along
    /// the canonical `[v0, v2]` diagonal (`[a,b,c]` then `[a,c,d]`), winding
    /// identical to `gap_quad_tris`.
    ///
    /// For a chunk layout that is the chunk's own tris plus the entangled
    /// ring's seam tris, interleaved in hexagon order.
    pub fn all_tris(&self) -> Vec<[Vec3; 3]> {
        self.owned_tris_of(shapes::hexagon(self.center, self.grid_radius))
    }

    /// [`owned_tris_into`](Self::owned_tris_into) over `cells`, in their order.
    fn owned_tris_of(&self, cells: impl Iterator<Item = Hex>) -> Vec<[Vec3; 3]> {
        cells.fold(Vec::new(), |mut out, hex| {
            self.owned_tris_into(hex, &mut out);
            out
        })
    }

    /// The own cells: every cell of a `new` grid, or a chunk's cells without its
    /// entangled ring, in `shapes::hexagon` order.
    pub fn own_cells(&self) -> impl Iterator<Item = Hex> + '_ {
        shapes::hexagon(self.center, self.grid_radius - u32::from(self.chunk))
    }

    /// The own cells' state, parallel to [`own_cells`](Self::own_cells).
    pub fn own_cell_states(&self) -> Vec<HexCell> {
        self.own_cells().map(|h| self.cells[h]).collect()
    }

    /// The entangled ring's cells in `center.ring(chunk_radius + 1)` order;
    /// none for a `new` grid.
    pub fn entangled_ring(&self) -> impl Iterator<Item = Hex> + '_ {
        self.chunk.then(|| self.center.ring(self.grid_radius)).into_iter().flatten()
    }

    /// The tris the own cells own, cell by cell in [`own_cells`](Self::own_cells)
    /// order. In a chunk every own cell has all its neighbours, so each owns
    /// exactly 14: 6 face, 6 gap-quad and 2 junction tris (its `tri_sequence`).
    pub fn own_tris(&self) -> Vec<[Vec3; 3]> {
        self.owned_tris_of(self.own_cells())
    }

    /// The tris the entangled ring gives this chunk: per entangled cell, in
    /// [`entangled_ring`](Self::entangled_ring) order, its quads then its
    /// junctions. Each is a copy of a tri in the owning neighbour chunk's
    /// [`own_tris`](Self::own_tris). Empty for a `new` grid.
    pub fn entangled_seam_tris(&self) -> Vec<[Vec3; 3]> {
        self.owned_tris_of(self.entangled_ring())
    }

    /// `(quad_tris, junction_tris)` of each entangled cell, parallel to
    /// [`entangled_ring`](Self::entangled_ring): how
    /// [`entangled_seam_tris`](Self::entangled_seam_tris) splits up.
    pub fn entangled_seam_counts(&self) -> Vec<(usize, usize)> {
        self.entangled_ring()
            .map(|hex| {
                let gaps = self.owned_gaps(hex, true);
                let quads = gaps.quads.iter().flatten().count();
                (2 * quads, gaps.junctions.iter().flatten().count())
            })
            .collect()
    }

    /// Appends the triangles `hex` owns to `out` — the per-cell body of
    /// [`HGridLayout::all_tris`].
    ///
    /// A cell owns its face fan, the gap quads on its even edges `[0, 2, 4]`
    /// whose neighbor is in the layout, and the junction tris at its corners
    /// `[0, 1]` where all three cells are in the layout (every lattice vertex
    /// is corner 0 or 1 of exactly one of its three hexes).
    ///
    /// An entangled cell ([`HGridLayout::is_entangled`]) emits only what
    /// touches an own cell: no face fan and no quad to another entangled cell
    /// (decision D10 in `docs/design/cell-state.md`). What it emits are its
    /// chunk's entangled seam tris.
    ///
    /// @param hex — the owning cell; a hex outside the layout appends nothing.
    /// @param out — triangles are appended here.
    /// @returns `(face_tris, quad_tris, junction_tris)` appended.
    pub fn owned_tris_into(&self, hex: Hex, out: &mut Vec<[Vec3; 3]>) -> (usize, usize, usize) {
        let Some(&cell) = self.cells.get(hex) else {
            return (0, 0, 0);
        };
        let start = out.len();
        let center2 = self.layout.hex_to_world_pos(hex);
        let height = cell.height;
        let radius = cell.radius;
        let corners: [Vec3; 6] = std::array::from_fn(|i| {
            let off = self.unit_corners[i] * radius;
            Vec3::new(center2.x + off.x, height, center2.y + off.y)
        });

        let entangled = self.is_entangled(hex);
        if !entangled {
            let center = Vec3::new(center2.x, height, center2.y);
            for i in 0..6usize {
                let j = (i + 1) % 6;
                out.push([center, corners[i], corners[j]]);
            }
        }
        let after_faces = out.len();

        let gaps = self.owned_gaps(hex, entangled);
        for (edge_index, neighbor) in gaps.quads.into_iter().flatten() {
            let nb_cell = self.cells[neighbor];
            let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
            let nb_center2 = self.layout.hex_to_world_pos(neighbor);
            let nb_corner = |i: u8| {
                let off = self.unit_corners[i as usize] * nb_cell.radius;
                Vec3::new(nb_center2.x + off.x, nb_cell.height, nb_center2.y + off.y)
            };
            let a = corners[v0_idx as usize];
            let b = nb_corner(n0_idx);
            let c = nb_corner(n1_idx);
            let d = corners[v1_idx as usize];
            out.push([a, b, c]);
            out.push([a, c, d]);
        }
        let after_quads = out.len();

        for (v_idx, gv) in gaps.junctions.into_iter().flatten() {
            let coords = gv.coordinates();
            if let (Some(i1), Some(i2)) = (
                corner_index_for_vertex(coords[1], &gv),
                corner_index_for_vertex(coords[2], &gv),
            ) && let (Some(v1), Some(v2)) =
                (self.vertex(coords[1], i1), self.vertex(coords[2], i2))
            {
                let v0 = corners[v_idx as usize];
                out.push([v0, v1, v2]);
            }
        }

        (
            after_faces - start,
            after_quads - after_faces,
            out.len() - after_quads,
        )
    }

    /// [`owned_gaps`] of `hex` in this layout: a quad needs its neighbour in the
    /// layout and, from an `entangled` cell, not entangled itself (D10).
    fn owned_gaps(&self, hex: Hex, entangled: bool) -> OwnedGaps {
        let in_layout = |h: Hex| self.cells.get(h).is_some();
        let quad = |nb: Hex| in_layout(nb) && !(entangled && self.is_entangled(nb));
        owned_gaps(hex, quad, in_layout)
    }

    /// Returns the three world-space corners of every 3-hex junction gap tri.
    /// Ownership: each tri is emitted by the hex whose corner 0 or 1 it sits on;
    /// every lattice vertex is corner 0 or 1 of exactly one of its three hexes.
    pub fn gap_tris(&self) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for v_idx in [0u8, 1] {
                let dir = VertexDirection::ALL_DIRECTIONS[v_idx as usize];
                let gv = GridVertex {
                    origin: hex,
                    direction: dir,
                };
                let coords = gv.coordinates();
                if coords[0] != hex {
                    continue;
                }
                if !coords.iter().all(|c| self.cells.get(*c).is_some()) {
                    continue;
                }
                let idx1 = corner_index_for_vertex(coords[1], &gv);
                let idx2 = corner_index_for_vertex(coords[2], &gv);
                if let (Some(i1), Some(i2)) = (idx1, idx2)
                    && let (Some(v0), Some(v1), Some(v2)) = (
                        self.vertex(coords[0], v_idx),
                        self.vertex(coords[1], i1),
                        self.vertex(coords[2], i2),
                    )
                {
                    tris.push([v0, v1, v2]);
                }
            }
        }
        tris
    }

    /// Centre hex of the grid — `Hex::ZERO` for [`HGridLayout::new`], the chunk
    /// centre for [`HGridLayout::for_chunk`].
    pub fn center(&self) -> Hex {
        self.center
    }

    /// Grid radius (number of hex rings around the centre).
    pub fn grid_radius(&self) -> u32 {
        self.grid_radius
    }

    /// Nominal hex radius (center-to-corner of a 100% cell), reading the layout's `scale.x`.
    pub fn nominal_hex_radius(&self) -> f32 {
        self.layout.scale.x
    }

    /// Inverse-distance-weighted height interpolation from nearby hex vertices.
    pub fn interpolate_height(&self, pos: Vec2) -> f32 {
        let hex = self.layout.world_pos_to_hex(pos);
        let vertices: Vec<Vec3> = std::iter::once(hex)
            .chain(hex.all_neighbors())
            .flat_map(|h| (0..6u8).filter_map(move |i| self.vertex(h, i)))
            .collect();
        math::idw_interpolate_height(pos, &vertices)
            .unwrap_or_else(|| self.cells.get(hex).map(|c| c.height).unwrap_or(0.0))
    }
}

/// The centre cell of chunk `coord`, if the chunk can be built exactly: its
/// centre and ring fit in `i32`, and `to_lower_res` (which divides in `f32`)
/// maps its own cells to `coord` and its ring cells elsewhere. Shared by
/// [`HGridLayout::for_chunk`] and `entangled_seam_keys`, so both reject the
/// same chunks.
pub(crate) fn chunk_center_hex(coord: Hex, chunk_radius: u32) -> Result<Hex, ChunkError> {
    // `to_higher_res` multiplies in `i32`: rule out overflow (a panic in
    // debug builds) before calling it, with room for the ring.
    let (range, q, r) = (i64::from(chunk_radius), i64::from(coord.x), i64::from(coord.y));
    let fits = |v: i64| v.abs() + range < i64::from(i32::MAX);
    let (cq, cr) = (q * (range + 1) + range * (q + r), r * (range + 1) - range * q);
    if ![q + r, cq, cr, cq + cr].into_iter().all(fits) {
        return Err(ChunkError::TooFarFromOrigin(coord));
    }
    let center = coord.to_higher_res(chunk_radius);
    // Own cells must map to `coord` and ring cells away from it: seam owners
    // (`entangled_seam_keys`) come from the ring cells' `to_lower_res`.
    let misplaced = shapes::hexagon(center, chunk_radius + 1).any(|h| {
        let own = center.unsigned_distance_to(h) <= chunk_radius;
        (h.to_lower_res(chunk_radius) == coord) != own
    });
    if misplaced {
        return Err(ChunkError::TooFarFromOrigin(coord));
    }
    Ok(center)
}

/// The gap pieces a cell owns, by hex coordinates only (no heights or radii).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct OwnedGaps {
    /// `(edge_index, neighbour)` of each owned gap quad, edges `[0, 2, 4]` in order.
    pub quads: [Option<(u8, Hex)>; 3],
    /// `(corner_index, vertex)` of each owned junction, corners `[0, 1]` in order.
    pub junctions: [Option<(u8, GridVertex)>; 2],
}

/// What `hex` owns besides its face, under the ownership rules: the quads on
/// its even edges `[0, 2, 4]` whose neighbour passes `quad`, and the junctions
/// at its corners `[0, 1]` whose three cells all pass `exists` (every lattice
/// vertex is corner 0 or 1 of exactly one of its three hexes).
///
/// [`HGridLayout::owned_tris_into`] emits these pieces in this order, and
/// `entangled_seam_keys` keys them without a layout, so both share one rule.
pub(crate) fn owned_gaps(
    hex: Hex,
    quad: impl Fn(Hex) -> bool,
    exists: impl Fn(Hex) -> bool,
) -> OwnedGaps {
    let mut gaps = OwnedGaps::default();
    for (slot, edge_index) in [0u8, 2, 4].into_iter().enumerate() {
        let neighbor = hex.neighbor(EdgeDirection::ALL_DIRECTIONS[edge_index as usize]);
        if quad(neighbor) {
            gaps.quads[slot] = Some((edge_index, neighbor));
        }
    }
    for v_idx in [0u8, 1] {
        let gv = GridVertex {
            origin: hex,
            direction: VertexDirection::ALL_DIRECTIONS[v_idx as usize],
        };
        let coords = gv.coordinates();
        if coords[0] == hex && coords.iter().all(|&c| exists(c)) {
            gaps.junctions[v_idx as usize] = Some((v_idx, gv));
        }
    }
    gaps
}

fn corner_index_for_vertex(hex: Hex, target: &GridVertex) -> Option<u8> {
    VertexDirection::ALL_DIRECTIONS.iter().find_map(|&dir| {
        let candidate = GridVertex {
            origin: hex,
            direction: dir,
        };
        candidate.equivalent(target).then_some(dir.index())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_RADIUS: u32 = 4;
    /// Grid radius for tests that don't care about it (the old `HGridSettings::radius` default).
    const GRID_RADIUS: u32 = 20;
    const GRID_TRIS_GOLDEN: u64 = 6_321_228_726_395_634_444;
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;

    fn default_settings() -> HGridSettings {
        HGridSettings::default()
    }

    /// 64-bit FNV-1a over the `f32` bit patterns of every vertex coordinate.
    fn fnv1a_tris(tris: &[[Vec3; 3]]) -> u64 {
        tris.iter()
            .flat_map(|t| t.iter().flat_map(|v| [v.x, v.y, v.z]))
            .fold(FNV_OFFSET, |h, f| {
                (h ^ u64::from(f.to_bits())).wrapping_mul(FNV_PRIME)
            })
    }

    #[test]
    fn grid_tris_golden_checksum() {
        // Pins a `new` grid's all_tris byte-for-byte; the value is the old
        // `all_tris(false)` of the same grid with no entangled cells. Update the
        // constant only on an intentional geometry change.
        let layout = HGridLayout::new(&default_settings(), GOLDEN_RADIUS);
        assert_eq!(fnv1a_tris(&layout.all_tris()), GRID_TRIS_GOLDEN);
    }

    const CHUNK_GOLDEN_COORD: (i32, i32) = (1, -2);
    const CHUNK_GOLDEN_RADIUS: u32 = 3;
    const CHUNK_TRIS_GOLDEN: u64 = 14_654_224_851_271_909_658;

    #[test]
    fn chunk_tris_golden_checksum() {
        // Pins one chunk byte-for-byte (docs/design/cell-state.md, D11): each own cell's
        // 14 tris in `shapes::hexagon` order, then the entangled seam tris (per ring cell,
        // quads then junctions) in `ring(r + 1)` order. Update the constant only on an
        // intentional geometry change.
        let (r, (q, s)) = (CHUNK_GOLDEN_RADIUS, CHUNK_GOLDEN_COORD);
        let layout = HGridLayout::for_chunk(&default_settings(), Hex::new(q, s), r, &[]).unwrap();
        let center = layout.center();
        let mut tris = Vec::new();
        for h in shapes::hexagon(center, r) {
            let counts = layout.owned_tris_into(h, &mut tris);
            assert_eq!(counts, (6, 6, 2), "own cell {h:?}");
        }
        for h in center.ring(r + 1) {
            let (faces, ..) = layout.owned_tris_into(h, &mut tris);
            assert_eq!(faces, 0, "entangled cell {h:?} emits no face");
        }
        assert_eq!(
            tris.len(),
            layout.all_tris().len(),
            "own + seam tris cover the chunk"
        );
        assert_eq!(fnv1a_tris(&tris), CHUNK_TRIS_GOLDEN);
    }

    const CHUNK_COORDS: [(i32, i32); 5] = [(0, 0), (1, 0), (0, -1), (-3, 2), (4, -7)];
    const CHUNK_TRI_COUNTS: [(u32, usize); 3] = [(1, 126), (2, 312), (3, 582)];

    #[test]
    fn chunk_cells_map_back_to_coord() {
        for r in 0..=3u32 {
            for (q, s) in CHUNK_COORDS {
                let coord = Hex::new(q, s);
                let layout = HGridLayout::for_chunk(&default_settings(), coord, r, &[]).unwrap();
                let center = layout.center();
                assert_eq!(center, coord.to_higher_res(r), "r {r}, {coord:?}");
                assert_eq!(layout.grid_radius(), r + 1);
                for h in shapes::hexagon(center, r) {
                    assert_eq!(h.to_lower_res(r), coord, "r {r}: {h:?} outside {coord:?}");
                    assert!(!layout.is_entangled(h), "r {r}: {h:?} entangled");
                }
                for h in center.ring(r + 1) {
                    assert!(layout.is_entangled(h), "r {r}: ring {h:?} not entangled");
                    assert_ne!(h.to_lower_res(r), coord, "r {r}: ring {h:?} inside {coord:?}");
                }
            }
        }
    }

    #[test]
    fn for_chunk_all_tris_counts() {
        for coord in [Hex::ZERO, Hex::new(-3, 2)] {
            for (r, n) in CHUNK_TRI_COUNTS {
                let layout = HGridLayout::for_chunk(&default_settings(), coord, r, &[]).unwrap();
                assert_eq!(layout.all_tris().len(), n, "r {r}, {coord:?}");
            }
        }
    }

    #[test]
    fn all_tris_is_concat_of_owned_tris_into() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, 2);
        let concat = shapes::hexagon(Hex::ZERO, 2).fold(Vec::new(), |mut out, hex| {
            layout.owned_tris_into(hex, &mut out);
            out
        });
        assert_eq!(concat, layout.all_tris());
    }

    #[test]
    fn owned_tris_into_counts_match_appended() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, 2);
        let mut out = Vec::new();
        for hex in shapes::hexagon(Hex::ZERO, 2) {
            let before = out.len();
            let (f, q, j) = layout.owned_tris_into(hex, &mut out);
            assert_eq!(out.len() - before, f + q + j, "{hex:?}");
            assert!(f == 0 || f == 6, "{hex:?}: face tris {f}");
            assert!(q % 2 == 0 && q <= 6, "{hex:?}: quad tris {q}");
            assert!(j <= 2, "{hex:?}: junction tris {j}");
        }
        let before = out.len();
        assert_eq!(layout.owned_tris_into(Hex::new(999, 999), &mut out), (0, 0, 0));
        assert_eq!(out.len(), before);
    }

    #[test]
    fn new_populates_all_hexes() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        let expected = shapes::hexagon(Hex::ZERO, GRID_RADIUS).count();
        assert_eq!(layout.cells.len(), expected);
    }

    #[test]
    fn new_grid_has_no_entangled_cells() {
        let layout = HGridLayout::new(&default_settings(), 3);
        assert!(shapes::hexagon(Hex::ZERO, 4).all(|h| !layout.is_entangled(h)));
    }

    #[test]
    fn entangled_cells_emit_only_what_touches_the_chunk() {
        // D10: no face fan, no quad between two entangled cells, and every tri
        // touches an own cell (some vertex lies within the own hexagon's reach).
        let r = 2;
        let layout = HGridLayout::for_chunk(&default_settings(), Hex::new(2, -1), r, &[]).unwrap();
        let center = layout.center();
        let own_corners: Vec<Vec3> = shapes::hexagon(center, r)
            .flat_map(|h| (0..6).map(move |i| (h, i)))
            .map(|(h, i)| layout.vertex(h, i).unwrap())
            .collect();
        for h in center.ring(r + 1) {
            let mut tris = Vec::new();
            let (faces, quads, junctions) = layout.owned_tris_into(h, &mut tris);
            assert_eq!(faces, 0, "{h:?}");
            assert!(quads <= 4 && junctions <= 2, "{h:?}: {quads} quad, {junctions} junction tris");
            for t in &tris {
                assert!(t.iter().any(|v| own_corners.contains(v)), "{h:?}: {t:?} misses the chunk");
            }
        }
    }

    #[test]
    fn hex_to_world_and_back_roundtrip() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        for hex in shapes::hexagon(Hex::ZERO, 3) {
            let world = layout.hex_to_world_pos(hex);
            let back = layout.world_pos_to_hex(world);
            assert_eq!(hex, back, "roundtrip failed for {hex:?}");
        }
    }

    #[test]
    fn vertex_returns_six_positions_per_hex() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        for i in 0..6u8 {
            assert!(
                layout.vertex(Hex::ZERO, i).is_some(),
                "vertex {i} should exist"
            );
        }
    }

    #[test]
    fn interpolate_at_center_uniform_height() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, 1);
        let h = layout.interpolate_height(Vec2::ZERO);
        let center_h = layout.cell(&Hex::ZERO).unwrap().height;
        assert!(
            (h - center_h).abs() < 2.0,
            "interpolated height {h} should be near center height {center_h}"
        );
    }

    #[test]
    fn unit_corner_returns_six_distinct_offsets() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        let corners: Vec<Vec2> = (0..6).map(|i| layout.unit_corner(i)).collect();
        for i in 0..6 {
            for j in (i + 1)..6 {
                assert_ne!(corners[i], corners[j], "corners {i} and {j} are identical");
            }
        }
    }

    #[test]
    fn hex_face_tris_count_is_six_per_hex() {
        for r in [0u32, 1, 2, 4] {
            let g = default_settings();
            let layout = HGridLayout::new(&g, r);
            let hex_count = shapes::hexagon(Hex::ZERO, r).count();
            let tris = layout.hex_face_tris();
            assert_eq!(
                tris.len(),
                hex_count * 6,
                "radius {r}: expected {} fan tris, got {}",
                hex_count * 6,
                tris.len()
            );
        }
    }

    #[test]
    fn hex_face_tris_share_height_per_hex() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, 1);
        let tris = layout.hex_face_tris();
        for (i, tri) in tris.iter().enumerate() {
            let y0 = tri[0].y;
            let y1 = tri[1].y;
            let y2 = tri[2].y;
            assert!(
                (y0 - y1).abs() < 1e-4 && (y0 - y2).abs() < 1e-4,
                "tri {i}: heights differ ({y0}, {y1}, {y2}) — face should be flat"
            );
        }
    }

    #[test]
    fn hex_face_bridge_quads_per_hex_shape() {
        // Radius-1 grid: 1 center + 6 borders. Center sees 6 in-grid
        // neighbors → 6 bridges; each border sees 3.
        let g = default_settings();
        let layout = HGridLayout::new(&g, 1);
        let bridges = layout.hex_face_bridge_quads();
        assert_eq!(bridges.len(), 7);
        let counts: Vec<usize> = bridges
            .iter()
            .map(|b| b.iter().filter(|q| q.is_some()).count())
            .collect();
        let six = counts.iter().filter(|&&c| c == 6).count();
        let three = counts.iter().filter(|&&c| c == 3).count();
        assert_eq!(six, 1, "exactly one hex (center) should have 6 bridges; got {counts:?}");
        assert_eq!(three, 6, "six border hexes should have 3 bridges; got {counts:?}");
    }

    #[test]
    fn hex_face_bridge_quads_emit_each_gap_twice() {
        // Every gap quad is shared by two hexes, and each hex reports both
        // its `[0, 2, 4]` and `[1, 3, 5]` edges, so the total Some-count
        // is exactly 2× the canonical `gap_quads().len()`.
        for r in [1u32, 2, 4] {
            let g = default_settings();
            let layout = HGridLayout::new(&g, r);
            let bridges = layout.hex_face_bridge_quads();
            let some_count: usize = bridges
                .iter()
                .map(|b| b.iter().filter(|q| q.is_some()).count())
                .sum();
            assert_eq!(some_count, layout.gap_quads().len() * 2);
        }
    }

    #[test]
    fn hex_face_bridge_quads_share_corners_with_face_tris() {
        // The two source-side corners of each Some bridge must match the
        // perimeter corners of the face-fan tri that owns the same edge.
        // `shapes::hexagon` shares its order between hex_face_tris and
        // hex_face_bridge_quads, so the i-th hex's 6 tris live at
        // face_tris[i*6 .. (i+1)*6] alongside bridges[i].
        let g = default_settings();
        let layout = HGridLayout::new(&g, 1);
        let face_tris = layout.hex_face_tris();
        let bridges = layout.hex_face_bridge_quads();
        let center_idx = bridges
            .iter()
            .position(|b| b.iter().all(|q| q.is_some()))
            .expect("one hex must have all 6 in-grid neighbors at radius=1");
        let base = center_idx * 6;
        for edge_index in 0..6usize {
            let tri = face_tris[base + edge_index];
            let q = bridges[center_idx][edge_index].expect("center has all 6 bridges");
            // Face-fan tri vertices: [center, perimeter_i, perimeter_(i+1)].
            // Bridge quad: [v0 = perimeter_i, n0, n1, v1 = perimeter_(i+1)].
            assert_eq!(tri[1], q[0], "edge {edge_index}: tri.v1 vs bridge.v0");
            assert_eq!(tri[2], q[3], "edge {edge_index}: tri.v2 vs bridge.v1");
        }
    }

    #[test]
    fn all_tris_count_matches_components() {
        for r in [1u32, 2, 4] {
            let g = default_settings();
            let layout = HGridLayout::new(&g, r);
            let quad_tris = layout.gap_quad_tris().len();
            let gap_tris = layout.gap_tris().len();
            let face_tris = layout.hex_face_tris().len();
            let total = layout.all_tris().len();
            assert_eq!(
                total,
                quad_tris + gap_tris + face_tris,
                "radius {r}: all_tris() should equal gap_quad_tris() + gap_tris + hex_face_tris()"
            );
        }
    }

    #[test]
    fn all_tris_equals_components_as_multiset() {
        for r in [1u32, 2, 4] {
            let g = default_settings();
            let layout = HGridLayout::new(&g, r);
            let mut combined: Vec<[Vec3; 3]> = layout.gap_quad_tris();
            combined.extend(layout.gap_tris());
            combined.extend(layout.hex_face_tris());
            let single = layout.all_tris();

            let key = |t: &[Vec3; 3]| {
                let mut bits: [[u32; 3]; 3] = std::array::from_fn(|i| {
                    [t[i].x.to_bits(), t[i].y.to_bits(), t[i].z.to_bits()]
                });
                bits.sort();
                bits
            };
            let mut a: Vec<_> = combined.iter().map(key).collect();
            let mut b: Vec<_> = single.iter().map(key).collect();
            a.sort();
            b.sort();
            assert_eq!(
                a, b,
                "radius {r}: all_tris() multiset diverges from components"
            );
        }
    }

    #[test]
    fn overrides_replace_noise_values() {
        let (g, coord, r) = (default_settings(), Hex::new(1, -1), 2);
        let baseline = HGridLayout::for_chunk(&g, coord, r, &[]).unwrap();
        let center = baseline.center();
        let ring_cell = center.ring(r + 1).next().unwrap();
        let neighbor = center + Hex::new(1, 0);
        let overrides = [
            (NoiseType::Height, center, 12.5),
            (NoiseType::Size, center, 1.75),
            (NoiseType::Height, ring_cell, -3.0),
        ];
        let pinned = HGridLayout::for_chunk(&g, coord, r, &overrides).unwrap();

        let pinned_center = pinned.cell(&center).unwrap();
        assert_eq!((pinned_center.height, pinned_center.radius), (12.5, 1.75));
        let ring_height = pinned.cell(&ring_cell).unwrap().height;
        assert_eq!(ring_height, -3.0, "a neighbour's edit lands on the ring");
        assert_eq!(pinned.cell(&neighbor), baseline.cell(&neighbor));
    }

    #[test]
    fn for_chunk_rejects_bad_overrides() {
        let (g, coord, r) = (default_settings(), Hex::new(1, -1), 2);
        let center = coord.to_higher_res(r);
        let outside = center + Hex::new(r as i32 + 2, 0);
        let build = |o: Override| HGridLayout::for_chunk(&g, coord, r, &[o]).err();
        use ChunkError::{NonFiniteOverride, OverrideOutsideChunk};
        let outside_err = build((NoiseType::Height, outside, 1.0));
        assert_eq!(outside_err, Some(OverrideOutsideChunk(outside)));
        assert_eq!(build((NoiseType::Size, center, f32::NAN)), Some(NonFiniteOverride(center)));
        let inf_err = build((NoiseType::Height, center, f32::INFINITY));
        assert_eq!(inf_err, Some(NonFiniteOverride(center)));
    }

    #[test]
    fn for_chunk_rejects_chunks_past_f32_range() {
        let (g, r) = (default_settings(), 6);
        let far = Hex::new(2_000_000, 0);
        let err = HGridLayout::for_chunk(&g, far, r, &[]).err();
        assert_eq!(err, Some(ChunkError::TooFarFromOrigin(far)));
        // So far out that `to_higher_res` would overflow `i32`.
        for huge in [Hex::new(i32::MAX, 0), Hex::new(0, i32::MIN), Hex::new(400_000_000, -1)] {
            let err = HGridLayout::for_chunk(&g, huge, r, &[]).err();
            assert_eq!(err, Some(ChunkError::TooFarFromOrigin(huge)));
        }
        assert!(HGridLayout::for_chunk(&g, Hex::new(-3, 2), r, &[]).is_ok());
    }

    #[test]
    fn cell_returns_in_grid_data() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        for hex in [Hex::ZERO, Hex::new(1, 0)] {
            let cell = layout.cell(&hex).expect("in-grid hex");
            assert_eq!(cell.hex, hex);
        }
    }

    #[test]
    fn cell_returns_none_off_grid() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, GRID_RADIUS);
        assert_eq!(layout.cell(&Hex::new(999, 999)), None);
    }

    #[test]
    fn quad_bridge_edges_count_matches_gap_filler() {
        for r in [1, 2, 4] {
            let g = default_settings();
            let layout = HGridLayout::new(&g, r);
            let grid: Vec<Hex> = shapes::hexagon(Hex::ZERO, r).collect();
            let (expected_quads, _) = crate::math::gap_filler(&grid);
            let edges = layout.quad_bridge_edges();
            assert_eq!(
                edges.len(),
                expected_quads * 2,
                "radius {r}: expected {} bridge edges ({}×2), got {}",
                expected_quads * 2,
                expected_quads,
                edges.len()
            );
        }
    }

    #[test]
    fn nominal_hex_radius_field_and_accessor_exist() {
        let s = HGridSettings {
            nominal_hex_radius: 4.0,
            ..HGridSettings::default()
        };
        let layout = HGridLayout::new(&s, GRID_RADIUS);
        assert_eq!(layout.nominal_hex_radius(), 4.0);
    }

    #[test]
    fn per_cell_radii_respect_ratio_bounds() {
        let s = HGridSettings {
            nominal_hex_radius: 4.0,
            min_radius_ratio: 0.05,
            max_radius_ratio: 0.65,
            ..HGridSettings::default()
        };
        let radius = 5;
        let layout = HGridLayout::new(&s, radius);

        let lo = s.nominal_hex_radius * s.min_radius_ratio;
        let hi = s.nominal_hex_radius * s.max_radius_ratio;
        let eps = 1e-4;

        let (min_r, max_r) = hexx::shapes::hexagon(Hex::ZERO, radius)
            .map(|h| layout.cell(&h).unwrap().radius)
            .fold(
                (f32::INFINITY, f32::NEG_INFINITY),
                |(min, max), r| (min.min(r), max.max(r)),
            );

        assert!(min_r >= lo - eps, "min radius {min_r} below floor {lo}");
        assert!(max_r <= hi + eps, "max radius {max_r} above ceiling {hi}");
    }
}
