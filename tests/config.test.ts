import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationFilePath, loadConfiguration } from '../src/cli/config.ts';
import { ConfigurationError } from '../src/cli/errors.ts';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-config-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configFile(contents: string | Uint8Array): string {
  const path = join(scratch, 'config.json');
  writeFileSync(path, contents);

  return path;
}

describe('configurationFilePath', () => {
  test('honors an absolute XDG_CONFIG_HOME', () => {
    expect(configurationFilePath({ XDG_CONFIG_HOME: scratch })).toBe(
      join(scratch, 'mat', 'config.json'),
    );
  });

  test('falls back to ~/.config when unset, empty or relative', () => {
    const fallback = join(homedir(), '.config', 'mat', 'config.json');

    expect(configurationFilePath({}, 'linux')).toBe(fallback);
    expect(configurationFilePath({ XDG_CONFIG_HOME: '' }, 'linux')).toBe(fallback);
    // The XDG spec demands that a relative value be ignored.
    expect(configurationFilePath({ XDG_CONFIG_HOME: 'relative/config' }, 'linux')).toBe(fallback);
  });

  test('uses %APPDATA% on Windows', () => {
    expect(configurationFilePath({ APPDATA: scratch }, 'win32')).toBe(
      join(scratch, 'mat', 'config.json'),
    );
  });

  test('lets an absolute XDG_CONFIG_HOME win on Windows too', () => {
    expect(
      configurationFilePath(
        { XDG_CONFIG_HOME: scratch, APPDATA: join(scratch, 'roaming') },
        'win32',
      ),
    ).toBe(join(scratch, 'mat', 'config.json'));
  });

  test('falls back below the home directory when %APPDATA% is missing', () => {
    const fallback = join(homedir(), 'AppData', 'Roaming', 'mat', 'config.json');

    expect(configurationFilePath({}, 'win32')).toBe(fallback);
    expect(configurationFilePath({ APPDATA: '' }, 'win32')).toBe(fallback);
  });
});

describe('loadConfiguration', () => {
  test('treats a missing file as empty defaults', () => {
    expect(loadConfiguration(join(scratch, 'nope', 'config.json'))).toEqual({});
  });

  test('treats a file blocking the path as empty defaults', () => {
    // A stray regular file at ~/.config/mat makes the stat fail with ENOTDIR instead of ENOENT;
    // the configuration file does not exist in that case either.
    writeFileSync(join(scratch, 'mat'), 'not a directory');

    expect(loadConfiguration(join(scratch, 'mat', 'config.json'))).toEqual({});
  });

  test('accepts an empty object', () => {
    expect(loadConfiguration(configFile('{}'))).toEqual({});
  });

  test('reads both keys', () => {
    const path = configFile('{"defaultDocuments": ["NOTES.md", "docs/x.md"], "followLinks": true}');

    expect(loadConfiguration(path)).toEqual({
      defaultDocuments: ['NOTES.md', 'docs/x.md'],
      followLinks: true,
    });
  });

  test('reads followLinks set to false', () => {
    expect(loadConfiguration(configFile('{"followLinks": false}'))).toEqual({
      followLinks: false,
    });
  });

  // Every rejection carries the path — the user has to know which file to fix — plus a fragment
  // naming the mistake.
  const rejected: ReadonlyArray<[string, string, string]> = [
    ['broken JSON', '{"followLinks": ', 'config.json'],
    ['an array root', '["README.md"]', 'not a JSON object'],
    ['a string root', '"README.md"', 'not a JSON object'],
    ['an unknown key', '{"followLink": true}', 'unknown key "followLink"'],
    ['a non-boolean followLinks', '{"followLinks": "yes"}', 'followLinks: expected true or false'],
    [
      'a non-array defaultDocuments',
      '{"defaultDocuments": "README.md"}',
      'defaultDocuments: expected an array',
    ],
    [
      'an empty defaultDocuments',
      '{"defaultDocuments": []}',
      'defaultDocuments: must name at least one file',
    ],
    [
      'a non-string document entry',
      '{"defaultDocuments": ["a.md", 7]}',
      'defaultDocuments[1]: expected a non-empty file name',
    ],
    [
      'an empty document entry',
      '{"defaultDocuments": [""]}',
      'defaultDocuments[0]: expected a non-empty file name',
    ],
  ];

  for (const [name, contents, expected] of rejected) {
    test(`rejects ${name}`, () => {
      const path = configFile(contents);

      expect(() => loadConfiguration(path)).toThrow(ConfigurationError);
      expect(() => loadConfiguration(path)).toThrow(expected);
    });
  }

  test('rejects a file that is not valid UTF-8', () => {
    const path = configFile(new Uint8Array([0x7b, 0xff, 0x7d]));

    expect(() => loadConfiguration(path)).toThrow('not valid UTF-8');
  });

  test('rejects an oversized file before reading it', () => {
    const path = configFile(`{"followLinks": true}${' '.repeat(1024 * 1024)}`);

    expect(() => loadConfiguration(path)).toThrow('exceeds the 1048576 byte limit');
  });

  test('rejects a directory in place of the file', () => {
    const path = join(scratch, 'config.json');
    mkdirSync(path);

    expect(() => loadConfiguration(path)).toThrow('is a directory');
  });
});
