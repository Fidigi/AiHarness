# Démonstration statique

L’application séparée `demo/` est une démonstration synthétique d’AiHarness utilisable hors ligne. Elle ne nécessite ni compte, ni clé fournisseur, ni service d’inférence, ni serveur applicatif. Son interface est en anglais.

[IMPORTANT] Ne saisissez pas d’informations privées. Réponses, modèles, sessions, fichiers, changements Git et sorties terminal sont des exemples rédigés, pas des inférences ou opérations réelles sur l’hôte. Ce n’est pas un déploiement public de l’agent de production.

## Explorer l’exemple

- Choisissez une conversation ou créez-en une temporaire. Sélectionnez un modèle fictif et envoyez un texte ; **Stop** annule la simulation différée.
- Activez ou désactivez les outils read/bash simulés. L’aperçu d’une édition modifie le fichier d’exemple ; Files, Git et Terminal affichent ce même changement temporaire.
- Explorez les aperçus source, Markdown et image fournis. Le terminal accepte uniquement les commandes d’exemple indiquées ; chemins arbitraires, opérateurs shell et processus sont refusés.
- Passez entre Light/Dark. **Reset** demande confirmation avant d’effacer le travail temporaire. Un rechargement réinitialise aussi conversations, textes et éditions.

Aucune saisie n’invoque un LLM, un outil réel, Git, MCP, un processus terminal ou votre système de fichiers. Aucun stockage des textes/sessions ni outil d’analyse externe n’est ajouté. Le composant de langue réutilisé peut lire une préférence de langue existante, non secrète.

## Construire et prévisualiser

Depuis la racine du dépôt, avec Docker :

```bash
bash demo/run-docker.sh
# Base imbriquée facultative ; les deux barres obliques sont obligatoires.
DEMO_BASE=/preview/AiHarness/ bash demo/run-docker.sh
```

Le script exécute tests isolés, vérifications de types et d’artefact, puis parcours Chromium. Il exporte `demo/dist/` validé sans fusionner d’anciens fichiers. Une validation échouée ne publie pas de remplacement ; l’échec d’un export obligatoire fait échouer la commande. Téléversez uniquement le contenu de ce répertoire généré sous sa base statique configurée. Aucun serveur Node ou AiHarness n’est nécessaire sur l’hébergement public.

Pour prévisualiser l’artefact généré localement :

```bash
docker run --rm -p 127.0.0.1:4173:4173 \
  -e DEMO_HOST=0.0.0.0 -v "$PWD/demo:/app/demo:ro" \
  -w /app node:26-bookworm-slim node demo/scripts/serve.mjs
```

Ouvrez `http://127.0.0.1:4173/AiHarness/` pour la construction par défaut. Les routes à fragment fonctionnent sous la base choisie. Les chemins inconnus et endpoints API ne deviennent pas des requêtes d’agent et renvoient 404.

## Hors ligne et limites du déploiement

Après **Offline ready**, le service worker peut servir hors ligne les assets publics et vues différées. L’installation initiale nécessite un chargement en ligne réussi en HTTPS ou localhost et un navigateur compatible. Seuls les assets sont mis en cache, pas vos textes ou sessions ; recharger réinitialise toujours le travail temporaire.

Le workflow Pages dédié valide les pull requests sans autorité de déploiement. Seul un push validé sur la branche principale ou un déclenchement explicite de déploiement sur celle-ci peut publier l’artefact. Le propriétaire doit configurer GitHub Pages avec GitHub Actions et les éventuelles approbations d’environnement. Une validation locale n’active pas Pages, ne modifie pas les paramètres et ne déploie pas à distance ; les tests locaux ne prouvent pas un déploiement hébergé par GitHub.

L’artefact est borné et vérifié contre des formes de secrets représentatives ; cela ne garantit pas la détection de tout secret arbitraire. Les données synthétiques rédigées et l’absence d’entrées de credentials, d’imports backend et d’exécution hôte constituent la frontière principale. La publication suppose un checkout fiable sans mutation concurrente ; ce n’est pas un bac à sable contre un hôte hostile.

Consultez la [référence d’implémentation, de validation et de maintenance](../../ai/topics/static-demo.md) et le [guide de production](./user-guide.md).
