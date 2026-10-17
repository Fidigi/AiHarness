# Raccourcis du terminal

Ces réglages concernent le CLI classique et plein écran, pas les raccourcis Web ni les modes print, JSON ou RPC. Voir les [thèmes du terminal](./user-guide.md#thème-et-raccourcis-personnalisés) pour les emplacements des palettes, `system` et le rechargement.

## Choisir un fichier

Le défaut est `<répertoire-agent>/keybindings.json`, normalement `~/.ai-harness/keybindings.json`. AiHarness résout d’abord un répertoire agent indépendant approuvé ; `AI_HARNESS_AGENT_DIR` ne permet pas à un projet de s’approuver lui-même.

Une valeur non vide de `AI_HARNESS_KEYBINDINGS` sélectionne plutôt un unique fichier littéral :

```bash
export AI_HARNESS_KEYBINDINGS="$HOME/.ai-harness/keybindings.json"
ai-harness --regular
```

Un chemin relatif part du dossier de démarrage ; `~/` désigne votre répertoire personnel. Les crochets restent littéraux, sans glob. La variable est capturée au démarrage : redémarrez pour la changer. Un fichier sélectionné dans le workspace exige la confiance des ressources projet, même sélectionné explicitement. Aucun fichier projet `keybindings.json` ni raccourci de package n’est découvert automatiquement.

Le fichier doit être UTF-8, ordinaire, stable, sans lien symbolique ni lien physique supplémentaire, et limité à 64 Kio. Les ancêtres dangereux et les fichiers modifiés pendant la lecture sont refusés. Charger la configuration n’exécute aucune action.

## Format et schéma

Utilisez un tableau JSON, par exemple :

```json
[
  { "id": "mon-aide", "keys": ["ctrl", "h"], "action": "app.help" },
  { "id": "mes-raccourcis", "keys": ["f2"], "action": "app.hotkeys" },
  { "id": "precedents", "keys": ["f4"], "action": "transcript.up" }
]
```

Chaque entrée possède un `id` unique et un accord `keys`. Les champs facultatifs sont `action`, `description` et le booléen `preventDefault` ; les autres sont refusés. Sans `action`, `id` sert d’action. Un ID d’action inconnu reste inerte et apparaît indisponible ; le fichier ne définit aucun callback, n’évalue aucun code et n’accorde aucun droit d’extension.

Limites : 512 entrées ; IDs/actions de 256 octets UTF-8 ; descriptions de 512 octets ; un non-modificateur et au plus cinq parties normalisées par accord. Les noms sont ASCII, insensibles à la casse et éventuellement joints par `+` ; `control`, `option`, `return`, `esc` deviennent `ctrl`, `alt`, `enter`, `escape`. Contrôles/bidi, IDs dupliqués et accords normalisés dupliqués sont refusés. Utilisez `slash` pour `/`. L’encodage du terminal détermine les accords réellement reçus ; `cmd`/`meta` ne garantissent pas la touche Command native de macOS.

Un accord configuré remplace le même accord par défaut ; ajouter un accord ne retire pas les autres défauts de l’action. `preventDefault` vaut true par défaut. Mettez false seulement pour obtenir volontairement l’action **et** le traitement natif de l’éditeur, donc potentiellement deux effets. Ctrl+C, Ctrl+D, Escape et l’alias de décodage Node `alt+escape` ne peuvent pas viser une autre action ; le pilote de saisie conserve leur sécurité native. Les anciens IDs de défauts sauvegardés ne créent aucun callback.

Le [schéma source](../../../packages/cli/schemas/keybindings.schema.json) est livré à l’identique dans `@ai-harness/cli/dist/schemas/keybindings.schema.json`. Associez-le dans votre éditeur plutôt que d’ajouter `$schema` dans ce tableau. La validation runtime fait autorité pour les octets UTF-8, l’unicité normalisée et les touches réservées.

## Parcourir sans exécuter

Appuyez par défaut sur **F1** ou **Alt+K**. La vue présente les 22 actions, leurs accords effectifs et l’état réservé/conditionnel/indisponible/non lié. Le marqueur conditionnel est une métadonnée, pas la preuve que le prédicat est actuellement vrai. Ouvrir ou filtrer n’exécute ni handler ni prédicat.

| Saisie dans la vue | Effet |
|---|---|
| Texte puis Entrée | Filtrer par ID, description ou accord |
| Entrée vide, `:next`, Bas ou PageDown | Page suivante |
| `:prev`, Haut ou PageUp | Page précédente |
| `:all` | Effacer le filtre |
| `:close`, Escape, F1 ou Alt+K | Fermer et restaurer le brouillon et le curseur |

La vue affiche au plus huit actions par page, moins sur un écran court. Requêtes et lignes sont bornées et tronquées en cellules terminal. Les credentials enregistrés sont masqués avant troncature ; cela ne garantit pas la détection de tout texte privé. Les filtres ne deviennent ni prompts provider, ni demandes d’éditeur externe, ni historique natif. Le transcript/flux sous-jacent continue ; fermer restaure l’éditeur sans annuler l’agent. Les contrôles natifs d’interruption et de sortie restent disponibles.

## Inventaire des actions

| ID | Accords par défaut |
|---|---|
| `app.interrupt` | Ctrl+C : interruption ; sortie au repos |
| `app.exit` | Ctrl+D : sortie seulement si l’éditeur est vide |
| `app.escape` | Escape : annuler opération/saisie multiligne ou fermer la vue ; pas de sortie au repos |
| `app.help` | Alt+H, Ctrl+/ |
| `app.hotkeys` | F1, Alt+K |
| `terminal.clear` | Ctrl+L |
| `input.submit` | Entrée : envoyer, ou guider une réponse active |
| `input.followUp` | Alt+Entrée, Ctrl+Q |
| `input.dequeue` | Alt+Haut : rappeler la file, sinon remonter l’historique |
| `input.externalEditor` | Ctrl+G |
| `transcript.up` | PageUp |
| `transcript.down` | PageDown, Alt+Bas |
| `editor.left` | Gauche |
| `editor.right` | Droite |
| `editor.home` | Home, Ctrl+A |
| `editor.end` | End, Ctrl+E |
| `editor.previous` | Haut |
| `editor.next` | Bas |
| `editor.backspace` | Backspace |
| `editor.delete` | Delete |
| `editor.clear` | Ctrl+U |
| `editor.complete` | Tab |

En mode classique, les actions transcript impriment de vrais aperçus en mémoire par pages de 20 entrées anciennes/récentes, avec une ligne bornée par entrée, sans perdre brouillon/curseur ni interrompre le flux. Ce n’est ni un viewport plein écran ni une recherche du journal complet : la rétention est limitée à 500 entrées/16 Mio. Le plein écran conserve son propre viewport. Cela n’implique aucun support complet souris, sélection, images, liens ou émulateurs terminal.

## Recharger et récupérer

Enregistrez le fichier, fermez la vue, puis lancez `/reload`. Un succès remplace toute la couche personnalisée ; les accords retirés disparaissent et les défauts ordinaires restent. Un fichier invalide ou illisible à la même source conserve la dernière couche publiée, avec une raison sans valeur telle que `json` ou `read`. Une source changée/indisponible retire son ancienne couche ; supprimer le fichier par défaut du répertoire agent restaure les défauts sans avis d’échec de chargement. Aucun candidat invalide n’est publié partiellement et une lecture obsolète ne remplace pas un reload ultérieur ou un arrêt.

Si un accord gêne, retirez-le ou utilisez un tableau vide puis rechargez. Gardez un accord utilisable pour `app.hotkeys` ; les contrôles natifs Escape/Ctrl+C/Ctrl+D ne peuvent pas être détournés. Redémarrez après changement du chemin d’environnement. Les terminaux physiques peuvent réserver ou encoder les touches différemment ; les tests PTY Linux et exécutables empaquetés ne certifient pas chaque OS ou terminal.

Voir la [sécurité CLI](./cli-security.md) pour diagnostics sûrs et replis terminal ; le [guide utilisateur](./user-guide.md) couvre confiance et configuration de l’éditeur externe.
