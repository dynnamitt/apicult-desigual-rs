// hex-stream.js — streaming-cluster state machine and pure helpers.
// Browser + Node compatible: imports nothing from `three` or `./pkg/*`.
// WasmLayout is always passed in; never imported here.

export const axialKey = ({ q, r }) => `${q},${r}`;

// 6 axial neighbor offsets, indexed by hex direction d ∈ 0..5.
// d=0 is +x ("right"), CCW from there: matches petal placement angles d*60°.
export const AXIAL_NEIGHBORS = [
  { q:  1, r:  0 },
  { q:  0, r:  1 },
  { q: -1, r:  1 },
  { q: -1, r:  0 },
  { q:  0, r: -1 },
  { q:  1, r: -1 },
];

const NEIGHBOR_LOOKUP = new Map(
  AXIAL_NEIGHBORS.map((n, d) => [axialKey(n), d]),
);

// Returns dir index 0..5 if {q, r} is a unit hex neighbor offset; null otherwise.
export const axialDirToSide = (delta) => {
  const idx = NEIGHBOR_LOOKUP.get(axialKey(delta));
  return idx === undefined ? null : idx;
};

// Petal-axial (q, r) → world (x, z). Each unit step in petal-axial is one
// petal-spacing in the world. The basis is petal-dir-0 along +x and
// petal-dir-1 at +60° (CCW), giving the standard pointy-top axial → cartesian
// transform scaled by petalSpacing.
export const petalAxialToWorld = ({ q, r }, petalSpacing) => ({
  x: petalSpacing * (q + r / 2),
  z: petalSpacing * (r * Math.sqrt(3) / 2),
});

// Cheap reversible mixer. Same shape as the splitmix32 already in
// hex-terrain-scene.js (kept here as a self-contained copy so this module has
// zero browser-only deps and is Node-testable).
const splitmix32 = (s) => {
  s = (s + 0x9E3779B9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35) >>> 0;
  return (s ^ (s >>> 16)) >>> 0;
};

const randomU32 = () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

// Hash (worldSeed, q, r) into a stable pair of u32 seeds: one for the height
// channel, one for the radius channel. With worldSeed=null we fall back to
// fresh randomness per call (the current showcase behavior — non-reproducible).
export const seedForCell = (worldSeed, q, r) => {
  if (worldSeed === null || worldSeed === undefined) {
    return [randomU32(), randomU32()];
  }
  const w = worldSeed >>> 0;
  // Pack (q, r) into a single u32. The mask + shift loses information for
  // |q| or |r| > 2^15, but that is far beyond any realistic streaming run
  // and the splitmix32 cascade still produces well-distributed outputs.
  const packed = ((q & 0xFFFF) << 16) | (r & 0xFFFF);
  return [
    splitmix32(splitmix32(w ^ packed)),
    splitmix32(splitmix32((w + 1) ^ packed)),
  ];
};

// 7-cell footprint of a cluster anchored at `anchor`: anchor itself plus the
// 6 unit neighbors. Returned as a Set<axialKey> for O(1) intersection.
export const clusterFootprint = (anchor) => {
  const fp = new Set();
  fp.add(axialKey(anchor));
  for (const n of AXIAL_NEIGHBORS) {
    fp.add(axialKey({ q: anchor.q + n.q, r: anchor.r + n.r }));
  }
  return fp;
};

// Set diff of old footprint vs new footprint. Returns:
//   spawn:   axial coords {q, r} that are in new but not old (3 of them)
//   despawn: axial keys (strings) that are in old but not new (3 of them)
//   survive: axial coords {q, r} that are in both (4 of them)
// Caller passes both anchors; this function recomputes both footprints.
export const axialDiff = (oldAnchor, newAnchor) => {
  const oldFp = clusterFootprint(oldAnchor);
  const newFpCells = [
    newAnchor,
    ...AXIAL_NEIGHBORS.map((n) => ({
      q: newAnchor.q + n.q,
      r: newAnchor.r + n.r,
    })),
  ];
  const newFpKeys = new Set(newFpCells.map(axialKey));

  const spawn = newFpCells.filter((c) => !oldFp.has(axialKey(c)));
  const survive = newFpCells.filter((c) => oldFp.has(axialKey(c)));
  const despawn = [...oldFp].filter((k) => !newFpKeys.has(k));
  return { spawn, despawn, survive };
};
