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
  On `createAgentResourceLoader` / `ResourceManager`, `discoverSkills: false` and
  `discoverPrompts: false` skip automatic roots and supplied settings/package
  selectors, retaining explicit `skillPaths` / `promptPaths`. Both default true;
  legacy `disableSkills` / `disablePrompts` still disable all loading, including
  explicit paths. These host options never grant project trust. Absolute Markdown
  selectors under the configured cwd, agent directory or home preserve that
  known literal root, including legacy string paths. Scoped absolute selectors
  preserve their own declaring base as well; outside-base and nested patterns
  retain glob syntax. `resolveAgentResourcePaths` still returns unchanged strings in a
  mutable array; no filesystem probing guesses an arbitrary literal root.
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
  admitted only while the signal, session identity, active leaf and local policy
  remain eligible, including after inherited-policy, summary and manager-queue
  waits. Cancellation does not roll back persistence that has already started.
  A callback may call a model, but the SDK does not create a separate provider
  summarization loop or retry policy.
  Policy/summary inputs and summary results are detached/redacted; the cancellation
  signal remains live. Value options and borrowed identities are captured before
  factory initialization, and mutable method arguments at call admission.

Outside the facade, `SessionManager.setCompactionContextWindow(tokens?)` accepts
only positive safe integers or `undefined`; `getCompactionContextWindow()` reads
that manager-scoped, non-persisted host policy. With a limit, automatic compaction
requires `estimateContextTokens(id) > window - reserveTokens`; `keepRecentTokens`
still chooses the cut. Changing the admitted window withdraws unpublished stale
output at the existing policy/start/summary/queue boundaries. Clearing it retains
the legacy host trigger. Manual target selection is unchanged. The facade neither
infers this limit nor gains a setter.

Lower-level `SessionManager.applyCompaction(id, summary, firstKeptEntryId, details?,
{signal?,source?})` publishes an explicitly supplied summary without invoking a
registered generation callback, even when automatic compaction is disabled.
Optional own-data `SessionCompactionOptions` capture an authentic live abort signal.
Before external generation, `captureCompactionSource(id)` can capture a frozen,
manager-local `SessionCompactionSource` view (or null for a missing session), without
provider or store work. Its public fields are only `sourceSessionId` and optional
`entryId`. Pass that exact view as `source` to require the same own-data canonical
session ID, session/leaf, manager-owned journal/legacy context and captured store
generation at publication; substituted IDs/accessors are refused without execution;
store replacement followed by restoration still withdraws it. Copies, foreign
views and consumed views are refused. Title/settings changes alone do not revoke
caller-summary authority. Admission is checked after structural preparation,
immediately before the captured save; an admitted save finishes. This is not
cross-process CAS, host isolation, a serialized capability or a new facade/store
method. Hosts still own foreground admission and generation lifetimes. Legacy
four-slot invalid boundaries remain no-ops; with an exact captured source, an
invalid boundary rejects rather than permitting a false host completion event.

Optional root helpers `getCompactionModelMessages` and `prepareCompactionContext`
share Core's owned model view: prior summaries, public custom content (including
`display:false`) and completed command context, never private custom state/details.
Capture publication source and host bindings before preparation/callback exposure.
Preparation returns mutable owned Message arrays, a retained model-entry ID and
legacy context estimates; it does not generate, publish or renew source authority.
`selectCompactionCut` accepts an owned complete projection and aligned trusted
weights; assistant/tool units are indivisible and may exceed soft keep. Explicit
manual fallback keeps two whole units when default keep fits everything; no useful
prefix returns null. These are not full system/tool/media wire estimates, hooks,
usage accounting or overflow recovery. No new facade/store capability is required.
Native reload/copies/navigation retain custom/summary/command boundaries and remap
known projected command links, never IDs inside private payloads.

The passive root helper `resolveAgentCompactionContextWindow(provider?, model?)`
uses published limits, or a 128,000-token fallback for other non-mock providers;
mock/unspecified hosts retain legacy policy. CLI/RPC apply it after model changes.
The fallback is not authoritative vendor metadata; estimates omit system/tool
wire overhead and are not exact tokenization or overflow recovery.

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

