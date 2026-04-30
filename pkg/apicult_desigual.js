/* @ts-self-types="./apicult_desigual.d.ts" */

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
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Build a layout with project defaults (`HGridSettings::default()`)
     * overridden by the explicit `radius` and noise seeds. `overrides`
     * pin per-hex height/radius values after noise sampling.
     * @param {number} radius
     * @param {number} height_seed
     * @param {number} radius_seed
     * @param {OverrideSpec[]} overrides
     */
    constructor(radius, height_seed, radius_seed, overrides) {
        const ptr0 = passArrayJsValueToWasm0(overrides, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmlayout_new(radius, height_seed, radius_seed, ptr0, len0);
        this.__wbg_ptr = ret;
        WasmLayoutFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Canonical unified mesh stream. Flat `n_tris * 9` floats: hex face
     * fans + junction tris + gap quads tessellated along the rust-canonical
     * diagonal. Welds into a complete surface on its own.
     * @returns {Float32Array}
     */
    tris() {
        const ret = wasm.wasmlayout_tris(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Gap-quad perimeter segments. Flat `n_edges * 6` floats
     * (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
     * `q[0]→q[1]→q[2]→q[3]→q[0]`. No tessellation diagonal — feed
     * straight into a `THREE.LineSegments` geometry.
     * @returns {Float32Array}
     */
    wire_edges() {
        const ret = wasm.wasmlayout_wire_edges(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WasmLayout.prototype[Symbol.dispose] = WasmLayout.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_9c75d47bf9e7731e: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
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
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./apicult_desigual_bg.js": import0,
    };
}

const HexCellViewFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hexcellview_free(ptr, 1));
const OverrideSpecFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_overridespec_free(ptr, 1));
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

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
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

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

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

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


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
