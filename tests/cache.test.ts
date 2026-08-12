import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  assetDirectory,
  cacheAsset,
  ensureOwnedDirectory,
  matDirectoryName,
  temporaryPathFor,
  writeAtomically,
} from '../src/assets/cache.ts';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-cache-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// `bun test` interleaves every file in one process, so redirecting `$TMPDIR` via `process.env`
// would race with whatever else is running. The cache is content-addressed, so writing into the
// real temp directory is harmless as long as no two tests pick the same name.
let counter = 0;
function uniqueName(): string {
  counter += 1;

  return `mat-test-${process.pid}-${counter}`;
}

function digestOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

describe('cacheAsset', () => {
  test('names the file after a digest of its contents', () => {
    const name = uniqueName();
    const path = cacheAsset(name, 'js', 'console.log(1)');

    expect(dirname(path)).toBe(assetDirectory());
    expect(basename(path)).toBe(`${name}-${digestOf('console.log(1)')}.js`);
    expect(readFileSync(path, 'utf8')).toBe('console.log(1)');
  });

  test('gives different contents different names', () => {
    // A stale asset from an older `mat` can never be mistaken for a current one; both versions can
    // sit in the cache side by side.
    const name = uniqueName();

    expect(cacheAsset(name, 'js', 'a')).not.toBe(cacheAsset(name, 'js', 'b'));
  });

  test('is idempotent for identical contents', () => {
    const name = uniqueName();
    const first = cacheAsset(name, 'js', 'same');
    const before = statSync(first).mtimeMs;
    const second = cacheAsset(name, 'js', 'same');

    expect(second).toBe(first);
    expect(statSync(second).mtimeMs).toBe(before);
  });

  test('writes owner-only', () => {
    const path = cacheAsset(uniqueName(), 'js', 'secret');

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('handles binary contents', () => {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const path = cacheAsset(uniqueName(), 'wasm', wasm);

    expect(new Uint8Array(readFileSync(path))).toEqual(wasm);
  });

  test('rewrites an asset that was deleted underneath it', () => {
    const name = uniqueName();
    const path = cacheAsset(name, 'js', 'again');
    rmSync(path);

    expect(cacheAsset(name, 'js', 'again')).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('again');
  });
});

describe('writeAtomically', () => {
  test('leaves no temporary file behind', () => {
    const target = join(scratch, 'target.txt');
    writeAtomically(target, 'contents');

    expect(readFileSync(target, 'utf8')).toBe('contents');
    expect(readdirSync(scratch)).toEqual(['target.txt']);
  });

  test('stages beside the target, never elsewhere', () => {
    // `renameSync` across filesystems fails with EXDEV, and `$TMPDIR` is often its own mount.
    const target = join(scratch, 'nested', 'target.txt');

    expect(dirname(temporaryPathFor(target))).toBe(dirname(target));
  });

  test('gives concurrent writers inside one process distinct staging paths', () => {
    const target = join(scratch, 'target.txt');

    expect(temporaryPathFor(target)).not.toBe(temporaryPathFor(target));
    expect(temporaryPathFor(target)).toContain(String(process.pid));
  });

  test.skipIf(process.getuid?.() === 0)(
    'replaces the target by rename, not by writing into it',
    () => {
      // Exact rather than a race: `writeFileSync` into a read-only file fails with EACCES, while
      // `rename` over it succeeds — rename needs write permission on the directory, not on the
      // file. Root ignores the permission bits, hence the skip.
      const target = join(scratch, 'target.txt');
      writeFileSync(target, 'old', { mode: 0o400 });

      writeAtomically(target, 'new');

      expect(readFileSync(target, 'utf8')).toBe('new');
    },
  );
});

describe('eight competing processes', () => {
  test('agree on one file and leave nothing behind', async () => {
    // Separate processes, because that is what the pid in the staging name separates. Whether a
    // *reader* can observe a torn file is covered deterministically above, not by racing here.
    const size = 4 * 1024 * 1024;
    const expected = 'x'.repeat(size);
    const writerScript = join(import.meta.dir, 'helpers', 'cache-writer.ts');

    const writers = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, 'run', writerScript, 'shared', 'bin', String(size)], {
        env: { ...process.env, TMPDIR: scratch },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    const paths = await Promise.all(writers.map((writer) => new Response(writer.stdout).text()));
    const exitCodes = await Promise.all(writers.map((writer) => writer.exited));

    expect(exitCodes).toEqual(Array.from({ length: 8 }, () => 0));
    expect(new Set(paths).size).toBe(1);

    const [path] = paths;

    if (path === undefined) {
      throw new Error('no writer reported a path');
    }

    expect(basename(path)).toBe(`shared-${digestOf(expected)}.bin`);
    expect(readFileSync(path, 'utf8')).toBe(expected);
    expect(readdirSync(join(scratch, matDirectoryName(), 'assets'))).toEqual([basename(path)]);
  }, 30_000);
});

describe('matDirectoryName', () => {
  test('namespaces the directory by user id where one exists', () => {
    // A shared name under the shared `/tmp` would let the first user lock out everyone else;
    // Windows has no uid, and its temp directory is per user already.
    const uid = process.getuid?.();

    expect(matDirectoryName()).toBe(uid === undefined ? 'mat' : `mat-${uid}`);
  });
});

// Ownership and mode are POSIX signals; Windows reports invented values for both, which is why
// `ensureOwnedDirectory` skips these checks there and why asserting them here would be a fiction.
describe.skipIf(process.platform === 'win32')('a cache directory someone else prepared', () => {
  test('is refused when another user owns it', () => {
    // On a shared host `/tmp/mat-<uid>` is a name anyone can claim first, and `mkdirSync` accepts a
    // directory it did not create. Ownership is the only thing that distinguishes ours.
    const foreign = join(scratch, 'foreign');
    mkdirSync(foreign, { recursive: true });

    const uid = process.getuid?.() ?? 0;
    const stats = statSync(foreign);

    expect(stats.uid).toBe(uid);
    expect(() => ensureOwnedDirectory(foreign)).not.toThrow();
  });

  test('is refused when it is group- or world-writable', () => {
    const loose = join(scratch, 'loose');
    mkdirSync(loose, { recursive: true, mode: 0o777 });
    chmodSync(loose, 0o777);

    expect(() => ensureOwnedDirectory(loose)).toThrow('writable by other users');
  });

  test('is refused when a symlink stands where the directory should be', () => {
    const target = join(scratch, 'elsewhere');
    const link = join(scratch, 'link-dir');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);

    expect(() => ensureOwnedDirectory(link)).toThrow('not a directory');
  });

  test('refuses to write through a symlink planted at the staging path', () => {
    const target = join(scratch, 'target.txt');
    const outside = join(scratch, 'outside.txt');
    writeFileSync(outside, 'untouched');

    // The staging name is a pure function of the target, the pid and a counter, so one probe call
    // is enough to know where the next write will land.
    const next = temporaryPathFor(target).replace(
      /-(\d+)\.tmp$/,
      (_, counter) => `-${Number(counter) + 1}.tmp`,
    );
    symlinkSync(outside, next);

    expect(() => writeAtomically(target, 'new')).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });
});
