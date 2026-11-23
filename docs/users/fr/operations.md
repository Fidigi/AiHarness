# Guide opérateur

Ce guide couvre le déploiement CLI/Web partagé et les évolutions MCP/code-mode. Il complète le [guide utilisateur](./user-guide.md), la [conteneurisation](./containerization.md) et les [décisions d’architecture](../../contributors/fr/architecture-decisions.md). Les procédures décrivent les contrats AiHarness implémentés, sans certifier votre déploiement ni une parité complète avec l’amont.

## 1. Préparer et vérifier l’hôte

1. Utilisez un compte système dédié avec le minimum de droits. Gardez données privées, credentials, confiance et code installé **hors des répertoires modifiables par les agents**.
2. Choisissez des racines autorisées et un répertoire initial existant. Une racine donne une portée de chemins, pas la confiance projet. N’exposez pas tout le répertoire personnel ou la racine système pour contourner une erreur.
3. Fournissez les secrets par le gestionnaire de secrets ou l’environnement. Conservez une clé `AI_HARNESS_MASTER_KEY` stable et protégée pour la persistance chiffrée ; en régénérer une à chaque redémarrage rend les anciens enregistrements illisibles.
4. Conservez l’écoute loopback en local. Avant une exposition distante, configurez authentification, HTTPS via un reverse proxy de confiance, origines et limites du proxy. Le contournement d’écoute distante non sécurisée n’est pas une solution de production.
5. Démarrez le service, consultez des journaux sans valeurs secrètes, puis vérifiez séparément l’interface, les autorisations API et une conversation mock explicite. HTTP200 ne certifie ni la santé globale, ni les outils, ni un fournisseur ou un déploiement.

Exemple local, après préparation de l’environnement :

```sh
ai-harness-web --hostname 127.0.0.1 --port 3080 --no-open
```

En développement, API3099 et Vite3080 sont deux processus ; le lanceur de production sert un seul port. Consultez les [modes de lancement](./user-guide.md) plutôt que d’exposer un serveur de développement comme artefact de production.

| Configuration | Frontière opérationnelle |
| --- | --- |
| `AI_HARNESS_DATA_DIR` | Données du serveur ; `~/.ai-harness` par défaut. Ce n’est pas une racine de workspace. |
| `AI_HARNESS_AGENT_DIR` | Réglages, ressources et credentials CLI/RPC. Avant confiance, un répertoire contrôlé par le projet est refusé ou remplacé par un repli indépendant. |
| `AI_HARNESS_SESSIONS_DIR`, CLI `--session-dir` | Stockage/recherche des sessions, sans autorité d’écriture de sortie ou de workspace. |
| `AI_HARNESS_DEFAULT_CWD`, `AI_HARNESS_ALLOWED_ROOTS` | Cwd canonique initial et racines autorisées. Redémarrez après une modification de l’environnement serveur. |
| `AI_HARNESS_AUTH_TOKEN`, `AI_HARNESS_ADMIN_TOKEN` | Rôles utilisateur/admin séparés ; un token d’authentification seul possède aussi les capacités admin. |
| `AI_HARNESS_MASTER_KEY` | Credentials fournisseur/MCP chiffrés durables. Séparez-la des sauvegardes et fichiers projet. |
| `AI_HARNESS_ALLOWED_ORIGINS` | Origines supplémentaires acceptées, sans remplacer l’authentification ou HTTPS. |
| `AI_HARNESS_DEFAULT_PROVIDER`, `AI_HARNESS_DEFAULT_MODEL`, `AI_HARNESS_DEFAULT_THINKING`, `AI_HARNESS_DEFAULT_TOOL_PRESET`, `AI_HARNESS_AUTO_COMPACTION` | Overrides d’environnement serveur, visibles comme valeurs effectives verrouillées plutôt que préférences navigateur modifiables. |
| `AI_HARNESS_OFFLINE` / CLI `--offline` | Supprime découverte et travail automatique sur les credentials du CLI. **Ni pare-feu réseau, ni mode hors ligne du Web**. |

La grammaire exacte, les valeurs par défaut et les contrôles supplémentaires restent dans le [guide utilisateur](./user-guide.md). Les clés propres aux fournisseurs ne doivent apparaître ni dans les captures ni dans les rapports d’incident.

