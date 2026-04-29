OUT ?= target/svg-preview
RADIUS ?= 2
PAD ?= 0.6
SHORT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

# Random u32 seeds, fresh per make invocation. Override with `make HSEED=N HSEED2=N HSEED3=N ...`.
HSEED  := $(shell od -An -N4 -tu4 /dev/urandom | tr -d ' ')
HSEED2 := $(shell od -An -N4 -tu4 /dev/urandom | tr -d ' ')
HSEED3 := $(shell od -An -N4 -tu4 /dev/urandom | tr -d ' ')

# $(call EXPORT,<format>,<dst>,<seed>) — empty <format> means default plain SVG; <seed> defaults to HSEED
EXPORT = cargo run -q --example geo_export --release -- $(RADIUS) $(PAD) --seed $(or $(3),$(HSEED)) $(if $(1),--format $(1)) > $(2)
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

json-v2-01: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-01.json)

json-v2-02: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-02.json,$(HSEED2))

json-v2-03: prep
	$(call EXPORT,json-v2,$(OUT)/apicult-03.json,$(HSEED3))

json-v3-01: prep
	$(call EXPORT,json-v3,$(OUT)/apicult-01.json)

json-v3-02: prep
	$(call EXPORT,json-v3,$(OUT)/apicult-02.json,$(HSEED2))

json-v3-03: prep
	$(call EXPORT,json-v3,$(OUT)/apicult-03.json,$(HSEED3))

preview-html: prep
	$(call RENDER,web/svg-preview.html,$(OUT)/svg-preview.html)

terrain-html: prep
	$(call RENDER,web/hex-terrain.html,$(OUT)/index.html)
	cp web/hex-terrain.js web/hex-terrain-scene.js web/hex-terrain-shader.js $(OUT)/

preview: svg-plain svg-rich json-v1 json-v3-01 json-v3-02 json-v3-03 preview-html terrain-html
	@echo "preview built in $(OUT)/ (seeds=$(HSEED),$(HSEED2),$(HSEED3))"

.PHONY: build test prep svg-plain svg-rich json-v1 json-v2-01 json-v2-02 json-v2-03 json-v3-01 json-v3-02 json-v3-03 preview-html terrain-html preview
