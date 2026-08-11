import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureOwnedDirectory, matDirectory, writeAtomically } from './assets/cache.ts';
import { openInBrowser } from './browser.ts';
import { DEFAULT_FLAVOR_NAME, flavorNames } from './flavors/index.ts';
import { MAT_VERSION, type ThemeName } from './generated/assets.ts';
import { render } from './render/index.ts';

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_BROWSER_LAUNCH_FAILED = 3;

const WARN_BYTES = 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_PRINTED_MESSAGES = 5;

const THEMES: readonly ThemeName[] = ['auto', 'light', 'dark'];

export const HELP = `Usage: mat <file.md> [options]
       mat - [options]

Render a Markdown file the way GitHub does and open it in your browser.

Options:
  --output <path>    Write the HTML there and do not open a browser.
                     Use - for stdout. The file is self-contained.
  --theme <name>     auto, light or dark. Default: auto.
  --flavor <name>    Markdown dialect. Default: ${DEFAULT_FLAVOR_NAME}.
  --base-dir <dir>   Directory relative links resolve against. Only valid
                     with -, where there is no file to derive it from.
                     Default: the current directory.
  --help             Show this text.
  --version          Show the version.

Examples:
  mat README.md
  cat notes.md | mat -
  mat README.md --output readme.html

mat renders untrusted Markdown as trusted HTML. Only point it at documents you trust.
The preview URL is stable per file, so a second run just needs a reload in the open tab.
`;

class UsageError extends Error {}

class RuntimeError extends Error {}

export interface Invocation {
  source: string;
  output: string | undefined;
  theme: ThemeName;
  flavor: string;
  baseDir: string | undefined;
}

export type ParsedArguments =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'render'; invocation: Invocation };

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        output: { type: 'string' },
        theme: { type: 'string' },
        flavor: { type: 'string' },
        'base-dir': { type: 'string' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) {
    return { kind: 'help' };
  }

  if (values.version) {
    return { kind: 'version' };
  }

  if (positionals.length === 0) {
    throw new UsageError('expected exactly one file argument, or - to read stdin');
  }

  if (positionals.length > 1) {
    throw new UsageError(`expected exactly one file argument, got ${positionals.length}`);
  }

  const theme = values.theme ?? 'auto';

  if (typeof theme !== 'string' || !THEMES.includes(theme as ThemeName)) {
    throw new UsageError(`unknown theme \`${String(theme)}\`; expected ${THEMES.join(', ')}`);
  }

  const flavor = values.flavor ?? DEFAULT_FLAVOR_NAME;

  if (typeof flavor !== 'string' || !flavorNames().includes(flavor)) {
    throw new UsageError(
      `unknown flavor \`${String(flavor)}\`; expected ${flavorNames().join(', ')}`,
    );
  }

  const source = positionals[0] ?? '';
  const baseDir = typeof values['base-dir'] === 'string' ? values['base-dir'] : undefined;

  if (baseDir !== undefined && source !== '-') {
    // An override would silently resolve images against a directory the document knows nothing
    // about; with a file argument the base is always that file's directory.
    throw new UsageError('--base-dir is only valid together with -');
  }

  return {
    kind: 'render',
    invocation: {
      source,
      output: typeof values.output === 'string' ? values.output : undefined,
      theme: theme as ThemeName,
      flavor,
      baseDir,
    },
  };
}

export function previewDirectory(): string {
  return matDirectory();
}

/**
 * Stable on purpose: `file://` documents are never cached, so reusing the URL lets an open tab show
 * the new render on plain reload, keeping the scroll position. Hashing the *real* path makes two
 * symlinks to one document share a tab.
 */
export function previewPathFor(realPath: string): string {
  const digest = createHash('sha256').update(realPath).digest('hex');

  return join(previewDirectory(), `${digest}.html`);
}

/**
 * Not `process.stdin`: the stream only starts buffering once something is listening, and `mat`
 * spends ~70 ms importing its embedded assets first. Measured against a producer that writes and
 * closes immediately, the stream variant returned nothing and rendered an empty document.
 */
function readStdin(): Uint8Array {
  return readFileSync(0);
}

export function decodeMarkdown(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_BYTES) {
    throw new RuntimeError(
      `${label}: ${bytes.byteLength} bytes exceeds the ${MAX_BYTES} byte limit`,
    );
  }

  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new RuntimeError(`${label}: looks like a binary file`);
  }

  try {
    // A BOM needs no handling: micromark is transparent to it, even before front matter.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeError(`${label}: not valid UTF-8`);
  }
}

async function readSource(invocation: Invocation): Promise<{ bytes: Uint8Array; label: string }> {
  if (invocation.source === '-') {
    return { bytes: readStdin(), label: '<stdin>' };
  }

  try {
    const realPath = realpathSync(invocation.source);
    const stats = statSync(realPath);

    if (stats.isDirectory()) {
      throw new RuntimeError(`${invocation.source}: is a directory`);
    }

    // Before reading, not after: a 3 GB file otherwise costs 3 GB of memory to be told it is too
    // large, and a large enough one is killed by the allocator before the message is ever printed.
    if (stats.size > MAX_BYTES) {
      throw new RuntimeError(
        `${realPath}: ${stats.size} bytes exceeds the ${MAX_BYTES} byte limit`,
      );
    }

    return { bytes: await Bun.file(realPath).bytes(), label: realPath };
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(`${invocation.source}: ${describeFileSystemError(error)}`);
  }
}

