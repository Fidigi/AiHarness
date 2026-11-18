import type { AiProvider } from './index.js';
import type { PublishedModelMetadata } from './published-models.js';

type Source = Pick<AiProvider, 'getPublishedModels' | 'getModelApi'>;
const readers = new WeakMap<Source, {
  list: Source['getPublishedModels'];
  prototype: object | null;
  read(model: string): readonly PublishedModelMetadata[];
}>();

/** Internal original-owner optimization, not a metadata snapshot or provider grant. */
export function registerPublishedModelReader(
  source: Source,
  list: Source['getPublishedModels'],
  read: (model: string) => readonly PublishedModelMetadata[],
): void {
  readers.set(source, { list, prototype: Object.getPrototypeOf(source), read });
}

/** Every call rechecks method identity and reads current owner state, including withdrawal. */
export function readOwnedPublishedModel(source: Source, model: string): readonly PublishedModelMetadata[] | undefined {
  const reader = readers.get(source);
  if (!reader) return undefined;
  // Do not invoke an overridden accessor merely to decide whether to optimize.
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== reader.prototype) return undefined;
  const method = Object.getOwnPropertyDescriptor(source, 'getPublishedModels')
    ?? (prototype ? Object.getOwnPropertyDescriptor(prototype, 'getPublishedModels') : undefined);
  return method?.value === reader.list ? reader.read(model) : undefined;
}
