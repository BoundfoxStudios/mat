import { pathToFileURL } from 'node:url';
import type { Root } from 'hast';
import { visit } from 'unist-util-visit';

const URL_PROPERTIES: ReadonlySet<string> = new Set(['cite', 'href', 'longDesc', 'src', 'srcSet']);

const URL_LIST_PROPERTIES: ReadonlySet<string> = new Set(['srcSet']);

// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject
const LEADING_IGNORED = /^[\u0000-\u0020\u007f]+/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject
const SCHEME = /^([a-z][a-z0-9+.\-\u0000-\u0020\u007f]*):/i;

/** A drive letter parses as the scheme `c:`, which no allowlist will ever contain. */
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;

/**
 * Rewrites a URL into the one shape the sanitiser can judge.
 *
 * `hast-util-sanitize` compares schemes case-sensitively and against the literal prefix, so
 * `HTTPS://example.com` and `java\tscript:alert(1)` are both invisible to it — the first would
 * lose a perfectly good link, the second would keep a live one.
 */
function normaliseScheme(value: string): string {
  const trimmed = value.replace(LEADING_IGNORED, '');

  if (process.platform === 'win32' && WINDOWS_DRIVE_PATH.test(trimmed)) {
    return pathToFileURL(trimmed).href;
  }

  const match = trimmed.match(SCHEME);

  if (!match?.[1]) {
    return trimmed;
  }

  const scheme = match[1].replace(IGNORED_IN_SCHEME, '').toLowerCase();

  return `${scheme}:${trimmed.slice(match[0].length)}`;
}

/**
 * The three things an element allowlist cannot express.
 *
 * `javascript:` and `vbscript:` are checked here rather than left to the allowlist: the schema
 * cannot see inside a `srcset`, where the executable URL is the second candidate of a
 * comma-separated list and the first one is innocent.
 */
function isBlocked(value: string): boolean {
  if (value.startsWith('//')) {
    return true;
  }

  if (/^(?:javascript|vbscript):/i.test(value)) {
    return true;
  }

  return /^data:/i.test(value) && !/^data:image\//i.test(value);
}

export function rehypeUrlPolicy() {
  return (tree: Root): void => {
    visit(tree, 'element', (node) => {
      const { properties } = node;

      if (!properties) {
        return;
      }

      for (const [name, value] of Object.entries(properties)) {
        if (!URL_PROPERTIES.has(name)) {
          continue;
        }

        const entries = Array.isArray(value) ? value : [value];
        const rewritten: Array<string | number> = [];
        let blocked = false;

        for (const entry of entries) {
          if (typeof entry !== 'string') {
            if (typeof entry === 'number') {
              rewritten.push(entry);
            }

            continue;
          }

          if (!URL_LIST_PROPERTIES.has(name)) {
            const normalised = normaliseScheme(entry);
            blocked ||= isBlocked(normalised);
            rewritten.push(normalised);
            continue;
          }

          // A `data:` URL carries commas of its own, so a list holding one cannot be split into
          // candidates without corrupting it. Such a value is judged whole and left as written.
          if (/data:/i.test(entry)) {
            blocked ||= /data:(?!image\/)/i.test(entry) || /(javascript|vbscript):/i.test(entry);
            rewritten.push(entry);
            continue;
          }

          rewritten.push(
            entry
              .split(',')
              .map((candidate) => {
                const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
                const normalised = normaliseScheme(url);
                blocked ||= isBlocked(normalised);

                return [normalised, ...descriptor].join(' ');
              })
              .join(', '),
          );
        }

        if (blocked) {
          delete properties[name];
        } else {
          properties[name] = Array.isArray(value) ? rewritten : (rewritten[0] ?? '');
        }
      }
    });
  };
}
