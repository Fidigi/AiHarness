import { selectResourceFiles, type ScopedFileSelector } from '../resources/file-selectors.js';

export { isResourcePathWithin as isExtensionPathWithin } from '../resources/file-selectors.js';
export type ExtensionModuleSelector = ScopedFileSelector;

/** Preserve extension policy and diagnostics over the shared metadata engine. */
export async function selectExtensionFiles(
  initial: readonly string[],
  selectors: readonly ExtensionModuleSelector[],
  options: {
    cwd: string;
    allowed(candidate: string): boolean;
    discover(candidate: string, directoryOnly?: boolean): Promise<string[]>;
  },
): Promise<string[]> {
  return selectResourceFiles(initial, selectors, {
    cwd: options.cwd,
    allowed: options.allowed,
    discover: options.discover,
  });
}
