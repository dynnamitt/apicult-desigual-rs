//! Streaming chunks: build any chunk of an unbounded world on demand from its
//! coordinate.
//!
//! A chunk is the radius-`chunk_radius` hexagon of cells with
//! `hex.to_lower_res(chunk_radius) == coord`. It is built by
//! [`HGridLayout::for_chunk`] with one extra entangled ring of neighbour cells,
//! then cut into two streams:
//!
//! - **owned** — what the chunk's own cells own. Across all chunks the owned
//!   streams cover the world with no overlap and no holes.
//! - **seams** — the gaps that ring cells own and that touch the chunk,
//!   grouped by [`Seam`] key `(owner, also)`. Each is a copy of triangles in
//!   the owner's owned stream. `also` names the third chunk a corner junction
//!   triangle touches; that chunk carries the same copy.
//!
//! Rules for consumers:
//! 1. Always draw the owned stream. Draw a seam only while [`Seam::drawn`]:
//!    its owner isn't loaded, and if it has an `also` chunk, that one isn't
//!    loaded either or sorts after the carrier in `(q, r)` order. Every
//!    triangle touching a loaded chunk is then drawn exactly once.
//! 2. Entangled cells are never state. A change to a cell goes to its owning
//!    chunk only.
//! 3. A changed cell rebuilds its own chunk and every chunk that has it in its
//!    entangled ring: 1 chunk for an interior cell, 2 along a chunk edge, 3 at
//!    a chunk corner.

use glam::{Vec2, Vec3};
use hexx::{Hex, shapes};

use crate::layout::{HGridLayout, HGridSettings, HexCell};

/// Deterministic per-coordinate chunk generator.
pub trait ChunkSource {
    /// Rings of cells per chunk; the same for every chunk this source yields.
    fn chunk_radius(&self) -> u32;
    /// Owned + seam geometry of chunk `coord`. Same seeds and coord give the same output.
    ///
    /// @param coord — the chunk's coordinate on the chunk lattice.
    /// @returns the chunk's cells, owned stream and seam groups.
    fn chunk(&self, coord: Hex) -> Chunk;
}

/// One chunk's state and geometry. Ring cells are dropped after building.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub coord: Hex,
    /// World `(x, z)` of the centre cell `coord.to_higher_res(chunk_radius)`.
    pub center: Vec2,
    /// Own cells, in `shapes::hexagon(center, chunk_radius)` order.
    pub cells: Vec<HexCell>,
    /// Owned stream: `owned_tris_into(cell, false)` of every own cell, concatenated.
    pub owned: Vec<[Vec3; 3]>,
    /// Triangle count of each cell's run in `owned`; parallel to `cells`.
    pub owned_runs: Vec<usize>,
    /// Seam groups in first-seen order walking `center.ring(chunk_radius + 1)`;
    /// empty groups omitted.
    pub seams: Vec<Seam>,
}

/// Triangles a neighbour chunk owns that touch the carrying chunk, keyed by `(owner, also)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Seam {
    /// Chunk whose owned stream holds these triangles.
    pub owner: Hex,
    /// Third chunk these triangles touch (corner junction tris only); it carries the same copy.
    pub also: Option<Hex>,
    pub tris: Vec<[Vec3; 3]>,
}

impl Seam {
    /// Consumer rule 1: whether the chunk `carrier` should draw this seam now.
    /// The `(q, r)` tie-break lets exactly one of two loaded carriers draw a corner.
    ///
    /// @param carrier — the chunk whose `seams` hold this one.
    /// @param loaded — whether a chunk coordinate is loaded.
    /// @returns true when no loaded chunk already draws these triangles.
    pub fn drawn(&self, carrier: Hex, loaded: impl Fn(Hex) -> bool) -> bool {
        !loaded(self.owner)
            && self
                .also
                .is_none_or(|b| !loaded(b) || (carrier.x, carrier.y) < (b.x, b.y))
    }
}

/// [`ChunkSource`] that samples noise per request via [`HGridLayout::for_chunk`].
/// One `settings` (and so one set of seeds) per world.
#[derive(Clone, Debug)]
pub struct NoiseWorld {
    /// Seeds and noise parameters; `settings.radius` is ignored.
    pub settings: HGridSettings,
    pub chunk_radius: u32,
}

impl ChunkSource for NoiseWorld {
    fn chunk_radius(&self) -> u32 {
        self.chunk_radius
    }

