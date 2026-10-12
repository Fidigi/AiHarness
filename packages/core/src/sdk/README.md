# AiHarness session SDK / SDK de session AiHarness

## English — user guide

The supported import is the root-built `@ai-harness/core` public entry. This is Core API major **1**, not upstream SDK compatibility.
Package release, Core major and JSONL schema (v2) are separate versions.

```ts
import { createAgentSession, JsonlSessionStore } from '@ai-harness/core';

const session = await createAgentSession({
  cwd: '/absolute/workspace',
  provider: { kind: 'config', config: { type: 'mock', model: 'mock-model' } },
  // Omit store for genuine process-local history; no disk store is constructed.
  // store: new JsonlSessionStore('/independent/private/sessions'),
  // Host decision, not a project file or implicit approval. Defaults to deny.
  isProjectTrusted: async canonicalCwd => canonicalCwd === '/absolute/workspace',
  runDefaults: { maxRetries: 2, steeringMode: 'all', followUpMode: 'all' },
});
const unsubscribe = session.subscribe(event => console.log(event.type, event.sequence));
try {
  const result = await session.promptAndWait('Explain this task.');
  if (result.phase === 'failed') throw new Error(result.error);
  console.log(session.messages().at(-1)?.content);
} finally {
  unsubscribe();
  await session.dispose();
}
```

Do not copy the example's trust callback into an untrusted multi-workspace host.
Compose Core `WorkspaceManager`/`ProjectTrustManager` or your independently owned
approval policy. The SDK canonicalizes `cwd` within `allowedRoots` (default: cwd)
and rechecks the injected decision before each run and explicit resource load.
A saved refusal must remain a refusal; the SDK never grants or persists trust.

### Factory options

- **cwd / allowedRoots**: existing directory and canonical path boundary. No Git,
  shell or instruction discovery occurs at construction.
- **provider**: `{kind:'config', config}` accepts only named Core built-ins
  (OpenAI, Anthropic, Google, Azure, Vertex, Bedrock, local, mock). Construction
  is deferred until an explicit prompt. Network/transport/proxy/deadline/retry
  fields pass unchanged to Core. `{kind:'instance', name, provider}` borrows an
  `AiProvider`; custom adapters must use Core's network policy and honor abort
  and awaited stream callbacks. There is no global dynamic-factory fallback.
- **auth**: optional borrowed `CredentialRedactor` and explicit `secrets`. API
  keys, configured headers/proxy/cloud keys and sensitive ambient environment
  values join the Core redactor before creation/loading. Register other secrets
  for caller instances/config extras yourself. Auth/model aliases use existing
  versioned Core types; they do not implement login, refresh or credential
  resolution. Use the existing Core credential service explicitly in your host.
  Built-in cloud adapters can use ambient credentials at prompt time; none are
  resolved, no commands run and no encrypted store opens at SDK factory time.
- **store**: borrowed `SessionStore`, or omitted for true in-memory operation.
  `JsonlSessionStore` satisfies this structural interface. A custom implementation
  supplies the same six existing manager operations, not a new storage format.
- **session**: `{kind:'new',options}` accepts existing `CreateSessionOptions`
  except cwd; `{kind:'resume',id}` requires a store, loads/redacts/rewrites through
  Core and refuses a different canonical workspace. No latest/prefix/path picker.
- **extensionRegistry**: optional borrowed already-configured registry. No
  extensions, packages, tools, MCP or executable modules are loaded implicitly.
  Tool execution, hooks, queues, interactions and accounting stay in Core.
- **resourceLoader**: optional borrowed loader, invoked only by explicit
  `reloadResources`, `expandPrompt` or `invokeSkill`. Constructor/reads do not
  discover anything. The provided `createAgentResourceLoader` delegates bounded
  Markdown discovery and trust gates to `ResourceManager`; host loaders are
  trusted host code responsible for equivalent policy. Expansion returns text;
  call `prompt(text)` yourself. It never registers skills as model tools.
