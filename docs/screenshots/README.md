# AiHarness Screenshots / Captures d’écran

## English

This directory contains deterministic product screenshots used by the human-facing documentation. They are copied from the Playwright visual baselines in `e2e/visual.spec.ts-snapshots/`; the scenarios use bounded mock data and contain no credentials. The 11 documented states were checked against the Web source at commit `6e16a33d` before synchronization. Fixture dates, model names and counts are synthetic, not a live account or catalogue inventory.

They illustrate the [English user guide](../users/en/user-guide.md) and [French user guide](../users/fr/user-guide.md). Most captures use English labels. The current desktop layout has the explorer below conversations in the left sidebar and a separate file reader on the right; Settings is a categorized dialog with resource lists/details. These are product screenshots, not captures of the separate static demo.

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

### Workspace-default recovery

Four reviewed selector crops stay beside their owning `e2e/workspace-defaults.spec.ts`, not in the general visual directory. They show a missing default without exposing server paths: English Light [desktop](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-desktop-light-chromium-linux.png) / [mobile](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-mobile-light-chromium-linux.png), and French Dark [desktop](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-desktop-dark-chromium-linux.png) / [mobile](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-mobile-dark-chromium-linux.png). Source viewports are 1440×900 and 390×900; these PNGs crop only the workspace selector. Generate new baselines through that owning file, then validate without updates; unrelated historical baselines are unchanged.

### Refresh procedure

1. Check the baselines against the current interface in Docker:
   ```bash
   make test-e2e E2E_ARGS='e2e/visual.spec.ts --retries=0'
   ```
2. If an intentional interface change requires new baselines, regenerate the affected scenarios with `--update-snapshots=all`. Review the images for layout, readable content and absence of secrets, then rerun those scenarios **without** snapshot updates. Updating a baseline alone is not validation.
3. Run `make sync-doc-screenshots` to copy the 11 documented states. This command copies existing PNGs; it does not run the application or check freshness.
4. Check the corresponding passages in both user guides. Update this inventory and all references when adding or renaming a capture.
5. Run `make lint-docs` and `git diff --check`.

---

## Français

Ce dossier contient les captures déterministes du produit utilisées par la documentation humaine. Elles sont copiées depuis les références visuelles Playwright de `e2e/visual.spec.ts-snapshots/` ; les scénarios utilisent des données mockées et bornées, sans credential. Les 11 états documentés ont été vérifiés contre le code Web du commit `6e16a33d` avant synchronisation. Dates, noms de modèles et compteurs sont synthétiques, pas un compte réel ni un inventaire de catalogue en production.

Elles illustrent le [guide français](../users/fr/user-guide.md) et le [guide anglais](../users/en/user-guide.md). La plupart utilisent des libellés anglais. Sur ordinateur, l’interface actuelle place l’explorateur sous les conversations dans la barre latérale gauche et le lecteur de fichiers séparément à droite ; les réglages sont une boîte de dialogue par catégories avec listes et détails. Il s’agit du produit, pas de la démonstration statique distincte.

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

### Récupération du workspace par défaut

Quatre recadrages examinés du sélecteur restent à côté de leur scénario `e2e/workspace-defaults.spec.ts`, hors du dossier visuel général. Ils montrent un défaut absent sans exposer de chemin serveur : anglais Light [desktop](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-desktop-light-chromium-linux.png) / [mobile](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-mobile-light-chromium-linux.png), français Dark [desktop](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-desktop-dark-chromium-linux.png) / [mobile](../../e2e/workspace-defaults.spec.ts-snapshots/workspace-unavailable-mobile-dark-chromium-linux.png). Les viewports sources sont 1440×900 et 390×900 ; ces PNG recadrent uniquement le sélecteur de workspace. Générez les nouvelles références via ce fichier propriétaire, puis validez sans mise à jour ; les références historiques non liées sont conservées.

### Procédure de mise à jour

1. Vérifiez les références contre l’interface actuelle dans Docker :
   ```bash
   make test-e2e E2E_ARGS='e2e/visual.spec.ts --retries=0'
   ```
2. Si une évolution volontaire de l’interface impose de nouvelles références, régénérez les scénarios concernés avec `--update-snapshots=all`. Examinez disposition, lisibilité et absence de secrets, puis rejouez ces scénarios **sans** mise à jour des références. La régénération seule n’est pas une validation.
3. Lancez `make sync-doc-screenshots` pour copier les 11 états documentés. Cette commande copie les PNG existants ; elle ne lance pas l’application et ne vérifie pas leur fraîcheur.
4. Vérifiez les passages correspondants des deux guides utilisateur. Mettez à jour cet inventaire et toutes les références lors de tout ajout ou renommage.
5. Lancez `make lint-docs` et `git diff --check`.
