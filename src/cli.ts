import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSafely } from 'cmd-ts';
import { ensureOwnedDirectory, matDirectory, writeAtomically } from './assets/cache.ts';
import { openInBrowser } from './browser.ts';
import { type Invocation, renderCommand } from './cli/commands/render.ts';
import { describeFileSystemError, RuntimeError } from './cli/errors.ts';
import { MAT_VERSION } from './generated/assets.ts';
import { render } from './render/index.ts';

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_BROWSER_LAUNCH_FAILED = 3;

const WARN_BYTES = 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_PRINTED_MESSAGES = 5;

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

/** `--base-dir` is already absolute and known to exist; parsing it took care of both. */
function resolveBaseDir(invocation: Invocation, realPath: string | undefined): string {
  return realPath === undefined ? (invocation.baseDir ?? process.cwd()) : dirname(realPath);
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
    const parsed = await runSafely(renderCommand, [...argv]);

    if (parsed._tag === 'error') {
      // cmd-ts hands back `--help`, `--version` and every usage error as a value instead of calling
      // `process.exit` itself, which is what keeps this function testable.
      const { exitCode, message, into } = parsed.error.config;
      // `--version` prints the bare version, and `brew test` greps for `mat <semver>`. Naming the
      // program in `version` instead would repeat it in the help header, which prints both.
      const text = message === MAT_VERSION ? `mat ${message}` : message;
      (into === 'stdout' ? out.stdout : out.stderr)(`${text}\n`);

      return exitCode === 0 ? EXIT_SUCCESS : EXIT_USAGE_ERROR;
    }

    return await runRender(parsed.value, out);
  } catch (error) {
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
