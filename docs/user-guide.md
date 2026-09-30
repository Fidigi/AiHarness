# Guide utilisateur AiHarness

AiHarness fournit deux interfaces sur les mêmes providers et le même stockage de sessions :

- **CLI** : agent interactif dans un terminal, avec sessions, branches, outils, skills et extensions ;
- **Web** : chat React connecté au serveur AiHarness, avec streaming SSE ou WebSocket.

Ce guide décrit l’installation depuis les sources, la configuration des providers et l’usage quotidien des deux interfaces.

## Sommaire

- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Configuration des providers](#configuration-des-providers)
- [Utiliser le CLI](#utiliser-le-cli)
- [Utiliser l’interface Web](#utiliser-linterface-web)
- [Sessions et fichiers](#sessions-et-fichiers)
- [Sécurité](#sécurité)
- [Dépannage](#dépannage)

## Installation

### Prérequis

- Node.js 22.22.2+, 24.15.0+ ou 26+ ;
- npm 12.1.0+ ;
- une clé d’API ou un serveur local compatible OpenAI pour utiliser un vrai modèle.

Le provider `mock` est disponible sans configuration pour découvrir l’application.

### Installation depuis les sources

```bash
git clone https://github.com/Fidigi/AiHarness.git
cd AiHarness
npm install
npm run link:global
```

### Installer les commandes `ai-harness` et `ai-harness-web`

La commande `npm run link:global` construit le projet et installe deux exécutables liés à ce dépôt :

- `ai-harness` pour le terminal ;
- `ai-harness-web` pour l’application Web complète.

Vous pouvez ensuite les lancer depuis n’importe quel dossier. Vérifiez que le dossier global de npm est présent dans votre `PATH` si une commande reste introuvable.

Les liens globaux pointent vers ce dépôt. Après une modification du code, relancez `npm run build` ; il n’est pas nécessaire de recréer les liens.

## Démarrage rapide

### Terminal

```bash
ai-harness
```

### Web

```bash
ai-harness-web
```

Le navigateur s’ouvre automatiquement sur [http://127.0.0.1:3080](http://127.0.0.1:3080). Utilisez `Ctrl+C` pour arrêter le serveur.

## Configuration des providers

Les variables doivent être définies **avant** de démarrer le CLI ou le serveur Web.

| Provider | Variables principales | Variables facultatives |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` en mode RPC |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` en mode RPC |
| Google Gemini | `GEMINI_API_KEY` ou `GOOGLE_API_KEY` | `GEMINI_MODEL` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| Google Vertex AI | `GOOGLE_VERTEX_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT` | `GOOGLE_CLOUD_LOCATION`, `VERTEX_MODEL` |
| AWS Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `AWS_SESSION_TOKEN`, `AWS_REGION`, `BEDROCK_MODEL` |
| Local / Ollama / llama.cpp / AirNES | `LOCAL_BASE_URL` ou `LLAMA_BASE_URL` | `LOCAL_API_KEY`/`LLAMA_API_KEY`, `LOCAL_MODEL`/`LLAMA_MODEL` |

Exemple OpenAI :

```bash
export OPENAI_API_KEY='sk-...'
```

Exemple Ollama :

```bash
export LOCAL_BASE_URL='http://127.0.0.1:11434/v1'
export LOCAL_MODEL='qwen2.5-coder'
```

Exemple AirNES :

```bash
export LLAMA_BASE_URL='http://127.0.0.1:8888'
export LLAMA_API_KEY='llama-cpp'
export LLAMA_MODEL='Qwen3.6-35B-A3B-UD-IQ4_XS'
```

AiHarness ajoute automatiquement `/v1` à l’URL locale côté serveur si nécessaire.

## Utiliser le CLI

### Démarrage

Après l’installation globale décrite plus haut, la commande normale est :

```bash
ai-harness
```

Pour travailler directement depuis les sources, sans lien global :

```bash
npm run dev:cli
```

Après `npm run build`, il reste également possible d’appeler directement le fichier compilé :

```bash
node packages/cli/dist/index.js
```

Le provider actif au démarrage est `mock`. Sélectionnez un provider configuré avant une conversation réelle :

```text
/provider
/provider openai
/model
/model gpt-4o
```

Saisissez ensuite un message et validez avec Entrée. La réponse est affichée progressivement.

### Options de lancement

| Option | Effet |
|---|---|
| `--fullscreen` | demande l’interface plein écran si le terminal la prend en charge |
| `--regular` ou `--no-fullscreen` | force l’interface terminal classique |
| `--no-session` | conserve la conversation uniquement en mémoire |
| `--theme dark` / `--theme light` | sélectionne un thème intégré |
| `--theme <fichier.json>` | charge un thème personnalisé |
| `--extension <fichier-ou-dossier>` | charge une extension JavaScript explicite ; option répétable |
| `--rpc` | active le protocole JSONL sur stdin/stdout au lieu du mode interactif |

Exemple :

```bash
ai-harness --regular --theme light
```

La variable `AI_HARNESS_TUI_MODE=regular|fullscreen` permet aussi de définir le mode. L’option en ligne de commande reste prioritaire.

### Raccourcis et saisie

| Action | Raccourci/commande |
|---|---|
| Envoyer la saisie | `Entrée` |
| Compléter une commande, un skill ou un prompt | `Tab` |
| Parcourir l’historique de saisie | `↑` / `↓` |
| Interrompre une réponse en cours | `Ctrl+C` |
| Quitter lorsqu’aucune opération n’est active | `Ctrl+C`, `Ctrl+D` ou `/quit` |
| Ouvrir `$VISUAL` ou `$EDITOR` | `Ctrl+G` |
| Rafraîchir l’écran | `Ctrl+L` |
| Faire défiler le transcript en plein écran | `Alt+↑` / `Alt+↓` |

Pour une saisie multi-lignes dans le terminal classique :

```text
/edit
première ligne
seconde ligne
/send
```

Utilisez `/cancel` pour abandonner la saisie multi-lignes.

### Commandes de conversation et de session

| Commande | Description |
|---|---|
| `/help` | affiche l’aide intégrée |
| `/new [titre]` | crée et active une conversation |
| `/list [recherche]` | liste ou filtre les conversations |
| `/switch <id-ou-numéro>` | active une conversation |
| `/name <titre>` ou `/rename <titre>` | renomme la conversation active |
| `/delete <id>` | supprime une conversation |
| `/clear` | efface les messages de la conversation courante |
| `/session [-a|--all]` | affiche les statistiques et l’estimation de tokens |
| `/search <texte>` | recherche dans le transcript affiché |
| `/copy` | copie la dernière réponse dans le presse-papiers |
| `/quit` ou `/exit` | quitte AiHarness |

### Provider, modèle et raisonnement

| Commande | Description |
|---|---|
| `/provider` | affiche les providers disponibles et leur état |
| `/provider <nom>` | sélectionne `openai`, `anthropic`, `google`, `local`, `azure`, `vertex`, `bedrock` ou `mock` si disponible |
| `/model` | affiche le modèle courant et le catalogue du provider |
| `/model <nom>` | choisit un modèle |
| `/model cycle` | passe au modèle suivant |
| `/thinking [off|low|medium|high|xhigh]` | affiche ou change le niveau de raisonnement |
| `/login <provider>` | lance un flux OAuth Device configuré |
| `/config` | affiche l’emplacement des sessions |

Le support réel d’un niveau de raisonnement dépend du provider et du modèle.

Pour `/login openai`, par exemple, définissez :

```bash
export AI_HARNESS_OAUTH_OPENAI_DEVICE_URL='https://.../device'
export AI_HARNESS_OAUTH_OPENAI_TOKEN_URL='https://.../token'
export AI_HARNESS_OAUTH_OPENAI_CLIENT_ID='...'
export AI_HARNESS_OAUTH_OPENAI_SCOPE='...' # facultatif
```

Le préfixe suit la forme `AI_HARNESS_OAUTH_<PROVIDER>_*`.

### Branches et contexte

| Commande | Description |
|---|---|
| `/compact [instructions]` | résume une conversation suffisamment longue avec le provider actif |
| `/summarize-branch [session-id] [instructions]` | enregistre un résumé sans supprimer les messages |
| `/fork <session-id> [index-message] [titre]` | crée une branche à partir d’un message |
| `/clone <session-id> [titre]` | copie toute une conversation |
| `/tree [branch-id]` | affiche l’arbre et les résumés de branches |

La compaction nécessite un provider configuré et au moins trois messages.

### Import, export et partage

```text
/export json [chemin]
/export markdown [chemin]
/export jsonl [chemin]
/export html [chemin]
/import <fichier.jsonl>
/share [durée-en-heures]
/bug [description]
```

Sans chemin, les exports sont créés dans `~/.ai-harness/exports/`. La commande `/import` accepte un JSON contenant un tableau de sessions ou un JSONL contenant un message par ligne.

`/share` nécessite le serveur AiHarness. Par défaut, le CLI l’appelle sur `http://127.0.0.1:3080`. Les variables utiles sont :

```bash
export AI_HARNESS_SERVER_URL='http://127.0.0.1:3080'
export AI_HARNESS_AUTH_TOKEN='...'       # si le serveur est protégé
export AI_HARNESS_ISSUES_URL='https://github.com/Fidigi/AiHarness/issues/new'
```

Les liens de partage expirent après 24 heures par défaut ; la durée acceptée est limitée à 1–168 heures et les liens sont perdus au redémarrage du serveur.

### Skills et prompts

Le CLI découvre les skills `SKILL.md` dans :

- `~/.agents/skills/` et `~/.ai-harness/skills/` ;
- `<projet>/.agents/skills/` et `<projet>/.ai-harness/skills/`.

Exemple `~/.ai-harness/skills/relecture/SKILL.md` :

```markdown
---
name: relecture
description: Relire et corriger un texte
disable-model-invocation: false
---

Corrige l’orthographe, la grammaire et explique brièvement les changements.
```

Commandes :

```text
/skills
/skill:relecture Texte à relire
```

Les prompts Markdown sont recherchés dans `~/.ai-harness/prompts/`, `<projet>/.ai-harness/prompts/` et `<projet>/prompts/`.

```markdown
---
name: review
description: Revue de code
---

Relis $1 avec le contexte suivant : $@
```

Après `/reload`, utilisez `/prompts` puis `/review fichier.ts contraintes supplémentaires`. Les paramètres pris en charge sont `$1`, `$2`, `$@`, `${1:-valeur}` et `${@:-valeur}`.

### Extensions et confiance du projet

Les extensions utilisateur sont chargées depuis `~/.ai-harness/extensions/`. Les extensions de `<projet>/.ai-harness/extensions/` sont bloquées tant que le projet n’est pas approuvé :

```text
/trust status
/trust add
/reload
/extensions
/tools
/tool nom {"parametre":"valeur"}
```

Pour révoquer l’autorisation : `/trust remove`, puis `/reload`. Une extension peut enregistrer des commandes, outils, providers, hooks de cycle de vie et panneaux texte pour le mode plein écran. Elle s’exécute avec les mêmes droits que le CLI : n’approuvez que du code vérifié. Voir [extensions.md](extensions.md) pour développer une extension.

### Thème et raccourcis personnalisés

Un thème personnalisé est un fichier JSON :

```json
{
  "name": "mon-theme",
  "mode": "dark",
  "colors": {
    "accent": "#22d3ee",
    "user": "#4ade80",
    "assistant": "#f8fafc",
    "warning": "#facc15",
    "error": "#f87171",
    "muted": "#94a3b8"
  }
}
```

Chargez-le avec `--theme ./mon-theme.json`. Sans option, `AI_HARNESS_THEME=dark|light|auto` et `COLORFGBG` participent à la détection.

Un fichier de raccourcis peut réaffecter les actions `app.help` et `terminal.clear` :

```json
[
  { "id": "aide", "keys": ["ctrl", "h"], "action": "app.help" },
  { "id": "effacer", "keys": ["ctrl", "k"], "action": "terminal.clear" }
]
```

```bash
export AI_HARNESS_KEYBINDINGS="$HOME/.ai-harness/keybindings.json"
```

### Mode RPC

Le mode RPC lit une requête JSON par ligne sur stdin et écrit réponses et événements sur stdout :

```bash
ai-harness --rpc
```

Méthodes disponibles :

- `system.ping` ;
- `session.list`, `session.create`, `session.get`, `session.delete` ;
- `provider.list` ;
- `chat.send`.

Exemple :

```json
{"id":1,"method":"session.create","params":{"title":"RPC"}}
{"id":2,"method":"provider.list"}
{"id":3,"method":"chat.send","params":{"sessionId":"<id-retourné>","provider":"mock","content":"Bonjour"}}
```

`chat.send` émet des événements `text_delta` et `message_end` avant sa réponse finale. `AI_HARNESS_SESSIONS_DIR` permet de choisir le dossier de sessions propre au mode RPC.

## Utiliser l’interface Web

En utilisation normale, `ai-harness-web` sert l’interface React, l’API, le streaming SSE et les WebSockets depuis un seul processus et un seul port.

### Démarrage

```bash
ai-harness-web
```

Le serveur écoute uniquement sur `127.0.0.1:3080` par défaut et ouvre le navigateur automatiquement.

Options disponibles :

| Option ou variable | Fonction | Défaut |
|---|---|---|
| `--help`, `-h` | affiche l’aide sans démarrer | — |
| `--port <port>`, `-p <port>` | choisit le port HTTP | `3080` |
| `--hostname <hôte>`, `-H <hôte>` | choisit l’adresse d’écoute | `127.0.0.1` |
| `--no-open` | empêche l’ouverture du navigateur | navigateur ouvert |
| `AI_HARNESS_WEB_PORT` | port, avec alias `WEB_PORT` et `PORT` | `3080` |
| `AI_HARNESS_WEB_HOSTNAME` | adresse, avec alias `WEB_HOSTNAME` | `127.0.0.1` |
| `AI_HARNESS_WEB_NO_OPEN=1` | empêche l’ouverture du navigateur | non défini |

Exemples :

```bash
ai-harness-web --help
ai-harness-web -p 8080 -H 0.0.0.0 --no-open
```

### Lancement depuis les sources

Sans installation globale, lancez depuis la racine du dépôt :

```bash
npm run web
```

Pour le développement avec rechargement automatique du serveur :

```bash
npm run dev:web
```

Dans ces deux modes de développement, l’API écoute en interne sur `127.0.0.1:3099` et Vite relaie `/api` et les WebSockets depuis le port 3080.

Pour découvrir l’interface sans clé :

1. cliquez sur **+** pour créer une conversation ;
2. conservez le provider **Mock** dans **Settings** ;
3. envoyez `Hello` dans le chat.

### Configurer le Web

La page **Settings** permet de :

- sélectionner le provider actif ;
- enregistrer une clé auprès du serveur ;
- choisir le transport **SSE** ou **WebSocket** ;
- basculer entre thème clair et sombre ;
- saisir le Bearer token du serveur pour l’onglet courant.

Pour un provider local, Azure, Vertex ou Bedrock, préférez les variables d’environnement du serveur, car elles portent aussi l’URL, le projet, la région ou le modèle nécessaires.

Le token d’authentification Web est conservé dans `sessionStorage` : il est isolé par onglet. Le choix SSE/WebSocket est conservé dans `localStorage`.

### Langue de l’interface

L’interface est fournie en anglais et en français. Lors de la première visite,
AiHarness sélectionne la première langue compatible déclarée par le navigateur,
puis revient à l’anglais si nécessaire. Le sélecteur 🌐 dans l’en-tête de la
barre latérale permet de changer de langue immédiatement. Ce choix est conservé
dans `localStorage` sous la clé `ai-harness-locale`.

Pour ajouter un paquet de traduction ou modifier un texte d’interface, consultez
le [guide d’internationalisation](i18n.md).

### Utilisation quotidienne

- **+** crée une session persistante ;
- la barre latérale sélectionne une session existante ;
- **Settings** configure provider, authentification, transport et apparence ;
- le sélecteur **🌐** choisit la langue de l’interface ;
- **Send** envoie le message ;
- le message assistant est mis à jour en place pendant le streaming.

Les sessions sont chargées depuis le serveur au démarrage. Plusieurs onglets voient le même stockage serveur après rechargement, mais gardent chacun leur token d’authentification.

### Exécution après build sans lien global

Après `npm run build`, le même lanceur reste accessible directement :

```bash
node packages/server/dist/web-cli.js --no-open
```

Le bundle `packages/web/dist/` est servi automatiquement avec l’API. Aucun second serveur HTTP n’est nécessaire. En production publique, placez néanmoins `ai-harness-web` derrière un reverse proxy HTTPS.

## Sessions et fichiers

Par défaut, le CLI et le serveur utilisent :

| Donnée | Emplacement |
|---|---|
| Sessions JSONL | `~/.ai-harness/sessions/<id>.jsonl` |
| Exports CLI | `~/.ai-harness/exports/` |
| Credentials Web chiffrés | `~/.ai-harness/credentials.enc` |
| Confiance des projets | `~/.ai-harness/trust.json` |
| Extensions utilisateur | `~/.ai-harness/extensions/` |
| Skills utilisateur | `~/.ai-harness/skills/` |
| Prompts utilisateur | `~/.ai-harness/prompts/` |

Le CLI et le Web partagent leurs sessions lorsqu’ils s’exécutent avec le même utilisateur et le même répertoire personnel. Sauvegardez `~/.ai-harness/` pour conserver les conversations.

Le mode CLI `--no-session` désactive lectures et écritures. Pour un conteneur, montez un volume privé sur le dossier `.ai-harness` de l’utilisateur effectif ; voir [containerization.md](containerization.md).

## Sécurité

### Protéger l’API Web

Définissez un token utilisateur avant de démarrer le serveur :

```bash
export AI_HARNESS_AUTH_TOKEN="$(openssl rand -hex 32)"
```

Toutes les routes `/api` demanderont alors `Authorization: Bearer <token>`. Saisissez ce token dans **Settings → Authentification serveur**.

Un token administrateur séparé peut protéger les changements de credentials :

```bash
export AI_HARNESS_AUTH_TOKEN='token-utilisateur'
export AI_HARNESS_ADMIN_TOKEN='token-administrateur'
```

Le token utilisateur permet le chat et les sessions ; seul le token administrateur peut modifier `/api/config`. Pour enregistrer les clés Web chiffrées entre les redémarrages :

```bash
export AI_HARNESS_MASTER_KEY="$(openssl rand -hex 32)"
```

Sans `AI_HARNESS_MASTER_KEY`, les clés envoyées depuis Settings restent seulement en mémoire jusqu’au redémarrage. Les clés fournies directement par variables d’environnement restent la méthode recommandée en production.

Pour les liens `/share`, configurez l’URL publique correcte :

```bash
export AI_HARNESS_PUBLIC_URL='https://ai.example.com'
```

### Écoute réseau

Le serveur écoute uniquement `127.0.0.1` par défaut. Pour une écoute réseau explicite :

```bash
ai-harness-web --hostname 0.0.0.0 --port 3080 --no-open
```

Placez-le derrière un reverse proxy HTTPS et activez les tokens avant d’utiliser `0.0.0.0`.

## Dépannage

### Le Web affiche une erreur HTTP ou ne crée pas de session

- vérifiez que `ai-harness-web` tourne sur le port choisi ;
- ouvrez `http://127.0.0.1:3080/health` avec les valeurs par défaut ;
- depuis les sources, utilisez `npm run web` afin de démarrer ensemble l’API et Vite ;
- si l’API est protégée, appliquez le bon token dans Settings.

### « Provider not configured »

- exportez les variables avant de démarrer le processus ;
- redémarrez le CLI ou le serveur après leur modification ;
- dans le CLI, exécutez `/provider` puis `/provider <nom>` ;
- dans le Web, vérifiez le provider actif dans Settings.

### Le provider local ne répond pas

```bash
curl http://127.0.0.1:11434/v1/models
```

Adaptez `LOCAL_BASE_URL`, vérifiez le nom `LOCAL_MODEL` et assurez-vous que le modèle est chargé. Dans un conteneur, `localhost` désigne le conteneur lui-même : utilisez le nom DNS du service ou `host.docker.internal` selon l’environnement.

### Le plein écran ne fonctionne pas

Utilisez :

```bash
npm run dev --workspace @ai-harness/cli -- --regular
```

Le CLI revient automatiquement au mode classique lorsque stdin/stdout ne sont pas des TTY compatibles.

### Le presse-papiers est indisponible

Sous Linux, installez `wl-copy`, `xclip` ou `xsel`. Le CLI tente sinon OSC 52, puis affiche le contenu si aucune méthode n’est disponible.

### Réinitialiser une configuration locale

Arrêtez AiHarness et sauvegardez avant suppression :

```bash
mv ~/.ai-harness ~/.ai-harness.backup
```

Un nouveau dossier sera créé au prochain démarrage.
