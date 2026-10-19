import { describe, expect, it } from 'vitest';
import { navigationBasename } from './navigation-base.js';

describe('same-origin router mounts are distinct from asset destinations', () => {
  it.each(['/', '/navigation', '/navigation/', '/nested/worktree/'])('retains explicit path %s', base => {
    expect(navigationBasename(base)).toBe(base);
  });
  it.each(['', './', 'https://cdn.example/assets/', '//cdn.example/assets/', '/\\foreign/', '/path?token=PRIVATE', '/path#fragment', '/line\nbreak/', '/space path/'])('uses root instead of unsupported asset URL/control base %j', base => {
    expect(navigationBasename(base)).toBe('/');
  });
});
