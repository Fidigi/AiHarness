import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

function providerSection(page: import('@playwright/test').Page) {
  return page.getByRole('heading', { name: 'AI Provider' }).locator('..');
}

test.describe('Conversation', () => {
  test('envoie et persiste un échange avec le fournisseur mock', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();

    const input = page.getByPlaceholder(/Type your message/);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await input.fill('Hello from Playwright');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.user')).toHaveText(/Hello from Playwright/);
    await expect(page.locator('.message.assistant').first()).toContainText(
      'Hello! How can I help you today?',
    );
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');

    await expect.poll(() => api.requests.filter((request) => (
      request.method === 'POST' && request.path === '/api/sessions/e2e-session-1/messages'
    )).map((request) => request.body)).toEqual([
      { role: 'user', content: 'Hello from Playwright' },
      { role: 'assistant', content: 'Hello! How can I help you today?' },
    ]);
  });

  test('consomme un flux SSE et lui transmet tout l’historique', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('streamed-session', 'Conversation SSE', [
        { role: 'user', content: 'Message précédent' },
        { role: 'assistant', content: 'Contexte précédent' },
      ])],
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
      ],
      stream: [
        { type: 'message_start' },
        { type: 'text_delta', content: 'Bon' },
        { type: 'text_delta', content: 'jour' },
        { type: 'message_end', content: 'Bonjour' },
      ],
    });
    await page.goto('/settings');
    await providerSection(page).locator('select').selectOption('openai');
    await page.getByRole('button', { name: 'Conversation SSE' }).click();

    await page.getByPlaceholder(/Type your message/).fill('Nouveau message');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.assistant').last()).toContainText('Bonjour');
    await expect.poll(() => api.requests.filter((request) => (
      request.method === 'POST' && request.path === '/api/chat/stream'
    )).length).toBe(1);

    const streamRequest = api.requests.find((request) => request.path === '/api/chat/stream');
    expect(streamRequest?.body).toEqual({
      provider: 'openai',
      messages: [
        { role: 'user', content: 'Message précédent' },
        { role: 'assistant', content: 'Contexte précédent' },
        { role: 'user', content: 'Nouveau message' },
      ],
      options: { model: 'gpt-4o' },
    });

    await expect.poll(() => api.requests.filter((request) => (
      request.path === '/api/sessions/streamed-session/messages'
    )).map((request) => request.body)).toEqual([
      { role: 'user', content: 'Nouveau message' },
      { role: 'assistant', content: 'Bonjour' },
    ]);
  });

  test('échange les messages via WebSocket quand ce transport est sélectionné', async ({ page }) => {
    await page.addInitScript(() => {
      const requests: Array<{ url: string; body: unknown }> = [];
      (window as unknown as { __webSocketRequests: typeof requests }).__webSocketRequests = requests;

      class MockWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readonly url: string;
        readyState = MockWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(url: string | URL) {
          this.url = String(url);
          setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event('open'));
          });
        }

        send(data: string): void {
          requests.push({ url: this.url, body: JSON.parse(data) as unknown });
          for (const frame of [
            'event: message_start\ndata: {}\n\n',
            'event: text_delta\ndata: {"content":"Via "}\n\n',
            'event: text_delta\ndata: {"content":"WebSocket"}\n\n',
            'event: message_end\ndata: {"content":"Via WebSocket"}\n\n',
          ]) {
            this.onmessage?.(new MessageEvent('message', { data: frame }));
          }
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close'));
        }

        close(): void {
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close'));
        }
      }

      window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    });
    const api = await installMockApi(page, {
      sessions: [mockSession('websocket-session', 'Conversation WebSocket')],
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
      ],
    });
    await page.goto('/settings');
    await providerSection(page).locator('select').selectOption('openai');
    await page.getByRole('heading', { name: 'Real-time transport' })
      .locator('..')
      .locator('select')
      .selectOption('websocket');
    await page.getByRole('button', { name: 'Conversation WebSocket' }).click();

    await page.getByPlaceholder(/Type your message/).fill('Tester le socket');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.assistant')).toContainText('Via WebSocket');
    expect(api.requests.some((request) => request.path === '/api/chat/stream')).toBe(false);
    const socketRequests = await page.evaluate(() => (
      window as unknown as { __webSocketRequests: Array<{ url: string; body: unknown }> }
    ).__webSocketRequests);
    expect(socketRequests).toEqual([{
      url: 'ws://localhost:3080/api/chat/ws',
      body: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'Tester le socket' }],
        options: { model: 'gpt-4o' },
      },
    }]);
  });

  test('affiche et persiste une erreur de streaming', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('error-session', 'Conversation en erreur')],
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
      ],
      stream: [{ type: 'error', content: 'Provider unavailable' }],
    });
    await page.goto('/settings');
    await providerSection(page).locator('select').selectOption('openai');
    await page.getByRole('button', { name: 'Conversation en erreur' }).click();

    await page.getByPlaceholder(/Type your message/).fill('Déclencher une erreur');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.assistant')).toContainText('Error: Provider unavailable');
    await expect.poll(() => api.requests.filter((request) => (
      request.path === '/api/sessions/error-session/messages'
    )).map((request) => request.body)).toEqual([
      { role: 'user', content: 'Déclencher une erreur' },
      { role: 'assistant', content: 'Error: Provider unavailable' },
    ]);
  });

  test('utilise le mode démo pour un fournisseur hébergé non configuré', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('demo-session', 'Conversation démo')],
      providers: [{ type: 'mock', configured: true }],
    });
    await page.goto('/settings');
    await providerSection(page).locator('select').selectOption('anthropic');
    await page.getByRole('button', { name: 'Conversation démo' }).click();

    await expect(page.getByText(/Demo mode - configure API Key in Settings/)).toBeVisible();
    await page.getByPlaceholder(/Type your message/).fill('Une question');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.assistant')).toContainText('[Demo mode]');
    expect(api.requests.some((request) => request.path === '/api/chat/stream')).toBe(false);
  });

  test('rend les blocs de code et le code en ligne sans interpréter le HTML', async ({ page }) => {
    await installMockApi(page, {
      sessions: [mockSession('formatted-session', 'Réponse formatée', [
        {
          role: 'assistant',
          content: 'Utilisez `npm test`.\n```ts\nconst safe = "<script>";\n```\n<script>alert(1)</script>',
        },
      ])],
    });

    await page.goto('/chat/formatted-session');

    await expect(page.locator('code.inline-code')).toHaveText('npm test');
    await expect(page.locator('pre.code-block code')).toContainText('const safe = "<script>";');
    await expect(page.locator('.message-content script')).toHaveCount(0);
    await expect(page.locator('.message-content')).toContainText('<script>alert(1)</script>');
  });
});
