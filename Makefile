# Couleurs
BLUE=\033[1;34m
GREEN=\033[1;32m
NC=\033[0m

# ============================================
# Commande HELP
# ============================================

help: ## Affiche cette aide
	@echo "$(BLUE)=== Commandes disponibles ===$(NC)"
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

# ============================================
# Cible par défaut
# ============================================

.DEFAULT_GOAL := help