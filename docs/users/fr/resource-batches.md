# Contrôles par groupe des catalogues de modèles et skills

Dans **Paramètres → Modèle → Gérer le catalogue de modèles**, filtrez par modèle ou provider, puis utilisez **Activer les éléments affichés** ou **Désactiver les éléments affichés** pour un provider ou tout le catalogue affiché.

- Seules les lignes affichées dont l’état change sont envoyées, dans une requête. Les lignes masquées et les autres groupes conservent leur état.
- Une action accepte au plus 500 lignes modifiées. Affinez le filtre pour un groupe plus grand ; une action sans changement est désactivée.
- Les cases individuelles restent disponibles et envoient un sélecteur exact.
- Avec un workspace sélectionné, les changements ciblent sa configuration projet ; les valeurs globales héritées et les autres paramètres sont préservés. Le catalogue indique la source effective.
- La liste distingue les sélecteurs modifiés, inchangés et en échec. Un échec ne devient pas une réussite fictive.

Si une requête échoue, ne supposez pas que le disque est inchangé. Le client recharge le catalogue canonique et affiche une erreur. Après avoir quitté la page pendant une sauvegarde, revenez et utilisez **Actualiser le catalogue** avant de réessayer. Une ancienne réponse ne peut pas remplacer le catalogue de la nouvelle page Paramètres.

Une configuration illisible est refusée, jamais écrasée. Une publication non réconciliable renvoie une erreur d’incertitude explicite plutôt qu’un catalogue périmé. Ces contrôles ne sauvegardent pas les valeurs par défaut de modèle/raisonnement, ne remplacent pas les identifiants, ne renomment pas les providers et ne changent pas le modèle sélectionné dans la conversation courante.

## Groupes de skills

Dans **Paramètres → Skills**, filtrez par nom, description ou source. Utilisez **Activer les éléments affichés**/**Désactiver les éléments affichés** pour Projet, Global ou une source configurée/package. Seules les entrées visibles modifiées sont envoyées, avec des résultats séparés ; un fichier invalide ou non approuvé ne supprime pas les réussites suivantes. Les cases individuelles restent disponibles.

Le serveur modifie seulement les métadonnées d’invocation valides de `SKILL.md`, préservant corps, commentaires, fins de ligne et mode. Une opération effectivement inchangée ne réécrit rien. Les fichiers projet exigent une confiance enregistrée séparément ; ces contrôles ne l’accordent pas. Les skills masqués et autres paramètres de portée restent intacts. Modifier un document Global/Package/Chemin configuré peut aussi affecter sa découverte dans d’autres workspaces, selon leurs listes effectives.

Un échec des paramètres peut déclencher un retour arrière du fichier détenu. Si un writer intervenu ou la confiance modifiée l’interdit, le résultat signale cet échec et le catalogue recharge l’état réel. Un état canonique illisible produit une erreur d’incertitude explicite sans catalogue périmé. Actualisez avant de réessayer ; ne supposez ni que chaque échec a été annulé, ni qu’un lot est atomique après crash.

Consultez le [guide utilisateur](./user-guide.md) pour la sélection et les valeurs par défaut, et le [contrat contributeur](../../contributors/fr/resource-batches.md) pour les requêtes et la persistance.
