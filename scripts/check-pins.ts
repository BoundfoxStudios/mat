/**
 * Every version here was verified by rendering with it. A range would let a patch release change a
 * class name or a plugin default without a single line of the repository changing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `overrides` too: it decides a version for the whole tree, so a range there drifts just as far. */
const FIELDS = ['dependencies', 'devDependencies', 'overrides'] as const;

const manifestPath = join(import.meta.dir, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  [field in (typeof FIELDS)[number]]?: Record<string, string>;
};

const loose: string[] = [];

for (const field of FIELDS) {
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

const count = FIELDS.reduce((total, field) => total + Object.keys(manifest[field] ?? {}).length, 0);

process.stdout.write(`all ${count} version specifiers are pinned\n`);
