import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_DOCUMENTS: readonly string[] = [
  'index.md',
  'README.md',
  'docs/index.md',
  'docs/README.md',
  'SPEC.md',
];

export function findDefaultDocument(
  directory: string,
  candidates: readonly string[] = DEFAULT_DOCUMENTS,
): string | undefined {
  for (const candidate of candidates) {
    // `resolve`, not `join`: a configured candidate may be an absolute path.
    const path = resolve(directory, candidate);

    try {
      if (statSync(path).isFile()) {
        return path;
      }
    } catch {}
  }

  return undefined;
}
