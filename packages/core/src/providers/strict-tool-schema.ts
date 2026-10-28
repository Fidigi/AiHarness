export class UnsupportedStrictToolSchema extends Error {}
const schemaRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupportedStrictKeys = ['$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'patternProperties', 'dependentSchemas', 'dependencies',
  'unevaluatedProperties', 'propertyNames', 'contains', 'prefixItems', 'not', 'if', 'then', 'else'];
function schemaAllowsNull(value: unknown): boolean {
  return schemaRecord(value) && (value.type === 'null' || (Array.isArray(value.type) && value.type.includes('null'))
    || value.const === null || (Array.isArray(value.enum) && value.enum.includes(null))
    || (Array.isArray(value.anyOf) && value.anyOf.some(schemaAllowsNull)));
}
/** Pinned JSON-schema strict subset: close objects, require fields and make optional fields nullable without mutation. */
export function makeStrictToolSchema(parameters: Record<string, unknown>, isUnsupportedKeyword?: (key: string, value: unknown) => boolean): Record<string, unknown> {
  const schema: unknown = structuredClone(parameters);
  const unsupported = (): never => { throw new UnsupportedStrictToolSchema(); };
  const visit = (value: unknown): void => {
    if (!schemaRecord(value)) return unsupported();
    if (unsupportedStrictKeys.some(key => value[key] !== undefined)) unsupported();
    if (isUnsupportedKeyword && Object.entries(value).some(([key, item]) => isUnsupportedKeyword(key, item))) unsupported();
    if (value.anyOf !== undefined) {
      if (!Array.isArray(value.anyOf) || value.anyOf.length === 0) return unsupported();
      for (const member of value.anyOf) {
        if (schemaRecord(member)) {
          const types = Array.isArray(member.type) ? member.type : [member.type];
          if (types.includes('object') || types.includes('array') || member.properties !== undefined || member.items !== undefined) unsupported();
        }
        visit(member);
      }
    }
    if (value.items !== undefined) { if (Array.isArray(value.items)) unsupported(); visit(value.items); }
    if (value.properties !== undefined && value.type !== 'object') unsupported();
    if (value.type !== 'object') return;
    if (value.additionalProperties !== undefined && value.additionalProperties !== false) unsupported();
    if (value.properties !== undefined && !schemaRecord(value.properties)) unsupported();
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string'))) unsupported();
    const properties = (value.properties ?? {}) as Record<string, unknown>, names = Object.keys(properties);
    const required = new Set((value.required ?? []) as string[]);
    if ([...required].some(key => !names.includes(key))) unsupported();
    for (const key of names) {
      const property = properties[key]; visit(property);
      if (!required.has(key) && !schemaAllowsNull(property)) properties[key] = { anyOf: [property, { type: 'null' }] };
    }
    value.required = names; value.additionalProperties = false;
  };
  visit(schema);
  if (!schemaRecord(schema) || schema.type !== 'object') return unsupported();
  return schema;
}
