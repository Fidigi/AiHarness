#!/usr/bin/env bash
# Validate local Markdown links and versioning boundaries in docs/ and the root README.
# Usage: scripts/check-doc-versioning.sh [docs-dir] [--predictive]

set -euo pipefail

DOCS_DIR="${1:-docs}"
MODE=live
for argument in "$@"; do
  if [[ "$argument" == "--predictive" ]]; then MODE=predictive; fi
done

node - "$DOCS_DIR" "$MODE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const docsDir = path.resolve(process.argv[2]);
const mode = process.argv[3];
const root = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const relative = absolute => path.relative(root, absolute).split(path.sep).join('/');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function ignored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relative(file)], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tracked(file) {
  return Boolean(git(['ls-files', '--error-unmatch', '--', relative(file)]));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const current = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(current) : [current];
  });
}

if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
  console.error(`Documentation directory not found: ${docsDir}`);
  process.exit(1);
}

const candidates = mode === 'predictive'
  ? walk(docsDir).filter(file => file.endsWith('.md') && !ignored(file))
  : git(['ls-files', '--', relative(docsDir)])
      .split('\n')
      .filter(file => file.endsWith('.md'))
      .map(file => path.join(root, file));
const rootReadme = path.join(root, 'README.md');
if (fs.existsSync(rootReadme) && (mode === 'predictive' ? !ignored(rootReadme) : tracked(rootReadme))) {
  candidates.push(rootReadme);
}

const files = [...new Set(candidates)].sort();
const errors = [];
const anchorCache = new Map();
let links = 0;

function headingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/\\([\\`*_[\]{}()#+.!~-])/gu, '$1')
    .replace(/\uFE0F/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const result = new Set();
  const occurrences = new Map();
  let fence;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
    if (!heading) continue;
    const base = headingSlug(heading[1]);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    result.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  anchorCache.set(file, result);
  return result;
}

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;

    // Remove inline-code contents while retaining surrounding Markdown links.
    const visible = line.replace(/`[^`]*`/g, match => ' '.repeat(match.length));
    const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of visible.matchAll(pattern)) {
      let reference = match[1].trim();
      if (!reference) continue;
      if (reference.startsWith('<') && reference.includes('>')) {
        reference = reference.slice(1, reference.indexOf('>'));
      } else {
        reference = reference.split(/\s+["']/u, 1)[0];
      }
      if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) || reference.startsWith('//')) continue;

      const fragmentIndex = reference.indexOf('#');
      const rawPath = (fragmentIndex === -1 ? reference : reference.slice(0, fragmentIndex)).split('?', 1)[0];
      const rawFragment = fragmentIndex === -1 ? undefined : reference.slice(fragmentIndex + 1);
      let decodedPath;
      let decodedFragment;
      try { decodedPath = decodeURIComponent(rawPath); }
      catch { decodedPath = rawPath; }
      try { decodedFragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment); }
      catch { decodedFragment = rawFragment; }
      const target = decodedPath ? path.resolve(path.dirname(file), decodedPath) : file;
      links++;

      if (!fs.existsSync(target)) {
        errors.push(`${relative(file)}:${index + 1}: broken link '${reference}' (${relative(target)} does not exist)`);
        continue;
      }
      if (!target.startsWith(`${root}${path.sep}`) && target !== root) continue;
      if (ignored(target)) {
        errors.push(`${relative(file)}:${index + 1}: '${reference}' points to ignored content (${relative(target)})`);
        continue;
      }
      if (mode === 'live' && fs.statSync(target).isFile() && !tracked(target)) {
        errors.push(`${relative(file)}:${index + 1}: '${reference}' points to an untracked file (${relative(target)})`);
      }
      if (decodedFragment && fs.statSync(target).isFile() && target.endsWith('.md') && !anchors(target).has(decodedFragment)) {
        errors.push(`${relative(file)}:${index + 1}: '${reference}' points to a missing Markdown anchor in ${relative(target)}`);
      }
    }
  }
}

console.log(`Checked ${files.length} Markdown files and ${links} local links (${mode} mode).`);
if (errors.length) {
  console.error(`Found ${errors.length} documentation violation(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('Documentation links and versioning boundaries are valid.');
NODE
