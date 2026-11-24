/** `node --test web/canvas.test.mjs` */
import test from "node:test";
import assert from "node:assert/strict";
import { needsResize } from "./canvas.js";

// Pixel 5 emulation from #28: 351×424 CSS px at devicePixelRatio 3.
const css = { clientWidth: 351, clientHeight: 424 };

test("needsResize is false once the buffer matches at a high devicePixelRatio", () => {
  assert.equal(needsResize({ ...css, width: 1053, height: 1272 }, 3), false);
  assert.equal(needsResize({ ...css, width: 351, height: 424 }, 1), false);
});

test("needsResize is true when the CSS size or the pixel ratio changes", () => {
  assert.equal(needsResize({ ...css, width: 351, height: 424 }, 3), true);
  assert.equal(needsResize({ ...css, clientWidth: 400, width: 1053, height: 1272 }, 3), true);
});

test("needsResize floors fractional ratios the way renderer.setSize does", () => {
  assert.equal(needsResize({ ...css, width: Math.floor(351 * 1.5), height: Math.floor(424 * 1.5) }, 1.5), false);
});
