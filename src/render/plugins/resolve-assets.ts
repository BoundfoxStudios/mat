import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Root } from 'hast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import type { LinkFollower, RenderContext } from '../pipeline.ts';

/** hast property names: `srcset` arrives as `srcSet`. */
const URL_PROPERTIES: ReadonlyMap<string, readonly string[]> = new Map([
  ['a', ['href']],
  ['audio', ['src']],
  ['img', ['src', 'srcSet']],
  ['source', ['src', 'srcSet']],
  ['video', ['src', 'poster']],
]);

/**
 * Links are left out on purpose: a document routinely links to paths that only exist once it is
 * published, and warning about those trains the user to ignore the warnings that matter.
 */
const WARN_WHEN_MISSING: ReadonlySet<string> = new Set(['img', 'source', 'video', 'audio']);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A drive letter matches `HAS_SCHEME` as scheme `c`, so `C:/pics/logo.png` would be mistaken for
 * an absolute URL and never resolved. Only on Windows, though: joining a drive path onto a POSIX
 * base directory produces a path that is wrong in a new way.
 */
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;

function isAlreadyResolved(value: string): boolean {
  if (process.platform === 'win32' && WINDOWS_DRIVE_PATH.test(value)) {
    return false;
  }

  return (
    value === '' ||
    value.startsWith('#') ||
    value.startsWith('//') || // protocol-relative
    HAS_SCHEME.test(value)
  );
}

/**
 * Query and fragment are split off first: they belong to the URL, not to the path, and
 * `pathToFileURL` would percent-encode the `#` in `./other.md#section` into the file name.
 */
function splitSuffix(value: string): { path: string; suffix: string } | undefined {
  const separator = value.search(/[?#]/);
  const path = separator === -1 ? value : value.slice(0, separator);
  const suffix = separator === -1 ? '' : value.slice(separator);

  return path === '' ? undefined : { path, suffix };
}

interface LocalTarget {
  absolutePath: string;
  suffix: string;
}

function parseLocalTarget(
  value: string,
  baseDir: string,
): (LocalTarget & { decodedPath: string }) | undefined {
  if (isAlreadyResolved(value)) {
    return undefined;
  }

  const split = splitSuffix(value);

  if (split === undefined) {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(split.path);
  } catch {
    decoded = split.path;
  }

  // `pathToFileURL` silently resolves a relative input against the cwd rather than throwing, and
  // the cwd is wherever the user happened to run `mat` from.
  return { absolutePath: resolve(baseDir, decoded), suffix: split.suffix, decodedPath: decoded };
}

function toFileUrl(value: string, baseDir: string): string {
  const target = parseLocalTarget(value, baseDir);

  return target === undefined
    ? value
    : `${pathToFileURL(target.absolutePath).href}${target.suffix}`;
}

const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

/**
 * On Windows the url policy has already turned drive-letter paths like `C:/docs/setup.md` into
 * `file:` URLs by the time this plugin runs, so following them means reading the path back out of
 * URL form. Literal `file:` links in a document take the same route.
 */
function parseFileUrlTarget(value: string): LocalTarget | undefined {
  if (!/^file:/i.test(value)) {
    return undefined;
  }

  const split = splitSuffix(value);

  if (split === undefined) {
    return undefined;
  }

  try {
    return { absolutePath: fileURLToPath(split.path), suffix: split.suffix };
  } catch {
    return undefined;
  }
}

function followedUrl(
  target: LocalTarget,
  value: string,
  follower: LinkFollower,
  file: VFile,
  keptUrl: string,
): string {
  const admission = follower.admit(target.absolutePath);

  if ('problem' in admission) {
    file.message(`${value}: ${admission.problem}, the link is not followed`);

    return keptUrl;
  }

  return `${admission.previewUrl}${target.suffix}`;
}

function resolveAnchor(value: string, context: RenderContext, file: VFile): string {
  const follower = context.followLinks;
  const local = parseLocalTarget(value, context.baseDir);

  if (local === undefined) {
    if (follower === undefined) {
      return value;
    }

    const fileUrl = parseFileUrlTarget(value);

    return fileUrl === undefined || !MARKDOWN_EXTENSION.test(fileUrl.absolutePath)
      ? value
      : followedUrl(fileUrl, value, follower, file, value);
  }

  const sourceUrl = `${pathToFileURL(local.absolutePath).href}${local.suffix}`;

  // Tested on the path component as written, not the resolved path: `resolve` strips a trailing
  // slash, and `setup.md/` names a directory, not a document.
  if (follower === undefined || !MARKDOWN_EXTENSION.test(local.decodedPath)) {
    return sourceUrl;
  }

  return followedUrl(local, value, follower, file, sourceUrl);
}

/**
 * A `data:` URL contains commas of its own, so a `srcset` holding one is left untouched rather
 * than split at the wrong place. Nothing is lost: `data:` URLs need no resolving.
 */
function resolveSourceSet(value: string, baseDir: string): string {
  if (/(^|,)\s*data:/i.test(value)) {
    return value;
  }

  return value
    .split(',')
    .map((candidate) => {
      const match = candidate.match(/^(\s*)(\S+)(.*)$/s);

      if (!match) {
        return candidate;
      }

      const [, leading = '', url = '', trailing = ''] = match;

      return `${leading}${toFileUrl(url, baseDir)}${trailing}`;
    })
    .join(',');
}

/**
 * The obvious alternative, a single `<base href>` in the document head, is wrong: it also resolves
 * `<a href="#heading">` against the base, so every table-of-contents link and every footnote
 * backreference navigates to a directory listing instead of scrolling. Measured in all three
 * engines.
 */
export function rehypeResolveAssets() {
  return (tree: Root, file: VFile): void => {
    const context = file.data.matContext;

    if (context?.linkMode !== 'absolute') {
      return;
    }

    visit(tree, 'element', (node) => {
      const properties = URL_PROPERTIES.get(node.tagName);

      if (!properties || !node.properties) {
        return;
      }

      for (const property of properties) {
        const value = node.properties[property];

        if (typeof value !== 'string') {
          continue;
        }

        const resolved =
          property === 'srcSet'
            ? resolveSourceSet(value, context.baseDir)
            : node.tagName === 'a'
              ? resolveAnchor(value, context, file)
              : toFileUrl(value, context.baseDir);

        node.properties[property] = resolved;

        if (
          WARN_WHEN_MISSING.has(node.tagName) &&
          resolved !== value &&
          property !== 'srcSet' &&
          !existsSync(fileURLToPath(resolved.replace(/[?#].*$/s, '')))
        ) {
          file.message(`${value}: no such file, the ${node.tagName} will not load`);
        }
      }
    });
  };
}
