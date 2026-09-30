#!/usr/bin/env bash
# =============================================================================
# Script de secours pour exécuter les tests dans Docker (sans make)
# Usage: ./scripts/run-tests.sh [commande]
# Commandes : test, test:e2e, build-test, shell
# =============================================================================

set -euo pipefail

PROJECT_NAME="ai-harness"
IMAGE_TEST="${PROJECT_NAME}:test-latest"
CONTAINER_PREFIX="aiharness-test"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Couleurs (désactivées si pas de terminal)
if [ ! -t 1 ]; then
    GREEN='' YELLOW='' RED='' NC=''
fi

log_info()  { printf "${GREEN}[TEST]${NC} %s\n" "$*"; }
log_warn()  { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
log_error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

# Vérifications préliminaires
check_prerequisites() {
    if ! command -v docker &>/dev/null; then
        log_error "Docker n'est pas installé. Veuillez l'installer avant de continuer."
        exit 1
    fi
}

build_image() {
    log_info "Construction de l'image Docker de test..."
    docker build -f .docker/Dockerfile.test \
        --target test-runner \
        -t "${IMAGE_TEST}" \
        .
}

run_container() {
    local cmd="$1"
    shift
    local container_name="${CONTAINER_PREFIX}-$RANDOM"
    
    docker run --rm \
        --name "${container_name}" \
        -v "$(pwd):/app" \
        -w /app \
        -e CI=true \
        "$@" \
        "${IMAGE_TEST}" \
        ${cmd}
}

# =============================================================================
# Commandes
# =============================================================================

case "${1:-test}" in
    test)
        check_prerequisites
        if ! docker image inspect "${IMAGE_TEST}" &>/dev/null; then
            build_image
        fi
        log_info "Exécution des tests unitaires..."
        run_container "npm test"
        ;;

    test:coverage)
        check_prerequisites
        if ! docker image inspect "${IMAGE_TEST}" &>/dev/null; then
            build_image
        fi
        log_info "Tests avec couverture de code..."
        run_container "npm run test:coverage"
        ;;

    test:e2e)
        check_prerequisites
        if ! docker image inspect "${IMAGE_TEST}" &>/dev/null; then
            build_image
        fi
        log_info "Exécution des tests e2e Playwright..."
        run_container "npm run test:e2e"
        ;;

    build-test)
        check_prerequisites
        build_image
        ;;

    shell)
        check_prerequisites
        if ! docker image inspect "${IMAGE_TEST}" &>/dev/null; then
            build_image
        fi
        log_info "Ouverture d'un shell interactif..."
        docker run --rm -it \
            --name "${CONTAINER_PREFIX}-shell-$RANDOM" \
            -v "$(pwd):/app" \
            -w /app \
            -e CI=true \
            "${IMAGE_TEST}" \
            bash
        ;;

    *)
        log_error "Commande inconnue : $1"
        echo ""
        echo "Usage: $0 {test|test:e2e|build-test|shell}"
        exit 1
        ;;
esac
