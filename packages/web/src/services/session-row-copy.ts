import { apiFetch, type ApiResponse, type ApiSession } from './api';
import type { DisplayedSessionCopyTarget } from '../components/session-row-copy-target';

/** Fixed native endpoint; captured cwd is a source comparison, not an execution
 * root or destination. Never fall back to generic clone or retry a refusal. */
export async function copyDisplayedSession(
  target: Readonly<DisplayedSessionCopyTarget>, signal?: AbortSignal,
): Promise<ApiResponse<ApiSession>> {
  try {
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(target.sessionId)}/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ entryId: target.entryId, expectedCwd: target.cwd }),
    });
    if (!response.ok) return { success: false, error: 'Displayed session entry could not be copied.' };
    const data = await response.json() as ApiSession;
    if (!data || typeof data.id !== 'string' || !data.id || data.id === target.sessionId || data.cwd !== target.cwd
      || data.metadata?.clonedFromSessionId !== target.sessionId || data.metadata?.clonedFromEntryId !== target.entryId) {
      return { success: false, error: 'Displayed session entry could not be copied.' };
    }
    return { success: true, data };
  } catch {
    return { success: false, error: 'Displayed session entry could not be copied.' };
  }
}
