/**
 * Every version here was verified by rendering with it. A range would let a patch release change a
 * class name or a plugin default without a single line of the repository changing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const manifestPath = join(import.meta.dir, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const loose: string[] = [];

for (const field of ['dependencies', 'devDependencies'] as const) {
  for (const [name, version] of Object.entries(manifest[field] ?? {})) {
    if (!EXACT_VERSION.test(version)) {
      loose.push(`${field}.${name}: ${version}`);
    }
  }
}

if (loose.length > 0) {
  process.stderr.write(
    `Not pinned to an exact version:\n${loose.map((entry) => `  ${entry}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `all ${Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length} dependencies are pinned\n`,
);
