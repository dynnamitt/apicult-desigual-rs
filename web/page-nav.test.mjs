/** `node --test web/page-nav.test.mjs` */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PAGES, pageOptions } from "./page-nav.js";

const WEB_DIR = new URL(".", import.meta.url);
// `make` publishes hex-stream.html (the treadmill) as index.html and the guide from its template; every other page keeps its name.
const GUIDE_TMPL = "../docs/guide/guide.tmpl.html";
const SOURCE_OF = { "index.html": "hex-stream.html", "guide.html": GUIDE_TMPL };
const PUBLISHED_PAGES = [...readdirSync(WEB_DIR).filter((f) => f.endsWith(".html")), GUIDE_TMPL];

test("PAGES lists every published html page exactly once", () => {
  const sources = PAGES.map((p) => SOURCE_OF[p.href] ?? p.href).sort();
  assert.deepEqual(sources, [...PUBLISHED_PAGES].sort());
});

test("every page mounts the shared nav", () => {
  for (const f of PUBLISHED_PAGES) {
    const html = readFileSync(new URL(f, WEB_DIR), "utf8");
    assert.match(html, /data-page-nav/, f);
    assert.match(html, /<script type="module" src="page-nav\.js"><\/script>/, f);
  }
});

test("pageOptions selects the current page", () => {
  const selected = (path) => pageOptions(path).filter((o) => o.selected).map((o) => o.href);
  assert.deepEqual(selected("/apicult-desigual-rs/hex-units.html"), ["hex-units.html"]);
  assert.deepEqual(selected("/apicult-desigual-rs/"), ["index.html"]);
  assert.deepEqual(selected("/index.html"), ["index.html"]);
  assert.deepEqual(selected("/nope.html"), []);
  assert.equal(pageOptions("/").length, PAGES.length);
});