The root `getSessionAccounting(entries, activeLeafId?)` helper accepts readonly
raw entries and returns independent `active`/`history` projections. For an idle
handle, pass `await session.history()` and `session.snapshot().activeLeafId`.
Active totals include pre-compaction ancestors; history includes abandoned
branches. Context size is separate. Persisted costs win; published calculations
require the entry's own provider/model, never today's selected model. Missing
measurements remain unknown/partial, and authenticated outer nested usage counts
once, not progress/details. `requests` counts accountable journal entries,
including unmeasured summaries, not individual nested network calls. Token sums
saturate at the safe-integer limit and mark partial; unrepresentable costs are
excluded from the known subtotal. Lower-level `addBranchSummary` and
`appendBranchSummary` optionally accept copied `BranchSummaryAccounting`
(provider/model/normalized usage); v2 legacy summaries remain readable/unpriced.
Those accounting parameters do not generate summaries or add a facade mutation.

Lower-level `SessionManager.navigateTree(sessionId, entryId, options?)` preserves
abandoned journal entries. Only explicit `summarize: true` authorizes the supplied
`BranchSummarizer`; `createProviderBranchSummarizer(provider, model?)` adapts an
already configured provider without tools/discovery. Generation runs outside the
mutation queue with bounded transcript/output budgets, then publishes only if the
source still matches. Results are `navigated`, `not-found`, `cancelled` or `stale`.
Cancellation withdraws an unpublished navigation, not an already admitted durable
write. Hosts must own foreground admission and cooperative callback cancellation.
The high-level facade does not expose this mutation.

Lower-level `onBeforeBranch` accepts ordered cancel-only `SessionBranchHook`
callbacks; the registry exposes `before:session:branch` with frozen primitive
source/operation/entry/position/external-source metadata and an owned signal.
`onBeforeBranchSummary` / `before:session:summary` run only for explicit summary
work, with frozen bounded model-visible transcript/IDs/budgets, never private
state/details. Undefined continues; false cancels; registry hooks also accept
own `{cancel:true,reason?}`. Summary hooks may instead return validated copied
`{summary,provider?,model?,usage?}`: last defined override wins, later veto cancels,
and fallback runs only without an override. Source/target transforms are refused.
Global hooks receive an owned generation signal; the legacy per-call summarizer
keeps the original caller signal capability. Registration/removal/unload/rebinding
withdraws unpublished work even for ignored callbacks; admitted writes finish.
Limits:128 Core hooks/kind,256 pending admissions; registry128 managers,256 leases
per manager and256 extension callbacks/kind. These are privileged host contracts,
not a sandbox, rollback guarantee or new facade/structural-store method.

`appendCustomEntry` persists bounded own JSON state outside model context;
`appendCustomMessage` contributes content even with `display: false`, but never
its `details`. These are persistence/context distinctions, not a secret vault or
extension sandbox. Effective context follows actual parents, active compaction
and destination summaries, and removes incomplete tool groups. Summary
`fromEntryId` is provenance only, never a context parent. A bounded own metadata
prefix retains legacy metadata-only compaction background on its original
ancestry through navigation, reload, later compaction and cloned anchors; it
cannot lend that background to a later independent root.

Lower-level `SessionManager.getActiveBranchEntries(sessionId)` returns an awaited,
owned parent-first journal path, including private state before compaction. Unlike
`getRawEntries`, it excludes abandoned branches; unlike effective model context,
it retains private custom data and details. It follows parent links, never summary
source provenance or timestamps, retains the last append projection per entry ID,
and refuses incomplete ancestry rather than returning a partial state. It serializes with manager mutations and refuses a host
store/leaf replacement during its read; this is not a cross-process CAS snapshot
or a new high-level facade method. Persisted data remains bounded by the store
contract. Extensions can reduce this path by their exact custom type; that name
is a convention, not ownership isolation or a secret-storage boundary.

