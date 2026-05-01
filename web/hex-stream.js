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
