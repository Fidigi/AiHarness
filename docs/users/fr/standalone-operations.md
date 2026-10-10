# Authentification et export autonomes

Ces commandes quittent avant le démarrage de l’agent, des providers, des extensions et du terminal. `ai-harness --help` ajoute les accès à `auth --help` et `export --help` ; les actions et aides package/MCP existantes restent inchangées.

### Identifiants provider

```sh
ai-harness auth --help
ai-harness auth list --json
ai-harness auth login openai --timeout 120
ai-harness auth logout openai
```

`auth list` décrit les identifiants enregistrés et la présence d’une configuration opérateur de flux device. Aucun token/clé n’est révélé ; aucune commande d’identifiants, actualisation de token ou connexion provider n’est exécutée. Ce n’est pas une liste des identifiants effectifs issus de l’environnement ou de commandes. `--json` est réservé à `list`.

La connexion réutilise le flux device HTTPS configuré par l’opérateur : pour l’identifiant provider en minuscules, définir `AI_HARNESS_OAUTH_<PROVIDER>_DEVICE_URL`, `_TOKEN_URL`, `_CLIENT_ID` et éventuellement `_SCOPE`. Aucun enregistrement provider prédéfini, ouverture automatique de navigateur, callback navigateur ou login PKCE n’est ajouté. `AI_HARNESS_MASTER_KEY` doit activer le stockage chiffré indépendant existant `credentials.enc` ; sans chiffrement durable, login/logout échouent avant tout accès réseau. La politique pré-confiance existante des dossiers de données s’applique : un dossier agent contrôlé par le projet ne fournit pas son propre magasin d’identifiants.

Les instructions d’autorisation et le code utilisateur vont sur stderr, jamais stdout. Un code modifié par le formatage terminal, l’encodage UTF-8 ou le masquage d’un secret connu est refusé avant instructions, polling ou publication des identifiants ; aucun caractère silencieusement altéré n’est demandé à l’opérateur. Codes device, tokens et URL complète/paramètres d’autorisation ne sont pas affichés. stdout contient uniquement un accusé fixe après la réussite du chiffrement. Ctrl+C/SIGTERM annule l’autorisation initiale, les corps des réponses et le polling. `--timeout` accepte un entier de 1 à 300 secondes (300 par défaut), également limité par la durée de vie du code device. Le délai global de connexion utilise une horloge monotone : un recul de l’horloge civile ne le prolonge pas. Transports, timers et listeners sont nettoyés. Une écriture durable Core déjà lancée n’est pas une transaction annulable : l’annulation ne promet pas le rollback d’un état chiffré déjà publié.

Logout supprime les identifiants provider enregistrés localement, pas les tokens côté émetteur ni les identifiants d’environnement/commande. Codes de sortie : 0 succès/aide, 2 syntaxe, 1 échec opérationnel, 124 délai, 130 annulation.

### Export de session

```sh
ai-harness export --help
ai-harness export --session identifiant-conversation --format html --output ./conversation.html --approve
ai-harness export --session ./sessions/conversation.jsonl --format jsonl --output ./conversation.jsonl --approve
```

`--session`, `--format` et `--output` sont obligatoires pour exporter. Choisir un ID exact, un préfixe d’ID non ambigu ou un fichier de session `.jsonl` existant. Aucun sélecteur ne crée une session. La recherche par ID inventorie uniquement noms/métadonnées, puis ouvre le seul corps sélectionné. Le magasin suit `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, puis `sessionDir` des paramètres approuvés, puis le dossier personnel existant. Le dossier de stockage existant choisi n’accorde qu’une autorité d’entrée. Un fichier sélectionné par chemin doit rester dans ce magasin ou le workspace courant ; une source locale au workspace ne nécessite pas l’existence du magasin par défaut. Liens et fichiers hors de ces racines d’entrée sont refusés.

La destination doit être explicite dans le workspace courant, avec le suffixe correspondant `.html`, `.jsonl`, `.json` ou `.md`. Une autorisation enregistrée effective ou `--approve` pour ce processus est nécessaire ; `--no-approve` refuse et les flags opposés sont incompatibles. L’autorité d’entrée du magasin n’élargit pas les destinations autorisées. Les fichiers ordinaires existants sont remplacés atomiquement en mode 0600 ; liens symboliques/durs et parents liés sont refusés. L’entrée ne peut pas être remplacée par la sortie.

[IMPORTANT] Les lectures du magasin Core peuvent appliquer des modes privés au dossier/fichier source. La normalisation de projection ne réécrit pas les octets source ; les permissions initiales non sûres ne sont pas conservées.

L’export réutilise l’exporteur slash et le writer stable Core existants. HTML est autonome et échappé ; JSON/Markdown conservent leurs projections. JSONL contient un message par ligne : ce n’est ni le journal v2 complet, ni une sauvegarde des branches abandonnées. JSON offre la projection active plus riche. La sérialisation commune retire les champs secrets de configuration provider ; le redactor commun copie/masque les identifiants connus d’environnement et du magasin provider chiffré. Ce n’est pas une détection automatique de tous les secrets arbitraires dans le texte.

stdout contient uniquement un accusé fixe, jamais transcription/titre/chemin. Un échec retourne 1 sans confirmation de succès ; un échec de publication ne garantit pas un disque inchangé. Vérifier la destination choisie. Aide/succès retourne 0 ; arguments mal formés, inconnus ou conflictuels retournent 2 avant démarrage.

Ce contrat ne fournit pas une connexion provider navigateur/PKCE, une interopérabilité provider générale, une sauvegarde complète des journaux ou des garanties de distribution multiplateforme.

## Documentation associée

- [Guide utilisateur](./user-guide.md)
- [Politique de commande des packages](./npm-command.md)
- [Version anglaise](../en/standalone-operations.md)
