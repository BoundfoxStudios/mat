// One competing writer, spawned by the concurrency test in `tests/cache.test.ts`.

import { cacheAsset } from '../../src/assets/cache.ts';

const [, , baseName, extension, size] = process.argv;

if (!baseName || !extension || !size) {
  throw new Error('usage: cache-writer.ts <baseName> <extension> <size>');
}

const contents = 'x'.repeat(Number(size));

process.stdout.write(cacheAsset(baseName, extension, contents));
