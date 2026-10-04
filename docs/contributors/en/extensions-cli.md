# AiHarness Extensions — CLI

## Table of Contents

- [Locations](#locations)
- [Example](#example)
- [Available API](#available-api)
  - [Transforming and cancellable hooks](#transforming-and-cancellable-hooks)
  - [Automatic tool invocations](#automatic-tool-invocations)
- [Management commands](#management-commands)
- [Current limitations](#current-limitations)

## Locations

The CLI automatically discovers:

- `~/.ai-harness/extensions/*.js|*.mjs`
- `<project>/.ai-harness/extensions/*.js|*.mjs`
- subdirectories containing `index.js` or `index.mjs`

A module can also be loaded explicitly:

```bash
ai-harness --extension ./extensions/example.mjs
```

Multiple paths can be provided with multiple `--extension` options, or with `AI_HARNESS_EXTENSIONS` separated by the system path separator.

TypeScript extensions must currently be compiled to JavaScript before loading.

## Example

```js
export default function exampleExtension(api) {
  api.registerCommand('hello', {
    description: 'Display a message',
    usage: '/hello [name]',
    handler: async (args, ctx) => {
      const message = `Hello ${args || 'world'}`;
      ctx.notify(message, 'success');
      return message;
    },
  });

  api.registerTool({
    name: 'sum',
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    execute: ({ a, b }) => ({
      content: String(a + b),
      details: { a, b },
    }),
  });

  api.registerUI({
    name: 'example-status',
    placement: 'status',
    render: ({ provider }) => `Active provider: ${provider || 'unknown'}`,
  });

  api.before('before:agent', data => ({
    input: data.input.trim(),
  }));

  api.before('before:tool', data => {
    if (data.tool === 'sum' && Number(data.input?.a) < 0) {
      return { cancel: true, reason: 'Negative numbers are not allowed.' };
    }
  });

  const unsubscribe = api.on('session:create', event => {
    api.events.emit('example:session-created', event);
  });

  return () => unsubscribe();
}
```

## Available API

- `registerCommand(name, definition)`: adds a `/name` command.
- `registerTool(definition)`: adds an executable tool. Tools are listed by `/tools` and can be tested with `/tool <name> <json>`.
- `registerProvider(type, definition)`: adds a provider factory selectable with `/provider <type>`.
- `registerUI(component)`: adds a text panel to the fullscreen CLI interface. The component receives notably `currentSessionId` and `provider`.
- `on(event, handler)`: listens to a lifecycle event and returns an unsubscribe function.
- `before(event, handler)`: transforms or cancels an operation before execution.
- `events`: event bus for inter-extension communication.

Current events cover sessions, messages, compaction, agent/provider/tool calls, `system:ready` and `system:shutdown`.

### Transforming and Cancellable Hooks

Three hooks are available:

- `before:agent` receives `{ sessionId, provider, input }`;
- `before:provider` receives `{ provider, model, messages, options }`;
- `before:tool` receives `{ tool, input, context }`.

Handlers execute in registration order. They can return a partial object to transform subsequent data, `false` to cancel, or `{ cancel: true, reason?: string }` to cancel with a reason. An exception interrupts the operation and identifies the offending extension. Hooks are automatically unsubscribed on unload.

To modify a provider option without removing others, explicitly preserve the existing object:

```js
api.before('before:provider', data => ({
  options: { ...data.options, temperature: 0.2 },
}));
```

### Automatic Tool Invocations

Tool schemas automatically pass through the shared provider contract; the OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock, and local-compatible adapters translate them when the model allows tool calls. When the model requests a tool, the CLI persists the tool call, executes the tool, persists its result (errors included), then resumes the model call. The loop is limited to eight consecutive turns to avoid infinite calls. An `Escape` or `Ctrl+C` interruption cancels the provider request and propagates the signal to the active tool.

## Management Commands

```text
/extensions   Lists extensions and their capabilities
/tools        Lists registered tools
/tool         Manually executes a tool
/reload       Unloads then reloads all modules
```

Unloading automatically removes commands, tools, providers, UI panels and listeners belonging to the extension. A cleanup function returned by the factory is also called.

## Current Limitations

- The CLI and Web server load separate extension generations: `/reload` reloads only the CLI process, while the Web API has its own reload routes.
- CLI panels registered with `registerUI` are text-only and visible only in fullscreen mode; the server separately returns its text widgets and declarative interactions.
- Executable modules are trusted Node code run in the host process, without a security sandbox.
