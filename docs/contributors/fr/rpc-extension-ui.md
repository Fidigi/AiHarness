# UI des extensions en RPC

Ce contrat additif appartient à AiHarness : ce n’est pas une couche de compatibilité avec une API ou un protocole tiers. Démarrer avec `ai-harness --mode rpc`. Lire stdout continuellement en JSONL délimité par LF ; envoyer les réponses sur stdin. Les diagnostics utilisent stderr.

## Contexte d’extension

Les commandes et outils RPC reçoivent un `context.ui` optionnel :

```ts
context.ui?.setStatus('review', 'Vérification');
context.ui?.setWidget('review', ['Texte brut, jamais du HTML']);
context.ui?.setTitle('Revue');
context.ui?.setEditorText('Brouillon suggéré');
const dialog = context.requestInteraction?.({
  kind: 'select', title: 'Continuer ?',
  options: [{ label: 'Oui', value: 'yes' }],
});
// Capacités optionnelles attachées à la Promise, pas des IDs fournis par l’appelant :
dialog?.update?.({ kind: 'confirm', title: 'Continuer ?', message: 'Prêt' });
const answer = await dialog;
context.ui?.setStatus('review'); // undefined supprime cette clé
```

`ui.mode` vaut `rpc`. Les capacités immuables `ui.capabilities` listent les dialogues `select`, `confirm`, `input`, `editor` et les méthodes de présentation `setStatus`, `setWidget`, `setTitle`, `setEditorText`. `custom` et `terminal` valent false. Vérifier les méthodes optionnelles dans une extension multimode. Les composants terminal `registerUI`, séquences d’échappement, composants personnalisés, rendu de champs/ANSI et gestion réelle du terminal/éditeur ne sont pas pris en charge ici. Une interaction custom est annulée sans émission. Le texte d’éditeur est une intention de présentation, jamais un prompt envoyé ou une commande shell.

## Protocole

Les enregistrements existants `extension_ui_request` conservent `id` généré par l’hôte, `method`, `title` et le `timeout` optionnel :

- `confirm` : `message` ; réponse `{type:"extension_ui_response",id,confirmed:true|false}`.
- `select` : libellés `options` ; réponse avec une chaîne `value` correspondant à un libellé ou une valeur actuelle. L’extension reçoit la valeur de l’option.
- `input` : `placeholder` optionnel ; `editor` : `prefill`. Répondre avec une chaîne `value`.
- Tout dialogue : `{type:"extension_ui_response",id,cancelled:true}` l’annule.
- `notify` : `message`, `notifyType` (`info`, `warning`, `error`) ; aucune réponse.

Les méthodes de présentation émettent `extension_ui_request` avec `method`, `id`, `key` et `value` (chaîne, ou tableau de chaînes pour les widgets). Une valeur absente émet `cleared:true` ; titre/éditeur utilisent la clé vide. Le client rend du texte brut et choisit comment présenter ces intentions. Aucune réponse n’est attendue.

Une mise à jour remplace la requête avec le **même ID**, conserve l’ordre d’admission et le délai/signal originaux, et valide les réponses selon le dernier schéma. `dialog.close()` annule cette seule requête ; les contrôles retournent false après résolution. Une annulation par l’hôte émet `{type:"extension_ui_closed",id,reason}`, avec `closed`, `aborted`, `timeout`, `session-changed`, `shutdown` ou `delivery-failed`. Une réponse client normale résout une seule fois sans fermeture supplémentaire. Les réponses tardives, étrangères ou malformées sont consommées sans résoudre un dialogue courant. Une confirmation expirée retourne false ; les autres expirations annulent.

## Rejeu explicite

Envoyer `{type:"get_extension_ui",id:"ui-state"}`. Seuls `type` et `id` chaîne optionnel sont admis. La réponse corrélée ordinaire contient :

```json
{"version":1,"mode":"rpc","capabilities":{"dialogs":["select","confirm","input","editor"],"presentation":["setStatus","setWidget","setTitle","setEditorText"],"custom":false,"terminal":false},"closed":false,"requests":[],"presentation":[]}
```

`requests` contient les requêtes pendantes dans l’ordre d’admission ; `presentation` contient la dernière valeur par méthode/clé. Remplacer l’état client par cet instantané ; sa lecture ne réémet/réadmet aucun dialogue, ne réinitialise pas les délais et ne répète pas les notifications. L’état est local au processus, non persisté et non récupérable depuis un nouveau processus. Les instantanés/enregistrements sont des copies détachées. Les identifiants secrets enregistrés sont masqués ; les secrets inconnus dans une conversation ne sont pas automatiquement reconnus.

## Bornes et fermeture

Au maximum : 16 dialogues, 100 clés de présentation, 100 options/lignes de widget, 128 000 octets UTF-8 par enregistrement normalisé/protocole et 512 000 octets d’état conservé cumulé, valeurs privées d’options incluses. Les clés sont limitées à 256 octets. Un dépassement d’admission/mise à jour/présentation refuse le changement sans supprimer l’état précédent. Le délai est un entier de 1 à 2 147 483 647 millisecondes. Au maximum 256 livraisons UI peuvent attendre un sink lent : un dialogue non livrable est annulé ; les émissions excédentaires de notification/présentation sont best-effort, tandis que la dernière présentation reste disponible dans l’instantané explicite. Les extensions sont du code privilégié, pas un bac à sable.

Abort annule les dialogues pendants mais permet les suivants. Une création/changement de session ou un fork réussi annule les anciennes requêtes ; la présentation reste au niveau du processus. EOF, signaux et fermeture du pont annulent avant d’attendre les commandes, refusent les nouveaux dialogues, effacent la présentation et retirent timers/listeners. La sortie utilise le writer RPC sérialisé normal ; un échec de livraison annule la requête concernée et le point de composition traite l’échec du sink comme terminal.

Validation : `make typecheck`, `make test`, `make test-parity`. Les régressions d’état/cycle de vie et le test de processus utilisant le véritable exécutable compilé se trouvent dans `packages/cli/src/rpc/rpc-extension-ui*.test.ts`.

[English](../en/rpc-extension-ui.md) · [Extensions CLI](./extensions-cli.md)
