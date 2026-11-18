# Décisions d’architecture : runtime partagé et évolutions Web

Date : **2026-10-17**. Portée : contrats AiHarness implémentés à `6903145` et documentation opérateur/développeur associée. Ce registre décrit décisions et limites, sans certifier compatibilité tierce complète, santé de production, publication distante ou appareils physiques.

Lire ensemble la [vue d’ensemble](./architecture-overview.md), l’[architecture serveur](./server-architecture.md) et le [guide opérateur](../../users/fr/operations.md). La navigation d’implémentation reste dans la [carte du projet](../../ai/project-map.md).

## ADR-01 — Un propriétaire Core, des adaptateurs propres aux hôtes

**Contexte.** CLI, RPC JSONL et agents Web détachés ne doivent pas réinterpréter séparément confiance, exécution des outils ou historique. Le navigateur ne doit pas charger du Node privilégié.

**Décision.** Core possède contrats, fournisseurs, boucle d’outils, projection/persistance des sessions, confiance, MCP et ponts sandbox. CLI possède terminal/protocole ; Server possède autorisation HTTP, services détachés et transports ; Web possède réconciliation et présentation, et n’importe que les types Core. API Core2 et schéma JSONL2 sont des surfaces versionnées distinctes ; un helper interne additif n’est pas une nouvelle méthode obligatoire d’extension/store.

**Conséquences.** Réutiliser les opérations partagées plutôt que copier les politiques dans routes/composants. Préserver stores structurels et durées de vie des ressources empruntées. Une capacité d’un hôte n’est pas automatiquement disponible sur un autre ; un nom ne donne pas d’autorité d’exécution.

Sources : `packages/core/src/agent/tool-loop.ts`, `packages/core/src/sdk/agent-session.ts`, `packages/server/src/runtime/services.ts`, `packages/cli/src/index.ts`. Tests : `tests/functional-parity/installed-executable.test.ts`, `packages/core/src/sdk/public-consumer.test.ts`. Voir [contrats publics](./public-contract-policy.md).

## ADR-02 — Séparer métadonnées MCP, Test, hôte de session et OAuth

**Contexte.** Ouvrir Settings ou prévisualiser un collage ne doit pas exécuter de commande, contacter une cible ou acquérir des credentials. Configuré/Test/Connecté sont des observations différentes.

**Décision.** Inventaire, aperçu et mutations restent des opérations de politique fichier. Test explicite relit une portée/un nom/configuration sous confiance fraîche puis ferme son transport borné sans appeler d’outil ni publier de credential. L’hôte par session prépare les connexions éligibles aux frontières de prompt, utilise les clés de configuration courantes et retire les cibles remplacées. OAuth explicite est un flux actif chiffré distinct ; les hôtes ordinaires emploient des credentials passifs sans déclencher de connexion interactive.

**Conséquences.** Ne jamais accepter un objet normalisé navigateur comme autorité. Reparser le texte original ; lier la mutation à la révision opaque et à la portée. Un client expiré ne prouve pas l’absence d’écriture. Le corps projet exige une confiance sauvegardée, même après un inventaire de dossier vide. L’identité OAuth inclut nom/URL normalisée ; logout retire les écrivains périmés sans révoquer les tokens auprès de l’émetteur. Annulation locale et règlement réel d’un transport/processus diffèrent.

Sources : `packages/core/src/mcp/config-inventory.ts`, `packages/core/src/mcp/config-import.ts`, `packages/core/src/mcp/server-test.ts`, `packages/core/src/mcp/session-host.ts`, `packages/core/src/mcp/oauth-flow.ts`. Tests : `packages/core/src/mcp/config-import-mutation.test.ts`, `packages/core/src/mcp/server-test.test.ts`, `packages/core/src/mcp/session-host.test.ts`, `packages/core/src/mcp/oauth-flow.test.ts`, `packages/server/src/api/mcp-oauth-routes.test.ts`. Voir [procédure MCP](../../users/fr/operations.md).

## ADR-03 — Découvrir n’autorise pas ; isoler le guest, pas l’hôte

**Contexte.** Les grands catalogues exigent des schémas différés et une composition code-mode sans autoriser chaque résultat de recherche ni donner Node ambiant au JavaScript généré.

