import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/cli/logger.ts';
import { startUpdateCheck, type UpdateCheckOptions } from '../src/cli/update-check.ts';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-update-check-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;

function harness(overrides: Partial<UpdateCheckOptions> = {}) {
  const lines: string[] = [];
  let fetchCalls = 0;

  const check = startUpdateCheck({
    enabled: true,
    currentVersion: '1.0.0',
    logger: createLogger((text) => lines.push(text), false),
    cacheDirectory: scratch,
    now: () => NOW,
    fetchLatestTag: () => {
      fetchCalls++;

      return Promise.resolve('v1.2.0');
    },
    ...overrides,
  });

  return { check, output: () => lines.join(''), fetchCalls: () => fetchCalls };
}

function cachePath(directory = scratch): string {
  return join(directory, 'update-check.json');
}

function readCache(directory = scratch): unknown {
  return JSON.parse(readFileSync(cachePath(directory), 'utf8'));
}

describe('update check', () => {
  test('logs when the fetched release is newer', async () => {
    const { check, output } = harness();

    await check.settled;
    check.report();

    expect(output()).toContain('update available: 1.0.0 → 1.2.0');
  });

  test('stays silent when the release is not newer', async () => {
    for (const tag of ['v1.0.0', 'v0.9.9']) {
      const directory = join(scratch, tag);
      let fetchCalls = 0;
      const { check, output } = harness({
        cacheDirectory: directory,
        fetchLatestTag: () => {
          fetchCalls++;

          return Promise.resolve(tag);
        },
      });

      await check.settled;
      check.report();

      // One fetch per iteration proves the verdict came from this tag, not from a cache hit.
      expect(fetchCalls).toBe(1);
      expect(output()).toBe('');
      expect(readCache(directory)).toEqual({
        checkedAt: NOW,
        latestVersion: tag.slice(1),
      });
    }
  });

  test('writes the cache after a successful fetch', async () => {
    const { check } = harness();

    await check.settled;

    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: '1.2.0' });
  });

  test('answers from a fresh cache without fetching', async () => {
    writeFileSync(
      cachePath(),
      JSON.stringify({ checkedAt: NOW - ONE_HOUR, latestVersion: '2.0.0' }),
    );

    const { check, output, fetchCalls } = harness();

    await check.settled;
    check.report();

    expect(fetchCalls()).toBe(0);
    expect(output()).toContain('update available: 1.0.0 → 2.0.0');
  });

  test('refetches when the cache is stale', async () => {
    writeFileSync(
      cachePath(),
      JSON.stringify({ checkedAt: NOW - 25 * ONE_HOUR, latestVersion: '2.0.0' }),
    );

    const { check, output, fetchCalls } = harness();

    await check.settled;
    check.report();

    expect(fetchCalls()).toBe(1);
    expect(output()).toContain('update available: 1.0.0 → 1.2.0');
    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: '1.2.0' });
  });

  const invalidEntries: ReadonlyArray<[string, string]> = [
    ['syntactically corrupt json', 'kein json {'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['a non-numeric checkedAt', JSON.stringify({ checkedAt: 'x', latestVersion: '2.0.0' })],
    ['a non-string version', JSON.stringify({ checkedAt: NOW, latestVersion: 7 })],
    ['a non-semver version', JSON.stringify({ checkedAt: NOW, latestVersion: 'nightly' })],
    ['a future checkedAt', JSON.stringify({ checkedAt: NOW + ONE_HOUR, latestVersion: '2.0.0' })],
    [
      'an absurdly long version',
      JSON.stringify({ checkedAt: NOW, latestVersion: `${'9'.repeat(100)}.0.0` }),
    ],
  ];

  for (const [name, contents] of invalidEntries) {
    test(`treats ${name} in the cache as a miss`, async () => {
      writeFileSync(cachePath(), contents);

      const { check, fetchCalls } = harness();

      await check.settled;
      check.report();

      expect(fetchCalls()).toBe(1);
    });
  }

  test('treats a cache behind a symlink as a miss', async () => {
    const target = join(scratch, 'target.json');
    writeFileSync(target, JSON.stringify({ checkedAt: NOW, latestVersion: '2.0.0' }));
    symlinkSync(target, cachePath());

    const { check, fetchCalls } = harness();

    await check.settled;

    expect(fetchCalls()).toBe(1);
  });

  test('treats an oversized cache file as a miss', async () => {
    writeFileSync(
      cachePath(),
      `${JSON.stringify({ checkedAt: NOW, latestVersion: '2.0.0' })}${' '.repeat(5000)}`,
    );

    const { check, fetchCalls } = harness();

    await check.settled;

    expect(fetchCalls()).toBe(1);
  });

  test('records a failed fetch so the next day stays quiet', async () => {
    const first = harness({ fetchLatestTag: () => Promise.reject(new Error('offline')) });

    await first.check.settled;
    first.check.report();

    expect(first.output()).toBe('');
    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: null });

    const second = harness();

    await second.check.settled;
    second.check.report();

    expect(second.fetchCalls()).toBe(0);
    expect(second.output()).toBe('');
  });

  test('records a tag that is not a release version without logging', async () => {
    const { check, output } = harness({ fetchLatestTag: () => Promise.resolve('nightly') });

    await check.settled;
    check.report();

    expect(output()).toBe('');
    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: null });
  });

  test('does nothing when disabled', async () => {
    const { check, output, fetchCalls } = harness({ enabled: false });

    await check.settled;
    check.report();

    expect(fetchCalls()).toBe(0);
    expect(output()).toBe('');
  });

  test('aborts an unfinished fetch and stamps the cache once it settles', async () => {
    let signal: AbortSignal | undefined;
    let reject: ((reason: Error) => void) | undefined;

    const { check, output } = harness({
      fetchLatestTag: (abortSignal) => {
        signal = abortSignal;

        return new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        });
      },
    });

    check.report();

    expect(signal?.aborted).toBe(true);
    expect(output()).toBe('');

    reject?.(new Error('aborted'));
    await check.settled;

    expect(output()).toBe('');
    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: null });
  });

  test('keeps a version arriving after report for the next run without logging late', async () => {
    let resolve: ((tag: string) => void) | undefined;

    const { check, output } = harness({
      fetchLatestTag: () =>
        new Promise((resolvePromise) => {
          resolve = resolvePromise;
        }),
    });

    check.report();
    resolve?.('v9.9.9');
    await check.settled;

    expect(output()).toBe('');
    expect(readCache()).toEqual({ checkedAt: NOW, latestVersion: '9.9.9' });
  });
});
