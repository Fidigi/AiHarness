# Chargement du panneau de fichiers

Ouvrez **Fichiers / workspace** pour charger l’explorateur et sa feuille de style. Un panneau fermé ne télécharge pas ces ressources optionnelles. La préférence d’ouverture par défaut sur ordinateur reste respectée.

| État | Actions disponibles |
|---|---|
| Chargement | Fermer ou Annuler ; conversation, éditeur, Stop et palette de commandes restent disponibles |
| Échec du téléchargement | Lire l’erreur locale, Fermer ou Annuler, ou choisir explicitement **Recharger et réessayer** |
| Prêt | Utiliser l’arborescence, le lecteur, les uploads et les contrôles Git existants |

Le chargement n’est pas une boîte de dialogue modale : il ne piège pas le focus et ne place pas automatiquement le focus dans l’éditeur. Fermer le panneau ou changer de workspace, conversation ou route retire la vue en attente. Un téléchargement tardif ne peut pas rouvrir l’ancien panneau ni rejouer sa demande de fichier dans la vue suivante.

Un lien vers un fichier activé pendant le chargement conserve uniquement la dernière intention d’ouverture bornée. Lorsque le vrai panneau est prêt, ses règles existantes de chemin, permission et lecture s’appliquent toujours. Le chargement n’accorde aucun accès supplémentaire aux fichiers.

[WARNING] Copiez votre texte non envoyé avant **Recharger et réessayer** : le rechargement risque de le perdre. Fermer puis rouvrir ne répare pas à lui seul un import JavaScript ou CSS rejeté. Le réessai recharge volontairement le document ; il ne prétend pas réinitialiser l’import en échec. Recharger n’envoie pas une demande Stop à un agent détaché.

Cette frontière modifie le chargement des ressources, pas les capacités de fichiers, upload, Git ou confiance du workspace.

## Documentation associée

- [Guide utilisateur](./user-guide.md)
- [Chargement des textes des réglages](./settings-loading.md)
- [Version anglaise](../en/workspace-loading.md)