**Décision.** Les outils effectifs croisent enregistrement, preset, portée, allowlist/exclusions et politique MCP read-only courante. `direct`, `deferred`, `codemode` et `hidden` contrôlent déclaration/découverte, pas une isolation système. La recherche active une déclaration ultérieure, pas la réponse déjà fixée. Le guest QuickJS jetable est borné en mémoire/durée/appels/résultats, sans Node/fichiers/réseau ambiants ; chaque appel hôte imbriqué revalide son éligibilité, même en file.

**Conséquences.** Aucun helper ne doit contourner les contrôles cachés, réservés au modèle ou récursifs. Les annotations MCP sont des indications non fiables. Extensions approuvées et processus MCP gardent leurs vrais droits. Le store du sandbox suit la branche et ne publie qu’au succès ; effets hôtes et helpers facturés déjà exécutés ne sont pas annulés. L’usage imbriqué normalisé est compté une fois sur le résultat externe ; un coût inconnu reste incomplet. Aucune progression active durable après crash n’est promise.

Sources : `packages/core/src/tools/tool-search.ts`, `packages/core/src/tools/codemode.ts`, `packages/core/src/tools/codemode-worker.ts`. Tests : `packages/core/src/tools/codemode.test.ts`, `packages/core/src/tools/tool-search.test.ts`, `e2e/codemode.spec.ts`. Voir [frontière code-mode](../../ai/topics/codemode.md) et [guide opérateur](../../users/fr/operations.md).

## ADR-04 — Séparer chemins accessibles, confiance et capacités

**Contexte.** Cwd sélectionné, racine autorisée, consentement de répertoire lié ou utilisateur authentifié ne doivent pas devenir une autorité illimitée de lecture/écriture/exécution.

**Décision.** Canonicaliser et confiner via Core ; appliquer indépendamment accord/refus sauvegardé le plus proche et capacités propres à l’opération. Avant confiance, inspecter les métadonnées des ressources projet, pas leurs corps. Garder agent/données/confiance/credentials indépendants des projets modifiables. Un répertoire lié donne un consentement de lecture borné, sans nouvelle racine globale ni écriture/exécution. Collisions d’upload, création d’enfant, Git dangereux et terminal relèvent d’opérations explicites.

**Conséquences.** Revérifier l’identité canonique aux frontières privilégiées. Un défaut indisponible ne choisit aucune racine arbitraire. Labels et état navigateur ne donnent pas confiance. Les reçus de publication stable protègent leurs remplacements possédés sans exclure les écrivains hostiles, ni offrir CAS atomique système ou atomicité crash multi-fichier. Code approuvé et PTY restent exécutés par l’utilisateur système hôte.

Sources : `packages/core/src/security/workspace-manager.ts`, `packages/core/src/security/project-trust.ts`, `packages/core/src/security/stable-file.ts`, `packages/server/src/security/request-security.ts`. Tests : `packages/core/src/security/workspace-manager.test.ts`, `packages/core/src/security/project-trust.test.ts`, `packages/core/src/security/stable-file-receipt.test.ts`, `e2e/linked-directories.spec.ts`. Voir [publication stable](./stable-file-publication.md), [répertoires liés](../../users/fr/linked-directories.md) et [procédures fichiers](../../users/fr/operations.md).

## ADR-05 — Historique parenté durable, durées de vie détachées volatiles

**Contexte.** Réduction de contexte, branches, reconnexion et interruption ne doivent inventer ni ascendance, ni réponse dupliquée, ni reprise après crash d’un travail seulement en mémoire.

**Décision.** Le schéma JSONL2 journalise messages/commandes/résumés/état custom avec leurs parents ; les liens parents, pas les dates, déterminent l’ascendance active. Projection modèle et comptabilité diffèrent de l’historique brut. Le run détaché continue après fermeture du flux navigateur. Rejeu séquencé borné et snapshots canoniques réconcilient les clients ; registres volatils de runs/dialogues/rejeu ne constituent pas un ordonnanceur de reprise après crash.

**Conséquences.** Conserver l’état custom privé sans le transmettre au modèle/RPC ordinaire. Capturer source/durée de vie/store avant les attentes et revalider avant publication non admise. Terminer la sauvegarde capturée déjà admise plutôt que promettre un rollback d’annulation. Retrait logique n’est ni règlement physique ni preuve de non-facturation d’une tentative invalide/retirée. Les exports API ne sauvegardent pas tout le journal. Réécritures de métadonnées/sauvegardes atomiques ne constituent pas un protocole universel append-only transactionnel.