- **runDefaults**: existing typed runtime prompt options. Factory-bound provider,
  session, cwd and settings-persistence flags cannot be overridden per prompt.
  Session model/thinking/tool-preset settings supply subsequent requests. Core's
  session thinking precedence is retained; use `setThinking` while idle rather
  than expecting a per-prompt override to bypass a saved session value. Explicit
  literal system prompts are ephemeral; no AGENTS/settings/system files are read.
- **onUsage**: existing Core usage callback, including nested tool accounting.
  Arguments are detached/redacted; mutating them cannot alter durable tokens.
  Only the returned cost affects accounting. Supply prices only when authoritative;
  the SDK invents no costs/model limits.
- **compaction**: existing manager settings, optional summary callback and policy.
  Automatic compaction follows Core's existing thresholds. Callback output is
  applied only if the signal is still live. A callback may call a model, but the
  SDK does not create a separate provider summarization loop or retry policy.
  Policy/summary inputs and summary results are detached/redacted; the cancellation
  signal remains live. Value options and borrowed identities are captured before
  factory initialization, and mutable method arguments at call admission.

### Session lifecycle

`prompt` starts a detached Core run; `promptAndWait` returns its exact settled
snapshot. Provider/tool errors after startup return a `failed` snapshot, while
startup/trust/storage failures can reject. `stop` acknowledges abort; **await
`wait`** before assuming interrupted usage/results are durable. Calling `wait`
does not block a later `stop`. History/settings mutations and a second prompt
are refused until settlement. `dispose` stops and waits, detaches listeners and
is idempotent. A non-cooperative host callback/store can still delay settlement;
the SDK does not add an unsafe fake terminal state or custom timeout loop.

Active runs support `steer`, `followUp`, `clearQueue` and
`respondToInteraction` using existing bounded Core contracts. `subscribe` and
`events(after)` expose Core's version-1 sequenced journal with **unknown** data
payloads; observer exceptions/rejected Promises cannot disrupt persistence.
Replay is bounded and its `reset` flag requires snapshot reconciliation. There
is no invented event union/data schema. Automatic/manual compaction lifecycle
is forwarded into the same journal; rename/branch/copy do not synthesize new
runtime events. Poll detached `snapshot`/`state` after those operations.

`snapshot`, `messages`, `effectiveContext`, `history`, `events` and
`exportSession` return detached, redacted data. Active messages differ from the
raw journal, which retains abandoned/pre-compaction entries. `exportSession`
uses existing `serializeSession`; use `deserializeSession` for runtime Date
hydration before creating a new session with its Date-based options. These
conversions are not validators of arbitrary untrusted imported JSON.

`rename`, `setModel`, `setThinking`, `branchBefore(userEntryId)` and
`applyCompaction(summary, firstKeptMessageId, details)` await Core persistence.
`compactionTarget()` uses Core selection. Manual compaction requires a caller
summary and valid active message boundary; it never invokes a model implicitly.
`fork(userEntryId,{before?,title?})` returns a related handle copied from durable
user-entry ancestry, including an empty prefix. `clone(title?)` returns an
independent-root handle with remapped active message/command IDs. Both operate
only while idle; unsupported labels/full custom-entry remapping/summary hooks
are not claimed. Related handles share one runtime/manager/provider group.

### Ownership, persistence and limitations

Inspect frozen `capabilities` and `ownership`. The SDK owns its manager, runtime,
bounded journal and (for built-in configs) isolated provider network scope.
Stores, instances, supplied registries and loaders remain caller-owned. Dispose
never deletes stored sessions, closes a caller store/provider, unloads a borrowed
registry or closes global network dispatchers. Dispose **every** fork/clone
handle: the last handle closes only its group's owned transports and registry.
Drop disposed handles when no longer needed; Core has no public runtime disposal
method that removes retained run snapshots. In-memory history is not durable.

Custom stores must validate IDs/data, return Date-based active projections,
preserve raw v2 parent graphs across save/compaction/branch/resume, honor atomic
`requireAbsent`, await their durability guarantee, and implement stable bounded
redaction/locking appropriate to their backend. The SDK delegates domain
operations to `SessionManager`; it does not implement a database/JSONL algorithm.
The bridge detaches/redacts passed/returned data and supplies Core redaction
callbacks to the store. Store redaction-initialization errors are scrubbed before
factory rejection, even though that initialization precedes session creation. Share one redactor when sharing a store/provider across
independent SDK groups so late-discovered historical credentials remain covered.

