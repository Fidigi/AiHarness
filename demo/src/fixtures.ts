import type { Message, ModelCatalogEntry } from '../../packages/core/src/types/index';

/** Entirely authored synthetic data, not captured user sessions or host files. */
export const fixtureDate = new Date('2026-01-01T12:00:00Z');
export const models: ModelCatalogEntry[] = [
  { key: 'mock/reviewer', provider: 'mock', id: 'reviewer', name: 'Workspace reviewer', available: true, enabled: true,
    source: 'configured', capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 32000 },
  { key: 'mock/writer', provider: 'mock', id: 'writer', name: 'Documentation helper', available: true, enabled: true,
    source: 'configured', capabilities: { reasoning: false, imageInput: false, toolCalls: true }, contextWindow: 16000 },
];
export const tools = [
  { name: 'read', description: 'Read one of the bundled synthetic files.' },
  { name: 'edit', description: 'Preview a fixed welcome-text edit in browser memory.' },
  { name: 'bash', description: 'Replay allowlisted terminal outputs; no command execution.' },
];
export const initialFiles: Record<string, string> = {
  'README.md': '# Garden board\n\nA synthetic community garden dashboard.\n\nWelcome, gardener!\n\n## Development\n\nRun `npm test` to check the sample card.\n',
  'src/GardenCard.tsx': 'export function GardenCard() {\n  return <article aria-label="Garden plot">\n    <h2>North bed</h2>\n    <p>Next watering: Thursday</p>\n  </article>;\n}\n',
  'src/garden.css': '.garden-card {\n  padding: 1rem;\n  border-radius: 0.75rem;\n  display: grid;\n  gap: 0.5rem;\n}\n',
  'tests/garden.test.ts': 'import { expect, test } from "vitest";\n\ntest("watering day is visible", () => {\n  expect("Next watering: Thursday").toContain("Thursday");\n});\n',
  'assets/garden.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120">\n  <rect width="240" height="120" rx="12" fill="#d5f5e6"/>\n  <path d="M120 100V40M120 70Q70 70 80 30Q120 30 120 70M120 60Q160 60 165 20Q120 20 120 60" fill="#14604a"/>\n</svg>\n',
};
export interface DemoSession { id: string; name: string; model: string; messages: Message[] }
export function message(id: string, role: Message['role'], content: string, name?: string): Message {
  return { id, role, content, timestamp: fixtureDate, ...(name ? { name } : {}) };
}
export function freshSessions(): DemoSession[] {
  return [
    { id: 'workspace-review', name: 'Review the garden board', model: models[0]!.key, messages: [
      message('review-user', 'user', 'Review this small dashboard for accessibility.'),
      message('review-tool', 'tool', initialFiles['src/GardenCard.tsx']!, 'read'),
      message('review-answer', 'assistant', '## A small, accessible start\n\nThe card has a heading and a descriptive landmark label. Keep the watering date as text, not color alone.\n\n- Test keyboard access before adding actions.\n- Keep spacing comfortable on small screens.\n\nThis is a **synthetic review**, not a live model response.'),
    ] },
    { id: 'welcome-copy', name: 'Improve the welcome copy', model: models[1]!.key, messages: [
      message('copy-user', 'user', 'Suggest friendlier wording for the welcome line.'),
      message('copy-answer', 'assistant', 'Try **Welcome to your community garden!**\n\nUse “Preview welcome edit” below to change the bundled README in browser memory, then inspect Git changes. Nothing is written to disk.'),
    ] },
  ];
}