Sources : `packages/core/src/sessions/session-manager.ts`, `packages/core/src/sessions/compaction-model-messages.ts`, `packages/core/src/agent/runtime.ts`, `packages/core/src/agent/events.ts`. Tests : `packages/core/src/sessions/session-compaction-store-admission.test.ts`, `packages/core/src/sdk/session-compaction-lifecycle.test.ts`, `packages/core/src/agent/events.test.ts`. Voir [SDK de session](./session-sdk.md) et [interruption/sauvegarde](../../users/fr/operations.md).

## ADR-06 — Métadonnées, estimation courante et comptabilité honnêtes

**Contexte.** Les dialectes diffèrent ; usage passé, contexte courant, réserve de sortie et limite publiée ne mesurent pas la même chose.

**Décision.** Garder des catalogues bornés sans secrets et normaliser les champs connus d’usage/cache sans inventer prix ni capacité. L’exécution partagée possède les payloads avant/après masquage extensible et conserve les mutations légitimes des observateurs attendus. Le contrôle canonique connu emploie `canonical-json-utf8/4-v1`, pas un tokenizer fournisseur. Conserver la preuve du maximum de sortie avant masquage ; la préparation Anthropic première partie exacte partage les défauts/thinking natifs sans capacité fournisseur obligatoire.

**Conséquences.** Limites/médias/coûts inconnus ne valent pas zéro. Composition des budgets CLI/RPC ordinaires, autorité initialement inconnue puis connue, admission modèle effectif/média après hook et reconstruction utile d’overflow restent incomplets. Un refus avant dispatch d’une requête connue impossible ne certifie ni tous les transports ni une comptabilité par tentative réellement réglée. Sous-classes/extensions/dialectes natifs gardent leurs frontières ; le nom du modèle ne prouve pas son support.

Sources : `packages/core/src/providers/model-catalog.ts`, `packages/core/src/providers/model-metadata.ts`, `packages/core/src/agent/provider-request-estimate.ts`, `packages/core/src/providers/anthropic-thinking.ts`, `packages/core/src/sessions/session-accounting.ts`. Tests : `packages/core/src/agent/provider-request-budget.test.ts`, `packages/core/src/providers/provider-output-budget.test.ts`, `packages/core/src/sessions/session-accounting.test.ts`. Voir [fournisseurs](../../ai/topics/providers.md) et [opérations modèles/réglages](../../users/fr/operations.md).

## ADR-07 — Réglages par portée, catalogues passifs et reload explicite

**Contexte.** Lire des métadonnées, installer un package, choisir un workspace ou changer un défaut ne doit ni exécuter silencieusement du code ni remplacer une autre portée.

**Décision.** Préserver provenance et séparation global/projet/conversation/environnement. Absence signifie héritage ; Auto/suppression Web retire l’override plutôt que sauvegarder sa valeur résolue. L’environnement prime sur Server. Les réglages CLI sont des entrées bornées en lecture seule ; leurs corps projet exigent confiance et les diagnostics omettent les valeurs. Lire/installer/activer un catalogue diffère de l’engagement explicite d’une génération exécutable. Une candidate échouée dans le même workspace conserve la précédente ; retirer le workspace retire l’ancienne autorité.

**Conséquences.** Reload est propre à l’hôte : CLI interactif recharge ses réglages/ressources pris en charge ; RPC `reload_context_settings` se limite à compaction/branchSummary ; Web cible la bonne session/le bon workspace. Aucun broadcast inter-hôte ni parité complète des réglages n’en découle. Un lot concerne seulement ses lignes qualifiées, recharge le canonique après incertitude et ne prétend pas annuler un écrivain intervenu. Le renommage fournisseur restreint reste désactivé par défaut, sans renommage général multi-hôte.

Sources : `packages/core/src/config/agent-settings.ts`, `packages/core/src/extensions/module-loader.ts`, `packages/core/src/plugins/plugin-service.ts`, `packages/server/src/config/config-store.ts`. Tests : `packages/core/src/config/agent-settings.test.ts`, `packages/core/src/plugins/plugin-service.test.ts`, `packages/cli/src/rpc/context-settings-reload.test.ts`. Voir [extensions](./extensions-cli.md), [lots de ressources](./resource-batches.md) et [renommage restreint](./server-architecture.md).

## ADR-08 — Garder secrets et autorité réseau sur l’hôte

**Contexte.** Le confort du navigateur et les défauts locaux ne justifient ni secrets exposés, ni administration distante non authentifiée, ni confiance contrôlée par le projet.