## 2. MCP : configurer, tester, autoriser, puis utiliser

| Opération | N’implique pas |
| --- | --- |
| Inventaire ou aperçu d’un collage | Connexion, évaluation de commande, OAuth, confiance ou initialisation des credentials |
| Enregistrer/importer/éditer/activer/exposer | Runtime actif et sain ; une réponse expirée peut suivre une écriture engagée |
| Test explicite | Appel d’outil, connexion persistante de session, connexion OAuth ou publication de credentials |
| Connexion explicite / CLI `mcp login` | Autorisation d’outil, révocation auprès de l’émetteur ou innocuité du code tiers |
| Hôte de session connecté | Sandbox ou confirmation utilisateur à chaque appel |

1. Dans **Settings → MCP servers**, choisissez la ligne globale/projet exacte et vérifiez la cible masquée. Le corps projet exige un accord sauvegardé ; choisir le dossier ou observer son état implicitement sûr ne suffit pas.
2. Prévisualisez le collage original avec la syntaxe étrangère/AiHarness voulue. Vérifiez cible, noms de variables et chaque confirmation secret/confiance. Préférez des références d’environnement protégées. Un secret littéral restant est refusé en projet ; les variables réservées d’authentification/clé maître ne sont pas éligibles.
3. Enregistrez une entrée. **Éditer remplace toute l’entrée** : incluez chaque champ à conserver. Après erreur, expiration ou révision périmée, rechargez l’inventaire canonique avant de réessayer. Ne supposez ni rollback ni absence d’écriture.
4. Ne lancez Test que pour exécuter volontairement le processus stdio ou contacter le serveur HTTP configuré. Vérifiez compteurs, répertoire, diagnostics bornés et exposition. Un changement de configuration invalide les anciens statuts Test/runtime.
5. Pour `needs-auth`, lancez explicitement la connexion. Le callback loopback écoute sur l’hôte AiHarness, pas sur la machine du navigateur. Si nécessaire, collez l’URL complète de redirection sans la modifier ; jamais un access token. Un stockage chiffré stable est requis.
6. N’envoyez un prompt qu’après avoir choisi exposition et preset minimaux. Les outils directs peuvent être déclarés immédiatement ; les différés nécessitent une recherche avant une déclaration ultérieure ; ceux de code mode restent réservés aux scripts. Les outils cachés sont exclus des déclarations, recherches et appels imbriqués. Une annotation read-only ne rend pas sûr un outil mensonger.
7. Désactivez/supprimez les entrées inutiles. L’annulation de suppression est temporaire et bornée. La déconnexion retire les credentials et connexions locaux ; utilisez l’émetteur pour une révocation distante.

Administration CLI et rafraîchissement passif partagent les contrats Core :

```sh
ai-harness mcp login documentation --no-open --timeout 120
ai-harness mcp logout documentation
```

Les prompts CLI/RPC/Web ordinaires peuvent réutiliser ou rafraîchir un état OAuth existant, jamais démarrer une connexion interactive. Renommer un serveur MCP ou changer son URL change l’identité des credentials. Consultez les procédures MCP/OAuth du [guide utilisateur](./user-guide.md).

## 3. Outils et code mode

- Vérifiez **Tools and presets** pour le projet choisi. La liste effective croise enregistrement courant, preset, réglages et allowlists ; trouver un outil n’autorise pas son appel.
- Vérifiez le résultat de santé QuickJS en cache, choisissez la politique globale/projet et autorisez le helper ainsi que les outils imbriqués voulus. Chat-only le désactive ; read-only reste applicable. Élargir les racines ne répare pas un helper indisponible.
- Le guest QuickJS est borné en mémoire, durée, appels et résultats, sans Node/fichiers/réseau ambiants. **Outils hôtes, processus MCP et extensions approuvées gardent leurs droits système/réseau réels**. Isolez ces droits au niveau processus/conteneur.
- Les valeurs du store suivent la branche et ne publient qu’au succès. Les appels hôtes déjà exécutés et helpers de modèles déjà facturés ne sont ni annulés ni remboursés par un échec ultérieur. Le store n’est pas un coffre à secrets.
- Consultez les cartes Process/code-mode pour le statut imbriqué, la troncature et les coûts incomplets. Un sous-total connu n’est pas un total complet. La restauration d’affichage n’assure pas la durabilité de la progression après crash.

