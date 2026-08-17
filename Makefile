.DEFAULT_GOAL := help
.PHONY: help build typecheck test check clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: typecheck ## Verify the TypeScript extensions compile.

typecheck: ## Type-check all TypeScript without emitting files.
	./node_modules/.bin/tsc --noEmit

test: ## Run the TypeScript tests.
	node --test */tests/*-test.ts

check: typecheck test ## Run all non-mutating checks.

clean: ## Remove generated TypeScript metadata.
	rm -f *.tsbuildinfo
