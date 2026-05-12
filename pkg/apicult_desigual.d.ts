/* tslint:disable */
/* eslint-disable */

/**
 * Per-hex entangle marker from JS. Maps to `hexx::Hex::new(q, r)`.
 */
export class EntangleSpec {
    free(): void;
    [Symbol.dispose](): void;
    constructor(q: number, r: number);
    q: number;
    r: number;
}

/**
 * Flattened `HexCell` (`hex` decomposed into `q`/`r` since `Hex` is foreign
 * and can't carry `#[wasm_bindgen]`).
 */
export class HexCellView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    entangled: boolean;
    height: number;
    q: number;
    r: number;
    radius: number;
}

/**
 * Mirror of `crate::NoiseType` exposed as a C-like enum for `wasm-bindgen`.
 */
export enum NoiseChannel {
    Height = 0,
    Size = 1,
}

/**
 * Per-hex override input from JS. Maps to `crate::Override = (NoiseType, Hex, f32)`.
 */
export class OverrideSpec {
    free(): void;
    [Symbol.dispose](): void;
    constructor(kind: NoiseChannel, q: number, r: number, value: number);
    kind: NoiseChannel;
    q: number;
    r: number;
    value: number;
}

/**
 * Mirror of `hexx::VertexDirection` (a tuple struct in hexx, so re-expressed
 * here as a 6-variant enum). Indices match `VertexDirection::ALL_DIRECTIONS`.
 */
export enum VertexDir {
    East = 0,
    SouthEast = 1,
    SouthWest = 2,
    West = 3,
    NorthWest = 4,
    NorthEast = 5,
}

/**
 * Opaque handle wrapping `HGridLayout`. Build once, query repeatedly.
 */
export class WasmLayout {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Cells along one outer side of the hexagon-shaped grid (see
     * `HGridLayout::borderline_cells`). Returns `grid_radius + 1` views.
     */
    borderline_cells(direction: VertexDir): HexCellView[];
    /**
     * Per-hex face-edge bridge quads matching `entangled`, flat
     * `n_hexes * 78` floats: 6 slots × 13 floats per slot
     * (`[flag, v0x, v0y, v0z, ..., v3x, v3y, v3z]`). `flag` is `1.0`
     * when a bridge exists on that face edge, `0.0` on border edges
     * (the 12 vertex floats are zeros in that case). Stride and hex
     * ordering match [`face_tris`] — the i-th 78-float slice owns the
     * 6 bridges of the i-th matching hex. Quad-corner order matches
     * the `gap_quads` layout: `v0` / `v3` lie on the source hex
     * perimeter, `n0` / `n1` on the neighbor — JS picks one of the 6
     * slots per selected hex and emits two band-shaded tris bridging
     * the gap.
     */
    face_bridge_quads(entangled: boolean): Float32Array;
    /**
     * Per-hex face fans matching `entangled`, flat `n_hexes * 54` floats
     * (6 center-fan tris × 3 verts × 3 floats). The grouping is stable:
     * the i-th 54-float slice owns the 6 tris of the i-th matching hex
     * (in `shapes::hexagon` traversal order, skipping non-matching cells).
     * Lets the JS side address whole hex cells (e.g. random-subset overlays
     * like the y-axis band shader) without reconstructing the grouping
     * from the flat `tris` stream.
     */
    face_tris(entangled: boolean): Float32Array;
    /**
     * Build a layout with project defaults (`HGridSettings::default()`)
     * overridden by the explicit `radius` and noise seeds. `overrides`
     * pin per-hex height/radius values after noise sampling; `entangle`
     * marks the listed hexes as entangled.
     */
    constructor(radius: number, height_seed: number, radius_seed: number, overrides: OverrideSpec[], entangle: EntangleSpec[]);
    /**
     * Unified mesh stream filtered by entanglement. Flat `n_tris * 9` floats:
     * gap quad tris + hex face fans matching `entangled`, plus junction tris
     * when `entangled = false`.
     */
    tris(entangled: boolean): Float32Array;
    /**
     * Gap-quad perimeter segments matching `entangled`. Flat `n_edges * 6`
     * floats (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
     * `q[0]→q[1]→q[2]→q[3]→q[0]`. Quad-local edges `0`/`2` are bridge
     * (cross-gap), `1`/`3` are rim (along one hex's side); see module docs.
     * No tessellation diagonal — feed straight into a `THREE.LineSegments`
     * geometry.
     */
    wire_edges(entangled: boolean): Float32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_entanglespec_free: (a: number, b: number) => void;
    readonly __wbg_get_entanglespec_q: (a: number) => number;
    readonly __wbg_get_entanglespec_r: (a: number) => number;
    readonly __wbg_get_hexcellview_entangled: (a: number) => number;
    readonly __wbg_get_hexcellview_height: (a: number) => number;
    readonly __wbg_get_hexcellview_radius: (a: number) => number;
    readonly __wbg_get_overridespec_kind: (a: number) => number;
    readonly __wbg_hexcellview_free: (a: number, b: number) => void;
    readonly __wbg_overridespec_free: (a: number, b: number) => void;
    readonly __wbg_set_entanglespec_q: (a: number, b: number) => void;
    readonly __wbg_set_entanglespec_r: (a: number, b: number) => void;
    readonly __wbg_set_hexcellview_entangled: (a: number, b: number) => void;
    readonly __wbg_set_hexcellview_height: (a: number, b: number) => void;
    readonly __wbg_set_hexcellview_radius: (a: number, b: number) => void;
    readonly __wbg_set_overridespec_kind: (a: number, b: number) => void;
    readonly __wbg_wasmlayout_free: (a: number, b: number) => void;
    readonly overridespec_new: (a: number, b: number, c: number, d: number) => number;
    readonly wasmlayout_borderline_cells: (a: number, b: number) => [number, number];
    readonly wasmlayout_face_bridge_quads: (a: number, b: number) => [number, number];
    readonly wasmlayout_face_tris: (a: number, b: number) => [number, number];
    readonly wasmlayout_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wasmlayout_tris: (a: number, b: number) => [number, number];
    readonly wasmlayout_wire_edges: (a: number, b: number) => [number, number];
    readonly __wbg_set_hexcellview_q: (a: number, b: number) => void;
    readonly __wbg_set_hexcellview_r: (a: number, b: number) => void;
    readonly __wbg_set_overridespec_q: (a: number, b: number) => void;
    readonly __wbg_set_overridespec_r: (a: number, b: number) => void;
    readonly __wbg_set_overridespec_value: (a: number, b: number) => void;
    readonly __wbg_get_hexcellview_q: (a: number) => number;
    readonly __wbg_get_hexcellview_r: (a: number) => number;
    readonly __wbg_get_overridespec_q: (a: number) => number;
    readonly __wbg_get_overridespec_r: (a: number) => number;
    readonly __wbg_get_overridespec_value: (a: number) => number;
    readonly entanglespec_new: (a: number, b: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
