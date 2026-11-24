/** `node --test web/hex-controls.test.mjs` */
import test from "node:test";
import assert from "node:assert/strict";
import { readSettingsFromDOM, STREAM_SCHEMA } from "./hex-controls.js";

// Just enough of the DOM for readSettingsFromDOM: inputs by id, with HTML's "" for a missing attribute.
const fakeRoot = (inputs) => ({
  querySelector: (sel) => {
    const el = inputs[sel.slice(1)];
    return el && { min: "", max: "", ...el, classList: { contains: () => false } };
  },
});

const read = (speed) => readSettingsFromDOM(fakeRoot({
  "ctl-chunk-radius": { value: "3", min: "0", max: "6" },
  "ctl-seed": { value: "" },
  "ctl-speed": { value: speed, min: "0", max: "60" },
  "ctl-direction": { value: "2", min: undefined, max: undefined }, // <select> has no min/max
}), STREAM_SCHEMA);

test("readSettingsFromDOM clamps typed numbers to the input's own min/max", () => {
  assert.equal(read("100000").speed, 60);
  assert.equal(read("-5").speed, 0);
  assert.equal(read("12.5").speed, 12.5);
});

test("readSettingsFromDOM leaves inputs without limits, and non-numbers, alone", () => {
  const s = read("abc");
  assert.ok(Number.isNaN(s.speed));
  assert.equal(s.seed, null);
  assert.equal(s.direction, 2);
  assert.equal(s.chunkRadius, 3);
});
