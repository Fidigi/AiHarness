import type { SkillContent } from '@ai-harness/core';
import { apiFetch, type ApiResponse } from './api';

/** Settings-only bounded Markdown read. Keep this out of the eager API barrel;
 * link text is query data, never an authenticated fetch destination. */
export async function getSkillContent(
  input: { key: string; cwd?: string; projectId?: string; href?: string; from?: string },
  signal?: AbortSignal,
): Promise<ApiResponse<SkillContent>> {
  try {
    const query = new URLSearchParams({ key: input.key });
    for (const field of ['cwd', 'projectId', 'href', 'from'] as const) {
      const value = input[field];
      if (value !== undefined) query.set(field, value);
    }
    const response = await apiFetch(`/api/skills/content?${query}`, { signal, cache: 'no-store' });
    const data = await response.json() as SkillContent & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.key !== input.key || typeof data.relativePath !== 'string' || typeof data.markdown !== 'string'
      || (data.fragment !== undefined && typeof data.fragment !== 'string')) throw new Error('Invalid skill content.');
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load skill content' };
  }
}
