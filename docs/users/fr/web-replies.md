# Réponses Web et progression en direct

## Limites de sortie et réponses interrompues

Une limite de sortie explicite du provider laisse la note **Limite de sortie. Demandez la suite.** sur la réponse assistant enregistrée, même vide. Demandez au modèle de continuer ; cette note n’est jamais déduite du texte de sa réponse.

La dernière réponse limitée propose **Compacter le contexte** lorsque le workspace est approuvé et qu’aucun run ni aucune compaction n’est actif. La compaction modifie le contexte effectif du modèle sans effacer le transcript. **Stop** reste accessible pendant une compaction automatique. L’annulation ne défait pas une persistance déjà commencée.

Si le provider échoue après avoir affiché du texte ou du raisonnement, cette réponse partielle et une erreur bornée restent adjacentes après rechargement. Il s’agit d’une preuve d’échec, pas d’une réponse achevée ni d’une facturation inventée.

## Demandes d’extension concurrentes

Les demandes en attente conservent leur ordre d’admission. Le formulaire actif indique le nombre de demandes suivantes ; validez-le ou annulez-le pour afficher la prochaine. Chaque demande peut être fermée séparément. Une mise à jour du même identifiant conserve les brouillons compatibles et valide selon le schéma actuel.

Le signal sonore retentit une fois lorsqu’une demande est nouvellement affichée, pas à chaque progression ou reconnexion. Stop et la reconstruction des extensions révoquent les demandes restantes. Une réponse enregistrée pour une demande retirée ne peut pas autoriser une nouvelle demande.

## Détails du processus et reconnexion

Le raisonnement, les outils et les sorties de commande liés partagent un groupe de processus, même lorsque l’historique chargé commence en cours de tour. L’ouverture d’une sortie native conserve cette ouverture et le focus pendant le chargement des formats/actions optionnels. En cas d’échec du code d’affichage optionnel, la sortie brute reste disponible ; un rechargement réessaie explicitement un import échoué mis en cache.

La reconnexion restaure la phase active et la dernière progression des outils dans la génération actuelle du serveur. Une connexion lente peut omettre une progression courante remplacée ou des deltas de texte uniquement si des enregistrements de remplacement complets existent ; le cycle de vie et les événements terminaux ne sont pas supprimés silencieusement. La progression courante est locale au processus, **pas durable après crash**. Les réponses/résultats terminaux enregistrés sont distincts.

Consultez [le guide utilisateur](./user-guide.md) pour la confiance, les sessions et les commandes, et [le contrat technique](../../ai/topics/detached-streams.md) pour les sources et les limites.