Voir le [guide utilisateur](./user-guide.md) et les [limites des réponses/progressions Web](./web-replies.md).

## 4. Workspaces, fichiers et accès

1. Vérifiez le cwd canonique avant d’accorder la confiance. L’accord/refus sauvegardé le plus proche s’applique ; un refus enfant peut primer sur un accord parent. Capacités HTTP et confinement des chemins restent indépendants.
2. Si le défaut est indisponible, choisissez un dossier autorisé existant. Aucune racine arbitraire n’est choisie. Le navigateur ne peut élargir `AI_HARNESS_ALLOWED_ROOTS` : corrigez l’hôte et redémarrez.
3. **Nouveau dossier** crée un seul enfant direct. Vérifiez la politique explicite de collision d’upload ; ne supposez jamais un écrasement. Afficher un fichier ou un chemin produit par un outil ne donne pas accès à tous les fichiers serveur.
4. Pour les répertoires liés, accordez le consentement exact et vérifiez séparément la confiance source. Ce sont des lectures bornées, sans écriture/exécution ni nouvelle racine globale. Révoquez-les lorsqu’ils sont inutiles.
5. Distinguez les commandes de session `!`/`!!` des terminaux PTY : les premières persistent des résultats bornés avec inclusion différente dans le contexte ; les seconds sont des processus interactifs hôtes. Arrêtez le processus possédé, pas seulement sa connexion réseau.
6. Traitez téléchargements, fichiers complets de sortie et exports comme sensibles. Le masquage couvre les credentials enregistrés, pas tous les secrets possibles d’un texte arbitraire.

Voir [répertoires liés](./linked-directories.md), [récupération du panneau de fichiers](./workspace-loading.md) et [guide utilisateur](./user-guide.md).

## 5. Sessions, interruption et restauration

- Un brouillon Web devient persistant au premier envoi. Les runs sont détachés : navigation ou coupure SSE ne les arrêtent pas. La reconnexion récupère état canonique et rejeu séquencé borné ; un curseur évincé exige un snapshot, pas des événements inventés.
- Utilisez **Stop** puis vérifiez la phase obtenue. Demande d’annulation, retrait logique, publication durable et règlement physique d’un travail non coopératif sont distincts. Une sauvegarde déjà admise peut finir ; perdre la réponse HTTP ne prouve pas l’absence de commit.
- L’ascendance suit les liens parents. Clone/fork/édition historique ont des sémantiques différentes ; vérifiez la destination avant d’envoyer. La compaction conserve l’historique journalisé et réduit le contexte effectif ; une estimation de contexte n’est ni usage facturé ni taille exacte système/outils/médias.
- Ne répétez pas indéfiniment une requête impossible. Vérifiez modèle/limites connus, réduisez la requête ou compactez explicitement un préfixe utile. Les limites inconnues restent inconnues ; admission complète modèle/média et récupération automatique d’overflow ne sont pas certifiées.
- Avant migration/restauration/nettoyage, arrêtez **tous** les écrivains CLI/serveur puis sauvegardez ensemble les répertoires effectifs de données, d’agent et de sessions : configuration, confiance, journaux et credentials chiffrés, avec leurs permissions restrictives. Gardez la clé maître séparément. Restaurez dans un dossier protégé distinct et vérifiez les sessions avant de rouvrir les écrivains.
- L’export JSONL est une projection des messages, **pas une sauvegarde complète du journal**. Gardez les `.jsonl` originaux pour l’historique persistant. Runs, dialogues, rejeu et Undo volatils ne reprennent pas comme travaux actifs après redémarrage.

Voir [guide utilisateur](./user-guide.md), [export autonome](./standalone-operations.md) et [durées de vie du SDK](../../contributors/fr/session-sdk.md).

## 6. Modèles, réglages et portée du rechargement

