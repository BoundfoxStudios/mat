import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnedDirectory, matDirectory, writeAtomically } from '../assets/cache.ts';
import type { Logger } from './logger.ts';

export const RELEASES_URL = 'https://github.com/BoundfoxStudios/mat/releases/latest';
const LATEST_RELEASE_API = 'https://api.github.com/repos/BoundfoxStudios/mat/releases/latest';
const CACHE_FILE_NAME = 'update-check.json';
const CACHE_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 4096;
// The digit bound keeps a planted cache entry from flooding the terminal with an absurdly long
// "version"; nine digits also stay well inside integer range for the semver comparison.
const VERSION_PATTERN = /^v?(\d{1,9}\.\d{1,9}\.\d{1,9})$/;

export interface UpdateCheckOptions {
  enabled: boolean;
  currentVersion: string;
  logger: Logger;
  cacheDirectory?: string;
  fetchLatestTag?: (signal: AbortSignal) => Promise<string | undefined>;
  now?: () => number;
}

export interface UpdateCheck {
  /**
   * Logs the update hint if a newer version is known by this moment and aborts a still-running
   * fetch — the render never waits for the network. The attempt still stamps the cache once it
   * settles, so the next network try is a day away either way.
   */
  report(): void;
  /** Resolves once the background attempt has finished; exists so tests can await it. */
  settled: Promise<void>;
}

async function fetchLatestTagFromGitHub(signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch(LATEST_RELEASE_API, {
    signal,
    headers: { accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    return undefined;
  }

  const body: unknown = await response.json();
  const tag = (body as { tag_name?: unknown }).tag_name;

  return typeof tag === 'string' ? tag : undefined;
}

function normalizeVersion(tag: string): string | undefined {
  return VERSION_PATTERN.exec(tag)?.[1];
}

/**
 * The cache lives in the world-shared temp directory and is read before mat's own ownership
 * checks ever run, so the path is opened without following symlinks and without blocking — a
 * planted FIFO would otherwise wedge `open(2)` forever, before any rendering. What was opened
 * is then judged by `fstat` on the descriptor itself; an lstat-then-open pair would leave a
 * swap window. Anything but a small regular file owned by this user counts as a miss.
 */
function readCacheFile(cachePath: string): string | undefined {
  let descriptor: number;

  try {
    descriptor = openSync(
      cachePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
  } catch {
    return undefined;
  }

  try {
    const stats = fstatSync(descriptor);
    const uid = process.getuid?.();

    if (
      !stats.isFile() ||
      stats.size > MAX_CACHE_BYTES ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      return undefined;
    }

    const buffer = Buffer.alloc(stats.size);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);

    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

interface FreshCheck {
  latestVersion: string | undefined;
}

/**
 * A fresh entry with `latestVersion: null` means "checked recently, nothing newer" and is
 * distinct from a miss: it is what keeps the once-a-day cadence on machines that are offline
 * or behind a non-semver release tag. Malformed content of any kind counts as a miss.
 */
function readCachedCheck(cachePath: string, now: number): FreshCheck | undefined {
  const contents = readCacheFile(cachePath);

  if (contents === undefined) {
    return undefined;
  }

  try {
    const entry: unknown = JSON.parse(contents);

    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }

    const { checkedAt, latestVersion } = entry as { checkedAt?: unknown; latestVersion?: unknown };

    if (typeof checkedAt !== 'number') {
      return undefined;
    }

    const age = now - checkedAt;

    if (age < 0 || age >= CACHE_LIFETIME_MILLISECONDS) {
      return undefined;
    }

    if (latestVersion === null) {
      return { latestVersion: undefined };
    }

    if (typeof latestVersion !== 'string') {
      return undefined;
    }

    const version = normalizeVersion(latestVersion);

    return version === undefined ? undefined : { latestVersion: version };
  } catch {
    return undefined;
  }
}

function writeCachedVersion(
  directory: string,
  cachePath: string,
  entry: {
    checkedAt: number;
    latestVersion: string | null;
  },
): void {
  try {
    ensureOwnedDirectory(directory);
    writeAtomically(cachePath, JSON.stringify(entry));
  } catch {}
}

export function startUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
  if (!options.enabled) {
    return { report() {}, settled: Promise.resolve() };
  }

  const now = options.now ?? Date.now;
  const directory = options.cacheDirectory ?? matDirectory();
  const cachePath = join(directory, CACHE_FILE_NAME);
  const controller = new AbortController();
  const cached = readCachedCheck(cachePath, now());

  let latest = cached?.latestVersion;
  let settled = Promise.resolve();

  if (cached === undefined) {
    const fetchLatestTag = options.fetchLatestTag ?? fetchLatestTagFromGitHub;

    // Every settled attempt stamps the cache, a failed or aborted one with `null`: without
    // negative entries, an offline machine, a non-semver release tag or a render that finishes
    // faster than GitHub answers would trigger a fresh network attempt on every single run.
    settled = fetchLatestTag(controller.signal)
      .then((tag) => (tag === undefined ? undefined : normalizeVersion(tag)))
      .catch(() => undefined)
      .then((version) => {
        latest = version;
        writeCachedVersion(directory, cachePath, {
          checkedAt: now(),
          latestVersion: version ?? null,
        });
      });
  }

  return {
    report() {
      controller.abort();

      if (latest !== undefined && Bun.semver.order(latest, options.currentVersion) > 0) {
        options.logger.info(
          `update available: ${options.currentVersion} → ${latest} (${RELEASES_URL})`,
        );
      }
    },
    settled,
  };
}
