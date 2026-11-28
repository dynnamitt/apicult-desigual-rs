/** `node --test web/canvas.test.mjs` */
import test from "node:test";
import assert from "node:assert/strict";
import { needsResize, runFrames } from "./canvas.js";

// Pixel 5 emulation: 351×424 CSS px at devicePixelRatio 3.
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

test("runFrames shows a throwing frame's error once, keeps looping, and clears it on recovery", () => {
  const queued = [], inserted = [];
  globalThis.requestAnimationFrame = (fn) => queued.push(fn);
  globalThis.document = { createElement: () => ({ remove() { inserted.splice(inserted.indexOf(this), 1); } }) };
  const canvas = { insertAdjacentElement: (_, p) => inserted.push(p) };
  const origError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  try {
    let fail = true;
    runFrames(canvas, "x failed", () => { if (fail) throw new Error("boom"); });
    queued.shift()();
    queued.shift()();
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].textContent, "x failed: boom");
    assert.equal(logged, 1);
    fail = false;
    queued.shift()();
    assert.equal(inserted.length, 0, "error removed after a good frame");
    assert.equal(queued.length, 1, "loop still running");
  } finally {
    console.error = origError;
    delete globalThis.requestAnimationFrame;
    delete globalThis.document;
  }
});