Lower-level `JsonlSessionStore.getSessionSnapshot(id)` reads one stable bounded
native journal into an owned `{session,entries}` without rewriting that source.
Its entries are raw history, not an active extension-state view. The manager's
`forkSession(id,index?,title?,{sourceStore?,id?,cwd?,workspaceId?,signal?})` reuses its rich
copy engine for an explicit external store or an already loaded ID. Own primitive
destination options and store identity are captured before awaiting; accessors,
unknown keys and invalid values are refused. Explicit `workspaceId:undefined`
clears inherited workspace identity. Destination-store replacement withdraws an
unpublished copy; admitted durable writes are not rolled back. External sources
are not inserted into the destination manager; copies are written only through
its persistence store, not by persisting a fork through a distinct source store. CLI startup ID/prefix/file forks use this engine, preserving private,
custom, summary and compaction ancestry rather than copying projected messages
alone. Existing no-session startup precedence remains. These additive lower-level
APIs do not expand the SDK facade, API major1, schema2, retained-file bounds or the
1,024-extra-entry copy limit; cross-process CAS is not provided.

`await session.editContext({targetEntryId, replacement?})` is an idle-only,
handle-lifetime-owned mutation. Omit `replacement` to omit that active entry from
future model input, or supply text (including `''`) to replace its public content.
It appends a branch-relative `context_edit`; it never rewrites transcript/usage.
Inputs are detached, accessors/unknown fields refuse, text is bounded to 512 KiB,
and compacted/foreign targets refuse. Core repairs tool groups after edits.
Navigation, related forks and independent clones preserve/remap these entries.

Lower-level `SessionManager.appendContextEdit` accepts the same edit and an
optional `{signal}`. `recordSessionLoadout` / `getSessionLoadout` persist/rebuild
private final-request prompt/tool/model/thinking deltas, not executable authority.
Core provider turns record these automatically; compaction retains complete
private loadout/file-operation checkpoints. Trusted `history()` can contain
private instructions/schemas: it is not a browser/RPC share DTO. Native
`onBeforeCompaction` / extension `before:session:compaction` permit only final
`{summary}` replacement or veto; original cut/source/usage remain authoritative.
No Pi import, historical-tool registration or implicit summary generation is added.

`rename`, `setModel`, `setThinking`, `branchBefore(userEntryId)` and
`applyCompaction(summary, firstKeptMessageId, details)` await Core persistence.
`compactionTarget()` uses Core selection. Manual compaction requires a caller
summary and valid active model boundary (ordinary/custom/branch-summary/command);
it never invokes a model implicitly.
It remains available with automatic compaction disabled. The facade captures Core's
source lease before observational `compaction.started` dispatch; a start observer
cannot lend replacement-store authority to that pending publication. Title-only
updates remain valid. `dispose` withdraws this handle's unpublished explicit
compaction, including while structural preparation
waits, and waits an already-admitted save without false cancellation. Siblings and
borrowed resources retain their independent lifetimes.
`fork(userEntryId,{before?,title?})` returns a related handle copied from durable
user-entry ancestry, including an empty prefix. `clone(title?)` returns an
independent-root handle with remapped active message/command/custom/summary and
compaction ancestry, including private custom state and model-visible custom
content. External provenance and arbitrary IDs inside custom data are not
rewritten. Related forks preserve stable message/command/custom/summary IDs and
selected private/custom ancestry, including state outside compacted model context;
independent clones remap those internal IDs. Both use the same bounded Core copy
path (at most 1,024 additional custom/edit/loadout/summary/compaction entries) and refuse live
command ancestors. Durable-user forks can select pre-compaction journal history;
indexed forks still select the current message projection. Both operate only while
idle. They participate in ordered Core branch admission through an independent
borrowed registry lease; disposal aborts that handle's unpublished branch work
before waiting its serial tail. Publish the disposal promise before abort dispatch,
so synchronous reentry returns that promise without releasing live sibling leases.
An ignored hook cannot publish late or prevent
this retirement; an already-admitted durable copy finishes and its child handle
remains live. Last-handle/factory-error cleanup releases only the SDK's lease,
not another host's lifecycle or summary binding. Labels, arbitrary payload-ID
rewriting and cross-process coordination remain separate. Related handles share
one runtime/manager/provider group.

### Native extension and Pi adaptation

