// ============================================================
// Utility Functions
// ============================================================

/** Generate a unique ID */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Format a date to readable string */
export function formatDate(date: Date): string {
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Truncate text to max length */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/** Sleep for a given duration */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deep clone an object */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}
