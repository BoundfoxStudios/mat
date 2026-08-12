/** A failure after the arguments were understood: exit 1, printed as `mat: <message>`. */
export class RuntimeError extends Error {}

/** A rejected configuration file: exit 2, like any other wrong way of invoking `mat`. */
export class ConfigurationError extends Error {}

export function describeFileSystemError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'ENOENT') {
    return 'no such file';
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission denied';
  }

  if (code === 'EISDIR') {
    return 'is a directory';
  }

  if (code === 'ENOTDIR') {
    return 'not a directory';
  }

  if (code === 'ELOOP') {
    return 'too many symbolic links';
  }

  if (code === 'ENOSPC') {
    return 'no space left on device';
  }

  if (code === 'EROFS') {
    return 'read-only file system';
  }

  return error instanceof Error ? error.message : String(error);
}
