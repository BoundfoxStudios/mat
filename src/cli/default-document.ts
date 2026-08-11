import { statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_DOCUMENTS: readonly string[] = [
  'index.md',
  'README.md',
  'docs/index.md',
  'docs/README.md',
  'SPEC.md',
];

export function findDefaultDocument(directory: string): string | undefined {
  for (const candidate of DEFAULT_DOCUMENTS) {
    const path = join(directory, candidate);

    try {
      if (statSync(path).isFile()) {
        return path;
      }
    } catch {}
  }

  return undefined;
}
