# Natively — Makefile
# Atalhos para desenvolvimento local do app Electron.
#
# Uso rápido:
#   make setup   # primeira vez (install + native + .env)
#   make run     # inicia o app em modo dev

NPM ?= npm

.PHONY: help install setup env build-native rebuild-native run dev start watch \
	build build-electron dist clean test typecheck test-ci

.DEFAULT_GOAL := help

help: ## Mostra esta ajuda
	@echo "Natively — targets disponíveis:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Fluxo recomendado:"
	@echo "  make setup   # primeira vez"
	@echo "  make run     # rodar o app"

install: ## Instala dependências npm
	$(NPM) install

env: ## Cria .env a partir de .env.example (se ainda não existir)
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Criado .env a partir de .env.example — edite com suas API keys."; \
	else \
		echo ".env já existe."; \
	fi

build-native: ## Compila o módulo nativo de áudio (Rust)
	$(NPM) run build:native

rebuild-native: ## Recompila módulos nativos do Electron
	$(NPM) run rebuild:native

setup: install build-native env ## Setup inicial completo
	@echo ""
	@echo "Setup concluído. Edite .env e rode: make run"

run dev start: ## Inicia o app em modo desenvolvimento
	$(NPM) start

watch: ## Recompila Electron em watch mode (terminal separado)
	$(NPM) run watch

build: ## Build do frontend (Vite + TypeScript)
	$(NPM) run build

build-electron: ## Compila apenas o código Electron
	$(NPM) run build:electron

dist: ## Build de produção (instalador)
	$(NPM) run dist

clean: ## Remove pastas dist/ e dist-electron/
	$(NPM) run clean

test: ## Roda testes unitários principais
	$(NPM) test

typecheck: ## Typecheck do Electron
	$(NPM) run typecheck:electron

test-ci: ## Suite de testes usada no CI
	$(NPM) run test:ci
