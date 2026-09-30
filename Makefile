# =============================================================================
# Makefile - AiHarness
# Tous les tests s'exécutent dans un conteneur Docker.
# Ne jamais exécuter les tests directement sur l'hôte.
# =============================================================================

# Variables
PROJECT_NAME       := ai-harness
IMAGE_TEST         := $(PROJECT_NAME):test-latest
IMAGE_PROD         := $(PROJECT_NAME):prod-latest
CONTAINER_PREFIX   := aiharness-test

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
	@echo "  $(GREEN)Nettoyage$(NC)"
	@echo "    make clean-images      Supprimer les images Docker"
	@echo "    make clean-containers  Supprimer les conteneurs arrêtés"
	@echo "    make clean             Nettoyage complet (images + conteneurs)"
	@echo ""
	@echo "  $(GREEN)Utilitaires$(NC)"
	@echo "    make shell             Ouvrir un shell interactif (rebuild inclus)"
	@echo "    make lockfile          Régénérer package-lock.json dans Docker"
	@echo "    make info              Informations sur l'environnement Docker"

# =============================================================================
# IMAGES DOCKER
# =============================================================================

.PHONY: build-test build-prod build clean-images clean-containers clean

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

clean-images: ## Supprimer les images Docker du projet
	@printf "$(YELLOW)[CLEAN] Suppression des images...$(NC)\n"
	-docker rmi $(IMAGE_TEST) 2>/dev/null || true
	-docker rmi $(IMAGE_PROD) 2>/dev/null || true

clean-containers: ## Supprimer les conteneurs de test arrêtés
	@printf "$(YELLOW)[CLEAN] Suppression des conteneurs arrêtés...$(NC)\n"
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
		-t $(IMAGE_TEST)-typecheck \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-typecheck-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-typecheck \
		npm run typecheck

test: ## Lancer tous les tests unitaires dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Build de l'image + exécution des tests...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST)-run-$$RANDOM \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-unit-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-run-$$RANDOM \
		npm test

test-watch: ## Lancer les tests en mode watch dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Mode watch...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST)-run-$$RANDOM \
		.
	docker run --rm -it \
		--name $(CONTAINER_PREFIX)-unit-watch-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-run-$$RANDOM \
		npm run test:watch

test-coverage: ## Lancer les tests avec couverture dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Tests avec couverture...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST)-run-$$RANDOM \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-unit-cov-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-run-$$RANDOM \
		npm run test:coverage

# =============================================================================
# TESTS E2E (Playwright)
# =============================================================================

.PHONY: test-e2e

test-e2e: ## Lancer les tests e2e Playwright dans Docker (rebuild inclus)
	@printf "$(GREEN)[TEST] Exécution des tests e2e...$(NC)\n"
	docker build -f .docker/Dockerfile.test \
		--target test-runner \
		-t $(IMAGE_TEST)-run-$$RANDOM \
		.
	docker run --rm \
		--name $(CONTAINER_PREFIX)-e2e-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-run-$$RANDOM \
		npm run test:e2e

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
		-t $(IMAGE_TEST)-run-$$RANDOM \
		.
	docker run --rm -it \
		--name $(CONTAINER_PREFIX)-shell-$$RANDOM \
		-e CI=true \
		$(IMAGE_TEST)-run-$$RANDOM \
		bash

info: ## Informations sur l'environnement Docker
	@printf "$(GREEN)[INFO] Environnement Docker :$(NC)\n"
	@echo ""
	@printf "  Version Docker   : " && docker --version || echo "(Docker non installé)"
	@printf "  Buildx           : " && docker buildx version || echo "(Buildx non disponible)"
	@printf "  Image test       : $(IMAGE_TEST)\n"
	@printf "  Image prod       : $(IMAGE_PROD)\n"
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
