import type { Page, Route } from '@playwright/test';

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface MockSession {
  id: string;
  title?: string;
  messages: MockMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface MockProvider {
  type: string;
  configured: boolean;
}

export interface MockStreamEvent {
  type: 'message_start' | 'text_delta' | 'message_end' | 'error';
  content?: string;
}

export interface RecordedApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface MockApiOptions {
  sessions?: MockSession[];
  providers?: MockProvider[];
  stream?: MockStreamEvent[];
  unavailable?: boolean;
  createSessionError?: boolean;
  configureProviderError?: boolean;
}

export interface MockApiController {
  requests: RecordedApiRequest[];
  sessions: MockSession[];
}

const DEFAULT_DATE = '2025-01-01T12:00:00.000Z';

export function mockSession(
  id: string,
  title: string,
  messages: Array<Pick<MockMessage, 'role' | 'content'>> = [],
): MockSession {
  return {
    id,
    title,
    messages: messages.map((message, index) => ({
      ...message,
      id: `${id}-message-${index + 1}`,
      timestamp: DEFAULT_DATE,
    })),
    createdAt: DEFAULT_DATE,
    updatedAt: DEFAULT_DATE,
  };
}

export async function installMockApi(
  page: Page,
  options: MockApiOptions = {},
): Promise<MockApiController> {
  const controller: MockApiController = {
    requests: [],
    sessions: structuredClone(options.sessions ?? []),
  };
  const providers = structuredClone(
    options.providers ?? [{ type: 'mock', configured: true }],
  );
  const stream = options.stream ?? [
    { type: 'message_start' },
    { type: 'text_delta', content: 'Mock response' },
    { type: 'message_end', content: 'Mock response' },
  ];
  let nextSessionId = 1;
  let nextMessageId = 1;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = readRequestBody(route);

    controller.requests.push({
      method,
      path: url.pathname,
      headers: request.headers(),
      ...(body === undefined ? {} : { body }),
    });

    if (options.unavailable) {
      await route.abort('failed');
      return;
    }

    if (url.pathname === '/api/providers' && method === 'GET') {
      await fulfillJson(route, providers);
      return;
    }

    if (url.pathname === '/api/config' && method === 'POST') {
      if (options.configureProviderError) {
        await fulfillJson(route, { error: 'Configuration refused' }, 500);
        return;
      }
      const configuration = body as { type?: string } | undefined;
      const provider = providers.find((item) => item.type === configuration?.type);
      if (provider) provider.configured = true;
      await fulfillJson(route, { success: true, message: 'Provider configured' });
      return;
    }

    if (url.pathname === '/api/sessions' && method === 'GET') {
      await fulfillJson(route, controller.sessions);
      return;
    }

    if (url.pathname === '/api/sessions' && method === 'POST') {
      if (options.createSessionError) {
        await fulfillJson(route, { error: 'Failed to create session' }, 500);
        return;
      }
      const input = body as { title?: string } | undefined;
      const session: MockSession = {
        id: `e2e-session-${nextSessionId++}`,
        ...(input?.title ? { title: input.title } : {}),
        messages: [],
        createdAt: DEFAULT_DATE,
        updatedAt: DEFAULT_DATE,
      };
      controller.sessions.unshift(session);
      await fulfillJson(route, session);
      return;
    }

    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && method === 'POST') {
      const session = controller.sessions.find((item) => item.id === decodeURIComponent(messageMatch[1]!));
      if (!session) {
        await fulfillJson(route, { error: 'Session not found' }, 404);
        return;
      }
      const input = body as Pick<MockMessage, 'role' | 'content'>;
      const message: MockMessage = {
        ...input,
        id: `e2e-message-${nextMessageId++}`,
        timestamp: new Date().toISOString(),
      };
      session.messages.push(message);
      session.updatedAt = message.timestamp;
      await fulfillJson(route, message, 201);
      return;
    }

    if (url.pathname === '/api/chat/stream' && method === 'POST') {
      const responseBody = stream
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: responseBody,
      });
      return;
    }

    await fulfillJson(route, { error: `Unhandled mock route: ${method} ${url.pathname}` }, 404);
  });

  return controller;
}

function readRequestBody(route: Route): unknown {
  const rawBody = route.request().postData();
  if (!rawBody) return undefined;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