| Changement | Application/récupération |
| --- | --- |
| Environnement serveur, écoute/authentification/racines/clé maître | Redémarrez l’hôte responsable ; rafraîchir le navigateur ne change pas le processus. |
| Réglages Web globaux/projet/session | Vérifiez portée/provenance. Auto/héritage retire un override ; l’environnement prime. Rechargez l’état canonique après incertitude. |
| Réglages/ressources CLI interactifs | Consultez `/settings` puis `/reload` pour les champs pris en charge. Stockage des sessions et type de renderer exigent un redémarrage. |
| Réglages RPC | Redémarrage pour défauts/ressources de démarrage ; `reload_context_settings` à l’arrêt recharge seulement `compaction` et `branchSummary`, pas du code arbitraire. |
| Packages/ressources exécutables Web | Installation/activation ne vaut pas exécution. Rechargez explicitement la bonne génération session/workspace. Lire le catalogue n’installe ni n’importe du code. |
| Échec d’import optionnel Settings/explorer/dialogue | Fermez localement ; copiez le texte non envoyé avant rechargement/réessai explicite. Ne modifiez pas la confiance pour réparer un asset client. |

Choisissez un modèle disponible et activé pour son fournisseur. Rafraîchissez explicitement la découverte si nécessaire ; un repli publié/configuré ne garantit ni l’existence distante du modèle ni un coût/une limite inconnus nuls. Gardez les credentials serveur. Le renommage général d’un fournisseur n’est pas une opération ordinaire prise en charge : le mode hôte exclusif est désactivé par défaut et possède un [contrat de récupération distinct](../../contributors/fr/server-architecture.md). Ne supprimez jamais son intent de force en ligne.

Voir [résultats des lots](./resource-batches.md), [chargement des réglages](./settings-loading.md) et [guide utilisateur](./user-guide.md). Le code exécutable des fournisseurs/extensions est du code hôte de confiance, pas une seconde sandbox.

## 7. Diagnostic d’incident

| Symptôme | Première réponse sûre |
| --- | --- |
|401/403 ou refus Origin|Vérifiez identité utilisateur/admin, origine du proxy et capacité demandée ; ne désactivez pas l’authentification.|
|Projet verrouillé ou chemin refusé|Vérifiez cwd, racines et confiance sauvegardée la plus proche ; examinez les métadonnées avant l’accord.|
|MCP configuré mais indisponible|Choisissez la ligne courante, vérifiez Test explicite/needs-auth/exposition puis un prompt ; GET inventaire ne connecte pas.|
|Stockage des secrets indisponible|Vérifiez clé stable, dossier indépendant privé accessible et permissions ; jamais de repli plaintext en projet.|
|Mutation expirée ou client déconnecté|Rechargez d’abord l’état canonique ; absence de réponse n’est pas absence de publication.|
|Run/progression absent après redémarrage|Consultez le journal persistant sans inventer un run actif ; rejeu et interactions sont volatils et bornés.|
|Coût inconnu ou contexte trop grand|Conservez les mentions inconnu/incomplet ; ne remplacez pas par zéro ou une certitude de tokenisation fournisseur.|
|HTTP200 mais watchdog ou fournisseur en échec|Analysez chaque observation séparément ; HTTP200 n’est pas une santé globale.|

Collectez version, opération, portée/cwd canonique, code d’erreur stable, heure et journaux masqués. Ne joignez ni tokens, clé maître, configuration/arguments MCP bruts, URL callback d’autorisation ni transcript non vérifié. Conservez les échecs avant de réessayer ; un succès ultérieur ne diagnostique pas un crash antérieur.

Pour une mise à jour, consultez les métadonnées de release et sauvegardez avant une installation explicite ; la recherche de version n’installe rien. La [démo statique](./static-demo.md) est synthétique et distincte d’un backend authentifié. Workflow Pages, build local, émulation desktop ou matrice navigateur ne prouvent ni publication distante, ni appareils physiques, ni fournisseur réel.

## Documentation associée

- [Index utilisateur français](./README.md) / [guide anglais](../en/operations.md)
- [Décisions d’architecture développeur](../../contributors/fr/architecture-decisions.md)
- [Architecture serveur détaillée](../../contributors/fr/server-architecture.md)
