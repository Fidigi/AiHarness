export { settingsSectionCategory, type SettingsCategory } from '../store/settings-navigation';

export const settingsCategories = [
  { id: 'general', section: 'appearance', icon: 'settings' },
  { id: 'models', section: 'providers', icon: 'globe' },
  { id: 'skills', section: 'skills', icon: 'file' },
  { id: 'tools', section: 'tools', icon: 'tool' },
  { id: 'plugins', section: 'plugins', icon: 'folder' },
  { id: 'subagents', section: 'subagents', icon: 'bot' },
  { id: 'mcp', section: 'mcp', icon: 'terminal' },
] as const;
