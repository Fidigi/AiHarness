# =============================================================================
# Makefile - AiHarness
# Tous les tests s'exécutent dans un conteneur Docker.
# Ne jamais exécuter les tests directement sur l'hôte.
# =============================================================================

# Variables
PROJECT_NAME       := ai-harness
IMAGE_TEST         := $(PROJECT_NAME):test-latest
IMAGE_PROD         := $(PROJECT_NAME):prod-latest
RUN_ID             := $(shell date +%s%N)
IMAGE_TEST_RUN     := $(IMAGE_TEST)-run-$(RUN_ID)
IMAGE_TYPECHECK    := $(IMAGE_TEST)-typecheck-$(RUN_ID)
CONTAINER_PREFIX   := aiharness-test
PROD_CONTAINER     ?= $(PROJECT_NAME)-prod
PROD_DATA_VOLUME   ?= $(PROJECT_NAME)-data
PROD_BIND_ADDRESS  ?= 127.0.0.1
PROD_PORT          ?= 3080
PROD_DOCKER_ARGS   ?=
E2E_DOCKER_ARGS    ?= --shm-size=1g

# Couleurs pour le terminal
GREEN  := \033[0;32m
YELLOW := \033[1;33m
RED    := \033[0;31m
NC     := \033[0m # No Color

# =============================================================================
# AIDE
# =============================================================================
.PHONY: help
help: ## Afficher cette aide
	@echo "========================================"
	@echo "  AiHarness - Makefile d'aide"
	@echo "========================================"
	@echo ""
	@echo "Commandes disponibles :"
	@echo ""
	@echo "  $(GREEN)Tests (toujours dans Docker)$(NC)"
	@echo "    make test              Lancer tous les tests unitaires"
	@echo "    make test-watch        Lancer les tests en mode watch"
	@echo "    make test-coverage     Lancer les tests avec couverture"
	@echo "    make test-e2e          Lancer les tests e2e (Playwright)"
	@echo "    make typecheck         Vérifier les types TypeScript"
	@echo ""
	@echo "  $(GREEN)Images Docker$(NC)"
	@echo "    make build-test        Construire l'image de test"
	@echo "    make build-prod        Construire l'image de production"
	@echo "    make build             Construire toutes les images"
	@echo ""
	@echo "  $(GREEN)Production$(NC)"
	@echo "    make run-prod          Construire et lancer le conteneur de production"
	@echo "    make shell-prod        Ouvrir Bash dans le conteneur de production"
	@echo ""
	@echo "  $(GREEN)Nettoyage$(NC)"
	@echo "    make clean-images      Supprimer les images Docker"
	@echo "    make clean-containers  Supprimer les conteneurs du projet"
	@echo "    make clean             Nettoyage complet (images + conteneurs)"
	@echo ""
	@echo "  $(GREEN)Utilitaires$(NC)"
	@echo "    make shell             Ouvrir un shell interactif (rebuild inclus)"
	@echo "    make lockfile          Régénérer package-lock.json dans Docker"
	@echo "    make info              Informations sur l'environnement Docker"
	@echo "    make lint-docs         Vérifier cibles, ancres et frontières de versioning des docs"
	@echo "    make sync-doc-screenshots  Copier les baselines visuelles documentées"

# =============================================================================
# IMAGES DOCKER
# =============================================================================

.PHONY: build-test build-prod build run-prod shell-prod clean-images clean-containers clean

build-test: ## Construire l'image de test
	@printf "$(YELLOW)[BUILD] Construction de l'image de test...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		-t $(IMAGE_TEST) \
		--target test-runner \
		.

build-prod: ## Construire l'image de production
	@printf "$(YELLOW)[BUILD] Construction de l'image de production...$(NC)\n"
	docker build -f .docker/Dockerfile.prod \
		-t $(IMAGE_PROD) \
		--target prod \
		.

build: build-test build-prod ## Construire toutes les images

run-prod: build-prod ## Construire et lancer le conteneur de production en arrière-plan
	@printf "$(GREEN)[PROD] Lancement du conteneur de production...$(NC)\n"
	@docker rm -f $(PROD_CONTAINER) >/dev/null 2>&1 || true
	docker run --rm --detach \
		--name $(PROD_CONTAINER) \
		--publish $(PROD_BIND_ADDRESS):$(PROD_PORT):3080 \
		--volume $(PROD_DATA_VOLUME):/app/.ai-harness $(PROD_DOCKER_ARGS) \
		$(IMAGE_PROD)
	@printf "$(GREEN)[PROD] Application disponible sur http://$(PROD_BIND_ADDRESS):$(PROD_PORT)$(NC)\n"

shell-prod: ## Ouvrir Bash dans le conteneur de production en cours d'exécution
	@if [ "$$(docker inspect --format '{{.State.Running}}' $(PROD_CONTAINER) 2>/dev/null)" != "true" ]; then \
		printf "$(RED)[ERREUR] Le conteneur $(PROD_CONTAINER) n'est pas en cours d'exécution. Lancez d'abord 'make run-prod'.$(NC)\n"; \
		exit 1; \
	fi
	docker exec -it $(PROD_CONTAINER) bash

clean-images: ## Supprimer les images Docker du projet
	@printf "$(YELLOW)[CLEAN] Suppression des images...$(NC)\n"
	-docker rmi $(IMAGE_TEST) 2>/dev/null || true
	-docker rmi $(IMAGE_PROD) 2>/dev/null || true

clean-containers: ## Supprimer les conteneurs du projet
	@printf "$(YELLOW)[CLEAN] Suppression des conteneurs...$(NC)\n"
	docker rm -f $(PROD_CONTAINER) 2>/dev/null || true
	docker rm -f $$(docker ps -aq --filter "ancestor=$(IMAGE_TEST)" 2>/dev/null) || true

clean: clean-containers clean-images ## Nettoyage complet (images + conteneurs)

# =============================================================================
# TESTS UNITAIRES (Vitest)
# =============================================================================

.PHONY: test test-watch test-coverage typecheck

typecheck: ## Vérifier les types TypeScript dans Docker (rebuild inclus)
	@printf "$(GREEN)[TYPECHECK] Build de l'image + vérification TypeScript...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TYPECHECK) \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-typecheck-$(RUN_ID) \
		-e CI=true \
		$(IMAGE_TYPECHECK) \
		npm run typecheck

test: ## Lancer tous les tests unitaires dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Build de l'image + exécution des tests...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST_RUN) \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-unit-$(RUN_ID) \
		-e CI=true \
		$(IMAGE_TEST_RUN) \
		npm test

test-watch: ## Lancer les tests en mode watch dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Mode watch...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST_RUN) \
		.
	docker run --rm -it \
		--name $(CONTAINER_PREFIX)-unit-watch-$(RUN_ID) \
		-e CI=true \
		$(IMAGE_TEST_RUN) \
		npm run test:watch

test-coverage: ## Lancer les tests avec couverture dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Tests avec couverture...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST_RUN) \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-unit-cov-$(RUN_ID) \
		-e CI=true \
		$(IMAGE_TEST_RUN) \
		npm run test:coverage

# =============================================================================
# TESTS E2E (Playwright)
# =============================================================================

.PHONY: test-e2e

test-e2e: ## Lancer les tests e2e Playwright dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Exécution des tests e2e...$(NC)\n"
	@set -eu; \
		run_id=$$$$; \
		image="$(IMAGE_TEST)-run-$$run_id"; \
		container="$(CONTAINER_PREFIX)-e2e-$$run_id"; \
		cleanup() { \
			status=$$?; \
			trap - EXIT; \
			mkdir -p playwright-report test-results e2e/visual.spec.ts-snapshots; \
			docker cp "$${container}:/app/playwright-report/." playwright-report/ 2>/dev/null || true; \
			docker cp "$${container}:/app/test-results/." test-results/ 2>/dev/null || true; \
			docker cp "$${container}:/app/e2e/visual.spec.ts-snapshots/." e2e/visual.spec.ts-snapshots/ 2>/dev/null || true; \
			docker rm -f "$$container" >/dev/null 2>&1 || true; \
			docker image rm "$$image" >/dev/null 2>&1 || true; \
			exit $$status; \
		}; \
		trap cleanup EXIT; \
		rm -rf playwright-report test-results; \
		mkdir -p playwright-report test-results; \
		docker build -f .docker/Dockerfile.test \
			--target test-runner \
			-t "$$image" \
			.; \
		docker create \
			--name "$$container" \
			-e CI=true \
			$(E2E_DOCKER_ARGS) \
			"$$image" \
			npm run test:e2e -- $(E2E_ARGS) >/dev/null; \
		docker start --attach "$$container"

# =============================================================================
# UTILITAIRES
# =============================================================================

.PHONY: shell lockfile info

lockfile: ## Régénérer package-lock.json dans Docker
	@printf "$(GREEN)[LOCKFILE] Synchronisation de package-lock.json...$(NC)\n"
	rm -rf .lockfile-output
	docker build -f .docker/Dockerfile.lockfile \
		--target export \
		--output type=local,dest=.lockfile-output \
		.
	mv .lockfile-output/package-lock.json package-lock.json
	rm -rf .lockfile-output

shell: ## Ouvrir un shell interactif dans le conteneur (rebuild inclus)
	@printf "$(GREEN)[SHELL] Ouverture d'un shell interactif...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST_RUN) \
		.
	docker run --rm -it \
		--name $(CONTAINER_PREFIX)-shell-$(RUN_ID) \
		-e CI=true \
		$(IMAGE_TEST_RUN) \
		bash

info: ## Informations sur l'environnement Docker
	@printf "$(GREEN)[INFO] Environnement Docker :$(NC)\n"
	@echo ""
	@printf "  Version Docker   : " && docker --version || echo "(Docker non installé)"
	@printf "  Buildx           : " && docker buildx version || echo "(Buildx non disponible)"
	@printf "  Image test       : $(IMAGE_TEST)\n"
	@printf "  Image prod       : $(IMAGE_PROD)\n"
	@printf "  Conteneur prod   : $(PROD_CONTAINER)\n"
	@printf "  Port prod        : $(PROD_BIND_ADDRESS):$(PROD_PORT)\n"
	@printf "  Volume prod      : $(PROD_DATA_VOLUME)\n"
	@echo ""
	@if [ -f ".docker/Dockerfile.test" ]; then \
		printf "$(GREEN)  Dockerfile test  : OK$(NC)\n"; \
	else \
		printf "$(RED)  Dockerfile test  : MISSING$(NC)\n"; \
	fi
	@if [ -f ".docker/Dockerfile.prod" ]; then \
		printf "$(GREEN)  Dockerfile prod  : OK$(NC)\n"; \
	else \
		printf "$(RED)  Dockerfile prod  : MISSING$(NC)\n"; \
	fi

# =============================================================================
# DOCUMENTATION VALIDATION
# =============================================================================

.PHONY: lint-docs sync-doc-screenshots
lint-docs: ## Vérifier les cibles, ancres et frontières de versioning de la documentation
	@bash scripts/check-doc-versioning.sh docs --predictive || \
		(echo ""; echo "Fix documentation violations before committing."; exit 1)

sync-doc-screenshots: ## Copier les baselines Playwright utilisées par la documentation
	@bash scripts/sync-doc-screenshots.sh
