SVG_OUT ?= target/svg-preview
SVG_RADIUS ?= 2
SVG_PAD ?= 0.6
SHORT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

build:
	cargo build

test:
	cargo test

svg-prep:
	@mkdir -p $(SVG_OUT)

svg-plain: svg-prep
	cargo run -q --example geo_export --release -- $(SVG_RADIUS) $(SVG_PAD) > $(SVG_OUT)/apicult-desigual.svg

svg-rich: svg-prep
	cargo run -q --example geo_export --release -- $(SVG_RADIUS) $(SVG_PAD) --format svg-rich > $(SVG_OUT)/apicult-desigual-rich.svg

svg-json: svg-prep
	cargo run -q --example geo_export --release -- $(SVG_RADIUS) $(SVG_PAD) --format json-v1 > $(SVG_OUT)/apicult-desigual.json

svg-json-v2: svg-prep
	cargo run -q --example geo_export --release -- $(SVG_RADIUS) $(SVG_PAD) --format json-v2 > $(SVG_OUT)/hex-terrain.json

svg-html: svg-prep
	sed "s|__SHA__|$(SHORT_SHA)|g" web/svg-preview.html > $(SVG_OUT)/index.html

hex-terrain: svg-prep
	sed "s|__SHA__|$(SHORT_SHA)|g" web/hex-terrain.html > $(SVG_OUT)/hex-terrain.html
	cp web/hex-terrain.js $(SVG_OUT)/hex-terrain.js

svg-preview: svg-plain svg-rich svg-json svg-json-v2 svg-html hex-terrain
	@echo "svg preview built in $(SVG_OUT)/"

.PHONY: build test svg-prep svg-plain svg-rich svg-json svg-json-v2 svg-html hex-terrain svg-preview
