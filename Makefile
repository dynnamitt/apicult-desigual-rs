OUT ?= target/www-preview
RADIUS ?= 2
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

build:
	cargo build

test:
	cargo test

prep:
	@mkdir -p $(OUT)

svg-plain: prep
	$(call EXPORT,,$(OUT)/apicult-desigual.svg)

svg-rich: prep
	$(call EXPORT,svg-rich,$(OUT)/apicult-desigual-rich.svg)

json-v1: prep
	$(call EXPORT,json-v1,$(OUT)/apicult-desigual.json)

# json-v2-* targets retained for `cargo run --example geo_export -- --format json-v2`
# parity; not consumed by `preview` (the demo computes meshes in-browser via wasm).
json-v2-01: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-01.json)

json-v2-02: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-02.json)

json-v2-03: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-03.json)

wasm: prep
	wasm-pack build --target web --out-dir web/pkg --features wasm
	@mkdir -p $(OUT)/pkg
	cp web/pkg/apicult_desigual.js web/pkg/apicult_desigual_bg.wasm $(OUT)/pkg/
	@if [ -f web/pkg/apicult_desigual.d.ts ]; then cp web/pkg/apicult_desigual.d.ts $(OUT)/pkg/; fi

preview-html: prep
	$(call RENDER,web/svg-preview.html,$(OUT)/svg-preview.html)

terrain-html: prep
	$(call RENDER_TERRAIN,web/hex-terrain.html,$(OUT)/index.html)
	cp web/hex-terrain.js web/hex-terrain-scene.js web/hex-terrain-shader.js web/hex-seam.js web/hex-terrain-controls.js $(OUT)/
	cp web/hex-terrain.css $(OUT)/

preview: svg-plain svg-rich json-v1 wasm preview-html terrain-html
	@echo "preview built in $(OUT)/ (seed=$(HSEED), radius=$(RADIUS))"

.PHONY: build test prep svg-plain svg-rich json-v1 json-v2-01 json-v2-02 json-v2-03 wasm preview-html terrain-html preview
