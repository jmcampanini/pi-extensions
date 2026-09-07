.DEFAULT_GOAL := help
.PHONY: help build typecheck fmt fmt-check lint test check clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: typecheck ## Verify the TypeScript extensions compile.

typecheck: ## Type-check all TypeScript without emitting files.
	./node_modules/.bin/tsc --noEmit

fmt: ## Format tracked TypeScript source files.
	git ls-files -z -- '*.ts' | xargs -0 ./node_modules/.bin/prettier --write

fmt-check: ## Verify tracked TypeScript formatting without changing files.
	git ls-files -z -- '*.ts' | xargs -0 ./node_modules/.bin/prettier --check

lint: ## Run type-aware correctness checks on tracked TypeScript.
	git ls-files -z -- '*.ts' | xargs -0 ./node_modules/.bin/oxlint

test: ## Run the TypeScript tests.
	node --test */tests/*-test.ts

check: fmt-check lint typecheck test ## Run all non-mutating checks.

clean: ## Remove generated TypeScript metadata.
	rm -f *.tsbuildinfo
