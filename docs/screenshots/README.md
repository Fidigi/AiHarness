# AiHarness Screenshots / Captures d’écran

## English

This directory contains deterministic product screenshots used by the human-facing documentation. They are copied from the Playwright visual baselines in `e2e/visual.spec.ts-snapshots/`; the scenarios use bounded mock data and contain no credentials.

### Formats and viewports

| Surface | Format | Viewport |
|---|---|---|
| Desktop | PNG | 1440×900 |
| Tablet | PNG | 820×1180 |
| Mobile | PNG | 390×844 when a mobile capture is added |

Use Light and Dark variants when a state benefits from a theme comparison. File names describe the feature, state, and optional theme.

### Current inventory

| Directory | Capture | Visual baseline source |
|---|---|---|
| `01-workspace/` | `trust-dialog-light.png` | `trust-pwa-desktop-light-chromium-linux.png` |
| `02-chat/` | `context-usage-light.png` | `session-info-desktop-light-chromium-linux.png` |
| `02-chat/` | `agent-controls-light.png` | `agent-controls-desktop-light-chromium-linux.png` |
| `03-sessions/` | `session-lifecycle-light.png` | `session-lifecycle-desktop-light-chromium-linux.png` |
| `03-sessions/` | `session-lifecycle-dark.png` | `session-lifecycle-desktop-dark-chromium-linux.png` |
| `04-files-git/` | `workspace-files-light.png` | `workspace-files-desktop-light-chromium-linux.png` |
| `05-settings/` | `model-catalog-light.png` | `model-catalog-desktop-light-chromium-linux.png` |
| `05-settings/` | `subagent-profiles-light.png` | `subagent-settings-desktop-light-chromium-linux.png` |
| `06-extensions/` | `interaction-confirm-light.png` | `extension-interaction-desktop-light-chromium-linux.png` |
| `07-mobile/` | `workspace-drawer-tablet-light.png` | `workspace-files-tablet-light-chromium-linux.png` |
| `08-accessibility/` | `command-palette-focus-light.png` | `command-palette-desktop-light-chromium-linux.png` |

### Refresh procedure

1. Regenerate the visual baselines in Docker:
   ```bash
   make test-e2e E2E_ARGS='e2e/visual.spec.ts --update-snapshots=all'
   ```
2. Review the changed baselines and confirm that mock content contains no secrets.
3. Run `make sync-doc-screenshots` to copy the documented states.
4. Update this inventory and all guide references when adding or renaming a capture.
5. Run `make lint-docs` and `git diff --check`.

---

## Français

Ce dossier contient les captures déterministes du produit utilisées par la documentation humaine. Elles sont copiées depuis les références visuelles Playwright de `e2e/visual.spec.ts-snapshots/` ; les scénarios utilisent des données mockées et bornées, sans credential.

### Formats et viewports

| Surface | Format | Viewport |
|---|---|---|
| Desktop | PNG | 1440×900 |
| Tablette | PNG | 820×1180 |
| Mobile | PNG | 390×844 lorsqu’une capture mobile est ajoutée |

Utilisez les variantes Light et Dark lorsqu’un état mérite une comparaison de thème. Les noms de fichiers décrivent la fonctionnalité, l’état et éventuellement le thème.

### Inventaire actuel

| Dossier | Capture | Référence visuelle source |
|---|---|---|
| `01-workspace/` | `trust-dialog-light.png` | `trust-pwa-desktop-light-chromium-linux.png` |
| `02-chat/` | `context-usage-light.png` | `session-info-desktop-light-chromium-linux.png` |
| `02-chat/` | `agent-controls-light.png` | `agent-controls-desktop-light-chromium-linux.png` |
| `03-sessions/` | `session-lifecycle-light.png` | `session-lifecycle-desktop-light-chromium-linux.png` |
| `03-sessions/` | `session-lifecycle-dark.png` | `session-lifecycle-desktop-dark-chromium-linux.png` |
| `04-files-git/` | `workspace-files-light.png` | `workspace-files-desktop-light-chromium-linux.png` |
| `05-settings/` | `model-catalog-light.png` | `model-catalog-desktop-light-chromium-linux.png` |
| `05-settings/` | `subagent-profiles-light.png` | `subagent-settings-desktop-light-chromium-linux.png` |
| `06-extensions/` | `interaction-confirm-light.png` | `extension-interaction-desktop-light-chromium-linux.png` |
| `07-mobile/` | `workspace-drawer-tablet-light.png` | `workspace-files-tablet-light-chromium-linux.png` |
| `08-accessibility/` | `command-palette-focus-light.png` | `command-palette-desktop-light-chromium-linux.png` |

### Procédure de mise à jour

1. Régénérez les références visuelles dans Docker :
   ```bash
   make test-e2e E2E_ARGS='e2e/visual.spec.ts --update-snapshots=all'
   ```
2. Examinez les références modifiées et vérifiez que les données mockées ne contiennent aucun secret.
3. Lancez `make sync-doc-screenshots` pour copier les états documentés.
4. Mettez à jour cet inventaire et les références des guides lors de tout ajout ou renommage.
5. Lancez `make lint-docs` et `git diff --check`.
