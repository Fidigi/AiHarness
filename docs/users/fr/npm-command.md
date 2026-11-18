# Configurer la commande des packages

Les actions d’installation, vérification et mise à jour CLI/Web partagent la politique Core `npmCommand`. Placez-la dans le `settings.json` du répertoire agent indépendant (`AI_HARNESS_AGENT_DIR` pour le CLI, `AI_HARNESS_DATA_DIR` pour Server), ou dans `.ai-harness/settings.json` d’un workspace approuvé :

```json
{
  "npmCommand": ["./npm-wrapper", "argument-prefixe-litteral"]
}
```

Le premier élément est un exécutable, pas une commande shell. Les suivants sont des arguments littéraux précédant les arguments install/view d’AiHarness. Un chemin exécutable relatif est résolu depuis le dossier du fichier déclarant ; un nom nu utilise PATH. Sans commande configurée, Core utilise `npm`. Cette sélection installe aussi les dépendances des packages Git ; Git lui-même reste `git`.

## Sélection et sécurité

- Une commande projet éligible remplace la commande globale. Les réglages d’un projet non approuvé ne sont pas ouverts. Des réglages invalides ou illisibles dans la couche gagnante/supérieure bloquent l’exécution sans repli global/PATH ; une commande projet approuvée valide peut remplacer une couche globale invalide.
- Le tableau contient 1 à 64 chaînes primitives non vides, jusqu’à 4 096 octets UTF-8 chacune et 32 Kio au total. Tableaux creux, accesseurs/éléments numériques hérités, caractères de contrôle/format et exécutable commençant par `-` sont refusés. Aucun itérateur personnalisé n’est exécuté.
- Le projet déclarant — pas la portée du package cible — doit rester canonique et autorisé avant chaque processus npm/Git, y compris après une attente de verrou. Installer globalement n’autorise pas un wrapper sélectionné par le projet.
- CLI `--approve`/`-a` ou une approbation explicite limitée à la session peut autoriser cette source exacte pour le processus sans enregistrer la confiance, même contre un refus sauvegardé. `--no-approve` prime sur une autorisation sauvegardée. Sans choix explicite, Core revérifie la confiance enregistrée avant chaque processus ; un défaut ou une autorisation en cache ne vaut pas dérogation.
- Server capture les réglages éligibles frais par opération, sans accepter de surcharge HTTP de commande/confiance. Sa source projet exige toujours une autorisation enregistrée fraîche. Des requêtes de workspaces concurrents ne modifient pas un runner partagé.

Inventaire et reload restent passifs. CLI `/reload` actualise la sélection ; Server la résout pour chaque opération explicite. Une opération admise conserve sa copie de commande mais revérifie l’autorisation source. Une politique invalide produit `INVALID_PLUGIN_NPM_COMMAND` ; une autorité source refusée produit `PROJECT_TRUST_REQUIRED`. Les vérifications retournent des résultats d’erreur fixes par package.

## Limites

Le runner n’utilise aucun shell, filtre secrets/configuration Node/npm/Git hérités, ignore stdin, borne sorties et délais, et conserve suppression des scripts de cycle de vie, staging, verrous et rollback. Un argument ressemblant à du shell reste littéral. Un wrapper reste néanmoins du code hôte privilégié : il peut implémenter son propre comportement et n’est pas sandboxé. Ne placez pas de secrets dans les arguments.

La confiance n’est ni une transaction OS atomique lecture/spawn ni un épinglage des octets exécutables. Une révocation ne retire pas un processus déjà lancé. L’arbre de processus Linux et les wrappers jetables sont testés ; aucune matrice multiplateforme ni connexion à un registre réel n’est revendiquée.

Consultez le [guide utilisateur](./user-guide.md) pour les actions et le [guide anglais](../en/npm-command.md) pour la même politique.
