# Publication de fichier détenue par le writer

Core exporte `atomicWriteStableFile`, `atomicWriteStableFileWithReceipt`, `disposeStableFilePublicationReceipt`, `AtomicStableFileOptions`, `StableFilePublicationReceipt` et `StableFilePublicationResult` depuis la racine du package construit. Le writer existant retourne toujours `undefined` ou rejette. Un rejet ne prouve pas que le disque est resté inchangé.

## Admission et résultat

Le chemin doit déjà être confiné par la politique de sécurité/workspace de l’appelant. Le writer ne décide pas de la confiance, n’élargit pas les racines autorisées et ne permet pas d’exécuter du code. Il accepte un contenu texte/octets borné (plafond dur de 64 MiB), un staging privé dans le même répertoire, un mode explicite et une revalidation `beforeCommit` facultative. Les valeurs/options d’autorité sont capturées avant le premier await ; le callback conserve son receveur original, mais modifier ses options ne modifie pas l’admission.

Le résultat opt-in est figé :

- `publication` : `not-published`, `published` ou `uncertain` ;
- `receipt` facultatif : autorité opaque détenue par le writer, parfois présente lors d’un échec ;
- `error` facultatif : vérifier la **présence de propriété**, même si la valeur lancée est undefined.

Une publication tentée peut modifier le disque avant d’échouer. Un résultat publié/incertain sans reçu ne permet pas un rollback sûr gardé. Ne restaurez pas aveuglément les anciens octets après un rejet du writer ou d’une opération de configuration dépendante ; réconciliez l’état canonique et signalez l’incertitude ou le rollback refusé.

## Cycle de vie du reçu

Le reçu conserve le descripteur du fichier de staging et celui du parent. L’identité est figée depuis le descripteur détenu après rename/link, pas en rouvrant/statant une destination potentiellement remplacée. Device/inode, taille, dates de modification/changement nanosecondes, mode et lien unique sont comparés au descripteur détenu et au chemin frais ; l’identité du parent est aussi vérifiée.

Passez `expectedPublication` avec `overwrite: true` pour remplacer exactement cette publication. La garde est liée à la destination et à usage unique, même si sa tentative échoue. Un objet étranger, cloné via JSON/structured clone, libéré ou réutilisé n’a aucune autorité. Des octets identiques sur un autre inode correspondent à un intervenant, pas à une permission d’écrasement.

Chaque reçu retourné doit être libéré dans un `finally` attendu, y compris reçus original et de remplacement lors d’un échec. Ne libérez pas un reçu pendant sa publication gardée. La libération d’un reçu authentique est idempotente. Il existe 64 slots retenus **et en cours** par instance de module/processus, chacun conservant au plus deux descripteurs. Un remplacement gardé simultané nécessite un autre slot. Aucune expiration/libération par finalizer n’est garantie ; oublier la libération peut épuiser ce pool borné. Le writer ordinaire ne conserve aucun reçu.

```ts
const result = await atomicWriteStableFileWithReceipt(path, newBytes, { overwrite: true });
try {
  if ('error' in result) throw result.error;
  if (!result.receipt) throw new Error('Missing owned publication');
  // Seulement si l’opération dépendante a échoué et le rollback reste autorisé :
  const rollback = await atomicWriteStableFileWithReceipt(path, oldBytes, {
    overwrite: true, expectedPublication: result.receipt,
  });
  try {
    if ('error' in rollback) throw rollback.error;
  } finally {
    if (rollback.receipt) await disposeStableFilePublicationReceipt(rollback.receipt);
  }
} finally {
  if (result.receipt) await disposeStableFilePublicationReceipt(result.receipt);
}
```

## Limites et preuves

Ce n’est ni un compare-and-swap atomique de l’OS, ni une exclusion des writers hostiles, ni une détection exhaustive de manipulations privilégiées des métadonnées, ni une transaction multifichier atomique après crash. Un writer hostile peut agir entre la dernière vérification et rename ; la précision des dates dépend du système de fichiers. Le fsync du répertoire reste best effort. Le mode final demandé est appliqué avant publication ; le staging commence en `0600`.

`packages/core/src/security/stable-file.test.ts` et `stable-file-receipt.test.ts` couvrent de vrais fichiers, échecs avant/après publication, mutation des options par l’appelant, ABA par inode étranger ou modification observable en place, remplacement du parent, gardes opaques à usage unique, libération et capacité. Validez dans Docker et via la racine réellement construite, pas seulement les alias source.

À consulter : [frontières de sécurité](../../ai/topics/security.md), [politique des contrats publics](./public-contract-policy.md), [référence anglaise](../en/stable-file-publication.md).
