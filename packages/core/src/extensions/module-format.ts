/** Executable entry formats shared by module discovery and package activation.
 * Declaration files are metadata, never extension factories. */
export function isExtensionModulePath(file: string): boolean {
  return /\.(?:[cm]?js|[cm]?ts|tsx)$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file);
}

export function isTypeScriptExtensionPath(file: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file);
}
