import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSafely } from 'cmd-ts';
import { ensureOwnedDirectory, matDirectory, writeAtomically } from './assets/cache.ts';
import { openInBrowser } from './browser.ts';
import { type Invocation, renderCommand } from './cli/commands/render.ts';
import { type Configuration, loadConfiguration } from './cli/config.ts';
import { DEFAULT_DOCUMENTS, findDefaultDocument } from './cli/default-document.ts';
import { ConfigurationError, describeFileSystemError, RuntimeError } from './cli/errors.ts';
import { createLogger, type Logger } from './cli/logger.ts';
import { startUpdateCheck } from './cli/update-check.ts';
import { runWatch } from './cli/watch.ts';
import { MAT_VERSION } from './generated/assets.ts';
import { type RenderOptions, render } from './render/index.ts';
import type { LinkAdmission } from './render/pipeline.ts';

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

type DecodedMarkdown = { markdown: string } | { problem: string };

function decodeBytes(bytes: Uint8Array): DecodedMarkdown {
  if (bytes.byteLength > MAX_BYTES) {
    return { problem: `${bytes.byteLength} bytes exceeds the ${MAX_BYTES} byte limit` };
  }

  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { problem: 'looks like a binary file' };
  }

  try {
    // A BOM needs no handling: micromark is transparent to it, even before front matter.
    return { markdown: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { problem: 'not valid UTF-8' };
  }
}

export function decodeMarkdown(bytes: Uint8Array, label: string): string {
  const decoded = decodeBytes(bytes);

  if ('problem' in decoded) {
    throw new RuntimeError(`${label}: ${decoded.problem}`);
  }

  return decoded.markdown;
}

interface QueuedDocument {
  realPath: string;
  markdown: string;
}

export interface LinkFollowQueue {
  admit(absolutePath: string): LinkAdmission;
  nextQueued(): QueuedDocument | undefined;
}

/**
 * Admission decides at rewrite time whether a target will actually render — existence alone is
 * not enough, because a link already rewritten to a preview would dangle if the target later
 * turned out binary or oversized. The price is that every admitted file is read here; the decoded
 * markdown travels on the queue so it is read exactly once.
 *
 * Decisions are keyed by real path, so symlinked spellings of one document share a verdict, a
 * single render, and — through `previewPathFor` hashing the real path — one preview file.
 */
export function createLinkFollowQueue(rootRealPath: string | undefined): LinkFollowQueue {
  const admissions = new Map<string, LinkAdmission>();
  const queue: QueuedDocument[] = [];

  if (rootRealPath !== undefined) {
    admissions.set(rootRealPath, {
      previewUrl: pathToFileURL(previewPathFor(rootRealPath)).href,
    });
  }

  function admitNew(absolutePath: string): { realPath?: string; admission: LinkAdmission } {
    let realPath: string;

    try {
      realPath = realpathSync(absolutePath);
    } catch (error) {
      return { admission: { problem: describeFileSystemError(error) } };
    }

    const decided = admissions.get(realPath);

    if (decided !== undefined) {
      return { realPath, admission: decided };
    }

    let bytes: Uint8Array;

    try {
      const stats = statSync(realPath);

      if (stats.isDirectory()) {
        return { realPath, admission: { problem: 'is a directory' } };
      }

      // A FIFO defeats both the size guard (it reports 0) and `readFileSync`, which would block
      // on it until a writer appears; a device file reads without end.
      if (!stats.isFile()) {
        return { realPath, admission: { problem: 'not a regular file' } };
      }

      // Before reading, for the same reason `readSource` checks first: being told a file is too
      // large must not cost its size in memory.
      if (stats.size > MAX_BYTES) {
        return {
          realPath,
          admission: { problem: `${stats.size} bytes exceeds the ${MAX_BYTES} byte limit` },
        };
      }

      bytes = readFileSync(realPath);
    } catch (error) {
      return { realPath, admission: { problem: describeFileSystemError(error) } };
    }

    const decoded = decodeBytes(bytes);

    if ('problem' in decoded) {
      return { realPath, admission: { problem: decoded.problem } };
    }

    queue.push({ realPath, markdown: decoded.markdown });

    return { realPath, admission: { previewUrl: pathToFileURL(previewPathFor(realPath)).href } };
  }

  return {
    admit(absolutePath) {
      const known = admissions.get(absolutePath);

      if (known !== undefined) {
        return known;
      }

      const { realPath, admission } = admitNew(absolutePath);
      admissions.set(absolutePath, admission);

      if (realPath !== undefined) {
        admissions.set(realPath, admission);
      }

      return admission;
    },
    nextQueued() {
      return queue.shift();
    },
  };
}

