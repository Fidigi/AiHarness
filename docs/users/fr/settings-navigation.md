# Navigation mémorisée dans les Paramètres Web

AiHarness mémorise la navigation des Paramètres séparément pour chaque dossier de projet validé par le serveur, avec un contexte distinct lorsqu’aucun projet n’est sélectionné. Cette mémoire décrit la présentation du navigateur, pas la configuration du projet.

## Ce qui est retrouvé

- La dernière section des Paramètres et le dernier groupe ou élément de ressource ayant reçu le focus dans cette section.
- Les choix de portée Globale/Projet pour les outils, les valeurs par défaut, les packages, les sous-agents et l’installation des skills.
- Un élément encore valide, uniquement après son identification unique dans les données fraîches. Un élément absent ou ambigu laisse place à son groupe ou à sa section ; celui d’un autre projet ne le remplace pas.

Toutes les sections actuelles proposent une vue globale ou en lecture seule sans projet. Fermer le projet ne quitte donc pas une section valide ; les choix de portée Projet devenus indisponibles reviennent à Globale.

Les recherches, configurations collées, identifiants secrets, champs non enregistrés, révisions, décisions de confiance et résultats Test/OAuth ne sont **pas** restaurés par cette mémoire. Retrouver une position ne clique sur aucun contrôle, n’enregistre aucune configuration, n’active aucune ressource et n’exécute aucun serveur.

## Changement de projet ou de confiance

Changez de projet avec le sélecteur d’espace de travail. Revenir au même dossier canonique retrouve sa navigation valide, et non la position de l’autre dossier.

Un changement canonique d’identité d’espace de travail (dont le chemin du dossier) ou de confiance recrée les formulaires des Paramètres montés et relit leurs données. Vérifiez de nouveau les modifications non enregistrées : elles ne sont pas transportées vers le nouveau contexte d’autorité. Changer de vue n’annule pas une opération déjà acceptée par le serveur.

Le focus peut revenir à un contrôle correspondant utilisable, ou à une zone de groupe/section sûre. Un retour différé s’efface devant une nouvelle intention de pointeur, de molette, de clavier ou de focus, un autre dialogue ou une navigation. Les dialogues conservent leur retour normal ; si leur contrôle d’origine disparaît, la section fraîche des Paramètres peut prendre le relais. Quand le navigateur signale un pointeur de précision réduite (`coarse`), le retour automatique évite les champs éditables plutôt que de forcer une saisie.

## Stockage et confidentialité

Les onglets ne suivent pas en direct la navigation ni les formulaires des autres onglets. Un changement de focus ultérieur conserve les positions fraîchement enregistrées dans les autres sections ; cette mémoire au mieux des possibilités du navigateur ne synchronise pas la configuration entre les onglets.

Cette mémoire facultative conserve des chemins de dossiers et des identifiants de navigation dans ce profil de navigateur pour ce site. Les noms de dossiers et identifiants de ressources peuvent eux-mêmes être sensibles. Limitée à 24 contextes, elle peut éliminer des entrées anciennes ou trop volumineuses. Un stockage indisponible, refusé ou corrompu ne modifie pas les paramètres du serveur et n’accorde aucune confiance ; les choix de portée de la vue montée restent utilisables.

Pour oublier ces positions par dossier, fermez les Paramètres dans tous les onglets, puis supprimez `ai-harness-settings-navigation-v1` avec les outils de stockage du site dans le navigateur. Les autres préférences et fichiers du serveur restent inchangés. Une ancienne section globale mémorisée peut encore servir de repli initial jusqu’à l’enregistrement d’une nouvelle position par dossier.

Consultez le [guide de configuration Web](./user-guide.md#configurer-le-web) pour les opérations réelles des Paramètres et les règles de portée.
