/** Restrict bases to unencoded path segments; never accept URLs, traversal or protocol-relative paths. */
export function validateBase(value = '/') {
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) {
    throw new Error('Demo base must be / or slash-delimited alphanumeric, underscore or hyphen segments with a trailing slash.');
  }
  return value;
}

export function pagesBase(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid GitHub repository identity.');
  }
  const [owner, name] = repository.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '/' : validateBase(`/${name}/`);
}

if (process.argv[1]?.endsWith('/base-path.mjs')) console.log(pagesBase(process.env.GITHUB_REPOSITORY));