Not delivered by this facade: executable/module loading, MCP connection hosting,
OAuth/login/discovery, settings/instruction auto-loading, provider switching,
publications, HTML export, direct-shell methods, cross-process run coordination,
full custom-entry cloning, or a new persistence schema. Existing primitive
capabilities do not become facade methods merely because their names are similar.

## English — contributor notes

Keep the SDK an additive composition layer. Do not duplicate the agent loop,
provider-turn retry/backpressure, persistence/branch projection, credential
redactor, workspace/trust gate, or resource parser. `SessionStoreAdapter` bridges
Core's nominal `JsonlSessionStore` constructor requirement; it overrides only the
six public store methods that the manager actually consumes. New domain behavior
belongs to the owning Core subsystem, not SDK shortcuts.

Validation is Docker-only, isolated image `ai-harness:sdk-public-review`, targeted SDK
Vitest with `--maxWorkers=1`. Build Core first. `public-consumer.test.ts` copies
emitted Core into an external temporary installation, imports only
`@ai-harness/core` in a real Node process, and compiles positive/negative calls
against emitted declarations with real NodeNext package resolution. The public
review also exercises persisted fresh trust, queued arguments, accounting/policy
copies, store redaction, borrowed ownership, nested progress and durable stop.

## Français — guide utilisateur

L'import public est l'entrée racine compilée de `@ai-harness/core`. Le contrat est **Core API 1**, indépendant de la version du paquet
et du journal JSONL v2 ; aucune compatibilité directe avec le SDK amont n'est
promise. L'exemple anglais ci-dessus utilise le fournisseur mock, sans réseau.

`createAgentSession` exige `cwd` et un fournisseur : configuration Core intégrée
créée paresseusement au premier prompt, ou instance `AiProvider` prêtée par
l'appelant. Les champs réseau/proxy/délais/retry restent ceux de Core. `allowedRoots`
limite les chemins canoniques. Sans `isProjectTrusted`, toute exécution est
refusée. Cette décision est relue avant chaque prompt/chargement explicite ; le
SDK n'accorde ni n'enregistre la confiance. Utilisez la politique de confiance de
votre hôte, pas une approbation automatique d'un projet inconnu.

Sans `store`, l'historique reste réellement en mémoire, sans construction de
stockage disque. Un `SessionStore` fourni est prêté ; `JsonlSessionStore` peut être
utilisé directement. `session:{kind:'resume',id}` exige ce stockage et refuse un
autre workspace. Les options de nouvelle session reprennent `CreateSessionOptions`
(sauf cwd). `auth` prête un redactor et enregistre les secrets supplémentaires ;
les alias d'authentification/modèle réutilisent les types Core. Aucun login,
rafraîchissement OAuth, commande de credentials ou accès au magasin chiffré
n'est déclenché par la fabrique. Les adaptateurs cloud peuvent utiliser leurs
credentials ambiants uniquement lors du prompt explicite.

`runDefaults`, `onUsage` et `compaction` composent les contrats existants du
runtime/gestionnaire. Les arguments des callbacks et résultats de résumé sont
copiés/expurgés ; seul le coût retourné par `onUsage` modifie la comptabilité.
Le signal d'annulation reste vivant. Les options sont capturées avant
l'initialisation et les arguments mutables des méthodes lors de leur appel. Aucun coût, limite de modèle ou retry de résumé n'est
inventé. La priorité Core du thinking enregistré est conservée : utilisez
`setThinking` au repos. Les prompts système littéraux sont éphémères ; aucun
fichier AGENTS/settings/system n'est découvert automatiquement.

