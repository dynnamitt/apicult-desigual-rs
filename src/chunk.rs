//! Hexagonal chunking of a [`HGridLayout`] into binary chunk files plus a
//! JSON manifest, for engines that stream precomputed terrain.
//!
//! A cell belongs to chunk `hex.to_lower_res(chunk_radius)`. A chunk carries
//! the triangles its cells *own* ([`HGridLayout::owned_tris_into`]), so the
//! chunks partition `all_tris(false)` exactly: no overlap, no holes.
//!
//! # Chunk file (`chunk_<q>_<r>.bin`, little-endian)
//!
//! | part | layout |
//! |---|---|
//! | header ([`HEADER_LEN`] B) | `"HXCK"`, `u32 version`, `i32 q`, `i32 r`, `u32 n_cells`, `u32 n_tris`, `u32 n_lines`, `u32 0`, `u64 hash` |
//! | cells | `n_cells × {i32 q, i32 r, f32 height, f32 radius, u32 first_tri, u8 n_quads, u8 n_junctions, u16 0}` ([`CELL_LEN`] B) |
//! | tris | `n_tris × 9 f32`: world-space corners, per cell 6 face tris, then `2·n_quads` gap tris, then `n_junctions` junction tris |
//! | lines | `n_lines × 6 f32`: perimeter segments of the owned gap quads |
//!
//! `hash` is FNV-1a 64 over every byte after the header: the chunk's
//! *original hash*, so a consumer can tell a pristine chunk from an edited one.

use std::collections::BTreeMap;
use std::io::{self, Write};

use glam::Vec3;
use hexx::{Hex, shapes};

use crate::layout::{HGridLayout, HGridSettings};

/// File magic, first 4 bytes of every chunk file.
pub const MAGIC: [u8; 4] = *b"HXCK";
/// Chunk file and manifest format version.
pub const VERSION: u32 = 1;
/// Bytes in a chunk file header.
pub const HEADER_LEN: usize = 40;
/// Bytes per cell record.
pub const CELL_LEN: usize = 24;
/// Bytes per triangle (9 × f32).
pub const TRI_LEN: usize = 36;
/// Bytes per line segment (6 × f32).
pub const LINE_LEN: usize = 24;

/// One cell's record inside a chunk.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkCell {
    pub hex: Hex,
    pub height: f32,
    pub radius: f32,
    /// Index into [`Chunk::tris`] of this cell's first (face) triangle.
    pub first_tri: u32,
    /// Owned gap quads; each contributes 2 tris after the 6 face tris.
    pub n_quads: u8,
    /// Owned junction tris, after the gap tris.
    pub n_junctions: u8,
}

/// The geometry owned by the cells of one chunk.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Chunk {
    /// Chunk coordinate in the lower-resolution grid.
    pub coord: Hex,
    pub cells: Vec<ChunkCell>,
    pub tris: Vec<[Vec3; 3]>,
    pub lines: Vec<[Vec3; 2]>,
}

/// Decoded chunk file header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkHeader {
    pub version: u32,
    pub coord: Hex,
    pub n_cells: u32,
    pub n_tris: u32,
    pub n_lines: u32,
    pub hash: u64,
}

/// Chunk coordinate that `hex` belongs to.
pub fn chunk_of(hex: Hex, chunk_radius: u32) -> Hex {
    hex.to_lower_res(chunk_radius)
}

/// Splits every cell of `layout` into hexagonal chunks of `chunk_radius`.
/// Chunks are sorted by `(q, r)`; cells keep the layout's spiral order.
pub fn partition(layout: &HGridLayout, chunk_radius: u32) -> Vec<Chunk> {
    let mut chunks: BTreeMap<(i32, i32), Chunk> = BTreeMap::new();
    for hex in shapes::hexagon(Hex::ZERO, layout.grid_radius()) {
        let coord = chunk_of(hex, chunk_radius);
        let chunk = chunks.entry((coord.x, coord.y)).or_insert_with(|| Chunk {
            coord,
            ..Chunk::default()
        });
        let first = chunk.tris.len();
        let (Some(cell), Some(counts)) = (
            layout.cell(&hex),
            layout.owned_tris_into(hex, false, &mut chunk.tris),
        ) else {
            continue;
        };
        // Owned gap quads follow the 6 face tris as `[a,b,c], [a,c,d]` pairs.
        let quads = &chunk.tris[first + counts.faces as usize..][..2 * counts.quads as usize];
        for pair in quads.chunks_exact(2) {
            let [a, b, c] = pair[0];
            let d = pair[1][2];
            chunk.lines.extend([[a, b], [b, c], [c, d], [d, a]]);
        }
        chunk.cells.push(ChunkCell {
            hex,
            height: cell.height,
            radius: cell.radius,
            first_tri: first as u32,
            n_quads: counts.quads,
            n_junctions: counts.junctions,
        });
    }
    chunks.into_values().collect()
}

