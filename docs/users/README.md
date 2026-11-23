# Documentation Utilisateurs

Ce dossier contient la documentation destinée aux utilisateurs finaux souhaitant installer, configurer et utiliser AiHarness au quotidien.

## 📚 Contenu par langue

### [Français](fr/)

Consultez l’[index français complet](fr/README.md) pour tous les guides spécialisés (opérations, sécurité, raccourcis, chargement des panneaux, etc.).

| Document | Description |
|---|---|
| [user-guide.md](fr/user-guide.md) | Guide utilisateur complet : installation, configuration CLI/Web, commandes, sessions, sécurité |
| [web-replies.md](fr/web-replies.md) | Limites de sortie, échecs partiels, demandes concurrentes et reconnexion |
| [containerization.md](fr/containerization.md) | Exécution conteneurisée Docker pour le CLI et le Web |
| [settings-navigation.md](fr/settings-navigation.md) | Navigation des réglages par catégorie et mémoire par workspace |
| [linked-directories.md](fr/linked-directories.md) | Consentement exact, confiance indépendante et navigation limitée |
| [static-demo.md](fr/static-demo.md) | Démonstration statique synthétique, hors ligne et sans autorité hôte |

### [English](en/)

See the [complete English index](en/README.md) for all specialized guides (operations, security, keybindings, optional panel loading, etc.).

| Document | Description |
|---|---|
| [user-guide.md](en/user-guide.md) | Full user guide: installation, CLI/Web configuration, commands, sessions and security |
| [web-replies.md](en/web-replies.md) | Output limits, partial failures, concurrent requests and reconnect |
| [containerization.md](en/containerization.md) | Docker-based CLI and Web execution |
| [settings-navigation.md](en/settings-navigation.md) | Settings categories and per-workspace navigation memory |
| [linked-directories.md](en/linked-directories.md) | Exact consent, independent trust and scoped browsing |
| [static-demo.md](en/static-demo.md) | Synthetic offline static demonstration without host authority |

## 🖼️ Captures d'écran

Les guides FR/EN intègrent les 11 captures de [`docs/screenshots/`](../screenshots/README.md), synchronisées depuis les références Playwright de l’interface actuelle. Elles utilisent des données synthétiques, principalement en anglais, sans annotations ajoutées. L’inventaire indique le scénario source et la procédure de vérification ; la démonstration statique reste une surface distincte, pas une référence visuelle du produit.

| Thème | Contenu |
|---|---|
| `01-workspace/` | Dialogue de confiance du workspace |
| `02-chat/` | Conversation, composer, commandes intégrées |
| `03-sessions/` | Titre généré et branche imbriquée, thèmes clair/sombre |
| `04-files-git/` | Explorateur dans la barre latérale et lecteur Markdown à droite |
| `05-settings/` | Réglages par catégories : catalogue de modèles et profils de sous-agents |
| `06-extensions/` | Formulaire déclaratif d’approbation d’une extension |
| `07-mobile/` | Explorateur et lecteur en tiroir sur tablette |
| `08-accessibility/` | Palette de commandes avec focus clavier |

## 🔗 Liens utiles

- **[docs/contributors/fr/architecture-overview.md](../contributors/fr/architecture-overview.md)** — Vue d'ensemble technique (pour les curieux)
- **[README.md](../../README.md)** — Vue d'ensemble du projet et démarrage rapide

## ✏️ Contribuer

Maintenez les versions française et anglaise ensemble :

1. modifiez le document dans les deux sous-dossiers de langue ;
2. conservez les commandes, variables et chemins techniques identiques ;
3. mettez à jour cet index lors de tout ajout ou renommage.
