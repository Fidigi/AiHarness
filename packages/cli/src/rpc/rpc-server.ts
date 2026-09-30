import readline from 'readline';
import {
  JsonlSessionStore,
  ProviderFactory,
  SessionManager,
  type AiProvider,
  type Message,
  type ProviderConfig,
} from '@ai-harness/core';

export interface RpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id?: string | number;
  result?: unknown;
  error?: { code: string; message: string };
  event?: string;
  data?: unknown;
}

export interface RpcContext {
  sessionManager: SessionManager;
  providers: Map<string, AiProvider>;
  emit(response: RpcResponse): void;
}

function configuredProviders(): Map<string, AiProvider> {
  const providers = new Map<string, AiProvider>();
  providers.set('mock', ProviderFactory.create({ type: 'mock' as any, apiKey: '' }));
  const configs: Array<ProviderConfig | undefined> = [
    process.env.OPENAI_API_KEY ? { type: 'openai' as any, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL } : undefined,
    process.env.ANTHROPIC_API_KEY ? { type: 'anthropic' as any, apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL } : undefined,
    (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) ? {
      type: 'google' as any,
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_MODEL,
    } : undefined,
    {
      type: 'local' as any,
      apiKey: process.env.LOCAL_API_KEY || process.env.LLAMA_API_KEY || 'local',
      baseUrl: process.env.LOCAL_BASE_URL || process.env.LLAMA_BASE_URL || 'http://localhost:11434/v1',
      model: process.env.LOCAL_MODEL || process.env.LLAMA_MODEL || 'local-model',
    },
  ];
  for (const config of configs) {
    if (!config) continue;
    providers.set(String(config.type), ProviderFactory.create(config));
  }
  return providers;
}

export async function handleRpcRequest(request: RpcRequest, context: RpcContext): Promise<RpcResponse> {
  const params = request.params ?? {};
  switch (request.method) {
    case 'system.ping':
      return { id: request.id, result: { ok: true } };
    case 'session.list':
      return { id: request.id, result: context.sessionManager.list() };
    case 'session.create': {
      const session = await context.sessionManager.create({ title: typeof params.title === 'string' ? params.title : undefined });
      return { id: request.id, result: session };
    }
    case 'session.get': {
      const sessionId = String(params.sessionId ?? '');
      const session = context.sessionManager.get(sessionId) ?? await context.sessionManager.loadFromStore(sessionId);
      if (!session) throw new Error(`Session introuvable : ${sessionId}`);
      return { id: request.id, result: session };
    }
    case 'session.delete': {
      const deletedCount = await context.sessionManager.deleteWithForks(String(params.sessionId ?? ''));
      return { id: request.id, result: { deletedCount } };
    }
    case 'provider.list':
      return { id: request.id, result: [...context.providers.keys()] };
    case 'chat.send': {
      const sessionId = String(params.sessionId ?? '');
      const content = String(params.content ?? '').trim();
      const providerName = String(params.provider ?? 'mock');
      if (!content) throw new Error('Le contenu du message est requis.');
      const session = context.sessionManager.get(sessionId) ?? await context.sessionManager.loadFromStore(sessionId);
      if (!session) throw new Error(`Session introuvable : ${sessionId}`);
      const provider = context.providers.get(providerName);
      if (!provider) throw new Error(`Provider indisponible : ${providerName}`);
      await context.sessionManager.addMessage(sessionId, { role: 'user', content });
      const messages = context.sessionManager.get(sessionId)!.messages.map(message => ({ ...message })) as Message[];
      let streamed = '';
      const response = await new Promise<{ content: string; usage?: unknown }>((resolve, reject) => {
        provider.streamChat(
          messages,
          chunk => {
            if (!chunk) return;
            streamed += chunk;
            context.emit({ event: 'text_delta', data: { requestId: request.id, sessionId, content: chunk } });
          },
          result => resolve({ content: streamed || result?.content || '', usage: result?.usage }),
          reject,
          { model: typeof params.model === 'string' ? params.model : undefined },
        ).catch(reject);
      });
      if (response.content) await context.sessionManager.addMessage(sessionId, { role: 'assistant', content: response.content });
      context.emit({ event: 'message_end', data: { requestId: request.id, sessionId, ...response } });
      return { id: request.id, result: response };
    }
    default:
      return { id: request.id, error: { code: 'METHOD_NOT_FOUND', message: `Méthode inconnue : ${request.method}` } };
  }
}

/** JSONL stdin/stdout RPC mode for headless integrations. */
export async function runRpcMode(): Promise<void> {
  const sessionManager = new SessionManager();
  sessionManager.setStore(new JsonlSessionStore(process.env.AI_HARNESS_SESSIONS_DIR));
  await sessionManager.loadAllSessions();
  const output = (response: RpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };
  const context: RpcContext = { sessionManager, providers: configuredProviders(), emit: output };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
      if (!request.method) throw new Error('Le champ method est requis.');
    } catch (error) {
      output({ error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) } });
      continue;
    }
    try {
      output(await handleRpcRequest(request, context));
    } catch (error) {
      output({
        id: request.id,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
