import type { CustomModelDefinition, ModelCapabilities, ModelPricing } from '../types/index.js';

type EditorSchema = Record<string, unknown>;
type EditableField = Exclude<keyof CustomModelDefinition, 'key' | 'createdAt' | 'updatedAt'>;
const text = (maxLength: number): EditorSchema => ({ type: 'string', minLength: 1, maxLength,
  'x-maxUtf16CodeUnits': maxLength, allOf: [{ pattern: '\\S' }, { pattern: '^[^\\u0000-\\u001f\\u007f]*$' }] });
const limit = (): EditorSchema => ({ anyOf: [{ type: 'integer', minimum: 1, maximum: 100_000_000 }, { type: 'null' }, { const: '' }] });
const price = (): EditorSchema => ({ anyOf: [{ type: 'number', minimum: 0, maximum: 1_000_000 }, { type: 'null' }, { const: '' }] });

/** Owned editor shape for native public model-registration metadata. This is
 * neither a CLI models.json format nor the private credential registry schema.
 * Runtime membership, normalization, defaults and write authority remain native. */
export function getCustomModelEditorSchema(): EditorSchema {
  const capabilityProperties = { reasoning: { type: 'boolean' }, imageInput: { type: 'boolean' }, toolCalls: { type: 'boolean' } } satisfies Record<keyof ModelCapabilities, EditorSchema>;
  const pricingProperties = { inputPerMillion: price(), outputPerMillion: price(), cacheReadPerMillion: price(), cacheWritePerMillion: price() } satisfies Record<keyof ModelPricing, EditorSchema>;
  const properties = {
    provider: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[a-z][a-z0-9_-]{1,63}$',
      description: 'Canonical existing built-in/custom provider id. Membership remains runtime state.' },
    id: text(500), name: text(500),
    capabilities: { type: 'object', properties: capabilityProperties, additionalProperties: false },
    contextWindow: limit(), maxOutputTokens: limit(),
    pricing: { type: 'object', properties: pricingProperties, additionalProperties: false },
    compatibility: { type: 'object', maxProperties: 50, propertyNames: { pattern: '^[a-zA-Z][\\w.-]{0,99}$', maxLength: 100 },
      additionalProperties: { anyOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string', maxLength: 1000, 'x-maxUtf16CodeUnits': 1000 }] } },
  } satisfies Record<EditableField, EditorSchema>;
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:ai-harness:schemas:custom-model:1',
    title: 'AiHarness native model-registration metadata', type: 'object', properties, required: ['provider', 'id'], additionalProperties: false,
    description: 'Editor data for one explicit native POST /api/provider-registry/models registration (or a complete update body). Not a CLI configuration loader, models.json file, private providers.json or secret store. Runtime enforces UTF-16 bounds, provider membership, stateful defaults, authentication/capabilities/Origin and persistence. Optional empty/null numeric values defer to native fallback; omitted fields are not invented defaults. Canonical typed editor values deliberately flag unknown/inert/coerced API extras; they do not change native input compatibility.' };
}
