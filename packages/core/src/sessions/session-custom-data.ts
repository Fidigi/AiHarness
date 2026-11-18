/** New custom-entry inputs are own JSON data, never getters, prototypes or executable objects. */
export function copySessionCustomValue(value: unknown, maxBytes = 1024 * 1024): unknown {
  let nodes = 0;
  let bytes = 0;
  const visiting = new Set<object>();
  const fail = (): never => { throw new Error('Custom session data is invalid.'); };
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 65_536 || depth > 32) return fail();
    bytes += typeof item === 'string' ? Buffer.byteLength(item) : 8;
    if (bytes > maxBytes) return fail();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : fail();
    if (!item || typeof item !== 'object' || visiting.has(item)) return fail();
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype
      : Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return fail();
    visiting.add(item);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return fail();
      bytes += Buffer.byteLength(key) + 4;
      if (bytes > maxBytes) return fail();
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property) || !property.enumerable) return fail();
      if (array && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) !== (result as unknown[]).length)) return fail();
      Object.defineProperty(result, key, { value: copy(property.value, depth + 1), enumerable: true,
        writable: true, configurable: true });
    }
    if (array && (result as unknown[]).length !== item.length) return fail();
    visiting.delete(item);
    return result;
  };
  if (value === undefined) return undefined;
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) return fail();
  return result;
}
