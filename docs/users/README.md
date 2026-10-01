# Documentation Utilisateurs

Ce dossier contient la documentation destinée aux utilisateurs finaux souhaitant installer, configurer et utiliser AiHarness au quotidien.

## 📚 Contenu par langue

### [Français](fr/)

Guide complet d'utilisation en français :

| Document | Description |
|---|---|
| [user-guide.md](fr/user-guide.md) | Guide utilisateur complet : installation, configuration CLI/Web, commandes, sessions, sécurité |
| [containerization.md](fr/containerization.md) | Exécution conteneurisée Docker pour le CLI et le Web |

### [English](en/)

| Document | Description |
|---|---|
| [user-guide.md](en/user-guide.md) | Full user guide: installation, CLI/Web configuration, commands, sessions and security |
| [containerization.md](en/containerization.md) | Docker-based CLI and Web execution |

## 🖼️ Captures d'écran

Des captures d'écran annotées sont disponibles dans le dossier [`docs/screenshots/`](../screenshots/) :

| Thème | Contenu |
|---|---|
| `01-workspace/` | Workspace, confiance des projets, worktrees Git |
| `02-chat/` | Conversation, composer, commandes intégrées |
| `03-sessions/` | Cycle de vie des sessions : branches, recherche, arbre |
| `04-files-git/` | Explorateur de fichiers, diffs Git, upload |
| `05-settings/` | Paramètres et administration (providers, modèles, plugins) |
| `06-extensions/` | Extensions Web : widgets et interactions |
| `07-mobile/` | Responsive design et PWA |
| `08-accessibility/` | Accessibilité et navigation clavier |

## 🔗 Liens utiles

- **[docs/contributors/fr/architecture-overview.md](../contributors/fr/architecture-overview.md)** — Vue d'ensemble technique (pour les curieux)
- **[README.md](../../README.md)** — Vue d'ensemble du projet et démarrage rapide

## 📐 Structure des docs

```
docs/users/
├── README.md              # Navigation générale
├── fr/                    # Documentation française
│   ├── README.md
│   ├── user-guide.md
│   └── containerization.md
└── en/                    # English documentation
    ├── README.md
    ├── user-guide.md
    └── containerization.md
```

## ✏️ Contribuer

Maintenez les versions française et anglaise ensemble :

1. modifiez le document dans les deux sous-dossiers de langue ;
2. conservez les commandes, variables et chemins techniques identiques ;
3. mettez à jour cet index lors de tout ajout ou renommage.
