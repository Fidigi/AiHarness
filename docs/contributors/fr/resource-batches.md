# Lots exacts d’activation des modèles et skills

## Responsabilités

Core exporte `ResourceEnableChange`, `ResourceEnableOutcome` et `ModelEnableBatchResult`/`SkillEnableBatchResult` depuis `packages/core/src/types/resource-batches.ts`. Server possède l’adaptateur HTTP/persistance dans `api/model-routes.ts` et la fusion des listes fraîches dans `runtime/resource-batches.ts`. L’arbre Paramètres chargé à la demande utilise `ResourceBatchControls.tsx` et `services/resource-batches.ts` ; Web ne boucle pas sur des écritures HTTP individuelles.

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

## Mutation des groupes de skills

L’administrateur appelle `PATCH /api/skills/enabled/batch` avec exactement `{changes, cwd?, projectId?}` et la même limite de 500 sélecteurs uniques. Résolvez ceux-ci par la découverte détenue par l’hôte, jamais par un chemin fourni par le client. L’ID projet doit correspondre au cwd canonique ; un document projet exige une confiance enregistrée fraîche avant lecture et publication. Paramètres sépare Projet/Global et chaque source configurée/package, envoyant seulement les lignes affichées modifiées ; une case individuelle envoie un sélecteur.

`runtime/skill-catalog.ts` sérialise chaque fichier indépendamment. `runtime/skill-markdown.ts` valide les métadonnées strictes courantes et modifie seulement `disable-model-invocation`, préservant BOM, LF/CRLF, commentaires, corps et mode existant. Un document malformé, lié, hardlink, non régulier, modifié ou non approuvé échoue indépendamment ; les suivants continuent. Une opération effectivement inchangée ne réécrit ni métadonnées ni héritage. Les transformations fraîches des listes de portée préservent les entrées masquées/inconnues et les homonymes non ciblés. Les modifications de documents globaux/package/chemin peuvent affecter la découverte d’autres workspaces ; invalidez tous les caches, sans contourner leurs listes de portée.

Après un échec des paramètres, restaurez le Markdown uniquement avec le reçu Core à usage unique issu du writer. Une substitution observable de mêmes octets/nouvel inode, un ABA en place ou la confiance révoquée refuse le retour arrière avec `SKILL_ROLLBACK_FAILED` ; n’écrasez jamais un writer intervenu. Attendez la libération des reçus de publication/retour arrière. Les codes d’erreur utilisent des descripteurs propres de valeur bornée, jamais des getters. Rechargez toujours les paramètres canoniques avant de renvoyer un catalogue. Une réconciliation illisible retourne `409 SKILL_BATCH_UNCERTAIN` avec les résultats ordonnés et sans catalogue ; `GET /api/skills` refuse aussi `CONFIGURATION_UNREADABLE`. Un échec après publication ne signifie ni fichier inchangé ni restauration multi-fichiers réussie. Aucune transaction multi-fichiers après crash, CAS atomique OS ou sandbox d’un producteur privilégié n’est promis.

## Tests et maintenance

- `packages/server/src/api/model-batches.test.ts` : vrai HTTP loopback authentifié, préservation des portées/alias, transformations concurrentes fraîches, stabilité des octets, contrôles invalidité/admin/Origin et réconciliation après publication/configuration illisible.
- `packages/server/src/runtime/resource-batches.test.ts` : sélecteurs stricts et fusion héritée.
- `packages/server/src/api/resource-batches.test.ts`, `packages/server/src/runtime/skill-markdown.test.ts` : vrai HTTP, contrôles stricts de document/corps/mode/confiance, concurrence de portée, deuxième publication réellement échouée, ABA/refus/libération des reçus et incertitude canonique.
- `e2e/resource-batches.spec.ts` : assertions combinées conservées, réconciliation partielle/échec, axe/débordement et huit captures skills/résultats desktop/mobile Light/Dark.
- `e2e/skill-batches-live.spec.ts` : découverte et publication disque réelles Vite/Express/Core, fichiers masqués préservés, poursuite après document invalide et rechargement durable sans interception API.
- `packages/web/src/services/resource-batches.test.ts` : route/corps minimaux et erreurs.
- `e2e/model-batches.spec.ts` : requêtes filtrées/par groupe/individuelles exactes, résultats, axe/débordement, anciennes sauvegardes sur le même workspace et quatre captures desktop/mobile Light/Dark.

Exécutez sous Docker les vérifications de types, les tests ciblés à un worker, les navigateurs sans mise à jour/retry et le contrôle des budgets de production inchangés. Inspectez seulement les deltas visuels justifiés. Synchronisez l’[API Server](../../ai/topics/server-api.md), les [instructions utilisateur](../../users/fr/resource-batches.md) et la version anglaise. Les lots de modèles et de skills disposent de preuves distinctes ; les primitives communes ne clôturent ni providers ni critères Paramètres plus larges.
