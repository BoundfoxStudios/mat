import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

/**
 * On a `file://` URL the browser blocks every static and dynamic `import()`, so mermaid's ESM
 * entry point (38 dynamic imports) is unusable; only `dist/mermaid.min.js`, an esbuild IIFE
 * reachable solely through the package's `"./*"` catch-all export, works. That build is
 * undocumented and mermaid v10 dropped it once already (mermaid-js/mermaid#4279, restored by
 * #4281) — hence vendored, pinned, and guarded here against a routine dependency bump.
 */

const VENDORED_MERMAID_PATH = join(import.meta.dir, '..', 'vendor', 'mermaid-11.16.1.min.js');
const EXPECTED_BYTE_LENGTH = 3_566_058;

const source = readFileSync(VENDORED_MERMAID_PATH, 'utf8');

describe('vendored mermaid bundle', () => {
  test('is the exact pinned artifact', () => {
    expect(Buffer.byteLength(source, 'utf8')).toBe(EXPECTED_BYTE_LENGTH);
  });

  test('parses as a classic script', () => {
    // Not `eval()`: the bundle's leading "use strict" gives `var` its own variable environment, so
    // `window.eval()` fails on it where a script tag succeeds.
    expect(() => new Script(source)).not.toThrow();
  });

  test('publishes itself on globalThis', () => {
    expect(source).toContain('globalThis["mermaid"]');
  });

  test('contains no dynamic import', () => {
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  test('contains no import.meta', () => {
    expect(source).not.toContain('import.meta');
  });

  test('contains no worker or network bootstrapping', () => {
    expect(source).not.toContain('new Worker');
    expect(source).not.toContain('importScripts');
  });
});
