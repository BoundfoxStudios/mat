import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMarkdown, main, parseArguments } from '../src/cli.ts';

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
// need a private `$TMPDIR` or a controlled `PATH` use `spawn` instead.
async function run(args: readonly string[]): Promise<RunResult> {
  const chunks = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: (text) => {
      chunks.stdout += text;
    },
    stderr: (text) => {
      chunks.stderr += text;
    },
  });

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
// whatever other test file is running at that moment.
async function spawn(args: readonly string[], stdin?: string): Promise<RunResult> {
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
    env: { ...process.env, TMPDIR: scratch, PATH: emptyPath },
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

describe('parseArguments', () => {
  test('fills in the documented defaults', () => {
    const parsed = parseArguments(['note.md']);

    expect(parsed).toEqual({
      kind: 'render',
      invocation: {
        source: 'note.md',
        output: undefined,
        theme: 'auto',
        flavor: 'gfm',
        baseDir: undefined,
      },
    });
  });

  test('accepts both spellings of a flag value', () => {
    for (const args of [
      ['note.md', '--theme', 'dark'],
      ['note.md', '--theme=dark'],
    ]) {
      expect(parseArguments(args)).toMatchObject({ invocation: { theme: 'dark' } });
    }
  });

  test('recognises help and version before anything else', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' });
    expect(parseArguments(['--version'])).toEqual({ kind: 'version' });
  });

  const rejected: ReadonlyArray<[string, readonly string[], string]> = [
    ['no arguments', [], 'expected exactly one file argument'],
    ['two files', ['a.md', 'b.md'], 'got 2'],
    ['unknown flag', ['a.md', '--nope'], 'nope'],
    ['missing flag value', ['a.md', '--theme'], 'theme'],
    ['unknown theme', ['a.md', '--theme=neon'], 'unknown theme'],
    ['unknown flavor', ['a.md', '--flavor=gitlab'], 'unknown flavor'],
    // With a file argument the base is always that file's directory; an override would silently
    // resolve images against a directory the document knows nothing about.
    ['base-dir with a file', ['a.md', '--base-dir=/tmp'], '--base-dir is only valid'],
  ];

  for (const [name, args, expected] of rejected) {
    test(`rejects ${name}`, () => {
      expect(() => parseArguments(args)).toThrow(expected);
    });
  }

  test('allows base-dir with stdin', () => {
    expect(parseArguments(['-', '--base-dir=/tmp'])).toMatchObject({
      invocation: { source: '-', baseDir: '/tmp' },
    });
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
    expect(help.stdout).toBe(readFileSync(join(import.meta.dir, 'fixtures', 'help.txt'), 'utf8'));

    expect(version.code).toBe(0);
    // `brew test` checks this exact string.
    expect(version.stdout).toMatch(/^mat \d+\.\d+\.\d+\n$/);
  });

  test('2 for a usage error, with a pointer to --help', async () => {
    const { code, stdout, stderr } = await run(['a.md', '--theme=neon']);

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('mat: unknown theme');
    expect(stderr).toContain('Try `mat --help`.');
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
    expect(stderr).toContain('mat: Unknown language `nosuchlang`');
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
