import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSafely } from 'cmd-ts';
import { matDirectoryName } from '../src/assets/cache.ts';
import { type Invocation, renderCommand } from '../src/cli/commands/render.ts';
import { DEFAULT_DOCUMENTS, findDefaultDocument } from '../src/cli/default-document.ts';
import type { UpdateCheckOptions } from '../src/cli/update-check.ts';
import { decodeMarkdown, main } from '../src/cli.ts';
import { MAT_VERSION } from '../src/generated/assets.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-cli-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Capturing via `main`'s stream parameters rather than patching `process.stdout.write`: `bun test`
// runs every file in one interleaved process, so the patch would leak into the others. Cases that
// need a private `$TMPDIR` or a controlled `PATH` use `spawn` instead. The configuration loader is
// stubbed out so no test ever depends on a config file on the machine running the suite.
async function run(args: readonly string[]): Promise<RunResult> {
  const chunks = { stdout: '', stderr: '' };
  const code = await main(
    args,
    {
      stdout: (text) => {
        chunks.stdout += text;
      },
      stderr: (text) => {
        chunks.stderr += text;
      },
    },
    undefined,
    () => ({}),
  );

  return { code, ...chunks };
}

/**
 * Every `spawn` case starts a fresh Bun that transpiles mat's whole module graph, including the
 * 4.7 MB of generated assets. Warm that is about 400 ms; on a cold cache — the first run after the
 * formatter has rewritten the tree — it has been measured past a minute with several children
 * competing. Reproduced by touching every source file and running the suite.
 */
const SPAWN_TIMEOUT = 180_000;

