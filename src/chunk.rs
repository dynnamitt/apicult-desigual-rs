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
//! - **seams** — the entangled seam tris: the gaps that ring cells own and
//!   that touch the chunk ([`HGridLayout::entangled_seam_tris`]), grouped by
//!   their [`EntangledSeam`] key `(owner, also)`. Each is a copy of triangles in
//!   the owner's owned stream. `also` names the third chunk a corner junction
//!   triangle touches; that chunk carries the same copy. The keys come from hex
//!   coordinates alone ([`entangled_seam_keys`]).
//!
//! Rules for consumers:
//! 1. Always draw the owned stream. Draw a seam only while [`EntangledSeam::drawn`]:
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

use crate::layout::{ChunkError, HGridLayout, HGridSettings, HexCell, owned_gaps};

/// Deterministic per-coordinate chunk generator.
pub trait ChunkSource {
    /// Rings of cells per chunk; the same for every chunk this source yields.
    fn chunk_radius(&self) -> u32;
    /// Owned + seam geometry of chunk `coord`. Same seeds and coord give the same output.
    ///
    /// @param coord — the chunk's coordinate on the chunk lattice.
    /// @returns the chunk's cells, owned stream and seam groups, or why the
    ///   chunk can't be built (see [`HGridLayout::for_chunk`]).
    fn chunk(&self, coord: Hex) -> Result<Chunk, ChunkError>;
}

/// One chunk's state and geometry. Ring cells are dropped after building.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub coord: Hex,
    /// World `(x, z)` of the centre cell `coord.to_higher_res(chunk_radius)`.
    pub center: Vec2,
    /// Own cells, in `shapes::hexagon(center, chunk_radius)` order.
    pub cells: Vec<HexCell>,
    /// Owned stream: `owned_tris_into(cell)` of every own cell, concatenated.
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
    /// This group's key.
    pub fn key(&self) -> EntangledSeam {
        EntangledSeam { owner: self.owner, also: self.also }
    }
}

/// The key of an entangled seam tri: which chunk owns it, and which third
/// chunk (if any) it also touches. A seam tri with no `also` touches only its
/// owner and the carrying chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EntangledSeam {
    /// Chunk whose owned stream holds the tri.
    pub owner: Hex,
    /// Third chunk a corner junction tri touches; it carries the same copy.
    pub also: Option<Hex>,
}

impl EntangledSeam {
    /// Consumer rule 1: whether chunk `carrier` should draw a seam tri with
    /// this key now. The `(q, r)` tie-break lets exactly one of two loaded
    /// carriers draw a corner. `testdata/entangled_seam_drawn.tsv` holds the
    /// cases every port of this rule is tested against.
    ///
    /// @param carrier {Hex} — the chunk whose entangled seam tris hold this one.
    /// @param loaded {impl Fn(Hex) -> bool} — whether a chunk coordinate is loaded.
    /// @returns {bool} true when no loaded chunk already draws the tri.
    pub fn drawn(&self, carrier: Hex, loaded: impl Fn(Hex) -> bool) -> bool {
        !loaded(self.owner)
            && self
                .also
                .is_none_or(|b| !loaded(b) || (carrier.x, carrier.y) < (b.x, b.y))
    }
}

/// The key of each of chunk `coord`'s entangled seam tris, parallel to
/// [`HGridLayout::entangled_seam_tris`] of that chunk, from hex coordinates
/// alone. Which tris exist depends only on the chunk's shape, not on heights
/// or edits, so no layout is built.
///
/// Matches the layout for every `coord` that [`HGridLayout::for_chunk`]
/// accepts. Call it only for those: for a `coord` it rejects, the `i32`
/// math overflows (a panic in debug builds) or the owners come out wrong.
///
/// @param coord — the carrying chunk's coordinate on the chunk lattice.
/// @param chunk_radius — rings of cells per chunk.
/// @returns one key per tri: per entangled cell, in `ring(chunk_radius + 1)`
///   order, its quad tris then its junction tris.
pub fn entangled_seam_keys(coord: Hex, chunk_radius: u32) -> Vec<EntangledSeam> {
    let r = chunk_radius;
    let center = coord.to_higher_res(r);
    let exists = |h: Hex| center.unsigned_distance_to(h) <= r + 1;
    let entangled = |h: Hex| center.unsigned_distance_to(h) == r + 1;
    let mut keys = Vec::new();
    for hex in center.ring(r + 1) {
        let owner = hex.to_lower_res(r);
        let gaps = owned_gaps(hex, |nb| exists(nb) && !entangled(nb), exists);
        let quad_tris = 2 * gaps.quads.iter().flatten().count();
        keys.extend(std::iter::repeat_n(EntangledSeam { owner, also: None }, quad_tris));
        for (_, gv) in gaps.junctions.iter().flatten() {
            let also = gv
                .coordinates()
                .into_iter()
                .map(|c| c.to_lower_res(r))
                .find(|&c| c != coord && c != owner);
            keys.push(EntangledSeam { owner, also });
        }
    }
    keys
}