**Décision.** Loopback par défaut, capacités utilisateur/admin séparées, contrôle Origin et entrées HTTP/WebSocket bornées. Persister les secrets seulement dans des stores protégés avec clé maître ; les API de métadonnées omettent leurs valeurs. Filtrer les environnements enfants et masquer les secrets enregistrés sur chaque flux indépendant avant persistance/affichage. Offline CLI supprime seulement le travail fournisseur automatique ; ce n’est pas une frontière réseau système/conteneur.

**Conséquences.** Séparer protection des données/clé maître et sauvegarder après arrêt des écrivains. Un token d’authentification seul est admin. Le distant exige HTTPS/proxy/origines/limites indépendants. OAuth/logout ne remplace ni autorisation d’outil ni révocation émetteur. Une erreur HTTP ou de publication stable peut suivre le commit : conserver l’incertitude, pas inventer un rollback. HTTP200, sortie0, preview locale et workflow Pages disponible ne prouvent ni santé ni publication distante.

Sources : `packages/server/src/security/request-security.ts`, `packages/core/src/providers/credentials.ts`, `packages/cli/src/cli/offline-mode.ts`, `packages/server/src/web-cli.ts`. Tests : `packages/server/src/security/request-security.test.ts`, `packages/core/src/providers/offline-policy.test.ts`, `packages/server/src/web-cli.test.ts`. Voir [sécurité](../../ai/topics/security.md) et [préparation de l’hôte](../../users/fr/operations.md).

## ADR-09 — Frontière Web optionnelle petite et autoritaire

**Contexte.** Settings, explorer, terminal et formulaires différés ne doivent bloquer Stop, perdre le texte non envoyé ou appliquer une réponse tardive à une autre session. Traduction et clavier appartiennent à l’opération complète, pas seulement à son premier label.

**Décision.** Garder des frontières eager de durée de vie/chargement/erreur et importer implémentation/assets seulement sur demande. Lier réponse et focus à l’identité courante de vue ; réconcilier depuis le canonique après mutation/reconnexion. Utiliser texte inerte traduit et schémas de formulaires, jamais HTML d’extension arbitraire. Fermer/annuler restent locaux ; le rechargement/réessai explicite avertit pour le texte non envoyé.

**Conséquences.** Un échec d’asset n’accorde aucune autorité hôte et n’annule pas automatiquement une réponse Server acceptée. Préserver l’édition IME, éviter le focus éditable coarse non sollicité et refuser une publication périmée. Tests navigateur/axe émulés ne certifient ni claviers/zoom physiques ni toutes les langues. Distinguer les échecs historiques des configurations entières passées ultérieures.

Sources : `packages/web/src/components/SettingsView.tsx`, `packages/web/src/components/ProcessBlockBoundary.tsx`, `packages/web/src/store/mcp-selection.ts`. Tests : `packages/web/src/store/mcp-selection.test.ts`, `e2e/interaction-single-asset-load.spec.ts`, `e2e/pane-lifetime.spec.ts`. Voir [architecture Web](./web-architecture.md), [extensions](./extensions-web.md) et [internationalisation](./i18n.md).

## Maintenance et validation

Pour chaque domaine modifié, mettre à jour procédure publique et topic AI propriétaire, vérifier chemins source/tests et conserver les limites d’hôte/portée/sécurité. Pour une modification documentaire seule : `make lint-docs` et `git diff --check`, sans inventer de nouveaux tests runtime. Pour du code, outillage ou comportement public modifié, suivre la [validation du projet](../../ai/project-map.md#8-validation) et les gates fonctionnels/visuels concernés.

| Domaine documentaire exigé | Procédure opérateur | Décision |
| --- | --- | --- |
|MCP|Guide §2|ADR-02|
|Code mode|Guide §3|ADR-03|
|Fichiers/accès|Guide §4|ADR-04|
|Sessions|Guide §5|ADR-05|
|Modèles|Guide §6|ADR-06|
|Outils|Guide §3|ADR-03|
|Réglages|Guide §6|ADR-07|
|Contrôles sécurité/environnement modifiés|Guide §1/§7|ADR-04/ADR-08|

Voir les [décisions anglaises](../en/architecture-decisions.md) et l’[index contributeur](./README.md). Cette table prouve une couverture documentaire, pas le droit de clôturer des capacités produit manquantes ou l’audit global.
