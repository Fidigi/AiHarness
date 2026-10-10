# Lots exacts d’activation des modèles

## Responsabilités

Core exporte `ResourceEnableChange`, `ResourceEnableOutcome` et `ModelEnableBatchResult` depuis `packages/core/src/types/resource-batches.ts`. Server possède l’adaptateur HTTP/persistance dans `api/model-routes.ts` et la fusion des listes fraîches dans `runtime/resource-batches.ts`. L’arbre Paramètres chargé à la demande utilise `ResourceBatchControls.tsx` et `services/resource-batches.ts` ; Web ne boucle pas sur des écritures HTTP individuelles.

## Requête publique

La capacité administrateur `configuration` et les contrôles Origin habituels protègent `PATCH /api/models/enabled/batch` :

```json
{
  "projectId": "selected-workspace-id",
  "changes": [{ "key": "openai:qualified-model-id", "enabled": false }]
}
```

Omettez `projectId` pour la portée globale. Acceptez exactement `changes` et le `projectId` facultatif ; au plus 500 entrées uniques `{key, enabled}`, avec sélecteurs bornés non vides et booléens. Refusez les champs inconnus, doublons et données malformées avant mutation. Un lot vide ne change rien.

La réussite renvoie les `outcomes` ordonnés (`changed`, `unchanged`, `failed`, code fixe facultatif) et le `catalog` canonique. Les sélecteurs inconnus échouent indépendamment. Paramètres envoie seulement les lignes affichées modifiées ; une case individuelle utilise la même route avec un sélecteur. Filtrez un groupe dépassant 500 changements, sans troncature silencieuse.

## Persistance et échecs

`ConfigurationStore.update()` sérialise une transformation contre des copies fraîches de la cible et de la portée globale. Préservez les clés activées inconnues ou masquées, les autres paramètres et les opérations héritées inchangées. Développez un ancien alias d’ID non qualifié avant de changer un sélecteur provider qualifié, sans affecter le même ID d’un autre provider. Les clés qualifiées connues priment sur les anciens ID qui les recouvrent, en lecture comme en fusion ; ne supprimez jamais une clé qualifiée d’un autre modèle comme s’il s’agissait d’un alias. Une opération inchangée ne matérialise pas l’héritage et ne remplace pas l’inode.

Un rejet du writer peut suivre une publication. Marquez les changements non confirmés en échec, rechargez la configuration canonique et renvoyez l’état réel plutôt qu’un retour arrière fictif. Si la réconciliation échoue, renvoyez `409 MODEL_BATCH_UNCERTAIN` avec les résultats et **sans catalogue**. `GET /api/models` relit la configuration et refuse un état illisible : l’actualisation ne valide donc pas une ancienne mémoire. Aucune atomicité multi-fichiers après crash ni exclusion d’un writer hostile n’est promise ; voir la [publication stable](./stable-file-publication.md).

Le client traite les erreurs de transport/incertitude comme nécessitant une actualisation, jamais une annulation présumée. L’ID/cwd capturé du workspace et la génération de vie de Paramètres excluent les anciennes réponses, y compris après fermeture/réouverture sur le même workspace. Un verrou local synchrone évite les doubles envois. Ce contrat ne modifie ni session, ni valeurs par défaut, ni provider.

## Tests et maintenance

- `packages/server/src/api/model-batches.test.ts` : vrai HTTP loopback authentifié, préservation des portées/alias, transformations concurrentes fraîches, stabilité des octets, contrôles invalidité/admin/Origin et réconciliation après publication/configuration illisible.
- `packages/server/src/runtime/resource-batches.test.ts` : sélecteurs stricts et fusion héritée.
- `packages/web/src/services/resource-batches.test.ts` : route/corps minimaux et erreurs.
- `e2e/model-batches.spec.ts` : requêtes filtrées/par groupe/individuelles exactes, résultats, axe/débordement, anciennes sauvegardes sur le même workspace et quatre captures desktop/mobile Light/Dark.

Exécutez sous Docker les vérifications de types, les tests ciblés à un worker, les navigateurs sans mise à jour/retry et le contrôle des budgets de production inchangés. Inspectez seulement les deltas visuels justifiés. Synchronisez l’[API Server](../../ai/topics/server-api.md), les [instructions utilisateur](../../users/fr/resource-batches.md) et la version anglaise. L’édition des groupes de skills reste une livraison distincte, non déduite des DTO/helpers communs.
