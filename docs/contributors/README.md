# Documentation Contributeurs

Ce dossier contient la documentation technique destinée aux développeurs et contributeurs souhaitant participer au projet AiHarness.

## 📚 Contenu par langue

### [Français](fr/)

Documentation technique complète en français :

| Document | Description |
|---|---|
| [architecture-overview.md](fr/architecture-overview.md) | Vue d'ensemble du monorepo et socle Core (contrats, sessions, providers, sécurité workspace) |
| [server-architecture.md](fr/server-architecture.md) | Architecture détaillée du serveur API : routes, flux détaché, configuration, sécurité HTTP |
| [web-architecture.md](fr/web-architecture.md) | Architecture de l'application Web React : composants, stores, rendu riche, PWA |
| [extensions-cli.md](fr/extensions-cli.md) | Développement d'extensions pour le CLI : hooks, outils, commandes, UI plein écran |
| [extensions-web.md](fr/extensions-web.md) | Pont UI Web et interactions déclaratives : widgets, notices, formulaires |
| [i18n.md](fr/i18n.md) | Guide d'internationalisation de l'interface Web React |

### [English](en/)

| Document | Description |
|---|---|
| [architecture-overview.md](en/architecture-overview.md) | Monorepo overview and Core foundation |
| [server-architecture.md](en/server-architecture.md) | Detailed server API architecture |
| [web-architecture.md](en/web-architecture.md) | React Web application architecture |
| [extensions-cli.md](en/extensions-cli.md) | CLI extension development |
| [extensions-web.md](en/extensions-web.md) | Declarative Web UI bridge and interactions |
| [i18n.md](en/i18n.md) | React Web internationalization guide |

## 🔗 Liens utiles

- **[docs/ai/project-map.md](../ai/project-map.md)** — Navigation complète du dépôt pour agents IA
- **[docs/ai/index.md](../ai/index.md)** — Index de la documentation technique IA
- **[README.md](../../README.md)** — Vue d'ensemble du projet et démarrage rapide

## 📐 Structure des docs

```
docs/contributors/
├── README.md              # Navigation générale
├── fr/                    # Documentation française
│   ├── README.md
│   └── *.md
└── en/                    # English documentation
    ├── README.md
    └── *.md
```

## ✏️ Contribuer

Pour ajouter ou modifier la documentation technique :

1. Modifiez ensemble les fichiers correspondants dans `fr/` et `en/`.
2. Conservez à l’identique les chemins, commandes, contrats et exemples de code.
3. Les documents IA se trouvent dans [`docs/ai/topics/`](../ai/topics/) et suivent leurs propres règles de validation.
4. Les documents humains ici peuvent rester plus détaillés et orientés pratique.
