import { useState } from 'react';
import { useSessionStore } from './session-store';
import {
  readSettingsNavigation, settingsScopeForContext, writeSettingsNavigation,
  type SettingsScope, type SettingsScopeControl,
} from './settings-navigation';

/** Scope is navigation intent only; every read/write still goes through the canonical API. */
export function useSettingsScope(control: SettingsScopeControl, fallback: SettingsScope): [SettingsScope, (scope: SettingsScope) => void] {
  const cwd = useSessionStore(state => state.workspace?.cwd);
  const [scope, update] = useState(() => settingsScopeForContext(readSettingsNavigation(cwd).scopes[control], cwd, fallback));
  const selected = settingsScopeForContext(scope, cwd, fallback);
  return [selected, next => {
    const value = settingsScopeForContext(next, cwd, fallback);
    update(value);
    const current = readSettingsNavigation(cwd);
    writeSettingsNavigation(cwd, { ...current, scopes: { ...current.scopes, [control]: value } });
  }];
}
