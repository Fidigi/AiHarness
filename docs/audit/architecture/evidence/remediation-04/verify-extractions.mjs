// Syntax-level copy check against the frozen pre-extraction image, not runtime certification.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '/app/node_modules/typescript/lib/typescript.js';
const printer = ts.createPrinter({ removeComments: true });
function declarations(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result = new Map();
  for (const node of ast.statements) {
    if (node.name) result.set(node.name.text, printer.printNode(ts.EmitHint.Unspecified, node, ast));
    if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
      result.set(item.name.getText(ast), printer.printNode(ts.EmitHint.Unspecified, item, ast));
    }
  }
  return result;
}
const checks = [];
for (const [before, after, names] of [
  ['/tmp/before-model-metadata.ts', '/app/packages/core/src/providers/published-models.ts', [
    'PublishedThinkingLevel', 'PUBLISHED_THINKING_LEVELS', 'PublishedModelMetadata', 'PricedTokenUsage',
    'TEXT_TOOLS', 'VISION_TOOLS', 'REASONING_VISION_TOOLS', 'PUBLISHED_MODEL_METADATA_VERSION', 'PUBLISHED_MODELS',
    'cloneMetadata', 'getPublishedProviders', 'getPublishedModels', 'getPublishedModelMetadata', 'calculatePublishedModelCost', 'calculateModelCost',
  ]],
  ['/tmp/before-model-metadata.ts', '/app/packages/core/src/providers/model-metadata.ts', [
    'STANDARD_REASONING_LEVELS', 'getSupportedThinkingLevels', 'clampPublishedThinkingLevel', 'inferModelCapabilities',
  ]],
  ['/tmp/before-api.ts', '/app/packages/web/src/services/api-transport.ts', [
    'MAX_CHAT_STREAM_CHUNK_BYTES', 'MAX_CHAT_STREAM_BYTES', 'MAX_CHAT_STREAM_EVENTS', 'CHAT_STREAM_IDLE_TIMEOUT_MS',
    'authToken', 'setAuthToken', 'utf8ByteLength', 'apiFetch', 'readChatStreamChunk', 'boundedSseRecords',
  ]],
  ['/tmp/before-tool-loop.ts', '/app/packages/core/src/agent/agent-errors.ts', ['AgentAbortError']],
]) {
  const left = declarations(before), right = declarations(after);
  for (const name of names) { assert.ok(left.has(name), name); assert.equal(right.get(name), left.get(name), name); checks.push(name); }
}
console.log(JSON.stringify({ equalDeclarations: checks.length, checks, limits: 'AST-printer equality of moved declarations/bodies; runtime/root/installed/browser identity still needs owning gates.' }, null, 2));
