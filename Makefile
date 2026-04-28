OUT ?= target/svg-preview
RADIUS ?= 2
PAD ?= 0.6
SHORT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

# Random u32 seed, snapshotted once per make invocation. Override with `make HSEED=N ...`.
ifndef HSEED
HSEED := $(shell od -An -N4 -tu4 /dev/urandom | tr -d ' ')
endif

# $(call EXPORT,<format>,<dst>) — empty <format> means default plain SVG
EXPORT = cargo run -q --example geo_export --release -- $(RADIUS) $(PAD) --seed $(HSEED) $(if $(1),--format $(1)) > $(2)
# $(call RENDER,<src>,<dst>) — templates the short SHA into an HTML file
RENDER = sed "s|__SHA__|$(SHORT_SHA)|g" $(1) > $(2)

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

json-v2: prep
	$(call EXPORT,json-v2,$(OUT)/hex-terrain.json)

preview-html: prep
	$(call RENDER,web/svg-preview.html,$(OUT)/index.html)

terrain-html: prep
	$(call RENDER,web/hex-terrain.html,$(OUT)/hex-terrain.html)
	cp web/hex-terrain.js $(OUT)/hex-terrain.js

preview: svg-plain svg-rich json-v1 json-v2 preview-html terrain-html
	@echo "preview built in $(OUT)/ (seed=$(HSEED))"

.PHONY: build test prep svg-plain svg-rich json-v1 json-v2 preview-html terrain-html preview
