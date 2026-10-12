import {
  collectProviderModelCatalog,
  filterModels,
  flattenModelCatalog,
  type AiProvider,
  type ModelCatalogEntry,
} from '@ai-harness/core';

function tokenCount(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}

function table(models: readonly ModelCatalogEntry[]): string {
  const rows = models.map(model => ({
    provider: model.provider,
    model: model.id,
    context: tokenCount(model.contextWindow),
    maxOut: tokenCount(model.maxOutputTokens),
    thinking: model.capabilities.reasoning ? 'yes' : 'no',
    images: model.capabilities.imageInput ? 'yes' : 'no',
  }));
  const headers = { provider: 'provider', model: 'model', context: 'context', maxOut: 'max-out', thinking: 'thinking', images: 'images' };
  const widths = Object.fromEntries(Object.keys(headers).map(key => {
    const column = key as keyof typeof headers;
    return [column, Math.max(headers[column].length, ...rows.map(row => row[column].length))];
  })) as Record<keyof typeof headers, number>;
  return [headers, ...rows].map(row => [
    row.provider.padEnd(widths.provider),
    row.model.padEnd(widths.model),
    row.context.padEnd(widths.context),
    row.maxOut.padEnd(widths.maxOut),
    row.thinking.padEnd(widths.thinking),
    row.images.padEnd(widths.images),
  ].join('  ').trimEnd()).join('\n');
}

/** Produce --list-models output from the same catalogue used by RPC and Web. */
export async function formatConfiguredModelList(
  providers: ReadonlyMap<string, AiProvider>,
  search?: string,
): Promise<string> {
  const catalog = await collectProviderModelCatalog(providers, {
    timeoutMs: 2_000,
    retries: 0,
  });
  const available = flattenModelCatalog(catalog).filter(model => model.available);
  const filtered = filterModels(available, search).sort((left, right) => (
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id)
  ));
  if (!filtered.length) {
    return search?.trim()
      ? `No models matching "${search.trim()}"`
      : 'No models available. Configure a provider and try again.';
  }
  return table(filtered);
}
