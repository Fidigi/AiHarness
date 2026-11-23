/** Handwritten browser-test contract; the fixture uses the emitted public packages. */
export function workspaceDefaultServer(kind?: 'missing' | 'relative' | 'removed-during-start'): Promise<{
  cwd: string;
  url: string;
  marker: string;
  projectMarker: string;
  close(): Promise<void>;
}>;