This SDK uses the [native host/import/event/result/UI/package map](../../../../docs/ai/topics/native-extension-contract.md), not Pi signatures or automatic configured persistence. Supply `extensionRegistry` explicitly; its shared-loop hooks include `before:message` (text only), `before:tool:result` (public top-level result only), `before:turn:end` and `before:agent:settle` (bounded custom continuation). Context transformation remains `before:provider`; private state uses the selected manager ancestry. Unknown foreign event names and retired registration APIs refuse.

```ts
await session.promptAndWait('Scheduled review context', {
  trigger: { kind: 'custom', type: 'automation:review' },
});
```

Default prompts are user-triggered. Explicit custom starts accept text only and append native model-visible `custom_message`, not a fabricated user message. A turn/settlement hook may return `{continuation:{type,content}}`; last defined wins, null clears, and continuations share `maxToolRounds` with tools. Stop/dispose retires pending hook authority, not privileged Node code. Message veto/error conserves completed provider usage without executing pending tool calls; output replacement is not a streaming secret filter. All existing ownership, queue, copy, supplied-summary compaction and explicit resource methods retain their contracts. No executable/auth/MCP discovery or Pi methods are synthesized.

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
all-history cloning/arbitrary custom-data reference remapping, or a new persistence schema. Existing primitive
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
Le signal d'annulation reste vivant. La compaction automatique revérifie
l’identité de session, la branche et la politique locale après les attentes de
politique/résumé/file du gestionnaire, avant d’admettre la persistance. Une
persistance déjà démarrée n’est pas annulée rétroactivement. Les options sont capturées avant
l'initialisation et les arguments mutables des méthodes lors de leur appel. Aucun coût, limite de modèle ou retry de résumé n'est
inventé. La priorité Core du thinking enregistré est conservée : utilisez
`setThinking` au repos. Les prompts système littéraux sont éphémères ; aucun
fichier AGENTS/settings/system n'est découvert automatiquement.

Hors façade, `SessionManager.setCompactionContextWindow(tokens?)` accepte un entier
sûr strictement positif ou `undefined` ; `getCompactionContextWindow()` lit cette
politique hôte propre au gestionnaire, non persistée. Avec une limite, l’automatique
exige `estimateContextTokens(id) > fenêtre - reserveTokens`, puis `keepRecentTokens`
choisit la coupe. La fenêtre est revérifiée après politique/observateurs/résumé/file ;
une sortie devenue inéligible n’est pas publiée. Effacer la limite conserve le
seuil historique ; les cibles manuelles et la façade restent inchangées.
La primitive `SessionManager.applyCompaction(id, résumé, premièreEntréeConservée,
détails?,{signal?,source?})` publie un résumé fourni sans invoquer le callback de
génération enregistré, même si l’automatique est désactivé. Les options propres
`SessionCompactionOptions` capturent un signal d’abort authentique vivant.
Avant une génération externe, `captureCompactionSource(id)` capture sans appel
provider/stockage une vue gelée locale `SessionCompactionSource` (ou null si absente),
exposant seulement `sourceSessionId` et `entryId` optionnel. Passez cette vue exacte
comme `source` : ID canonique propre de données, session/feuille, journal/contexte
historique possédés et génération du stockage doivent encore correspondre. Un ID
substitué ou un accesseur est refusé sans exécution. Remplacer puis restaurer le stockage
retire aussi ce travail. Copies, vues étrangères et vues consommées sont refusées.
Le titre/réglage seul ne retire pas l’autorité du résumé fourni. L’admission suit
la préparation structurelle, juste avant la sauvegarde capturée ; une sauvegarde
admise finit. Ce n’est ni CAS interprocessus, isolation hôte, capacité sérialisée,
ni nouvelle méthode de façade/stockage. L’hôte possède encore l’admission au premier
plan et les durées de génération. Sans source capturée, une borne invalide reste
sans effet ; avec une source capturée exacte, elle rejette pour éviter une fausse
notification de réussite hôte.

