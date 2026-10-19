/** Router mount paths are same-origin paths, not Vite's optional asset/CDN URLs. */
export function navigationBasename(base: string): string {
  return /^\/(?!\/)[^\\?#\u0000-\u0020\u007f]*$/.test(base) ? base : '/';
}
