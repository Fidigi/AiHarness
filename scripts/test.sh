#!/usr/bin/env bash
# =============================================================================
# AiHarness - Test Runner (fallback quand make n'est pas disponible)
# Déclenche les mêmes commandes que le Makefile : tout dans Docker via docker-compose
# =============================================================================

set -e

# Ajouter docker-compose au PATH si présent
if [ -d "$HOME/.local/bin" ]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

BLUE='\033[1;34m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NC='\033[0m'

# Configuration Docker
DOCKER_COMPOSE_BIN="docker-compose"
COMPOSE_FILE="../.dockers/AiHarness/docker-compose.test.yml"
PROJECT_NAME="ai-harness-test"

show_help() {
    echo -e "${BLUE}=== AiHarness - Test Runner (fallback) ===${NC}"
    echo ""
    echo "Tous les tests tournent dans un conteneur Docker."
    echo ""
    echo "Commandes:"
    echo "  test                 Exécuter tous les tests"
    echo "  test-ci              Tests CI/CD optimisés"
    echo "  install              Installer les dépendances"
    echo "  build                Construire le projet"
    echo "  clean                Nettoyer les fichiers de build"
    echo ""
}

run_docker() {
    local command="${1:-test}"
    
    if ! command -v $DOCKER_COMPOSE_BIN &> /dev/null; then
        echo -e "${RED}✗ Docker Compose n'est pas installé${NC}"
        exit 1
    fi
    
    case "$command" in
        test)
            echo -e "${BLUE}==> Tests dans le conteneur...${NC}"
            $DOCKER_COMPOSE_BIN -f "$COMPOSE_FILE" --project-name "${PROJECT_NAME}-ci" run --rm test-runner
            ;;
        test-ci)
            echo -e "${BLUE}==> Tests CI/CD dans le conteneur...${NC}"
            $DOCKER_COMPOSE_BIN -f "$COMPOSE_FILE" --project-name "${PROJECT_NAME}-ci" run --rm test-runner sh -c "npm run test-ci"
            ;;
        install)
            echo -e "${BLUE}==> Installation des dépendances dans le conteneur...${NC}"
            $DOCKER_COMPOSE_BIN -f "$COMPOSE_FILE" --project-name "${PROJECT_NAME}-ci" run --rm test-runner sh -c "npm install"
            ;;
        build)
            echo -e "${BLUE}==> Build dans le conteneur...${NC}"
            $DOCKER_COMPOSE_BIN -f "$COMPOSE_FILE" --project-name "${PROJECT_NAME}-ci" run --rm test-runner sh -c "npm run build"
            ;;
        clean)
            echo -e "${YELLOW}==> Nettoyage local des fichiers de build...${NC}"
            rm -rf dist .turbo packages/*/dist 2>/dev/null || true
            ;;
        *)
            echo -e "${RED}Commande inconnue: $command${NC}"
            show_help
            exit 1
            ;;
    esac
    
    echo -e "${GREEN}✓ Terminé (Docker)${NC}"
}

main() {
    local command="${1:-help}"
    
    case "$command" in
        test|test-ci|install|build|clean) run_docker "$command" ;;
        help|h|--help|-h|"") show_help ;;
        *) echo -e "${RED}Commande inconnue: $command${NC}"; exit 1 ;;
    esac
}

main "$@"
