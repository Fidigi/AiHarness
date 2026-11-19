import type { SettingsSection } from '../store/settings-navigation';
export { settingsSectionCategory, type SettingsCategory } from '../store/settings-navigation';

export const generalSettingsPanels = [
  { section: 'appearance', label: 'settings.appearance' },
  { section: 'behavior', label: 'settings.behavior' },
  { section: 'notifications', label: 'settings.notificationPreferences' },
  { section: 'authentication', label: 'settings.access' },
  { section: 'about', label: 'settings.about' },
] as const;
export type GeneralSettingsPanel = typeof generalSettingsPanels[number]['section'];

export function generalSettingsPanel(section: SettingsSection): GeneralSettingsPanel {
  if (section === 'defaults' || section === 'shortcuts') return 'behavior';
  if (section === 'sessions') return 'about';
  return generalSettingsPanels.find(panel => panel.section === section)?.section ?? 'appearance';
}

export const settingsCategories = [
  { id: 'general', section: 'appearance', icon: 'settings' },
  { id: 'models', section: 'providers', icon: 'globe' },
  { id: 'skills', section: 'skills', icon: 'file' },
  { id: 'tools', section: 'tools', icon: 'tool' },
  { id: 'plugins', section: 'plugins', icon: 'folder' },
  { id: 'subagents', section: 'subagents', icon: 'bot' },
  { id: 'mcp', section: 'mcp', icon: 'terminal' },
] as const;