`prompt` démarre le run détaché, `promptAndWait` attend exactement ce run.
`stop` accuse réception de l'annulation : **attendez `wait()`** avant de considérer
les résultats/consommations interrompus comme durables. `wait()` n'empêche pas un
`stop()` ultérieur. Les mutations d'historique/options et un second prompt sont
refusés jusqu'au règlement durable. Les erreurs d'exécution donnent un snapshot
`failed` ; les erreurs de démarrage/confiance/stockage peuvent rejeter l'appel.
`steer`, `followUp`, `clearQueue` et `respondToInteraction` reprennent Core.

`subscribe` et `events(after)` exposent le journal séquencé Core v1, données
`unknown`, replay borné et indicateur `reset`. Une erreur d'observateur ne casse
pas le run. Les événements de compaction rejoignent ce journal ; rename/branche/
copie ne créent pas d'événements inventés. Les lectures retournent des copies
expurgées : messages actifs, contexte effectif, journal brut conservant les
branches abandonnées et l'historique pré-compaction. `exportSession` utilise la
conversion ISO Core ; `deserializeSession` hydrate les dates sans valider un JSON
arbitraire non fiable.

`rename`, `setModel`, `setThinking`, `branchBefore` et `applyCompaction` attendent
la persistance Core. La compaction manuelle exige un résumé fourni et une borne
active valide : aucun appel modèle implicite. `compactionTarget` réutilise Core.
`fork` copie l'ascendance d'une entrée utilisateur durable, éventuellement avant
cette entrée ; `clone` crée une racine indépendante et remappe les IDs actifs.
Ces méthodes exigent une session au repos et retournent des handles partageant
le groupe runtime/gestionnaire/fournisseur.

`resourceLoader` et `extensionRegistry` sont prêtés. La fabrique/les lectures ne
chargent aucun module, package, outil ou MCP. `createAgentResourceLoader` compose
la découverte Markdown bornée et protégée de Core. `reloadResources`,
`expandPrompt` et `invokeSkill` sont explicites, avec confiance fraîche. Les
expansions retournent du texte à envoyer vous-même ; les skills ne deviennent
pas automatiquement des outils. Un loader personnalisé est du code hôte fiable,
responsable de ses propres limites et protections.

`capabilities` et `ownership` décrivent les limites réelles. `dispose` est
idempotent, annule/attend et détache les abonnements ; il ne supprime aucune
session ni ne ferme le stockage/fournisseur de l'appelant ou le réseau global.
Disposez aussi chaque fork/clone : seul le dernier handle ferme les transports
possédés du groupe. Abandonnez les handles disposés pour permettre leur collecte.
Un callback/stockage non coopératif peut retarder le règlement ; aucun état
terminal artificiel ni nouveau timeout de boucle n'est ajouté.

Limites explicites : pas de chargement exécutable/MCP, login OAuth, découverte de
modèles, auto-chargement de settings/instructions, changement de fournisseur,
export HTML/shell direct, coordination de runs entre processus, clonage complet
d'entrées personnalisées ou nouveau format de persistance.

## Français — notes contributeur

Conservez une couche de composition additive. Ne dupliquez ni boucle agent,
retry/backpressure du provider-turn, projections/persistance/branches, redactor,
confiance/chemins ou parseur de ressources. L'adaptateur de stockage relie les six
méthodes publiques réellement utilisées par `SessionManager` à son type nominal
existant ; il n'implémente pas de moteur de stockage.

Un stockage personnalisé doit valider ses entrées/IDs, restituer des dates Core,
conserver le journal brut v2 et les parents, garantir `requireAbsent` atomiquement,
attendre la durabilité promise et appliquer les limites/verrous/expurgations de
son backend. Partagez un redactor pour un stockage/fournisseur partagé entre
plusieurs groupes. Les validations se font uniquement dans Docker, image isolée
`ai-harness:sdk-public-review`, tests SDK ciblés avec `--maxWorkers=1`, après build Core.
La preuve publique copie Core compilé dans une installation temporaire externe,
importe son entrée publique dans un vrai processus Node et compile les appels
valides/invalides contre les déclarations émises. La revue publique vérifie aussi
la confiance persistée fraîche, les copies/expurgations, la propriété des
ressources, la progression imbriquée et l'arrêt durable.