    fn chunk(&self, coord: Hex) -> Chunk {
        let r = self.chunk_radius;
        debug_assert!(self.settings.max_radius_ratio < 1.0, "corner-to-chunk lookup below needs gaps");
        let layout = HGridLayout::for_chunk(&self.settings, coord, r);
        let center = layout.center();

        let (cells, owned, owned_runs) = shapes::hexagon(center, r).fold(
            (Vec::new(), Vec::new(), Vec::new()),
            |(mut cells, mut owned, mut runs), h| {
                cells.push(layout.cell(&h).expect("own cell is in the chunk layout"));
                let (f, q, j) = layout.owned_tris_into(h, false, &mut owned);
                runs.push(f + q + j);
                (cells, owned, runs)
            },
        );

        // shortcut: a corner lies strictly inside its cell only while max_radius_ratio < 1;
        // at 1.0 junction tris are degenerate anyway. Carry hexes through owned_tris_into if that changes.
        let chunk_of = |v: &Vec3| layout.world_pos_to_hex(Vec2::new(v.x, v.z)).to_lower_res(r);
        let seams = center.ring(r + 1).fold(Vec::<Seam>::new(), |mut groups, h| {
            let owner = h.to_lower_res(r);
            let mut tris = Vec::new();
            layout.owned_tris_into(h, false, &mut tris);
            tris.into_iter().for_each(|t| {
                let also = t.iter().map(chunk_of).find(|&c| c != coord && c != owner);
                match groups.iter_mut().find(|s| s.owner == owner && s.also == also) {
                    Some(s) => s.tris.push(t),
                    None => groups.push(Seam { owner, also, tris: vec![t] }),
                }
            });
            groups
        });

        Chunk {
            coord,
            center: layout.hex_to_world_pos(center),
            cells,
            owned,
            owned_runs,
            seams,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use glam::Vec3;
    use hexx::{Hex, shapes};

    use super::*;
    use crate::layout::{HGridLayout, HGridSettings};

    const WORLD_RADIUS: u32 = 9;
    const CHUNK_RADII: [u32; 3] = [0, 1, 2];
    const SEAM_COORDS: [(i32, i32); 3] = [(0, 0), (1, 0), (-3, 2)];
    const MIN_FITTING_CHUNKS: usize = 7;
    // ≤ 6 neighbour owners, plus ≤ 6 corner groups (one per chunk corner).
    const MAX_SEAM_GROUPS: usize = 12;
    const COVER_RADII: [u32; 4] = [0, 1, 2, 3];
    const REGION_RADIUS: u32 = 2; // 19 chunks
    const RANDOM_SUBSETS: usize = 300;
    const SUBSET_SEED: u64 = 0x2727;
    // The chunk drawn in the geometry guide (docs/guide/gen.py asserts the same numbers).
    const GUIDE_OWNED: usize = 266;
    const GUIDE_SEAMS: [((i32, i32), usize); 6] = [
        ((0, 1), 6),
        ((-1, 1), 7),
        ((-1, 0), 12),
        ((0, -1), 9),
        ((1, -1), 8),
        ((1, 0), 4),
    ];

    fn world(chunk_radius: u32) -> NoiseWorld {
        NoiseWorld {
            settings: HGridSettings::default(),
            chunk_radius,
        }
    }

    fn tri_bits(t: &[Vec3; 3]) -> [u32; 9] {
        let [a, b, c] = t;
        [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].map(f32::to_bits)
    }

    #[test]
    fn owned_streams_partition_world() {
        for r in CHUNK_RADII {
            let g = HGridSettings {
                radius: WORLD_RADIUS,
                ..HGridSettings::default()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let fitting: HashSet<Hex> = shapes::hexagon(Hex::ZERO, WORLD_RADIUS)
                .map(|h| h.to_lower_res(r))
                // The entangled ring (distance r + 1 from the centre) must fit inside the world.
                .filter(|c| c.to_higher_res(r).length() as u32 + r < WORLD_RADIUS)
                .collect();
            assert!(fitting.len() >= MIN_FITTING_CHUNKS, "r {r}: {} chunks", fitting.len());

            let src = world(r);
            let mut got: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|&c| src.chunk(c).owned)
                .map(|t| tri_bits(&t))
                .collect();
            let mut want: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|c| shapes::hexagon(c.to_higher_res(r), r))
                .fold(Vec::new(), |mut out, h| {
                    layout.owned_tris_into(h, false, &mut out);
                    out
                })
                .iter()
                .map(tri_bits)
                .collect();
            got.sort_unstable();
            want.sort_unstable();
            assert_eq!(got, want, "r {r}");
        }
    }

    #[test]
    fn seams_match_owner_owned() {
        for r in CHUNK_RADII {
            let src = world(r);
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let c = src.chunk(coord);
                assert!((1..=MAX_SEAM_GROUPS).contains(&c.seams.len()), "r {r}: {}", c.seams.len());
                for Seam { owner, also, tris } in &c.seams {
                    assert_ne!(*owner, coord);
                    assert!(!tris.is_empty(), "r {r}: empty group {owner:?}");
                    if let Some(b) = also {
                        assert!(*b != coord && b != owner, "r {r}: also {b:?}");
                        assert!(coord.unsigned_distance_to(*b) == 1 && owner.unsigned_distance_to(*b) == 1, "r {r}: also {b:?}");
                    }
                    let owned: HashSet<[u32; 9]> =
                        src.chunk(*owner).owned.iter().map(tri_bits).collect();
                    assert!(
                        tris.iter().all(|t| owned.contains(&tri_bits(t))),
                        "r {r}: seam of {coord:?} not in owner {owner:?}"
                    );
                }
                let seam_total: usize = c.seams.iter().map(|s| s.tris.len()).sum();
                let layout = HGridLayout::for_chunk(&src.settings, coord, r);
                assert_eq!(c.owned.len() + seam_total, layout.all_tris(false).len(), "r {r}");
            }
        }
    }

