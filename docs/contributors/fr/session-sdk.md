# SDK TypeScript de session AiHarness

Importez la façade depuis l’entrée racine réellement compilée de `@ai-harness/core` (Core API majeure 1). La [référence bilingue complète et son exemple mock](../../../packages/core/src/sdk/README.md) décrit les options/méthodes ; le [guide de propriété pour agents](../../ai/topics/session-sdk.md) identifie les sources et validations.

Composez une configuration intégrée explicite ou une instance `AiProvider` prêtée, des limites de workspace canoniques et une politique de confiance fraîche détenue par votre hôte. Sans `store`, le fonctionnement est réellement en mémoire ; `JsonlSessionStore` ou le `SessionStore` structurel à six opérations permet la persistance/reprise. La fabrique ne découvre rien, ne charge ni exécutable/MCP, ne lance aucune commande de credentials et ne contacte aucun fournisseur. Les credentials cloud peuvent être utilisés par un prompt explicite, pas par la fabrique.

`prompt` démarre le travail détaché ; `promptAndWait` attend ce run. `stop` accuse réception : attendez `wait` pour les résultats/comptes interrompus durables. Wait ne doit pas empêcher stop. Les démarrages et mutations occupés sont refusés. Les événements séquencés v1 conservent des données unknown et un replay/reset borné. Les lectures renvoient des copies expurgées du contexte actif ou du journal brut abandonné/pré-compaction.

`fork` copie l’ascendance utilisateur durable ; `branchBefore` change le chemin actif ; `clone` crée une racine indépendante avec IDs actifs remappés. La compaction manuelle reçoit un résumé ; l’automatique exige un callback explicite. Découverte/expansion des ressources est opt-in et retourne du texte à envoyer vous-même. Ne dupliquez pas la boucle agent/persistance/retry dans la façade.

Capturez options et identités prêtées avant le premier await, les arguments à l’admission, et copiez/expurgez callbacks, stockage et données publiques. Un observateur d’usage/politique ne doit pas modifier les tokens/historiques durables. Fournissez les secrets explicites ou un redactor Core partagé, surtout avec des backends partagés. Les stockages personnalisés doivent valider/borner leur backend, conserver les parents bruts v2 et dates, garantir requireAbsent atomique/verrous et attendre leur durabilité.

Consultez `capabilities`/`ownership` ; disposez chaque fork/clone. Seul le dernier handle ferme les scopes/registre possédés, jamais les stockages/fournisseurs/registres prêtés ou transports globaux. Les intégrations hôte non coopératives peuvent retarder le règlement et ne sont pas sandboxées. OAuth/découverte, instructions/settings implicites, chargement exécutable/MCP, changement de fournisseur, shell/export HTML, admission interprocessus et entrées personnalisées complètes ne sont pas implicites.

## Ressources Markdown contextualisées

`ResourceManager` et `createAgentResourceLoader` acceptent les options additives `globalSkillSelectors`, `projectSkillSelectors`, `globalPromptSelectors` et `projectPromptSelectors`. Chaque `ResourceFileSelector` readonly sépare `{ pattern, baseDir }` : `baseDir` doit être absolu et reste littéral ; `pattern` accepte les opérations ordonnées simple/glob, exacte `+`, retrait de sous-arbre `-` et exclusion `!glob`. Pour des réglages déjà chargés, utilisez `resolveAgentResourceSelectors(settings, 'prompts', homeDir, 'global')` (ou `'skills'`/`'project'`). Les sélecteurs projet restent soumis à la confiance.

```ts
import { createAgentResourceLoader, type ResourceFileSelector } from '@ai-harness/core';
const selectors: readonly ResourceFileSelector[] = Object.freeze([
  Object.freeze({ pattern: '*.md', baseDir: '/srv/operator/prompts[literal]' }),
]);
const loader = createAgentResourceLoader({ globalPromptSelectors: selectors });
// Toujours passif : seul loader.load(context) découvre les ressources.
```

`ResourceManager` copie les tableaux/champs contextualisés à sa construction sans invoquer les getters d’entrée de tableau ou de champ de sélecteur ; le chargeur intégré le construit lors du `load` explicite. Limites : 512 requêtes par couche combinant anciennes/nouvelles options et 32Kio par paire motif/base. Les anciennes options mutables `*Paths: string[]` et `resolveAgentResourcePaths` conservent leur ABI à chaînes. Pour une chaîne absolue située sous le cwd, le dossier agent ou le dossier personnel configuré du gestionnaire, la racine connue la plus précise reste désormais littérale. Fournissez les mêmes racines que pour la résolution des réglages ; aucune exploration du disque ne devine un dossier déclarant arbitraire. Un motif absolu contextualisé conserve aussi son propre `baseDir`. Les motifs externes à la base et les sous-motifs gardent leur syntaxe glob ; utilisez un objet contextualisé ou `+` pour toute autre identité littérale. Si les deux formes sont fournies, les anciennes précèdent les nouvelles dans la même couche. Aucun chargement implicite de réglages/exécutables ni confiance supplémentaire n’est ajouté au SDK.

`discoverSkills: false` / `discoverPrompts: false` sur `ResourceManager` ou `createAgentResourceLoader` ignorent les racines automatiques et les couches de sélecteurs réglages/packages fournies pour le type concerné, mais conservent les chemins explicites `skillPaths` / `promptPaths`. Les deux valent true par défaut. Les anciennes options `disableSkills` / `disablePrompts` désactivent toujours **tout** chargement, chemins explicites compris ; leur sens n’a pas été modifié. Ce sont des options hôte, pas des réglages agent enregistrés ; elles ne contournent ni confiance du projet ni contrôles de fichier stable. La fabrique SDK reste passive.

## Comptabilité du journal

Utilisez l’utilitaire public Core `getSessionAccounting(readonlyEntries, activeLeafId?)` pour distinguer ascendance active et historique complet. Sur un handle SDK au repos, fournissez `await session.history()` et `session.snapshot().activeLeafId` ; la taille du contexte est une estimation séparée. Le coût persisté prévaut ; un calcul tarifaire exige le provider/modèle de l’entrée. Les coûts inconnus/partiels et l’usage imbriqué authentifié sur le résultat externe doivent survivre à la projection, sans sommer les détails de progression/appels imbriqués. `requests` compte les entrées comptabilisables, pas les appels réseau internes. La provenance optionnelle copiée `BranchSummaryAccounting` des primitives gestionnaire/stockage survit à la relecture v2 et au clonage ; aucune génération automatique ni méthode de façade n’est ajoutée. La référence complète précise limites et mesures inconnues.

## Validation

Compilez Core et exécutez tests/typechecks SDK **dans Docker**, avec un worker. `public-consumer.test.ts` installe manifest et dist réellement émis dans un consommateur temporaire externe ; Node importe seulement `@ai-harness/core` et TypeScript NodeNext compile les appels valides/invalides contre les déclarations émises. Aucun alias source ni module SDK privé ne remplace la preuve publique.

Voir aussi : [politique des contrats publics](./public-contract-policy.md), [architecture](./architecture-overview.md), [guide utilisateur](../../users/fr/user-guide.md#sdk-typescript-de-session).