Les utilitaires racine optionnels `getCompactionModelMessages` et
`prepareCompactionContext` reprennent le contexte modèle possédé par Core : résumés
antérieurs, contenu custom public même `display:false`, commandes terminées, jamais
les données/détails custom privés. Capturez source de publication et liaisons hôte
avant préparation/exposition de callbacks. Le résultat contient des tableaux Message
possédés modifiables, une borne modèle et des estimations historiques ; il ne génère,
ne publie et ne renouvelle aucune autorité de source. `selectCompactionCut` reçoit
une projection complète possédée et des poids alignés fiables ; un groupe complet
assistant/outils est indivisible et peut dépasser la conservation souple. Le repli
manuel forcé garde deux unités entières si le seuil par défaut conserve tout ; sans
préfixe utile, le résultat est null. Ni payload complet système/outils/médias, hooks,
comptabilité ou récupération d’overflow ne sont ajoutés. Aucune nouvelle capacité
obligatoire de façade/stockage. Rechargement/copie/navigation conservent les bornes
custom/résumé/commande et remappent les liens de commandes connus, pas les IDs privés.

L’utilitaire passif `resolveAgentCompactionContextWindow(provider?, model?)` utilise
la limite publiée ou un repli de 128 000 tokens hors mock ; sans provider ou pour
mock, l’ancienne politique est conservée. CLI/RPC l’appliquent après changement de
modèle. Ce repli n’est pas une métadonnée fournisseur certifiée ; l’estimation
n’inclut pas tout le payload système/outils et n’est pas une récupération d’overflow.

`prompt` démarre le run détaché, `promptAndWait` attend exactement ce run.
`stop` accuse réception de l'annulation : **attendez `wait()`** avant de considérer
les résultats/consommations interrompus comme durables. `wait()` n'empêche pas un
`stop()` ultérieur. Les mutations d'historique/options et un second prompt sont
refusés jusqu'au règlement durable. Les erreurs d'exécution donnent un snapshot
`failed` ; les erreurs de démarrage/confiance/stockage peuvent rejeter l'appel.
`steer`, `followUp`, `clearQueue` et `respondToInteraction` reprennent Core.

L’adaptation suit le [contrat natif par hôte](../../../../docs/ai/topics/native-extension-contract.md), pas les signatures Pi. Un registre fourni explicitement peut utiliser `before:message` (texte seul), `before:tool:result` (résultat public externe), `before:turn:end` et `before:agent:settle`. Les deux derniers retournent éventuellement `{continuation:{type,content}}` ; dernière valeur définie retenue, null pour effacer, avec le même budget `maxToolRounds`. `promptAndWait(texte,{trigger:{kind:'custom',type:'automation:review'}})` accepte du texte seul et ajoute un `custom_message` visible au modèle, pas un faux message utilisateur. Par défaut le déclencheur reste utilisateur. Un veto/échec conserve l’usage fournisseur terminé sans lancer ses appels d’outils en attente ; les deltas déjà affichés ne sont pas effacés. Stop/dispose retire l’autorité des callbacks tardifs, sans sandbox Node. Les noms d’événements étrangers et API d’enregistrement retirées sont refusés ; aucune découverte exécutable/auth/MCP implicite n’est ajoutée.

`subscribe` et `events(after)` exposent le journal séquencé Core v1, données
`unknown`, replay borné et indicateur `reset`. Une erreur d'observateur ne casse
pas le run. Les événements de compaction rejoignent ce journal ; rename/branche/
copie ne créent pas d'événements inventés. Les lectures retournent des copies
expurgées : messages actifs, contexte effectif, journal brut conservant les
branches abandonnées et l'historique pré-compaction. `exportSession` utilise la
conversion ISO Core ; `deserializeSession` hydrate les dates sans valider un JSON
arbitraire non fiable.