impl Chunk {
    /// File name of this chunk inside the output directory.
    pub fn file_name(&self) -> String {
        format!("chunk_{}_{}.bin", self.coord.x, self.coord.y)
    }

    /// Everything after the header: cells, tris, lines.
    pub fn payload(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(
            self.cells.len() * CELL_LEN + self.tris.len() * TRI_LEN + self.lines.len() * LINE_LEN,
        );
        for c in &self.cells {
            buf.extend(c.hex.x.to_le_bytes());
            buf.extend(c.hex.y.to_le_bytes());
            buf.extend(c.height.to_le_bytes());
            buf.extend(c.radius.to_le_bytes());
            buf.extend(c.first_tri.to_le_bytes());
            buf.extend([c.n_quads, c.n_junctions, 0, 0]);
        }
        for v in self
            .tris
            .iter()
            .flatten()
            .chain(self.lines.iter().flatten())
        {
            for f in v.to_array() {
                buf.extend(f.to_le_bytes());
            }
        }
        buf
    }

    /// The header this chunk's file starts with.
    pub fn header(&self, hash: u64) -> ChunkHeader {
        ChunkHeader {
            version: VERSION,
            coord: self.coord,
            n_cells: self.cells.len() as u32,
            n_tris: self.tris.len() as u32,
            n_lines: self.lines.len() as u32,
            hash,
        }
    }

    /// Writes header + payload; returns the payload hash.
    pub fn write(&self, w: &mut impl Write) -> io::Result<u64> {
        let payload = self.payload();
        let hash = fnv1a64(&payload);
        w.write_all(&self.header(hash).encode())?;
        w.write_all(&payload)?;
        Ok(hash)
    }

    /// World-space AABB over the chunk's triangles, or `None` if it has none.
    pub fn aabb(&self) -> Option<(Vec3, Vec3)> {
        let mut verts = self.tris.iter().flatten();
        let first = *verts.next()?;
        Some(verts.fold((first, first), |(lo, hi), &v| (lo.min(v), hi.max(v))))
    }
}

impl ChunkHeader {
    /// The [`HEADER_LEN`] bytes of this header.
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[0..4].copy_from_slice(&MAGIC);
        b[4..8].copy_from_slice(&self.version.to_le_bytes());
        b[8..12].copy_from_slice(&self.coord.x.to_le_bytes());
        b[12..16].copy_from_slice(&self.coord.y.to_le_bytes());
        b[16..20].copy_from_slice(&self.n_cells.to_le_bytes());
        b[20..24].copy_from_slice(&self.n_tris.to_le_bytes());
        b[24..28].copy_from_slice(&self.n_lines.to_le_bytes());
        b[32..40].copy_from_slice(&self.hash.to_le_bytes());
        b
    }

    /// Parses a header; `None` if `bytes` is short or the magic is wrong.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let b = bytes.get(..HEADER_LEN)?;
        if b[0..4] != MAGIC {
            return None;
        }
        let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let i32_at = |i: usize| i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let mut hash = [0u8; 8];
        hash.copy_from_slice(&b[32..40]);
        Some(Self {
            version: u32_at(4),
            coord: Hex::new(i32_at(8), i32_at(12)),
            n_cells: u32_at(16),
            n_tris: u32_at(20),
            n_lines: u32_at(24),
            hash: u64::from_le_bytes(hash),
        })
    }

    /// Bytes the payload after this header must have.
    pub fn payload_len(&self) -> usize {
        self.n_cells as usize * CELL_LEN
            + self.n_tris as usize * TRI_LEN
            + self.n_lines as usize * LINE_LEN
    }
}

/// FNV-1a, 64-bit.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// A chunk's manifest entry: the chunk plus the hash its file was written with.
pub struct ManifestEntry<'a> {
    pub chunk: &'a Chunk,
    pub hash: u64,
}

