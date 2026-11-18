# Sécurité CLI, avertissements de confidentialité et terminaux

Utilisez un compte système peu privilégié et des répertoires agent/sessions protégés. La confiance projet autorise ressources exécutables et outils ; elle ne crée **pas** de sandbox système. Le [guide opérateur](./operations.md) détaille préparation de l’hôte, MCP et restauration.

## Avertissements et canaux de sortie

| Surface | Avertissement et action |
|---|---|
| `/share [heures]` interactif | Un avertissement fixe apparaît **avant la requête**. Relisez la session avant la commande : elle crée un lien public, pas une sauvegarde à accès contrôlé. |
| `/export <format> [path]` interactif | Un avertissement fixe précède résolution/publication de la destination d’un export pris en charge. Relisez le fichier avant de l’envoyer. |
| `ai-harness export ...` | Avertissement sur **stderr**, accusé fixe de succès sur stdout ; aucun transcript sur ces canaux. L’aide décrit aussi le risque. Une erreur de syntaxe/sélection/confiance ne signifie pas publication. |
| RPC `export_html` | La réponse corrélée réussie conserve `data.path` et ajoute `warnings: string[]`. Le texte accompagne le résultat, **sans confirmation avant écriture ni nouvel événement**. La requête explicite autorise l’export local ; le client doit présenter le texte avant de proposer son partage. |
| `/bug [description]` | Un avertissement fixe précède l’URL du rapport. La commande prépare cette URL avec votre description et des métadonnées Node/plateforme, sans soumettre le rapport. Vérifiez l’URL complète avant ouverture/envoi. |

Ces avertissements CLI, actuellement en anglais, ne contiennent ni transcript, credentials, chemins ni configuration de cible. Un hôte interactif peut fournir un canal d’avertissement distinct ; son échec synchrone interrompt la commande slash avant requête de partage/écriture d’export. Aucun dialogue de confirmation, accord de confiance implicite ou garantie d’élimination des secrets inconnus n’en découle. Le démarrage silencieux ne les désactive pas. Les préférences générales d’avertissement de facturation ne sont pas implémentées par cette politique de confidentialité.

Le masquage des credentials enregistrés et encodages connus laisse potentiellement texte privé, code source, données personnelles/client ou credentials inconnus. Échapper le HTML évite l’exécution de balises dans le renderer partagé, sans rendre publique une conversation en toute sécurité. Le mode privé d’un fichier n’est ni chiffrement ni politique complète de sauvegarde.

## Offline, proxy et réseau

| Contrôle | Portée réelle |
|---|---|
| `--offline`, `AI_HARNESS_OFFLINE=1\|true\|yes` | Suppression immuable propre au processus de la découverte fournisseur automatique, commandes/cache de credentials et refresh OAuth. Prompts/authentification/partage/packages/MCP/outils/extensions explicites gardent leur autorité habituelle. |
| `transport` | Transport fournisseur (`auto`, `sse`, `websocket`, `websocket-cached`), pas routage global de tous les processus. |
| `httpProxy`, répertoire agent uniquement | Politique partagée du réseau fournisseur HTTP(S)/WebSocket. Ne supposez pas qu’elle proxifie npm, outils arbitraires, sous-processus MCP ou cible de partage CLI. |
| Délais requête/idle/handshake et retries fournisseur | Travail fournisseur borné et erreurs réseau sans valeurs sensibles ; pas règlement physique d’une extension non coopérative. |
| URL serveur de `/share` | HTTPS, ou HTTP loopback seulement ; sans userinfo/query/fragment, redirections refusées, durée/réponse bornées. Une entrée invalide ne provoque aucun repli HTTP distant non sécurisé. |
| Interdiction réseau réelle | Utilisez politique système/conteneur/pare-feu et protégez le proxy hors des projets modifiables. Offline **n’est pas un pare-feu**. |

Le [guide utilisateur](./user-guide.md) donne réglages, défauts et provenance exacts. `/settings` expose les sources prises en charge sans afficher le proxy. Ne collez jamais une URL de proxy contenant des credentials dans un rapport ; les erreurs réseau fixes omettent volontairement corps distants, en-têtes et adresses. Redémarrez pour changer le choix offline du processus ; `/reload` interactif rafraîchit les réglages fournisseur pris en charge, pas l’isolation réseau système.

## Alias, profils et choix des exécutables

