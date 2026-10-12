# Extension startup options (API v1)

AiHarness owns this contract; it does not implement another product's option API.
`ExtensionAPI`, `ExtensionOption`, `ExtensionOptionDescriptor` and
`ExtensionOptionValue` are exported by `@ai-harness/core`. This is an additive
extension API v1 capability; existing factories need no migration.

```js
export default api => {
  api.registerOption('review-style', {
    type: 'string', description: 'Review style', default: 'brief',
    completions: ['brief', 'full'],
  });
  api.registerOption('review-check', {
    type: 'boolean', description: 'Check review', default: false,
  });
  api.before('before:provider', () => {
    const style = api.getOption('review-style');
    const check = api.getOption('review-check');
    // Consume the owned values here, or in a command/tool callback.
  });
}
```

Use loading and trust options **before** contributed options:

```sh
ai-harness --approve --extension ./review.mjs --review-style=full --review-check=false --print --no-session hello
ai-harness --approve --extension ./review.mjs --help-extensions
ai-harness --approve --extension ./review.mjs --completion=--review-style=f
printf '%s\n' '{"type":"prompt","message":"review"}' | ai-harness --approve --extension ./review.mjs --mode=rpc --no-session --review-style=full --review-check
```

- Names omit `--`, use lowercase alphanumeric hyphen-separated words, and are
  limited to 64 characters. Built-in names and aliases cannot be replaced.
- Only `boolean` and `string` are supported. Boolean flags accept bare presence
  (`true`) or `=true`/`=false`; strings accept `--name=value` or `--name value`.
  Empty strings, duplicate flags, unsupported values/types and unknown flags fail.
  Positional prompts and `--` end option interpretation as for built-ins.
- A factory may read its defaults immediately. Explicit values become available
  through **its own** `api.getOption(name)` after strict startup parsing, before
  hooks/commands/tools run. Do not cache a factory-time read as the startup value.
  Reading another extension's option returns `undefined`; values are not injected
  into shared tool/runtime contexts or persisted session metadata.
- Registration returns an idempotent disposer. Unload removes metadata and
  values; reload revalidates the CLI against the new metadata. Failed transactional
  replacement restores the previous metadata and values.
- At most 32 options per extension and 256 per registry are allowed. Descriptions
  are bounded plain text (512 characters), string defaults/values are limited to
  4096 characters, and literal completion lists have at most 64 entries of at most
  256 characters. Control characters are rejected. Completion never invokes a
  callback or shell. Terminal prefix completion also includes registered long
  options and `--name=value` candidates.

## Execution and trust

`--help` and `--version` remain metadata-only built-in operations: they never
import extensions, even when `--extension` or `--approve` is supplied.
`--help-extensions` and `--completion` explicitly load executable eligible
extensions and exit without starting an agent/session. Project extensions,
including explicitly selected project files and enabled project packages, still
require trust. Refused projects are never imported merely to recognize a flag.
An unknown contributed flag in a refused project fails closed. Global extensions
are executable user code, not sandboxed metadata.

Bootstrap parsing cannot know an unregistered option's arity without executing
code. Accordingly loading/trust flags after the first unrecognized long option
are rejected rather than inferred from a possible prompt. Use the ordering above.
Interactive, print, JSON and RPC startup reuse one loaded generation, not a
second import/factory invocation. RPC receives the prepared registry and loader,
so owned explicit values remain available to hooks and tools. Incidental import,
factory, hook and shutdown output stays off RPC protocol stdout; EOF and startup
or output failures shut down and unload the same registry.

Reload import attempts have identities independent of committed generations.
Failed registration or import attempts leave the committed generation unchanged;
a subsequent attempt evaluates fresh entry code instead of reusing a failed
candidate's cached module. This applies to ESM (`.mjs` and module `.js`) and
CommonJS (`.cjs` and CommonJS `.js`), on successful reloads and across independent
loader instances too. Directory entry points include `index.cjs`.

CommonJS entries are compiled as fresh, uncached modules from the held entry
source; a query alone cannot bypass Node's filename-based CommonJS cache.
Preexisting `require.cache` entries are neither removed nor replaced, including
on failed candidates. Relative `require`/dynamic `import`, `__filename` and
`__dirname` retain the real entry location; ESM relative imports and
`import.meta.url` retain their normal file location. Only the entry is refreshed:
dependencies retain Node's normal caching. Reload is transactional for owned
registrations and values, not arbitrary module side effects.