// `TMPDIR` and `PATH` go into the *child* environment; setting them on `process.env` would hit
// whatever other test file is running at that moment. `XDG_CONFIG_HOME` points into the scratch
// directory so no child ever reads a config file of the machine running the suite.
async function spawn(
  args: readonly string[],
  stdin?: string,
  cwd?: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  const emptyPath = join(scratch, 'no-launchers');
  mkdirSync(emptyPath, { recursive: true });

  // Files on every descriptor, no pipes anywhere.
  //
  // stdin, because `mat` reads it with a blocking `readFileSync(0)`: any arrangement where this
  // side has to keep pumping deadlocks — the child waits for input while the parent already waits
  // for its output. stdout and stderr, because awaiting `child.exited` after draining a piped
  // stream intermittently throws `EBADF: epoll_ctl` on Bun 1.3.14; reading the other way round
  // would instead deadlock, since the output is larger than a pipe buffer.
  const id = spawnCounter++;
  const stdoutPath = join(scratch, `stdout-${id}`);
  const stderrPath = join(scratch, `stderr-${id}`);
  let stdinSource: 'ignore' | ReturnType<typeof Bun.file> = 'ignore';

  if (stdin !== undefined) {
    const stdinPath = join(scratch, `stdin-${id}`);
    writeFileSync(stdinPath, stdin);
    stdinSource = Bun.file(stdinPath);
  }

  const child = Bun.spawn([process.execPath, 'run', CLI, ...args], {
    env: {
      ...process.env,
      TMPDIR: scratch,
      PATH: emptyPath,
      XDG_CONFIG_HOME: join(scratch, 'config-home'),
      ...env,
    },
    cwd,
    stdin: stdinSource,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });

  const code = await child.exited;

  return {
    code,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

let spawnCounter = 0;

function fixture(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents);

  return path;
}

describe('arguments', () => {
  async function parse(args: readonly string[]): Promise<Invocation> {
    const parsed = await runSafely(renderCommand, [...args]);

    if (parsed._tag === 'error') {
      throw new Error(parsed.error.config.message);
    }

    return parsed.value;
  }

  test('fills in the documented defaults', async () => {
    expect(await parse(['note.md'])).toEqual({
      source: 'note.md',
      output: undefined,
      theme: 'auto',
      flavor: 'gfm',
      baseDir: undefined,
      // Not false: only "not given" lets a configuration file supply the default.
      followLinks: undefined,
      // Plain false, because no configuration key can supply it.
      watch: false,
    });
  });

  test('accepts both spellings of follow-links', async () => {
    for (const args of [
      ['note.md', '--follow-links'],
      ['note.md', '-f'],
    ]) {
      expect(await parse(args)).toMatchObject({ followLinks: true });
    }
  });

  test('accepts both spellings of watch', async () => {
    for (const args of [
      ['note.md', '--watch'],
      ['note.md', '-w'],
    ]) {
      expect(await parse(args)).toMatchObject({ watch: true });
    }
  });

  test('accepts an explicit follow-links value', async () => {
    expect(await parse(['note.md', '--follow-links=false'])).toMatchObject({ followLinks: false });
    expect(await parse(['note.md', '--follow-links=true'])).toMatchObject({ followLinks: true });
  });

  test('accepts both spellings of an option value', async () => {
    for (const args of [
      ['note.md', '--theme', 'dark'],
      ['note.md', '--theme=dark'],
    ]) {
      expect(await parse(args)).toMatchObject({ theme: 'dark' });
    }
  });

  test('leaves the source undefined when no file is named', async () => {
    expect(await parse([])).toMatchObject({ source: undefined });
  });

  test('resolves base-dir to an absolute path', async () => {
    expect(await parse(['-', `--base-dir=${scratch}`])).toMatchObject({
      source: '-',
      baseDir: scratch,
    });
  });

  // Every one of these ends in exit 2 with the offending argument pointed at; the fragment is what
  // tells the user which mistake they made.
  const rejected: ReadonlyArray<[string, readonly string[], string]> = [
    ['two files', ['a.md', 'b.md'], 'Unknown arguments'],
    ['unknown flag', ['a.md', '--nope'], 'Unknown arguments'],
    // Without this, cmd-ts falls back to the default and silently ignores what was typed.
    ['a value-less option', ['a.md', '--output'], 'No value provided for --output'],
    ['unknown theme', ['a.md', '--theme=neon'], "Invalid value 'neon'"],
    ['a malformed follow-links value', ['a.md', '--follow-links=maybe'], 'expected value'],
    ['unknown flavor', ['a.md', '--flavor=gitlab'], "Invalid value 'gitlab'"],
    // With a file argument the base is always that file's directory; an override would silently
    // resolve images against a directory the document knows nothing about.
    ['base-dir with a file', ['a.md', '--base-dir=/tmp'], '--base-dir is only valid'],
    // The default document is a file too, so its own directory wins here as well.
    ['base-dir without a file', ['--base-dir=/tmp'], '--base-dir is only valid'],
    // `--output` produces a single self-contained file; following links needs one preview file
    // per document.
    [
      'follow-links with an output file',
      ['a.md', '--follow-links', '--output', 'a.html'],
      '--follow-links is only valid',
    ],
    [
      'the short flag with an output file',
      ['a.md', '-f', '--output', 'a.html'],
      '--follow-links is only valid',
    ],
    // `--output` writes once and opens nothing, so there is no tab to reload.
    [
      'watch with an output file',
      ['a.md', '--watch', '--output', 'a.html'],
      '--watch is only valid without --output',
    ],
    [
      'the short watch flag with an output file',
      ['a.md', '-w', '--output', '-'],
      '--watch is only valid without --output',
    ],
    // A pipe is read once and has no path to watch.
    ['watch with stdin', ['-', '--watch'], '--watch is only valid with a file'],
    [
      'watch with stdin and a base directory',
      ['-', '-w', '--base-dir=/tmp'],
      '--watch is only valid with a file',
    ],
  ];

  for (const [name, args, expected] of rejected) {
    test(`rejects ${name}`, async () => {
      const { code, stdout, stderr } = await run(args);

      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain(expected);
    });
  }
});

describe('default document', () => {
  function workspace(name: string): string {
    const directory = join(scratch, name);
    mkdirSync(directory, { recursive: true });

    return directory;
  }

  function create(directory: string, relativePath: string, contents = '# x'): string {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);

    return path;
  }

  test('takes the first candidate that exists', () => {
    const directory = workspace('order');
    create(directory, 'SPEC.md');
    create(directory, 'docs/README.md');

    expect(findDefaultDocument(directory)).toBe(join(directory, 'docs', 'README.md'));

    create(directory, 'README.md');

    expect(findDefaultDocument(directory)).toBe(join(directory, 'README.md'));

    create(directory, 'index.md');

    expect(findDefaultDocument(directory)).toBe(join(directory, 'index.md'));
  });

  test('walks past a directory carrying a candidate name', () => {
    const directory = workspace('shadowed');
    // A `mat` that only checked for existence would stop here and fail with "is a directory".
    mkdirSync(join(directory, 'index.md'));
    create(directory, 'README.md');

    expect(findDefaultDocument(directory)).toBe(join(directory, 'README.md'));
  });

  test('finds nothing in an empty directory', () => {
    expect(findDefaultDocument(workspace('empty'))).toBeUndefined();
  });

  test('tries configured candidates instead of the built-in list', () => {
    const directory = workspace('configured');
    create(directory, 'README.md');
    create(directory, 'NOTES.md');

    expect(findDefaultDocument(directory, ['NOTES.md'])).toBe(join(directory, 'NOTES.md'));
    expect(findDefaultDocument(directory, ['missing.md'])).toBeUndefined();
  });

  test('accepts an absolute configured candidate', () => {
    const elsewhere = create(workspace('elsewhere'), 'notes.md');

    expect(findDefaultDocument(workspace('empty-here'), [elsewhere])).toBe(elsewhere);
  });

  test(
    'renders it when no file is given',
    async () => {
      const directory = workspace('implicit');
      create(directory, 'README.md', '# Von README\n\n![](bild.png)');
      writeFileSync(join(directory, 'bild.png'), '');

      const { code, stdout, stderr } = await spawn(['--output', '-'], undefined, directory);

      expect(code).toBe(0);
      expect(stderr).toContain('no file given, rendering README.md');
      expect(stdout).toContain('<h1 id="von-readme">');
      // Relative links resolve against the document, not against the current directory — the two
      // happen to be the same one here, but the path has been through `realpath`.
      expect(stdout).toMatch(/src="file:\/\/\S*\/bild\.png"/);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'exits 1 and names every candidate when there is none',
    async () => {
      const { code, stdout, stderr } = await spawn([], undefined, workspace('bare'));

      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain(DEFAULT_DOCUMENTS.join(', '));
    },
    SPAWN_TIMEOUT,
  );
});

describe('configuration file', () => {
  // The path `spawn` hands every child as `XDG_CONFIG_HOME`.
  function writeConfiguration(contents: string): void {
    const directory = join(scratch, 'config-home', 'mat');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'config.json'), contents);
  }

  function workspace(name: string, files: Record<string, string>): string {
    const directory = join(scratch, name);

    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(directory, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }

    return directory;
  }

  function previews(): string[] {
    return readdirSync(join(scratch, matDirectoryName())).filter((name) => name.endsWith('.html'));
  }

  test(
    'replaces the built-in default documents',
    async () => {
      const directory = workspace('documents', {
        'README.md': '# Aus README',
        'NOTES.md': '# Aus NOTES',
      });
      writeConfiguration('{"defaultDocuments": ["NOTES.md"]}');

      const { code, stdout, stderr } = await spawn(['--output', '-'], undefined, directory);

      expect(code).toBe(0);
      expect(stderr).toContain('no file given, rendering NOTES.md');
      expect(stdout).toContain('<h1 id="aus-notes">');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'names the configured candidates when none exists',
    async () => {
      const directory = workspace('bare-documents', { 'README.md': '# x' });
      writeConfiguration('{"defaultDocuments": ["NOTES.md", "TODO.md"]}');

      const { code, stderr } = await spawn([], undefined, directory);

      expect(code).toBe(1);
      expect(stderr).toContain('NOTES.md, TODO.md');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'rejects an invalid configuration with exit 2',
    async () => {
      const directory = workspace('invalid', { 'note.md': '# x' });
      writeConfiguration('{"followLink": true}');

      const { code, stdout, stderr } = await spawn(
        ['note.md', '--output', '-'],
        undefined,
        directory,
      );

      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('config.json');
      expect(stderr).toContain('unknown key "followLink"');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'follows links by default when the configuration says so',
    async () => {
      const directory = workspace('follow', {
        'a.md': '# A\n\n[b](b.md)',
        'b.md': '# B',
      });
      writeConfiguration('{"followLinks": true}');

      // Exit 3 is the no-browser path of this suite: the previews exist, only the launch failed.
      const { code } = await spawn(['a.md'], undefined, directory);

      expect(code).toBe(3);
      expect(previews()).toHaveLength(2);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'lets --follow-links=false override the configuration',
    async () => {
      const directory = workspace('override', {
        'a.md': '# A\n\n[b](b.md)',
        'b.md': '# B',
      });
      writeConfiguration('{"followLinks": true}');

      const { code } = await spawn(['a.md', '--follow-links=false'], undefined, directory);

      expect(code).toBe(3);
      expect(previews()).toHaveLength(1);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'keeps --help working with a broken configuration',
    async () => {
      writeConfiguration('{broken');

      // The configuration is deliberately loaded after the --help/--version early returns:
      // --help is the very command a user needs while diagnosing a broken file.
      const { code, stdout } = await spawn(['--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('FLAGS:');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'suppresses a configured followLinks for --output instead of rejecting it',
    async () => {
      const directory = workspace('output', {
        'a.md': '# A\n\n[b](b.md)',
        'b.md': '# B',
      });
      writeConfiguration('{"followLinks": true}');

      const { code, stdout } = await spawn(['a.md', '--output', '-'], undefined, directory);

      expect(code).toBe(0);
      // The link still points at the source, not at a preview that was never written.
      expect(stdout).toMatch(/href="file:\/\/\S*\/b\.md"/);
    },
    SPAWN_TIMEOUT,
  );
});

describe('update check wiring', () => {
  interface WiringResult {
    captured: UpdateCheckOptions[];
    reports: number;
    code: number;
  }

  /**
   * Env vars are set and restored around the call because the gate reads `process.env`; the
   * injected check keeps the suite away from the network and the shared temp directory.
   */
  async function invoke(
    args: readonly string[],
    interactive: boolean | undefined,
    env: Record<string, string | undefined>,
  ): Promise<WiringResult> {
    const original = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
      original.set(key, process.env[key]);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    const captured: UpdateCheckOptions[] = [];
    let reports = 0;

    try {
      const code = await main(
        args,
        { stdout: () => {}, stderr: () => {}, interactive },
        (options) => {
          captured.push(options);

          return {
            report() {
              reports++;
            },
            settled: Promise.resolve(),
          };
        },
        () => ({}),
      );

      return { captured, reports, code };
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  const CLEAR_GATE = { MAT_NO_UPDATE_CHECK: undefined, CI: undefined };

  test('enables the check only for an interactive terminal outside CI', async () => {
    const path = fixture('note.md', '# x');
    const target = join(scratch, 'note.html');

    const enabled = await invoke([path, `--output=${target}`], true, CLEAR_GATE);

    expect(enabled.captured).toHaveLength(1);
    expect(enabled.captured[0]?.enabled).toBe(true);
    expect(enabled.reports).toBe(1);

    const cases: ReadonlyArray<[boolean | undefined, Record<string, string | undefined>]> = [
      [undefined, CLEAR_GATE],
      [true, { ...CLEAR_GATE, CI: '1' }],
      [true, { ...CLEAR_GATE, MAT_NO_UPDATE_CHECK: '1' }],
    ];

    for (const [interactive, env] of cases) {
      const { captured } = await invoke([path, `--output=${target}`], interactive, env);

      expect(captured[0]?.enabled).toBe(false);
    }
  });

  test('reports even when the render fails', async () => {
    const { reports, code } = await invoke([join(scratch, 'nope.md')], true, CLEAR_GATE);

    expect(code).toBe(1);
    expect(reports).toBe(1);
  });

  test('starts no check for --help, --version or a usage error', async () => {
    for (const args of [['--help'], ['--version'], ['a.md', '--nope']]) {
      const { captured } = await invoke(args, true, CLEAR_GATE);

      expect(captured).toHaveLength(0);
    }
  });
});

describe('decodeMarkdown', () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  test('strips a byte order mark rather than passing it on', () => {
    // `TextDecoder` drops it unless `ignoreBOM` is set, so a file with a BOM renders identically
    // to the same file without one.
    expect(decodeMarkdown(encode('﻿# Hallo'), 'x.md')).toBe('# Hallo');
  });

  test('accepts crlf and lone cr without normalising them', () => {
    expect(decodeMarkdown(encode('a\r\nb\rc'), 'x.md')).toBe('a\r\nb\rc');
  });

  test('rejects other encodings', () => {
    expect(() => decodeMarkdown(new Uint8Array([0x48, 0xe4, 0x6c]), 'x.md')).toThrow(
      'x.md: not valid UTF-8',
    );
  });

  test('rejects a binary file', () => {
    expect(() => decodeMarkdown(new Uint8Array([0x89, 0x50, 0x00, 0x1a]), 'x.md')).toThrow(
      'looks like a binary file',
    );
  });

  test('names both numbers when the file is too large', () => {
    const oversized = new Uint8Array(11 * 1024 * 1024);

    expect(() => decodeMarkdown(oversized, 'x.md')).toThrow(
      '11534336 bytes exceeds the 10485760 byte limit',
    );
  });

  test('ignores a nul byte beyond the sniffed prefix', () => {
    const late = new Uint8Array(9000);
    late.fill(0x61);
    late[8500] = 0;

    expect(decodeMarkdown(late, 'x.md')).toHaveLength(9000);
  });
});

describe('exit codes', () => {
  test('0 for --help and --version, on stdout', async () => {
    const help = await run(['--help']);
    const version = await run(['--version']);

    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    const expectedHelp = readFileSync(join(import.meta.dir, 'fixtures', 'help.txt'), 'utf8')
      // The version bumps on every release; pinning it in the fixture would break release PRs.
      .replace('{{version}}', MAT_VERSION);
    expect(help.stdout).toBe(expectedHelp);

    expect(version.code).toBe(0);
    // `brew test` checks this exact string.
    expect(version.stdout).toMatch(/^mat \d+\.\d+\.\d+\n$/);
  });

  test('the short spellings do the same', async () => {
    expect(await run(['-h'])).toEqual(await run(['--help']));
    expect(await run(['-v'])).toEqual(await run(['--version']));
  });

  test('2 for a usage error, with a pointer to --help', async () => {
    const { code, stdout, stderr } = await run(['a.md', '--theme=neon']);

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain("Invalid value 'neon'. Expected one of: 'auto', 'light', 'dark'");
    expect(stderr).toContain("try 'mat --help'");
  });

  test('1 for a missing file', async () => {
    const { code, stdout, stderr } = await run([join(scratch, 'nope.md')]);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('no such file');
  });

  test('1 for a directory', async () => {
    mkdirSync(join(scratch, 'folder'));
    const { code, stderr } = await run([join(scratch, 'folder')]);

    expect(code).toBe(1);
    expect(stderr).toContain('is a directory');
  });

  test('1 for a non-regular file, instead of blocking on it', async () => {
    // A FIFO would demonstrate the same, but a device file needs no platform-specific setup.
    const { code, stderr } = await run(['/dev/null']);

    expect(code).toBe(1);
    expect(stderr).toContain('not a regular file');
  });

  test(
    '2 for a base-dir that is not a directory',
    async () => {
      const file = fixture('note.md', '# x');
      const { code, stderr } = await spawn(['-', `--base-dir=${file}`], '# x');

      expect(code).toBe(2);
      expect(stderr).toContain('not a directory');
    },
    SPAWN_TIMEOUT,
  );

  test(
    '3 when the preview was written but no browser started',
    async () => {
      const path = fixture('note.md', '# Titel');
      const { code, stdout, stderr } = await spawn([path]);

      // The artefact exists, so this is not a plain failure — exit 1 would make `mat x.md || fallback`
      // do the wrong thing.
      expect(code).toBe(3);
      expect(stdout).toBe('');
      expect(stderr).toContain('could not open a browser');

      const url = stderr.match(/file:\/\/\S+/)?.[0];

      if (!url) {
        throw new Error('no preview url in stderr');
      }

      expect(readFileSync(new URL(url), 'utf8')).toContain('<h1 id="titel">');
    },
    SPAWN_TIMEOUT,
  );
});

describe('preview path', () => {
  test(
    'stays the same when the file changes',
    async () => {
      // A stable url reloads the open tab instead of opening a new one on every save.
      const path = fixture('note.md', '# Titel');
      const first = await spawn([path]);

      writeFileSync(path, '# Anderer Titel');

      const second = await spawn([path]);

      expect(second.stderr.match(/file:\/\/\S+/)?.[0]).toBe(
        first.stderr.match(/file:\/\/\S+/)?.[0],
      );
    },
    SPAWN_TIMEOUT,
  );

  test(
    'is shared by two symlinks to one document',
    async () => {
      const path = fixture('note.md', '# Titel');
      const link = join(scratch, 'link.md');
      symlinkSync(path, link);

      const direct = await spawn([path]);
      const viaLink = await spawn([link]);

      expect(viaLink.stderr.match(/file:\/\/\S+/)?.[0]).toBe(
        direct.stderr.match(/file:\/\/\S+/)?.[0],
      );
    },
    SPAWN_TIMEOUT,
  );
});

describe('output', () => {
  test('sends html to stdout and warnings to stderr', async () => {
    const path = fixture('note.md', '# Überschrift\n\n```nosuchlang\nx\n```');
    const { code, stdout, stderr } = await run([path, '--output', '-']);

    expect(code).toBe(0);
    expect(stdout).toStartWith('<!doctype html>');
    expect(stdout).toContain('<h1 id="überschrift">');
    expect(stdout).not.toContain('Unknown language');
    expect(stderr).toContain('Unknown language `nosuchlang`');
  });

  test('writes to a file without opening anything', async () => {
    const path = fixture('note.md', '# Titel');
    const target = join(scratch, 'note.html');

    const { code, stdout, stderr } = await run([path, `--output=${target}`]);

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(readFileSync(target, 'utf8')).toContain('<h1 id="titel">');
  });

  test('caps the warning list', async () => {
    const blocks = Array.from({ length: 9 }, (_, index) => `\`\`\`nolang${index}\nx\n\`\`\``);
    const path = fixture('many.md', blocks.join('\n\n'));

    const { stderr } = await run([path, '--output', '-']);

    expect(stderr.match(/Unknown language/g)).toHaveLength(5);
    expect(stderr).toContain('4 more warnings');
  });

  test('warns about a large file but still renders it', async () => {
    const path = fixture('big.md', `# Groß\n\n${'Wort '.repeat(250_000)}`);
    const { code, stderr } = await run([path, '--output', '-']);

    expect(code).toBe(0);
    expect(stderr).toContain('this may take a moment');
  });
});

describe('as a real process', () => {
  test(
    'reads stdin',
    async () => {
      // Iterating `process.stdin` instead loses everything a fast producer wrote before mat got
      // around to listening — that read path is the point, and in-process capture cannot supply fd 0.
      const { code, stdout } = await spawn(['-', '--output', '-'], '# Von stdin');

      expect(code).toBe(0);
      expect(stdout).toContain('<h1 id="von-stdin">');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'resolves relative assets against --base-dir',
    async () => {
      writeFileSync(join(scratch, 'a.png'), '');
      const { stdout } = await spawn(['-', '--output', '-', `--base-dir=${scratch}`], '![](a.png)');

      expect(stdout).toContain(`src="file://${scratch}/a.png"`);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'accepts empty input',
    async () => {
      const { code, stdout } = await spawn(['-', '--output', '-'], '   \n\n  ');

      expect(code).toBe(0);
      expect(stdout).toContain('<article class="markdown-body">');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'exits 0 when the reader stops reading',
    async () => {
      // `mat README.md --output - | head -1` is an ordinary thing to type, and the contract is
      // that it ends quietly rather than dying on a broken pipe.
      //
      // Cancelling the reader closes the same pipe with one process instead of three, and the
      // assertion is deliberately about the outcome rather than the mechanism: measured on Bun
      // 1.3.14, from source and from the compiled binary, `process.stdout` never emits an `error`
      // event here. The EPIPE branch in `cli.ts` is insurance for another runtime, not the thing
      // under test — a version of this case asserting it passed with the branch removed.
      const path = fixture('note.md', '# Titel');
      const child = Bun.spawn([process.execPath, 'run', CLI, path, '--output', '-'], {
        env: { ...process.env, TMPDIR: scratch },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const reader = child.stdout.getReader();
      await reader.read();
      await reader.cancel();

      const stderr = await new Response(child.stderr).text();

      expect(await child.exited).toBe(0);
      expect(stderr).toBe('');
    },
    SPAWN_TIMEOUT,
  );
});
