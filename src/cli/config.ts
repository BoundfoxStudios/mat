import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ConfigurationError, describeFileSystemError } from './errors.ts';

export interface Configuration {
  readonly defaultDocuments?: readonly string[];
  readonly followLinks?: boolean;
}

const MAX_CONFIGURATION_BYTES = 1024 * 1024;

export function configurationFilePath(
  environment: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdgConfigHome = environment.XDG_CONFIG_HOME;

  // The XDG spec demands that a relative value be ignored, and `isAbsolute` covers the empty
  // string with it. An explicit `XDG_CONFIG_HOME` wins on every platform, so one setting moves
  // the file wherever the user keeps such things.
  if (xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)) {
    return join(xdgConfigHome, 'mat', 'config.json');
  }

  if (platform === 'win32') {
    // Windows sets `%APPDATA%` for every session; the fallback only covers a stripped environment.
    const appData = environment.APPDATA;

    return join(
      appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming'),
      'mat',
      'config.json',
    );
  }

  return join(homedir(), '.config', 'mat', 'config.json');
}

function validatedDocuments(
  value: unknown,
  problem: (message: string) => ConfigurationError,
): string[] {
  if (!Array.isArray(value)) {
    throw problem('defaultDocuments: expected an array of file names');
  }

  if (value.length === 0) {
    throw problem('defaultDocuments: must name at least one file');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      throw problem(`defaultDocuments[${index}]: expected a non-empty file name`);
    }

    return entry;
  });
}

/**
 * Strict on purpose: an unknown key is far more likely a typo than an intention, and silently
 * ignoring it would leave the user believing a setting is active when it is not.
 */
function validated(
  parsed: unknown,
  problem: (message: string) => ConfigurationError,
): Configuration {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw problem('not a JSON object');
  }

  const configuration: { defaultDocuments?: string[]; followLinks?: boolean } = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'defaultDocuments') {
      configuration.defaultDocuments = validatedDocuments(value, problem);
    } else if (key === 'followLinks') {
      if (typeof value !== 'boolean') {
        throw problem('followLinks: expected true or false');
      }

      configuration.followLinks = value;
    } else {
      throw problem(`unknown key "${key}" (known: defaultDocuments, followLinks)`);
    }
  }

  return configuration;
}

export function loadConfiguration(path: string = configurationFilePath()): Configuration {
  const problem = (message: string) => new ConfigurationError(`${path}: ${message}`);
  let stats: ReturnType<typeof statSync>;

  try {
    stats = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    // Having no configuration file is the normal case, not an error. ENOTDIR is the same case
    // through a different syscall answer: a file sitting where a path component should be a
    // directory means the configuration file cannot exist either.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {};
    }

    throw problem(describeFileSystemError(error));
  }

  if (stats.isDirectory()) {
    throw problem('is a directory');
  }

  // A FIFO would block the read below until a writer appears; a device file reads without end.
  if (!stats.isFile()) {
    throw problem('not a regular file');
  }

  if (stats.size > MAX_CONFIGURATION_BYTES) {
    throw problem(`${stats.size} bytes exceeds the ${MAX_CONFIGURATION_BYTES} byte limit`);
  }

  let bytes: Uint8Array;

  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw problem(describeFileSystemError(error));
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw problem('not valid UTF-8');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw problem(error instanceof Error ? error.message : String(error));
  }

  return validated(parsed, problem);
}
