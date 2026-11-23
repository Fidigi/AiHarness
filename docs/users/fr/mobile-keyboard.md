# Disposition avec le clavier mobile

Sur un écran étroit à interaction tactile, le focus dans un champ éditable peut masquer les contrôles secondaires du chat lorsque le navigateur signale une réduction importante de la zone visible compatible avec un clavier. Envoyer/File, Arrêter, les images et la conversation restent disponibles. Les contrôles de modèle et de portée réapparaissent à la fermeture du clavier ; un contrôle ayant le focus n’est pas masqué.

## Détection et focus

- La détection exige un champ éditable ayant le focus, un pointeur tactile et une largeur de mise en page d’au plus 959 pixels CSS. Boutons, listes de sélection, champs désactivés/en lecture seule et `inputmode="none"` n’activent pas la disposition compacte.
- Le zoom seul, les petits mouvements des barres du navigateur et le déplacement de la zone visible ne sont pas considérés comme l’ouverture du clavier. Le zoom est normalisé par rapport à une référence précédemment observée sans zoom.
- Après une rotation pendant la saisie, quittez le champ avant d’établir la référence de la nouvelle orientation.
- Un changement d’espace de travail, de conversation ou de navigation retire les opérations de mise en page en attente. Un champ réutilisé avec son focus conservé exige une nouvelle intention de focus, de saisie ou de composition dans la nouvelle vue.

Le mode compact conserve le comportement Entrée/Mod+Entrée configuré, les lignes multiples et la protection de composition. Fermer le clavier n’envoie pas de message et n’arrête pas une exécution.

## Chargement des styles et réessai

La feuille de style propre au chat est chargée sur une intention de clavier admissible, pas à chaque ouverture de page. Le chat conserve sa disposition normale jusqu’au chargement des styles et à une nouvelle vérification du focus et de la géométrie.

Si la requête échoue ou reste bloquée huit secondes, la disposition normale et la saisie restent utilisables. Les redimensionnements ne déclenchent pas de réessais répétés. Fermez le clavier ou quittez le champ afin d’obtenir un état fermé, puis donnez de nouveau le focus au champ éditable. Ce réessai ne recharge pas la page et ne supprime pas le brouillon.

Quitter le chat retire sa feuille de style et ses écouteurs. Les réglages MCP restent indépendamment défilables et éditables ; `/mcp` permet d’y naviguer localement. Ces changements de disposition n’autorisent pas de fichiers, ne modifient pas la confiance et n’exécutent pas d’outils MCP.

## Limites

**[IMPORTANT]** Les signaux de zone visible ne prouvent pas la présence d’un clavier natif. Les claviers flottants/superposés sans redimensionnement, une zone initialement réduite ou zoomée sans référence fiable et les changements sans événement ultérieur de navigateur/saisie peuvent ne pas être détectés. Les claviers physiques Android/iOS/Safari, les barres de suggestions et les zones de sécurité matérielles non nulles ne sont pas certifiés par les tests d’émulation Chromium. La disposition adaptative normale reste la solution de repli.

Consultez le [guide utilisateur](./user-guide.md) et le [guide de chargement du panneau de fichiers](./workspace-loading.md).