    #[test]
    fn chunk_runs_and_cells_line_up() {
        for r in CHUNK_RADII {
            let c = world(r).chunk(Hex::new(-3, 2));
            let n = shapes::hexagon(c.coord.to_higher_res(r), r).count();
            assert_eq!(c.cells.len(), n);
            assert_eq!(c.owned_runs.len(), n);
            assert_eq!(c.owned_runs.iter().sum::<usize>(), c.owned.len());
            assert!(c.cells.iter().all(|cell| !cell.entangled));
        }
    }

    #[test]
    fn chunk_center_matches_layout() {
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let src = world(r);
                let layout = HGridLayout::for_chunk(&src.settings, coord, r);
                let want = layout.hex_to_world_pos(coord.to_higher_res(r));
                assert_eq!(src.chunk(coord).center, want, "r {r}, {coord:?}");
            }
        }
    }

    #[test]
    fn chunk_zero_radius_2_counts() {
        let c = world(2).chunk(Hex::ZERO);
        assert_eq!(c.owned.len(), GUIDE_OWNED);
        // The guide counts per owner; corner groups fold back into their owner.
        for ((q, s), n) in GUIDE_SEAMS {
            let owned_by = |seam: &&Seam| seam.owner == Hex::new(q, s);
            assert_eq!(c.seams.iter().filter(owned_by).map(|seam| seam.tris.len()).sum::<usize>(), n, "({q}, {s})");
        }
        let owners: HashSet<Hex> = c.seams.iter().map(|seam| seam.owner).collect();
        assert_eq!(owners.len(), GUIDE_SEAMS.len());
    }

    /// Loaded sets to check: every subset of the 1+6 around the origin, then
    /// random subsets of the whole region. Bit `i` loads `region[i]`.
    fn loaded_sets(region_len: usize) -> Vec<Vec<bool>> {
        let one_plus_six = (0u32..1 << 7).map(|m| (0..region_len).map(|i| i < 7 && m >> i & 1 == 1).collect());
        // splitmix64: no rand dependency for a test.
        let random = (0..RANDOM_SUBSETS as u64).map(|k| {
            let mut z = SUBSET_SEED.wrapping_add(k.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            let z = z ^ (z >> 31);
            (0..region_len).map(|i| z >> i & 1 == 1).collect()
        });
        one_plus_six.chain(random).collect()
    }

    #[test]
    fn drawn_seams_cover_loaded_chunks_once() {
        for r in COVER_RADII {
            let src = world(r);
            // The 1+6 first, so bits 0..7 of a loaded set pick them.
            let mut region: Vec<Hex> = std::iter::once(Hex::ZERO).chain(Hex::ZERO.ring(1)).collect();
            region.extend(shapes::hexagon(Hex::ZERO, REGION_RADIUS).filter(|h| h.length() > 1));
            let chunks: Vec<Chunk> = region.iter().map(|&c| src.chunk(c)).collect();
            // Number each distinct triangle once, so a loaded set is just counting.
            let mut ids = std::collections::HashMap::new();
            let mut id_of = |t: &[Vec3; 3]| {
                let n = ids.len();
                *ids.entry(tri_bits(t)).or_insert(n)
            };
            let owned: Vec<Vec<usize>> = chunks.iter().map(|c| c.owned.iter().map(&mut id_of).collect()).collect();
            let seams: Vec<Vec<Vec<usize>>> = chunks
                .iter()
                .map(|c| c.seams.iter().map(|s| s.tris.iter().map(&mut id_of).collect()).collect())
                .collect();

            for set in loaded_sets(region.len()) {
                let loaded = |h: Hex| region.iter().zip(&set).any(|(c, &on)| on && *c == h);
                let mut drawn = vec![0u8; ids.len()];
                let mut touching = vec![false; ids.len()];
                for (i, c) in chunks.iter().enumerate().filter(|&(i, _)| set[i]) {
                    owned[i].iter().for_each(|&t| (drawn[t], touching[t]) = (drawn[t] + 1, true));
                    for (s, tris) in c.seams.iter().zip(&seams[i]) {
                        let on = u8::from(s.drawn(c.coord, loaded));
                        tris.iter().for_each(|&t| (drawn[t], touching[t]) = (drawn[t] + on, true));
                    }
                }
                let twice = drawn.iter().filter(|&&n| n > 1).count();
                assert_eq!(twice, 0, "r {r}: {twice} duplicate tris, set {set:?}");
                // Every triangle touching a loaded chunk is in its owned or seam stream.
                let holes = touching.iter().zip(&drawn).filter(|&(&t, &n)| t && n == 0).count();
                assert_eq!(holes, 0, "r {r}: {holes} holes, set {set:?}");
            }
        }
    }

    #[test]
    fn chunk_is_deterministic() {
        let coord = Hex::new(-3, 2);
        assert_eq!(world(2).chunk(coord), world(2).chunk(coord));
        assert_eq!(world(2).chunk_radius(), 2);
    }
}