/// [`ChunkSource`] that samples noise per request via [`HGridLayout::for_chunk`].
/// One `settings` (and so one set of seeds) per world.
#[derive(Clone, Debug)]
pub struct NoiseWorld {
    /// Seeds, noise and size settings, the same for every chunk.
    pub settings: HGridSettings,
    pub chunk_radius: u32,
}

impl ChunkSource for NoiseWorld {
    fn chunk_radius(&self) -> u32 {
        self.chunk_radius
    }

    fn chunk(&self, coord: Hex) -> Result<Chunk, ChunkError> {
        let r = self.chunk_radius;
        let layout = HGridLayout::for_chunk(&self.settings, coord, r, &[])?;
        let center = layout.center();

        let (cells, owned, owned_runs) = shapes::hexagon(center, r).fold(
            (Vec::new(), Vec::new(), Vec::new()),
            |(mut cells, mut owned, mut runs), h| {
                cells.push(layout.cell(&h).expect("own cell is in the chunk layout"));
                let (f, q, j) = layout.owned_tris_into(h, &mut owned);
                runs.push(f + q + j);
                (cells, owned, runs)
            },
        );

        let keys = entangled_seam_keys(coord, r);
        let tris = layout.entangled_seam_tris();
        assert_eq!(keys.len(), tris.len(), "a seam key per entangled seam tri, chunk {coord:?}");
        let seams = keys.into_iter().zip(tris).fold(Vec::<Seam>::new(), |mut groups, (key, t)| {
            match groups.iter_mut().find(|s| s.key() == key) {
                Some(s) => s.tris.push(t),
                None => groups.push(Seam { owner: key.owner, also: key.also, tris: vec![t] }),
            }
            groups
        });

        Ok(Chunk {
            coord,
            center: layout.hex_to_world_pos(center),
            cells,
            owned,
            owned_runs,
            seams,
        })
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
    const ONE_PLUS_SIX: usize = 7;
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
            let layout = HGridLayout::new(&HGridSettings::default(), WORLD_RADIUS);
            let fitting: HashSet<Hex> = shapes::hexagon(Hex::ZERO, WORLD_RADIUS)
                .map(|h| h.to_lower_res(r))
                // The entangled ring (distance r + 1 from the centre) must fit inside the world.
                .filter(|c| c.to_higher_res(r).length() as u32 + r < WORLD_RADIUS)
                .collect();
            assert!(fitting.len() >= MIN_FITTING_CHUNKS, "r {r}: {} chunks", fitting.len());

            let src = world(r);
            let mut got: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|&c| src.chunk(c).unwrap().owned)
                .map(|t| tri_bits(&t))
                .collect();
            let mut want: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|c| shapes::hexagon(c.to_higher_res(r), r))
                .fold(Vec::new(), |mut out, h| {
                    layout.owned_tris_into(h, &mut out);
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
                let c = src.chunk(coord).unwrap();
                assert!((1..=MAX_SEAM_GROUPS).contains(&c.seams.len()), "r {r}: {}", c.seams.len());
                for Seam { owner, also, tris } in &c.seams {
                    assert_ne!(*owner, coord);
                    assert!(!tris.is_empty(), "r {r}: empty group {owner:?}");
                    if let Some(b) = also {
                        assert!(*b != coord && b != owner, "r {r}: also {b:?}");
                        assert!(coord.unsigned_distance_to(*b) == 1 && owner.unsigned_distance_to(*b) == 1, "r {r}: also {b:?}");
                    }
                    let owned: HashSet<[u32; 9]> =
                        src.chunk(*owner).unwrap().owned.iter().map(tri_bits).collect();
                    assert!(
                        tris.iter().all(|t| owned.contains(&tri_bits(t))),
                        "r {r}: seam of {coord:?} not in owner {owner:?}"
                    );
                }
                let seam_total: usize = c.seams.iter().map(|s| s.tris.len()).sum();
                let layout = HGridLayout::for_chunk(&src.settings, coord, r, &[]).unwrap();
                assert_eq!(c.owned.len() + seam_total, layout.all_tris().len(), "r {r}");
            }
        }
    }

    #[test]
    fn chunk_runs_and_cells_line_up() {
        for r in CHUNK_RADII {
            let c = world(r).chunk(Hex::new(-3, 2)).unwrap();
            let n = shapes::hexagon(c.coord.to_higher_res(r), r).count();
            assert_eq!(c.cells.len(), n);
            assert_eq!(c.owned_runs.len(), n);
            assert_eq!(c.owned_runs.iter().sum::<usize>(), c.owned.len());
        }
    }

    #[test]
    fn chunk_center_matches_layout() {
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let src = world(r);
                let layout = HGridLayout::for_chunk(&src.settings, coord, r, &[]).unwrap();
                let want = layout.hex_to_world_pos(coord.to_higher_res(r));
                assert_eq!(src.chunk(coord).unwrap().center, want, "r {r}, {coord:?}");
            }
        }
    }

    #[test]
    fn chunk_zero_radius_2_counts() {
        let c = world(2).chunk(Hex::ZERO).unwrap();
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
        let one_plus_six = (0u32..1 << ONE_PLUS_SIX).map(|m| (0..region_len).map(|i| i < ONE_PLUS_SIX && m >> i & 1 == 1).collect());
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
            // The 1+6 first, so the low ONE_PLUS_SIX bits of a loaded set pick them.
            let mut region: Vec<Hex> = std::iter::once(Hex::ZERO).chain(Hex::ZERO.ring(1)).collect();
            region.extend(shapes::hexagon(Hex::ZERO, REGION_RADIUS).filter(|h| h.length() > 1));
            let chunks: Vec<Chunk> = region.iter().map(|&c| src.chunk(c).unwrap()).collect();
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
                        let on = u8::from(s.key().drawn(c.coord, loaded));
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

    /// `testdata/entangled_seam_drawn.tsv`: `(carrier, key, loaded, drawn)` rows.
    fn drawn_table() -> Vec<(Hex, EntangledSeam, Vec<Hex>, bool)> {
        let hex = |t: &str| {
            let (q, r) = t.split_once(',').expect("hex is `q,r`");
            Hex::new(q.parse().expect("q"), r.parse().expect("r"))
        };
        let hexes = |t: &str| if t == "-" { Vec::new() } else { t.split(';').map(hex).collect() };
        include_str!("../testdata/entangled_seam_drawn.tsv")
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                let also = (f[2] != "-").then(|| hex(f[2]));
                let key = EntangledSeam { owner: hex(f[1]), also };
                (hex(f[0]), key, hexes(f[3]), f[4].parse().expect("drawn is true/false"))
            })
            .collect()
    }

    #[test]
    fn drawn_follows_the_shared_table() {
        let table = drawn_table();
        assert!(table.len() >= 10, "table has {} rows", table.len());
        for (carrier, key, loaded, want) in table {
            let got = key.drawn(carrier, |h| loaded.contains(&h));
            assert_eq!(got, want, "carrier {carrier:?}, {key:?}, loaded {loaded:?}");
        }
    }

    #[test]
    fn seam_keys_match_vertex_positions() {
        // The keys come from hex math; check them against the tris' actual corners:
        // `also` is the chunk of a corner cell that is neither the carrier nor the owner.
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let g = HGridSettings::default();
                let layout = HGridLayout::for_chunk(&g, coord, r, &[]).unwrap();
                let tris = layout.entangled_seam_tris();
                let keys = entangled_seam_keys(coord, r);
                assert_eq!(keys.len(), tris.len(), "r {r}, {coord:?}");
                let counts = layout.entangled_seam_counts();
                assert_eq!(counts.iter().map(|(q, j)| q + j).sum::<usize>(), tris.len());
                let owners = layout.entangled_ring().zip(&counts).flat_map(|(h, &(q, j))| {
                    std::iter::repeat_n(h, q + j)
                });
                for ((t, key), ring_cell) in tris.iter().zip(&keys).zip(owners) {
                    assert_eq!(key.owner, ring_cell.to_lower_res(r));
                    let chunk_of = |v: &Vec3| {
                        std::iter::once(ring_cell)
                            .chain(ring_cell.all_neighbors())
                            .find(|&n| (0..6).any(|i| layout.vertex(n, i) == Some(*v)))
                            .expect("seam vertex is a corner of its ring cell or a neighbour")
                            .to_lower_res(r)
                    };
                    let also = t.iter().map(chunk_of).find(|&c| c != coord && c != key.owner);
                    assert_eq!(key.also, also, "r {r}, {coord:?}, {t:?}");
                }
            }
        }
    }

    #[test]
    fn own_and_seam_tris_split_all_tris() {
        for r in CHUNK_RADII {
            let g = HGridSettings::default();
            let layout = HGridLayout::for_chunk(&g, Hex::new(2, -1), r, &[]).unwrap();
            let own = layout.own_tris();
            assert_eq!(own.len(), 14 * layout.own_cells().count(), "r {r}: 14 tris per own cell");
            let seam = layout.entangled_seam_tris();
            let mut split: Vec<_> = own.iter().chain(&seam).map(tri_bits).collect();
            let mut all: Vec<_> = layout.all_tris().iter().map(tri_bits).collect();
            split.sort();
            all.sort();
            assert_eq!(split, all, "r {r}");
            assert_eq!(layout.entangled_ring().count(), 6 * (r as usize + 1));
        }
        let grid = HGridLayout::new(&HGridSettings::default(), 2);
        assert!(grid.entangled_seam_tris().is_empty() && grid.entangled_seam_counts().is_empty());
        assert_eq!(grid.own_tris(), grid.all_tris());
    }

    #[test]
    fn chunk_is_deterministic() {
        let coord = Hex::new(-3, 2);
        assert_eq!(world(2).chunk(coord).unwrap(), world(2).chunk(coord).unwrap());
        assert_eq!(world(2).chunk_radius(), 2);
    }
}
