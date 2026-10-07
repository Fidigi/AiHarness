# Politique des contrats publics AiHarness

## Objectif

AiHarness évalue la parité fonctionnelle au moyen de comportements qu’il possède. Un produit de référence peut motiver une capacité, mais il ne définit ni les noms de packages, ni les commandes, ni les enveloppes JSON, ni les fichiers de session, ni les modules d’extension, ni les déclarations TypeScript d’AiHarness. Les probes publics doivent s’exécuter sans importer les packages de référence.

Cette politique couvre l’exécutable CLI, la sortie print, les modes d’automatisation JSON et RPC, le journal de session, l’API d’extension et le point d’entrée exporté par `@ai-harness/core`.

## Familles de contrats

| Famille | Contrat actuel | Marqueur de compatibilité |
|---|---|---|
| Invocation CLI | Arguments `ai-harness`, code de sortie, rôles de stdout et stderr | Version de release retournée par `ai-harness --version` |
| Mode print | Une réponse assistant finale sur stdout | Release CLI et scénarios golden |
| Mode JSON | Événements lifecycle séparés par LF | `session.version: 3` dans le premier record |
| Mode RPC | Requêtes canoniques `{type,id}` et records corrélés de réponse/événement | Enveloppe canonique ; pas encore de version dédiée dans le flux |
| Persistance de session | Métadonnées JSONL AiHarness et entrées liées par parent | `SESSION_SCHEMA_VERSION` (`2`) |
| Factory d’extension | `ExtensionAPI`, enregistrements, hooks et nettoyage lifecycle | `api.version` et `AI_HARNESS_EXTENSION_API_VERSION` (`1`) |
| Point d’entrée Core | Valeurs runtime et déclarations TypeScript exportées par `@ai-harness/core` | `AI_HARNESS_CORE_API_VERSION` (`1`) |

L’ancienne enveloppe RPC `{id,method,params}` est une entrée de migration, pas le contrat préféré. Sa fixture empêche sa suppression accidentelle avant une migration annoncée. Les nouvelles commandes n’ont pas à prendre en charge les deux formes.

## Règles de compatibilité

Dans une même version majeure de contrat :

- l’ajout de champs, événements, méthodes et exports optionnels est permis ;
- les entrées requises et le sens des sorties documentées restent stables ;
- le framing de stdout et l’ordre du flux restent valides ;
- les données persistées courantes et les formats historiques documentés restent lisibles ;
- les extensions continuent de recevoir une version d’API vérifiable avant leurs enregistrements ;
- aucun secret ne devient observable dans les sorties, fixtures, diagnostics ou sessions.

Une suppression, un renommage, un type requis incompatible, un changement de sens d’événement ou un format persisté devenu illisible constitue une rupture. Une même livraison doit alors :

1. incrémenter le marqueur concerné ou introduire une négociation explicite ;
2. fournir une migration bornée ou un refus volontaire avec diagnostic stable ;
3. ajouter des fixtures positives et négatives pour l’ancien et le nouveau comportement ;
4. mettre à jour les documentations anglaise et française ;
5. consigner la décision de compatibilité dans l’audit ou les notes de release concernés.

Le semver du package et les marqueurs de contrat ont des rôles distincts. Une release peut évoluer sans changer de version majeure d’interface, tandis qu’une release peut volontairement faire évoluer un contrat persistant ou wire précis.

## Canaux de sortie

Le stdout print contient uniquement la réponse finale. Les stdout JSON et RPC contiennent uniquement des objets JSON séparés par LF. Les diagnostics, avertissements et écritures accidentelles des extensions vont sur stderr. Le code de sortie du processus appartient au contrat d’invocation.

La comparaison golden ne canonicalise que les valeurs volatiles : racines temporaires, UUID, timestamps, durées mesurées, IDs de workspace générés et ordre des clés d’un objet JSON. Elle ne supprime ni l’ordre des événements, ni le nombre de records, ni les valeurs, erreurs, usages, codes de sortie, framing ou affectation des canaux.

## Harnais de parité fonctionnelle

Le harnais réside dans `tests/functional-parity/` et la configuration Vitest racine le découvre. Son manifeste versionné relie les scénarios à `CLI-RUN-*`, `CLI-SES-03–04`, `CLI-EXT-02` et `CLI-AUT-*`. Cette couverture signifie qu’une frontière publique est exercée ; elle ne suffit pas à déclarer complet chaque comportement d’un critère d’audit.

Les groupes de fixtures sont :

- invocations de processus pour le parsing CLI, print, l’aide package, JSON et RPC ;
- transcripts JSON/RPC positifs et négatifs, dont l’isolation du bruit stdout ;
- JSONL de session courant, historique, branché et malformé ;
- modules d’extension natifs valides et invalides avec une interaction RPC ;
- probes TypeScript positifs et négatifs et probe runtime du package construit.

Les probes SDK résolvent uniquement le point d’entrée construit de `@ai-harness/core`. Les fixtures d’extension reçoivent l’argument de factory AiHarness et n’importent pas une autre API d’extension. Une allowlist automatisée échoue dès qu’une fixture publique dépend d’une autre interface package.

Lancez la suite ciblée dans Docker :

```bash
make test-parity
```

Les mêmes scénarios s’exécutent avec `make test` ; `make typecheck` vérifie aussi les types du harnais, tandis que les probes consommateurs positifs et négatifs sont compilés pendant son exécution.

## Modifier un contrat golden

Il n’existe aucun mode implicite de mise à jour des snapshots. Pour changer un fichier golden :

1. déterminer si l’écart est sémantique ou seulement volatil ;
2. étendre la canonicalisation uniquement pour une valeur réellement hors contrat ;
3. modifier volontairement la plus petite fixture ;
4. inspecter le diff positif et négatif complet ;
5. lancer `make test-parity`, puis les validations imposées par la project map ;
6. documenter la rupture ou la migration lorsque l’ancien comportement était public.

Ne copiez pas de sorties, schémas, déclarations ou fixtures depuis un package de référence. Exprimez le comportement attendu avec des entrées AiHarness et des résultats AiHarness.

## Documentation associée

- [Développement d’extensions CLI](./extensions-cli.md)
- [Vue d’ensemble de l’architecture](./architecture-overview.md)
- [Référence CLI pour agents IA](../../ai/topics/cli-reference.md)
- [Sessions et persistance](../../ai/topics/sessions.md)
