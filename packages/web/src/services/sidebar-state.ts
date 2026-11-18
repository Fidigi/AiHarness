import type { SidebarChange, SidebarMutationResult, SidebarState } from '@ai-harness/core';
import { apiFetch, type ApiResponse } from './api.js';

export async function sidebarRequest(body?: { revision: string; change?: SidebarChange; undoToken?: string }, signal?: AbortSignal): Promise<ApiResponse<SidebarMutationResult>> {
  try {
    const response = await apiFetch('/api/sessions/ui-state', body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
      : { signal });
    const data = await response.json();
    if (!response.ok) return { success: false, code: data.code, error: 'Sidebar state unavailable' };
    return { success: true, data: body ? data as SidebarMutationResult : { state: data as SidebarState } };
  } catch { return { success: false, error: 'Sidebar state unavailable' }; }
}