L'utilitaire racine `getSessionAccounting(entries, activeLeafId?)` accepte un
journal readonly et rend des projections indépendantes `active`/`history`.
Sur un handle au repos, fournissez `await session.history()` et
`session.snapshot().activeLeafId`. L'ascendance active conserve le travail
pré-compaction ; l'historique inclut les branches abandonnées, sans confondre
ces totaux avec le contexte. Le coût persisté prévaut ; un calcul tarifaire
publié exige le provider/modèle de l'entrée, jamais le modèle courant.
L'absence de mesure reste inconnue/partielle ; l'usage imbriqué authentifié sur
le résultat externe compte une seule fois, pas les détails de progression.
`requests` compte des entrées comptabilisables, résumés non mesurés compris,
pas les appels réseau internes. Les totaux de tokens saturent à la limite des
entiers sûrs et deviennent partiels ; les coûts non représentables sont exclus
du sous-total connu. Les primitives `addBranchSummary`/`appendBranchSummary`
acceptent une provenance optionnelle copiée `BranchSummaryAccounting` ; les
anciens résumés v2 restent lisibles, sans prix inventé. Ces paramètres de
comptabilisation ne génèrent aucun résumé et n'ajoutent pas de mutation à la façade.

La primitive `SessionManager.navigateTree(sessionId, entryId, options?)` conserve
le journal abandonné. Seul `summarize: true` autorise le `BranchSummarizer` fourni ;
`createProviderBranchSummarizer(provider, model?)` adapte un fournisseur déjà
configuré, sans outils ni découverte. La génération bornée ne bloque pas la file
des mutations ; sa publication exige une source encore identique. Les résultats
sont `navigated`, `not-found`, `cancelled` ou `stale`. L'annulation retire une
navigation non publiée, pas une écriture durable déjà admise. L'hôte reste
responsable de l'admission au premier plan et de la coopération du callback.
La façade de haut niveau n'expose pas cette mutation.

Au niveau inférieur, `onBeforeBranch` accepte des `SessionBranchHook` ordonnés,
uniquement annulables ; le registre expose `before:session:branch` avec métadonnées
primitives gelées source/opération/entrée/position/source externe et signal possédé.
`onBeforeBranchSummary` / `before:session:summary` exigent une demande de résumé
explicite et reçoivent un transcript modèle borné, IDs/budgets gelés, jamais l’état
privé ni ses détails. Undefined continue, false annule ; les hooks du registre
acceptent aussi `{cancel:true,reason?}` propre. Un résumé peut retourner une sortie
copiée validée `{summary,provider?,model?,usage?}` : dernière sortie définie retenue,
veto ultérieur prioritaire, callback de secours seulement sans override. Aucun
remplacement source/cible. Les hooks globaux reçoivent le signal de génération
possédé ; le callback historique conserve le signal exact fourni par l’appelant.
Enregistrement/retrait/déchargement/reliaison retire le travail non admis, même
non coopératif ; les écritures admises finissent. Bornes :128 hooks Core/type,
256 admissions en attente ; registre128 managers,256 références/manager et256
callbacks/type. Ces intégrations privilégiées ne sont ni sandbox, ni rollback,
ni nouvelles méthodes de façade ou exigences du stockage structurel.

`appendCustomEntry` conserve un état JSON propre borné hors contexte modèle ;
`appendCustomMessage` y contribue même avec `display: false`, jamais ses `details`.
Ce n'est ni un coffre à secrets ni un bac à sable. Le contexte suit les parents,
la compaction active et les résumés de destination ; les groupes outils incomplets
sont retirés. `fromEntryId` décrit uniquement la provenance, pas un parent. Un
préfixe de métadonnées propre borné conserve l'ancien fond de compaction sur son
ascendance, après navigation/rechargement/compaction et remappage du clone, jamais
sur une nouvelle racine indépendante.

`await session.editContext({targetEntryId, replacement?})` exige le repos et suit
la durée du handle. Sans `replacement`, l’entrée active est omise du futur contexte
modèle ; un texte, même vide, remplace son contenu public. L’entrée `context_edit`
est relative à la branche : historique et facturation ne changent pas. Les entrées
étrangères/compactées, accesseurs, champs inconnus et textes dépassant 512 Kio sont
refusés. Core répare les groupes d’outils et conserve/remappe les éditions dans les
copies. La primitive `SessionManager.appendContextEdit` accepte aussi `{signal}`.