function describeFileSystemError(error: unknown): string {
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

  if (code === 'ENOSPC') {
    return 'no space left on device';
  }

  if (code === 'EROFS') {
    return 'read-only file system';
  }

  return error instanceof Error ? error.message : String(error);
}

function resolveBaseDir(invocation: Invocation, realPath: string | undefined): string {
  if (realPath !== undefined) {
    return dirname(realPath);
  }

  const candidate = resolve(invocation.baseDir ?? process.cwd());

  try {
    if (!statSync(candidate).isDirectory()) {
      throw new UsageError(`--base-dir ${candidate}: not a directory`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }

    throw new UsageError(`--base-dir ${candidate}: ${describeFileSystemError(error)}`);
  }

  return candidate;
}

/**
 * Injected so a test can capture output without replacing `process.stdout.write` — a global that
 * `bun test` shares across every test file running at the same moment.
 */
export interface OutputStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const PROCESS_STREAMS: OutputStreams = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

function reportMessages(messages: readonly string[], out: OutputStreams): void {
  for (const message of messages.slice(0, MAX_PRINTED_MESSAGES)) {
    out.stderr(`mat: ${message}\n`);
  }

  if (messages.length > MAX_PRINTED_MESSAGES) {
    out.stderr(`mat: ${messages.length - MAX_PRINTED_MESSAGES} more warnings\n`);
  }
}

async function runRender(invocation: Invocation, out: OutputStreams): Promise<number> {
  const { bytes, label } = await readSource(invocation);

  if (bytes.byteLength > WARN_BYTES) {
    out.stderr(`mat: ${label} is ${bytes.byteLength} bytes; this may take a moment\n`);
  }

  const markdown = decodeMarkdown(bytes, label);
  const realPath = invocation.source === '-' ? undefined : label;
  const toStdout = invocation.output === '-';
  const toFile = invocation.output !== undefined && !toStdout;

  const { html, messages } = await render(markdown, {
    title: realPath === undefined ? 'stdin' : basename(realPath),
    theme: invocation.theme,
    flavor: invocation.flavor,
    baseDir: resolveBaseDir(invocation, realPath),
    linkMode: 'absolute',
    // Anything the user keeps has to stand on its own; only the throwaway preview may point into
    // the shared cache.
    embedMode: invocation.output === undefined ? 'cache' : 'inline',
  });

  reportMessages(messages, out);

  if (toStdout) {
    out.stdout(html);

    return EXIT_SUCCESS;
  }

  if (toFile && invocation.output !== undefined) {
    const target = isAbsolute(invocation.output) ? invocation.output : resolve(invocation.output);

    try {
      // Atomic here too: a failure partway through would otherwise leave a truncated HTML file
      // that opens in a browser and looks merely broken.
      writeAtomically(target, html);
    } catch (error) {
      throw new RuntimeError(`${target}: ${describeFileSystemError(error)}`);
    }

    return EXIT_SUCCESS;
  }

  const previewPath =
    realPath === undefined
      ? join(previewDirectory(), `${createHash('sha256').update(markdown).digest('hex')}.html`)
      : previewPathFor(realPath);

  try {
    ensureOwnedDirectory(previewDirectory());
    writeAtomically(previewPath, html);
  } catch (error) {
    throw new RuntimeError(`${previewPath}: ${describeFileSystemError(error)}`);
  }

  // Never string concatenation: it breaks on Windows paths, spaces and umlauts.
  const previewUrl = pathToFileURL(previewPath).href;

  if (!(await openInBrowser(previewUrl))) {
    out.stderr(`mat: could not open a browser; the preview is at ${previewUrl}\n`);

    return EXIT_BROWSER_LAUNCH_FAILED;
  }

  out.stderr(`${previewUrl}\n`);

  return EXIT_SUCCESS;
}

export async function main(
  argv: readonly string[],
  out: OutputStreams = PROCESS_STREAMS,
): Promise<number> {
  try {
    const parsed = parseArguments(argv);

    if (parsed.kind === 'help') {
      out.stdout(HELP);

      return EXIT_SUCCESS;
    }

    if (parsed.kind === 'version') {
      out.stdout(`mat ${MAT_VERSION}\n`);

      return EXIT_SUCCESS;
    }

    return await runRender(parsed.invocation, out);
  } catch (error) {
    if (error instanceof UsageError) {
      out.stderr(`mat: ${error.message}\nTry \`mat --help\`.\n`);

      return EXIT_USAGE_ERROR;
    }

    const reason = error instanceof Error ? error.message : String(error);
    out.stderr(`mat: ${reason}\n`);

    return EXIT_RUNTIME_ERROR;
  }
}

if (import.meta.main) {
  // Unhandled, `mat README.md | head -1` dies with a stack trace and exit 1 in both runtimes.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(EXIT_SUCCESS);
    }

    // Throwing from a stream handler produces an unhandled 'error' event and a stack trace; the
    // contract is a message and an exit code.
    process.stderr.write(`mat: stdout: ${error.message}\n`);
    process.exit(EXIT_RUNTIME_ERROR);
  });

  process.exitCode = await main(process.argv.slice(2));
}
