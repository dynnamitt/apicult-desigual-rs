/* @ts-self-types="./apicult_desigual.d.ts" */

/**
 * Per-hex entangle marker from JS. Maps to `hexx::Hex::new(q, r)`.
 */
export class EntangleSpec {
    static __unwrap(jsValue) {
        if (!(jsValue instanceof EntangleSpec)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EntangleSpecFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_entanglespec_free(ptr, 0);
    }
    /**
     * @param {number} q
     * @param {number} r
     */
    constructor(q, r) {
        const ret = wasm.entanglespec_new(q, r);
        this.__wbg_ptr = ret;
        EntangleSpecFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get q() {
        const ret = wasm.__wbg_get_entanglespec_q(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get r() {
        const ret = wasm.__wbg_get_entanglespec_r(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set q(arg0) {
        wasm.__wbg_set_entanglespec_q(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set r(arg0) {
        wasm.__wbg_set_entanglespec_r(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) EntangleSpec.prototype[Symbol.dispose] = EntangleSpec.prototype.free;

/**
 * Flattened `HexCell` (`hex` decomposed into `q`/`r` since `Hex` is foreign
 * and can't carry `#[wasm_bindgen]`).
 */
export class HexCellView {
    static __wrap(ptr) {
        const obj = Object.create(HexCellView.prototype);
        obj.__wbg_ptr = ptr;
        HexCellViewFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HexCellViewFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hexcellview_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get entangled() {
        const ret = wasm.__wbg_get_hexcellview_entangled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_hexcellview_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get q() {
        const ret = wasm.__wbg_get_hexcellview_q(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get r() {
        const ret = wasm.__wbg_get_hexcellview_r(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get radius() {
        const ret = wasm.__wbg_get_hexcellview_radius(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {boolean} arg0
     */
    set entangled(arg0) {
        wasm.__wbg_set_hexcellview_entangled(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_hexcellview_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set q(arg0) {
        wasm.__wbg_set_hexcellview_q(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set r(arg0) {
        wasm.__wbg_set_hexcellview_r(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set radius(arg0) {
        wasm.__wbg_set_hexcellview_radius(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) HexCellView.prototype[Symbol.dispose] = HexCellView.prototype.free;

/**
 * Mirror of `crate::NoiseType` exposed as a C-like enum for `wasm-bindgen`.
 * @enum {0 | 1}
 */
export const NoiseChannel = Object.freeze({
    Height: 0, "0": "Height",
    Size: 1, "1": "Size",
});

/**
 * Per-hex override input from JS. Maps to `crate::Override = (NoiseType, Hex, f32)`.
 */
export class OverrideSpec {
    static __unwrap(jsValue) {
        if (!(jsValue instanceof OverrideSpec)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OverrideSpecFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_overridespec_free(ptr, 0);
    }
    /**
     * @returns {NoiseChannel}
     */
    get kind() {
        const ret = wasm.__wbg_get_overridespec_kind(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get q() {
        const ret = wasm.__wbg_get_overridespec_q(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get r() {
        const ret = wasm.__wbg_get_overridespec_r(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get value() {
        const ret = wasm.__wbg_get_overridespec_value(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {NoiseChannel} kind
     * @param {number} q
     * @param {number} r
     * @param {number} value
     */
    constructor(kind, q, r, value) {
        const ret = wasm.overridespec_new(kind, q, r, value);
        this.__wbg_ptr = ret;
        OverrideSpecFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {NoiseChannel} arg0
     */
    set kind(arg0) {
        wasm.__wbg_set_overridespec_kind(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set q(arg0) {
        wasm.__wbg_set_overridespec_q(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set r(arg0) {
        wasm.__wbg_set_overridespec_r(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set value(arg0) {
        wasm.__wbg_set_overridespec_value(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) OverrideSpec.prototype[Symbol.dispose] = OverrideSpec.prototype.free;

/**
 * Mirror of `hexx::VertexDirection` (a tuple struct in hexx, so re-expressed
 * here as a 6-variant enum). Indices match `VertexDirection::ALL_DIRECTIONS`.
 * @enum {0 | 1 | 2 | 3 | 4 | 5}
 */
export const VertexDir = Object.freeze({
    East: 0, "0": "East",
    SouthEast: 1, "1": "SouthEast",
    SouthWest: 2, "2": "SouthWest",
    West: 3, "3": "West",
    NorthWest: 4, "4": "NorthWest",
    NorthEast: 5, "5": "NorthEast",
});

/**
 * One built chunk. All tri buffers are flat `n_tris * 9` floats in world space.
 */
export class WasmChunk {
    static __wrap(ptr) {
        const obj = Object.create(WasmChunk.prototype);
        obj.__wbg_ptr = ptr;
        WasmChunkFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmChunkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmchunk_free(ptr, 0);
    }
    /**
     * World `[x, z]` of the chunk's centre cell.
     * @returns {Float32Array}
     */
    center() {
        const ret = wasm.wasmchunk_center(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Owned stream — always drawn.
     * @returns {Float32Array}
     */
    owned() {
        const ret = wasm.wasmchunk_owned(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Seam group `i` — draw only while its owner chunk isn't loaded. Empty when out of range.
     * @param {number} i
     * @returns {Float32Array}
     */
    seam(i) {
        const ret = wasm.wasmchunk_seam(this.__wbg_ptr, i);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Owning neighbour chunk of each seam group, flat `[q0, r0, q1, r1, …]`.
     * @returns {Int32Array}
     */
    seam_owners() {
        const ret = wasm.wasmchunk_seam_owners(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WasmChunk.prototype[Symbol.dispose] = WasmChunk.prototype.free;

/**
 * Chunk generator for one world: every chunk shares `chunk_radius` and both
 * noise seeds (other settings are `HGridSettings::default()`).
 */
export class WasmChunkWorld {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmChunkWorldFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmchunkworld_free(ptr, 0);
    }
    /**
     * Builds chunk `(q, r)` on the chunk lattice. Same seeds and coord give the same output.
     * @param {number} q
     * @param {number} r
     * @returns {WasmChunk}
     */
    chunk(q, r) {
        const ret = wasm.wasmchunkworld_chunk(this.__wbg_ptr, q, r);
        return WasmChunk.__wrap(ret);
    }
    /**
     * @param chunk_radius — rings of cells per chunk.
     * @param height_seed — height-noise seed, the same for every chunk.
     * @param radius_seed — radius-noise seed, the same for every chunk.
     * @param {number} chunk_radius
     * @param {number} height_seed
     * @param {number} radius_seed
     */
    constructor(chunk_radius, height_seed, radius_seed) {
        const ret = wasm.wasmchunkworld_new(chunk_radius, height_seed, radius_seed);
        this.__wbg_ptr = ret;
        WasmChunkWorldFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmChunkWorld.prototype[Symbol.dispose] = WasmChunkWorld.prototype.free;

/**
 * Opaque handle wrapping `HGridLayout`. Build once, query repeatedly.
 */
export class WasmLayout {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLayoutFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlayout_free(ptr, 0);
    }
    /**
     * Cells along one outer side of the hexagon-shaped grid (see
     * `HGridLayout::borderline_cells`). Returns `grid_radius + 1` views.
     * @param {VertexDir} direction
     * @returns {HexCellView[]}
     */
    borderline_cells(direction) {
        const ret = wasm.wasmlayout_borderline_cells(this.__wbg_ptr, direction);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
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
     * @param {boolean} entangled
     * @returns {Float32Array}
     */
    face_bridge_quads(entangled) {
        const ret = wasm.wasmlayout_face_bridge_quads(this.__wbg_ptr, entangled);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Per-hex face fans matching `entangled`, flat `n_hexes * 54` floats
     * (6 center-fan tris × 3 verts × 3 floats). The grouping is stable:
     * the i-th 54-float slice owns the 6 tris of the i-th matching hex
     * (in `shapes::hexagon` traversal order, skipping non-matching cells).
     * Lets the JS side address whole hex cells (e.g. random-subset overlays
     * like the y-axis band shader) without reconstructing the grouping
     * from the flat `tris` stream.
     * @param {boolean} entangled
     * @returns {Float32Array}
     */
    face_tris(entangled) {
        const ret = wasm.wasmlayout_face_tris(this.__wbg_ptr, entangled);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Build a layout with project defaults (`HGridSettings::default()`)
     * overridden by the explicit `radius` and noise seeds. `overrides`
     * pin per-hex height/radius values after noise sampling; `entangle`
     * marks the listed hexes as entangled.
     * @param {number} radius
     * @param {number} height_seed
     * @param {number} radius_seed
     * @param {OverrideSpec[]} overrides
     * @param {EntangleSpec[]} entangle
     */
    constructor(radius, height_seed, radius_seed, overrides, entangle) {
        const val3 = +radius;
        const val4 = +height_seed;
        const val5 = +radius_seed;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArrayJsValueToWasm0(overrides, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayJsValueToWasm0(entangle, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__externref_drop_slice(ptr1, len1); wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__externref_drop_slice(ptr0, len0); wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        const ret = wasm.wasmlayout_new(val3, val4, val5, ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret;
        WasmLayoutFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Unified mesh stream filtered by entanglement. Flat `n_tris * 9` floats:
     * gap quad tris + hex face fans matching `entangled`, plus junction tris
     * when `entangled = false`.
     * @param {boolean} entangled
     * @returns {Float32Array}
     */
    tris(entangled) {
        const ret = wasm.wasmlayout_tris(this.__wbg_ptr, entangled);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Gap-quad perimeter segments matching `entangled`. Flat `n_edges * 6`
     * floats (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
     * `q[0]→q[1]→q[2]→q[3]→q[0]`. Quad-local edges `0`/`2` are bridge
     * (cross-gap), `1`/`3` are rim (along one hex's side); see module docs.
     * No tessellation diagonal — feed straight into a `THREE.LineSegments`
     * geometry.
     * @param {boolean} entangled
     * @returns {Float32Array}
     */
    wire_edges(entangled) {
        const ret = wasm.wasmlayout_wire_edges(this.__wbg_ptr, entangled);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WasmLayout.prototype[Symbol.dispose] = WasmLayout.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_entanglespec_unwrap: function(arg0) {
            const ret = EntangleSpec.__unwrap(arg0);
            return ret;
        },
        __wbg_hexcellview_new: function(arg0) {
            const ret = HexCellView.__wrap(arg0);
            return ret;
        },
        __wbg_overridespec_unwrap: function(arg0) {
            const ret = OverrideSpec.__unwrap(arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./apicult_desigual_bg.js": import0,
    };
}

const EntangleSpecFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_entanglespec_free(ptr, 1));
const HexCellViewFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hexcellview_free(ptr, 1));
const OverrideSpecFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_overridespec_free(ptr, 1));
const WasmChunkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmchunk_free(ptr, 1));
const WasmChunkWorldFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmchunkworld_free(ptr, 1));
const WasmLayoutFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlayout_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('apicult_desigual_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