`recordSessionLoadout` / `getSessionLoadout` conservent/reconstruisent les deltas
privés du prompt/outillage/modèle/thinking préparés au dernier instant avant appel.
Les tours Core les enregistrent automatiquement ; la compaction garde leur
checkpoint et les opérations déclarées des outils fichiers. `history()` est une
lecture privilégiée pouvant contenir des instructions/schémas privés, pas un DTO
public. `onBeforeCompaction` / `before:session:compaction` autorisent seulement le
remplacement final `{summary}` ou le veto, sans changer source/borne/usage. Aucun
import Pi, enregistrement d’outil historique ou appel de résumé implicite n’est ajouté.

`rename`, `setModel`, `setThinking`, `branchBefore` et `applyCompaction` attendent
la persistance Core. La compaction manuelle exige un résumé fourni et une borne
modèle active valide (message/custom/résumé de branche/commande) : aucun appel
modèle implicite. Elle reste disponible si l’automatique
est désactivé. La façade capture la source Core avant l’observation
`compaction.started` : un observateur ne peut pas prêter l’autorité d’un stockage
remplaçant à cette publication en attente. Un changement de titre seul reste valide.
`dispose` retire la compaction explicite non publiée de ce handle, y compris pendant
la préparation structurelle, puis attend une sauvegarde déjà
admise sans fausse annulation. Les frères et ressources prêtées gardent leurs
propres durées. `compactionTarget` réutilise Core.
`fork` copie l'ascendance d'une entrée utilisateur durable, éventuellement avant
cette entrée ; `clone` crée une racine indépendante et remappe l'ascendance active
messages/commandes/état et messages personnalisés/résumés/compaction. Les références
arbitraires dans les données et la provenance externe ne sont pas réécrites.
Ces méthodes exigent une session au repos et participent à l’admission ordonnée
Core via une référence de registre prêtée indépendamment. `dispose` retire les
branches non admises de ce handle avant d’attendre sa file, même si un hook ignore
l’annulation. La promesse est publiée avant le dispatch d’abort : une réentrée
synchrone retourne cette même promesse, sans libérer la référence d’un frère vivant. Une copie durable déjà admise finit et son handle enfant reste vivant.
Le nettoyage final/échec de fabrique libère seulement la référence SDK, jamais la
liaison de cycle de vie/résumé d’un autre hôte. Labels, références arbitraires et
coordination interprocessus restent séparés. Les handles partagent le groupe
runtime/gestionnaire/fournisseur.

`resourceLoader` et `extensionRegistry` sont prêtés. La fabrique/les lectures ne
chargent aucun module, package, outil ou MCP. `createAgentResourceLoader` compose
la découverte Markdown bornée et protégée de Core. `reloadResources`,
`expandPrompt` et `invokeSkill` sont explicites, avec confiance fraîche. Les
expansions retournent du texte à envoyer vous-même ; les skills ne deviennent
pas automatiquement des outils. Un loader personnalisé est du code hôte fiable,
responsable de ses propres limites et protections. Sur `createAgentResourceLoader`
/ `ResourceManager`, `discoverSkills: false` et `discoverPrompts: false` ignorent
les racines automatiques et les sélecteurs réglages/packages fournis, pas les
chemins explicites `skillPaths` / `promptPaths`. Les deux valent true par défaut ;
les anciennes options `disableSkills` / `disablePrompts` désactivent toujours tout
chargement, chemins explicites compris. Ces options hôte n’accordent aucune
confiance au projet.

`capabilities` et `ownership` décrivent les limites réelles. `dispose` est
idempotent, annule/attend et détache les abonnements ; il ne supprime aucune
session ni ne ferme le stockage/fournisseur de l'appelant ou le réseau global.
Disposez aussi chaque fork/clone : seul le dernier handle ferme les transports
possédés du groupe. Abandonnez les handles disposés pour permettre leur collecte.
Un callback/stockage non coopératif peut retarder le règlement ; aucun état
terminal artificiel ni nouveau timeout de boucle n'est ajouté.

Limites explicites : pas de chargement exécutable/MCP, login OAuth, découverte de
modèles, auto-chargement de settings/instructions, changement de fournisseur,
export HTML/shell direct, coordination de runs entre processus, clonage de tout
l'historique/remappage des références arbitraires personnalisées ou nouveau format
de persistance.

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
