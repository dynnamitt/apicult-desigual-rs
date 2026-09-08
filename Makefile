OUT ?= target/www-preview
RADIUS ?= 2
# The units demo wants a roomier board to walk around on than the SVG/terrain
# previews need, so it gets its own radius knob.
UNITS_RADIUS ?= 4
PAD ?= 0.6
SHORT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

# Random u32 seed, fresh per make invocation. Override with `make HSEED=N ...`.
# Feeds the SVG previews and the v1 JSON payload (grid + welded mesh stay
# in sync). The terrain demo picks its own per-mesh seeds in-browser.
HSEED  := $(shell od -An -N4 -tu4 /dev/urandom | tr -d ' ')

# $(call EXPORT,<format>,<dst>,<seed>) — empty <format> means default plain SVG; <seed> defaults to HSEED
EXPORT = cargo run -q --example geo_export --release -- $(RADIUS) $(PAD) --seed $(or $(3),$(HSEED)) $(if $(1),--format $(1)) > $(2)
# $(call RENDER,<src>,<dst>) — templates the short SHA into an HTML file
RENDER = sed "s|__SHA__|$(SHORT_SHA)|g" $(1) > $(2)
# $(call RENDER_TERRAIN,<src>,<dst>) — also templates RADIUS for the terrain bootstrapper
RENDER_TERRAIN = sed -e "s|__SHA__|$(SHORT_SHA)|g" -e "s|__RADIUS__|$(RADIUS)|g" $(1) > $(2)
# $(call RENDER_UNITS,<src>,<dst>) — same, with the units demo's own radius
RENDER_UNITS = sed -e "s|__SHA__|$(SHORT_SHA)|g" -e "s|__UNITS_RADIUS__|$(UNITS_RADIUS)|g" $(1) > $(2)
# $(call ENSURE,<cmd>,<install-recipe>) — short-circuit if <cmd> is on PATH;
# otherwise print a notice and run <install-recipe> to install it. Use as the
# first `@`-prefixed line of a recipe (each recipe line runs in its own shell).
ENSURE = command -v $(1) >/dev/null 2>&1 || { echo ">> $(1) not found — installing via: $(2)"; $(2); }

# Front-end assets, split by which page needs them. Both pages share the
# stylesheet, the sidebar binder and the pure helpers (welding, seeds).
COMMON_WEB   = web/demo.css web/hex-controls.js web/weld.js web/seed.js
TERRAIN_WEB  = web/hex-terrain.js web/hex-terrain-scene.js web/hex-terrain-shader.js web/hex-seam.js
UNITS_WEB    = web/hex-units-scene.js web/hex-units-grid.js

build:
	cargo build

test: test-js
	cargo test

# Pure-JS units: the weld helper and the units demo's pathfinding, neither of
# which needs a browser or a wasm build.
test-js:
	node --test web/*.test.mjs

prep:
	@mkdir -p $(OUT)

svg-plain: prep
	$(call EXPORT,,$(OUT)/apicult-desigual.svg)

svg-rich: prep
	$(call EXPORT,svg-rich,$(OUT)/apicult-desigual-rich.svg)

json-v1: prep
	$(call EXPORT,json-v1,$(OUT)/apicult-desigual.json)

wasm: prep
	@$(call ENSURE,wasm-pack,cargo install wasm-pack)
	wasm-pack build --target web --out-dir web/pkg --features wasm
	@mkdir -p $(OUT)/pkg
	cp web/pkg/apicult_desigual.js web/pkg/apicult_desigual_bg.wasm $(OUT)/pkg/
	@if [ -f web/pkg/apicult_desigual.d.ts ]; then cp web/pkg/apicult_desigual.d.ts $(OUT)/pkg/; fi

preview-html: prep
	$(call RENDER,web/svg-preview.html,$(OUT)/svg-preview.html)

terrain-html: prep
	$(call RENDER_TERRAIN,web/hex-terrain.html,$(OUT)/index.html)
	cp $(COMMON_WEB) $(TERRAIN_WEB) $(OUT)/

units-html: prep
	$(call RENDER_UNITS,web/hex-units.html,$(OUT)/hex-units.html)
	cp $(COMMON_WEB) $(UNITS_WEB) $(OUT)/

serve: preview
	cd $(OUT); python3 -m http.server

preview: svg-plain svg-rich json-v1 wasm preview-html terrain-html units-html
	@echo "preview built in $(OUT)/ (seed=$(HSEED), radius=$(RADIUS), units_radius=$(UNITS_RADIUS))"

.PHONY: build test test-js prep svg-plain svg-rich json-v1 wasm preview-html terrain-html units-html preview serve
