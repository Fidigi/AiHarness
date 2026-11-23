let loaded: Promise<void> | undefined;

/** Retain success AND rejection: an ESM/preload failure requires a page reload,
 * not a reopen that incorrectly assumes the feature was registered. */
export function loadSettingsLocales(): Promise<void> {
  return loaded ??= import('./settings-locale').then(module => module.registerSettingsLocales());
}