- `!`/`!!` et les outils shell du modèle exécutent de vrais processus hôtes non supervisés après leurs contrôles de confiance. `!!` exclut la sortie du contexte modèle, **pas** de la persistance, du terminal ou des fichiers complets de sortie.
- Ne supposez pas qu’un alias interactif existe dans un sous-processus. Le chemin POSIX/override emploie `-lc` : les profils de connexion peuvent exécuter du code et modifier PATH/fonctions. Vérifiez-les et protégez-les hors du projet. Ne sourcez pas le script d’un projet non fiable pour réparer un alias manquant.
- Pour une opération sensible, préférez un chemin explicite vers un exécutable protégé ; vérifiez la résolution d’un nom court. `shellPath` choisit le programme ; le `shellCommandPrefix` approuvé est évalué par le shell avant les commandes. Ce préfixe est du code, pas un tableau argv littéral ni une politique de sécurité. N’y placez aucun secret.
- `npmCommand` diffère : tableau exécutable + arguments littéraux, sans syntaxe shell. Alias ou pipeline ne sont pas équivalents ; consultez la [procédure npm](./npm-command.md).
- Quotez pour le shell réellement utilisé : Unix, CMD et PowerShell ont des expansions/échappements distincts. Filtrer les variables enfant ressemblant à des credentials ne retire ni fichiers, ni droits réseau, ni tous les secrets présents dans les profils/configurations.

Dans un workspace POSIX approuvé, `!!command -V git` aide à vérifier la résolution sans transmettre sa sortie au modèle. Cela exécute toujours le shell sélectionné et persiste un résultat ; vérifiez-le localement plutôt que de le joindre brut.

## Matrice Windows et terminal

Cette matrice décrit implémentation et exploitation, **pas une certification physique Windows/macOS/terminal**.

| Environnement | Frontière et repli sûr |
|---|---|
| Hôte POSIX | Shell par défaut `$SHELL` ou `/bin/bash` ; override avec `-lc`. Arrêt/escalade des groupes de processus au mieux, pas confinement des descendants hostiles. |
| Shell direct Windows natif | Sans `shellPath`, `COMSPEC`/`cmd.exe` avec `/d /s /c`. L’annulation tente `taskkill.exe /T` puis escalade/repli ; aucun règlement garanti de chaque descendant détaché. |
| PowerShell Windows natif | L’outil de code `powershell` est propre à Windows. `!` n’emploie pas forcément PowerShell ; l’override `shellPath` utilise la convention `-lc`, donc ne substituez pas un programme incompatible à l’aveugle. |
| WSL/hôte distant | Chemins, shell, credentials, écoute callback et permissions appartiennent à l’hôte Node/AiHarness, pas à l’OS navigateur/client. Un label affiché ne permet pas de réutiliser chemin ou confiance. |
| Terminal fullscreen | Exige TTY entrée/sortie et raw mode. Sinon repli regular ; choisissez `--tui-mode regular` si intégration ou touches modifiées ne conviennent pas. |
| Print/JSON/RPC redirigé | Aucun terminal interactif ni bannière. Lisez stdout continuellement ; JSON/RPC est délimité par LF. Ne parsez pas diagnostics/avertissements comme réponse modèle ni comme texte protocole brut. |
| Sortie terminal | Les séquences de contrôle non fiables sont filtrées, sans garantie universelle pour émulateurs, hyperliens, images, presse-papiers/sélection ou clavier physique. Ne collez pas une sortie non vérifiée comme commande shell. |
| Permissions d’export | Le CLI demande le mode privé `0600` ; RPC HTML le définit aussi. Sous Windows vérifiez séparément ACL réelles et politique de stockage/partage ; les bits POSIX ne certifient pas la confidentialité Windows. |

Escape/Ctrl+C demande l’interruption ; vérifiez l’état obtenu. Fermeture réseau, annulation logique et règlement physique processus/fournisseur diffèrent. Un accusé de réception ne signifie ni remboursement, ni rollback, ni absence de processus enfant.

## Diagnostics sûrs et reprise d’incident

1. Conservez les échecs originaux, code stable, version, opération et heure. Ne divulguez cwd/portée canonique qu’après vérification du caractère publiable du chemin.
2. Relisez diagnostics de réglages/instructions/ressources et descriptions `/bug` localement. Même sans valeurs, un diagnostic peut divulguer noms de champs ou chemins privés ; le masquage n’est pas un classificateur universel.
3. Retirez tokens, clé maître, credentials de proxy, configuration/arguments MCP bruts, URL callback d’autorisation et transcripts non vérifiés. Vérifiez aussi scrollback, historique shell et liste de processus ; évitez les clés API directement dans argv.
4. Préférez reproduction mock minimale et extrait explicitement relu. Ne joignez pas environnement complet, store de credentials, journal ou sortie complète sous prétexte que le CLI masque les secrets connus.
5. Après erreur d’export/partage ou réponse perdue, inspectez l’état serveur canonique/le fichier local avant réessai. La publication peut avoir eu lieu ; RPC HTML peut réécrire sa cible, sans transaction interprocessus ni rollback promis. L’expiration du partage n’est pas une révocation de credentials distante.

Voir [export/authentification autonomes](./standalone-operations.md), [sauvegarde et restauration](./operations.md), [index utilisateur](./README.md) et [guide de sécurité anglais](../en/cli-security.md).