/// Writes `manifest.json`: format version, the generating settings, the chunk
/// radius and one entry per chunk.
pub fn write_manifest(
    settings: &HGridSettings,
    chunk_radius: u32,
    entries: &[ManifestEntry<'_>],
    w: &mut impl Write,
) -> io::Result<()> {
    let s = settings;
    writeln!(w, "{{")?;
    writeln!(w, "  \"version\": {VERSION},")?;
    writeln!(w, "  \"chunk_radius\": {chunk_radius},")?;
    writeln!(w, "  \"settings\": {{")?;
    writeln!(w, "    \"radius\": {},", s.radius)?;
    writeln!(w, "    \"nominal_hex_radius\": {},", s.nominal_hex_radius)?;
    writeln!(w, "    \"height_noise_seed\": {},", s.height_noise_seed)?;
    writeln!(w, "    \"radius_noise_seed\": {},", s.radius_noise_seed)?;
    writeln!(
        w,
        "    \"height_noise_octaves\": {},",
        s.height_noise_octaves
    )?;
    writeln!(
        w,
        "    \"radius_noise_octaves\": {},",
        s.radius_noise_octaves
    )?;
    writeln!(w, "    \"height_noise_scale\": {},", s.height_noise_scale)?;
    writeln!(w, "    \"radius_noise_scale\": {},", s.radius_noise_scale)?;
    writeln!(w, "    \"max_height\": {},", s.max_height)?;
    writeln!(w, "    \"min_radius_ratio\": {},", s.min_radius_ratio)?;
    writeln!(w, "    \"max_radius_ratio\": {}", s.max_radius_ratio)?;
    writeln!(w, "  }},")?;
    writeln!(w, "  \"chunks\": [")?;
    for (i, e) in entries.iter().enumerate() {
        let c = e.chunk;
        let (lo, hi) = c.aabb().unwrap_or((Vec3::ZERO, Vec3::ZERO));
        let sep = if i + 1 < entries.len() { "," } else { "" };
        writeln!(
            w,
            "    {{\"q\": {}, \"r\": {}, \"file\": \"{}\", \"hash\": \"{:016x}\", \"cells\": {}, \"tris\": {}, \"lines\": {}, \"min\": [{}, {}, {}], \"max\": [{}, {}, {}]}}{sep}",
            c.coord.x,
            c.coord.y,
            c.file_name(),
            e.hash,
            c.cells.len(),
            c.tris.len(),
            c.lines.len(),
            lo.x,
            lo.y,
            lo.z,
            hi.x,
            hi.y,
            hi.z,
        )?;
    }
    writeln!(w, "  ]")?;
    writeln!(w, "}}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn layout(radius: u32) -> HGridLayout {
        HGridLayout::new(
            &HGridSettings {
                radius,
                ..HGridSettings::default()
            },
            &[],
            &[],
        )
    }

    #[test]
    fn every_cell_is_in_exactly_one_chunk() {
        let l = layout(9);
        let chunks = partition(&l, 2);
        let mut seen = HashSet::new();
        for c in &chunks {
            for cell in &c.cells {
                assert!(seen.insert(cell.hex), "{:?} in two chunks", cell.hex);
                assert_eq!(chunk_of(cell.hex, 2), c.coord);
            }
        }
        assert_eq!(seen.len(), shapes::hexagon(Hex::ZERO, 9).count());
    }

    #[test]
    fn chunks_concatenate_to_all_tris() {
        let l = layout(9);
        let chunks = partition(&l, 2);
        let mut from_chunks: Vec<[Vec3; 3]> = chunks.iter().flat_map(|c| c.tris.clone()).collect();
        let mut all = l.all_tris(false);
        let key = |t: &[Vec3; 3]| t.map(|v| v.to_array().map(f32::to_bits));
        from_chunks.sort_by_key(key);
        all.sort_by_key(key);
        assert_eq!(from_chunks, all);
    }

    #[test]
    fn cell_runs_tile_the_tri_buffer() {
        for c in partition(&layout(6), 3) {
            let mut next = 0u32;
            for cell in &c.cells {
                assert_eq!(cell.first_tri, next);
                next += 6 + 2 * u32::from(cell.n_quads) + u32::from(cell.n_junctions);
            }
            assert_eq!(next as usize, c.tris.len());
            assert_eq!(
                c.lines.len(),
                4 * c.cells.iter().map(|x| x.n_quads as usize).sum::<usize>()
            );
        }
    }

    #[test]
    fn header_round_trips_and_hash_matches_payload() {
        let chunks = partition(&layout(5), 2);
        let c = &chunks[chunks.len() / 2];
        let mut file = Vec::new();
        let hash = c.write(&mut file).unwrap();
        let h = ChunkHeader::decode(&file).unwrap();
        assert_eq!(h, c.header(hash));
        assert_eq!(file.len(), HEADER_LEN + h.payload_len());
        assert_eq!(fnv1a64(&file[HEADER_LEN..]), h.hash);
        assert!(ChunkHeader::decode(&file[..HEADER_LEN - 1]).is_none());
    }

    #[test]
    fn fnv1a64_known_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn partition_is_deterministic() {
        let a = partition(&layout(5), 2);
        let b = partition(&layout(5), 2);
        let ha: Vec<u64> = a.iter().map(|c| fnv1a64(&c.payload())).collect();
        let hb: Vec<u64> = b.iter().map(|c| fnv1a64(&c.payload())).collect();
        assert_eq!(ha, hb);
    }
}