/** Called without a file, `mat` renders whatever the current directory offers first. */
function defaultSource(directory: string, candidates: readonly string[], logger: Logger): string {
  const found = findDefaultDocument(directory, candidates);

  if (found === undefined) {
    throw new RuntimeError(
      `no file given, and none of ${candidates.join(', ')} exists in ${directory}`,
    );
  }

  logger.info(`no file given, rendering ${relative(directory, found)}`);

  return found;
}

async function readSource(
  invocation: Invocation,
  configuration: Configuration,
  logger: Logger,
): Promise<{ bytes: Uint8Array; label: string }> {
  if (invocation.source === '-') {
    return { bytes: readStdin(), label: '<stdin>' };
  }

  const source =
    invocation.source ??
    defaultSource(process.cwd(), configuration.defaultDocuments ?? DEFAULT_DOCUMENTS, logger);

  try {
    const realPath = realpathSync(source);
    const stats = statSync(realPath);

    if (stats.isDirectory()) {
      throw new RuntimeError(`${source}: is a directory`);
    }

    // A FIFO reports size 0 and then blocks the read until a writer appears; a device file reads
    // without end. Neither of the two checks below catches either.
    if (!stats.isFile()) {
      throw new RuntimeError(`${source}: not a regular file`);
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

    throw new RuntimeError(`${source}: ${describeFileSystemError(error)}`);
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
  /** Whether stderr is an interactive terminal; picks the human-friendly log format. */
  interactive?: boolean;
}

const PROCESS_STREAMS: OutputStreams = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  interactive: process.stderr.isTTY === true,
};

function reportMessages(messages: readonly string[], logger: Logger): void {
  for (const message of messages.slice(0, MAX_PRINTED_MESSAGES)) {
    logger.warn(message);
  }

  if (messages.length > MAX_PRINTED_MESSAGES) {
    logger.warn(`${messages.length - MAX_PRINTED_MESSAGES} more warnings`);
  }
}

function writePreview(previewPath: string, html: string): void {
  try {
    ensureOwnedDirectory(previewDirectory());
    writeAtomically(previewPath, html);
  } catch (error) {
    throw new RuntimeError(`${previewPath}: ${describeFileSystemError(error)}`);
  }
}

export interface RenderedDocuments {
  html: string;
  /** Where the root document's preview belongs; a `--output` render has no use for it. */
  previewPath: string;
  /** The root document's real path, or undefined when it was read from stdin. */
  realPath: string | undefined;
  /** Every rendered document that has a path on disk: the root first, then the followed links. */
  renderedRealPaths: string[];
}

/**
 * One render pass over the source and everything it links to, with the linked previews already
 * written. Separate from `runRender` so that `--watch` can repeat exactly this step: every call
 * builds a fresh follow queue, so a link added or removed since the last pass is picked up.
 */
async function renderDocuments(
  invocation: Invocation,
  configuration: Configuration,
  logger: Logger,
  reload?: RenderOptions['reload'],
): Promise<RenderedDocuments> {
  const { bytes, label } = await readSource(invocation, configuration, logger);

  if (bytes.byteLength > WARN_BYTES) {
    logger.warn(`${label} is ${bytes.byteLength} bytes; this may take a moment`);
  }

  const markdown = decodeMarkdown(bytes, label);
  const realPath = invocation.source === '-' ? undefined : label;
  // The configured default is suppressed by `--output` rather than rejected like the explicit
  // flag: a single self-contained file cannot hold the linked previews, and a configuration
  // meant as a default must not make `--output` unusable.
  const followLinks =
    invocation.followLinks ??
    (configuration.followLinks === true && invocation.output === undefined);
  const followQueue = followLinks ? createLinkFollowQueue(realPath) : undefined;

  const { html, messages } = await render(markdown, {
    title: realPath === undefined ? 'stdin' : basename(realPath),
    theme: invocation.theme,
    flavor: invocation.flavor,
    baseDir: resolveBaseDir(invocation, realPath),
    linkMode: 'absolute',
    // Anything the user keeps has to stand on its own; only the throwaway preview may point into
    // the shared cache.
    embedMode: invocation.output === undefined ? 'cache' : 'inline',
    followLinks: followQueue,
    reload,
  });

  const collectedMessages = [...messages];
  const renderedRealPaths = realPath === undefined ? [] : [realPath];

  if (followQueue !== undefined) {
    for (
      let queued = followQueue.nextQueued();
      queued !== undefined;
      queued = followQueue.nextQueued()
    ) {
      const linked = await render(queued.markdown, {
        title: basename(queued.realPath),
        theme: invocation.theme,
        flavor: invocation.flavor,
        baseDir: dirname(queued.realPath),
        linkMode: 'absolute',
        embedMode: 'cache',
        followLinks: followQueue,
        reload,
      });

      writePreview(previewPathFor(queued.realPath), linked.html);
      renderedRealPaths.push(queued.realPath);

      const documentLabel = relative(process.cwd(), queued.realPath);
      collectedMessages.push(...linked.messages.map((message) => `${documentLabel}: ${message}`));
    }
  }

  reportMessages(collectedMessages, logger);

  return {
    html,
    // stdin has no path to key the preview on, so its content decides: two different documents
    // piped in must not overwrite each other's tab.
    previewPath:
      realPath === undefined
        ? join(previewDirectory(), `${createHash('sha256').update(markdown).digest('hex')}.html`)
        : previewPathFor(realPath),
    realPath,
    renderedRealPaths,
  };
}

async function runRender(
  invocation: Invocation,
  configuration: Configuration,
  out: OutputStreams,
  logger: Logger,
): Promise<number> {
  const { html, previewPath } = await renderDocuments(invocation, configuration, logger);

  if (invocation.output === '-') {
    out.stdout(html);

    return EXIT_SUCCESS;
  }

  if (invocation.output !== undefined) {
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

  writePreview(previewPath, html);

  // Never string concatenation: it breaks on Windows paths, spaces and umlauts.
  const previewUrl = pathToFileURL(previewPath).href;

  if (!(await openInBrowser(previewUrl))) {
    logger.error(`could not open a browser; the preview is at ${previewUrl}`);

    return EXIT_BROWSER_LAUNCH_FAILED;
  }

  logger.success(previewUrl);

  return EXIT_SUCCESS;
}

async function runWatchSession(
  invocation: Invocation,
  configuration: Configuration,
  logger: Logger,
  signal: AbortSignal,
  onFirstRender: () => void,
): Promise<number> {
  let pinned = invocation;

  await runWatch({
    logger,
    signal,
    onFirstRender,
    async render(reloadUrl) {
      const rendered = await renderDocuments(pinned, configuration, logger, { url: reloadUrl });

      writePreview(rendered.previewPath, rendered.html);
      // Pinned to the path the first render resolved: called without a file, a session that
      // started on `README.md` must not silently switch to an `index.md` created later. `--watch`
      // is rejected for stdin, so there is always a path to pin. Retargeting the symlink a
      // session was started through is knowingly not followed.
      pinned = { ...pinned, source: rendered.realPath ?? pinned.source };

      return {
        previewUrl: pathToFileURL(rendered.previewPath).href,
        renderedRealPaths: rendered.renderedRealPaths,
      };
    },
  });

  return EXIT_SUCCESS;
}

/**
 * `checkForUpdate` is injectable for the same reason `out` is: the real one talks to GitHub
 * and to the shared temp directory, neither of which a test may touch.
 */
export async function main(
  argv: readonly string[],
  out: OutputStreams = PROCESS_STREAMS,
  checkForUpdate: typeof startUpdateCheck = startUpdateCheck,
  loadConfig: typeof loadConfiguration = loadConfiguration,
): Promise<number> {
  const logger = createLogger(out.stderr, out.interactive === true);

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

    // After the early returns above, so that `--help` and `--version` keep working with a broken
    // configuration file.
    const configuration = loadConfig();

    // Starts only for a real render — `--help`, `--version` and usage errors returned above —
    // and only where someone watches stderr: never under CI, never when it is redirected.
    const updateCheck = checkForUpdate({
      enabled:
        process.env.MAT_NO_UPDATE_CHECK === undefined &&
        process.env.CI === undefined &&
        out.interactive === true,
      currentVersion: MAT_VERSION,
      logger,
    });

    // A watch session reports right after its first render instead of at shutdown, where the hint
    // would scroll past minutes later; the wrapper keeps the `finally` below from repeating it.
    let reported = false;
    const reportUpdateOnce = (): void => {
      if (reported) {
        return;
      }

      reported = true;
      updateCheck.report();
    };

    try {
      if (!parsed.value.watch) {
        return await runRender(parsed.value, configuration, out, logger);
      }

      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };

      // `once` on both, so a second Ctrl+C during shutdown reaches the default handler and kills
      // the process rather than being swallowed.
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);

      try {
        return await runWatchSession(
          parsed.value,
          configuration,
          logger,
          controller.signal,
          reportUpdateOnce,
        );
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
      }
    } finally {
      reportUpdateOnce();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(reason);

    return error instanceof ConfigurationError ? EXIT_USAGE_ERROR : EXIT_RUNTIME_ERROR;
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
