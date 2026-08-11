import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function matDirectory(): string {
  return join(tmpdir(), 'mat');
}

export function assetDirectory(): string {
  return join(matDirectory(), 'assets');
}

let temporaryCounter = 0;

/**
 * Must stay a sibling of the target: `renameSync` across filesystems fails with EXDEV, and
 * `$TMPDIR` is regularly its own mount. The pid separates concurrent processes, the counter
 * concurrent writes inside one process.
 */
export function temporaryPathFor(targetPath: string): string {
  return `${targetPath}.${process.pid}-${temporaryCounter++}.tmp`;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Creates a directory and refuses one another local user could have prepared.
 *
 * On Linux `tmpdir()` is the shared `/tmp`, and `mkdirSync` accepts a pre-existing directory no
 * matter who owns it. Without this an unprivileged user can create `/tmp/mat/assets` first and
 * plant a file under a name `mat` will later serve to the browser as its own script.
 *
 * Windows has neither of the two signals: there is no `process.getuid`, and `lstat` synthesises
 * the mode rather than reading it, so a directory that is in fact private reports `0o777` and
 * would fail the check below on every run. Its temp directory is per user and carries an ACL, so
 * the check is dropped there instead of being decided on invented numbers.
 */
export function ensureOwnedDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });

  const stats = lstatSync(path);

  if (!stats.isDirectory()) {
    throw new Error(`${path}: not a directory`);
  }

  const uid = process.getuid?.();

  if (uid === undefined) {
    return;
  }

  if (stats.uid !== uid) {
    throw new Error(`${path}: owned by another user, refusing to use it`);
  }

  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${path}: writable by other users, refusing to use it`);
  }
}

export function ensureCacheDirectories(): void {
  ensureOwnedDirectory(matDirectory());
  ensureOwnedDirectory(assetDirectory());
}

/**
 * `writeFileSync` alone is not enough: a second `mat` process reading a half-written 3.4 MB script
 * fails hard rather than cosmetically. Writing beside the target and renaming makes the swap
 * atomic, because `rename(2)` is.
 */
export function writeAtomically(targetPath: string, contents: Uint8Array | string): void {
  const temporaryPath = temporaryPathFor(targetPath);

  try {
    // `wx` refuses an existing entry rather than following a symlink planted at this path.
    const handle = openSync(temporaryPath, 'wx', 0o600);

    try {
      writeFileSync(handle, contents);
    } finally {
      closeSync(handle);
    }

    renameSync(temporaryPath, targetPath);
  } catch (error) {
    // Nothing ever collects staging files, so on a full disk every failed attempt would add one.
    rmSync(temporaryPath, { force: true });

    throw error;
  }
}

/**
 * The digest in the file name keeps two `mat` versions from mistaking each other's assets for
 * their own. An existing file is complete by construction — every write goes through the rename
 * above — so its presence is enough to skip the work, as long as it is a plain file that we own.
 */
export function cacheAsset(
  baseName: string,
  extension: string,
  contents: Uint8Array | string,
): string {
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const targetPath = join(assetDirectory(), `${baseName}-${digest}.${extension}`);

  ensureCacheDirectories();

  const existing = lstatOrUndefined(targetPath);
  const uid = process.getuid?.();

  if (existing?.isFile() && (uid === undefined || existing.uid === uid)) {
    return targetPath;
  }

  if (existing) {
    rmSync(targetPath, { force: true, recursive: true });
  }

  writeAtomically(targetPath, contents);

  return targetPath;
}
