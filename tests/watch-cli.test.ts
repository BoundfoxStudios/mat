import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// Same reasoning as in cli.test.ts: every case starts a fresh Bun that transpiles mat's whole
// module graph, and on a cold cache that has been measured past a minute.
const SPAWN_TIMEOUT = 180_000;
const DEADLINE_MILLISECONDS = 60_000;
const POLL_INTERVAL_MILLISECONDS = 25;
// The watcher's 200 ms debounce plus room for a render: a shorter window would let every negative
// case pass by simply looking too early.
const QUIET_MILLISECONDS = 3000;

interface WatchProcess {
  stderr(): string;
  /** Sends the signal and resolves with the exit code mat chose for itself. */
  stop(signal: NodeJS.Signals): Promise<number>;
  kill(): Promise<void>;
}

let scratch: string;
let watchCounter = 0;
const running: WatchProcess[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-watch-test-'));
});

afterEach(async () => {
  // A case that failed mid-way leaves its session running, and a `mat --watch` never ends on its
  // own; without this the test process would hang on the surviving children.
  for (const watch of running) {
    await watch.kill();
  }

  running.length = 0;
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Deliberately does not await `child.exited`: the process under test only ends when it is told to,
 * so the caller drives it from the outside and reads stderr as it is written.
 *
 * The empty `PATH` leaves the child with no browser launcher, which is also the test of that
 * decision: watching has to continue after a failed launch, and the printed url is what the rest
 * of every case works with.
 */
function spawnWatch(args: readonly string[], cwd: string): WatchProcess {
  const emptyPath = join(scratch, 'no-launchers');
  mkdirSync(emptyPath, { recursive: true });

  const id = watchCounter++;
  const stdoutPath = join(scratch, `stdout-${id}`);
  const stderrPath = join(scratch, `stderr-${id}`);

  const child = Bun.spawn([process.execPath, 'run', CLI, ...args, '--watch'], {
    env: {
      ...process.env,
      TMPDIR: scratch,
      PATH: emptyPath,
      XDG_CONFIG_HOME: join(scratch, 'config-home'),
    },
    cwd,
    stdin: 'ignore',
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });

  const watch: WatchProcess = {
    stderr() {
      try {
        return readFileSync(stderrPath, 'utf8');
      } catch {
        return '';
      }
    },
    stop(signal) {
      child.kill(signal);

      return child.exited;
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };

  running.push(watch);

  return watch;
}

function workspace(name: string, files: Record<string, string>): string {
  const directory = join(scratch, name);
  mkdirSync(directory, { recursive: true });

  for (const [fileName, contents] of Object.entries(files)) {
    writeFileSync(join(directory, fileName), contents);
  }

  return directory;
}

async function waitFor(condition: () => boolean, expectation: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MILLISECONDS;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${expectation}`);
    }

    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

function renderCount(watch: WatchProcess): number {
  return watch.stderr().split('re-rendered').length - 1;
}

/** Resolves once the watch set is armed, which mat logs only after the first preview is written. */
function waitUntilArmed(watch: WatchProcess): Promise<void> {
  return waitFor(() => watch.stderr().includes('watching for changes'), 'the watcher to be armed');
}

function waitForRenders(watch: WatchProcess, count: number): Promise<void> {
  return waitFor(() => renderCount(watch) >= count, `${count} re-renders`);
}

function previewOf(watch: WatchProcess): string {
  const url = /file:\/\/\S+/.exec(watch.stderr())?.[0];

  if (url === undefined) {
    throw new Error('no preview url on stderr');
  }

  return fileURLToPath(url);
}

describe('watch session', () => {
  test(
    're-renders a changed file into the same preview and exits 0 on SIGINT',
    async () => {
      const directory = workspace('rerender', { 'note.md': '# First' });
      const watch = spawnWatch(['note.md'], directory);

      await waitUntilArmed(watch);

      const preview = previewOf(watch);

      expect(readFileSync(preview, 'utf8')).toContain('<h1 id="first">');

      writeFileSync(join(directory, 'note.md'), '# Second');
      await waitForRenders(watch, 1);

      expect(readFileSync(preview, 'utf8')).toContain('<h1 id="second">');
      expect(await watch.stop('SIGINT')).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'exits 0 on SIGTERM as well',
    async () => {
      const directory = workspace('sigterm', { 'note.md': '# First' });
      const watch = spawnWatch(['note.md'], directory);

      await waitUntilArmed(watch);

      expect(await watch.stop('SIGTERM')).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'keeps the last good preview when a render fails and recovers on the next save',
    async () => {
      const directory = workspace('recovery', { 'note.md': '# First' });
      const watch = spawnWatch(['note.md'], directory);

      await waitUntilArmed(watch);

      const preview = previewOf(watch);

      rmSync(join(directory, 'note.md'));
      await waitFor(() => watch.stderr().includes('no such file'), 'the read error');

      expect(readFileSync(preview, 'utf8')).toContain('<h1 id="first">');
      expect(renderCount(watch)).toBe(0);

      writeFileSync(join(directory, 'note.md'), '# Second');
      await waitForRenders(watch, 1);

      expect(readFileSync(preview, 'utf8')).toContain('<h1 id="second">');
      expect(await watch.stop('SIGINT')).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'gives a linked preview the same reload channel and drops it once the link is gone',
    async () => {
      const directory = workspace('follow', {
        'a.md': '# A\n\n[b](b.md)',
        'b.md': '# B first',
      });
      const watch = spawnWatch(['a.md', '-f'], directory);

      await waitUntilArmed(watch);

      const root = readFileSync(previewOf(watch), 'utf8');
      const reloadUrl = /ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(root)?.[0];
      const linkedHref = /href="(file:\/\/[^"]+)"/.exec(root)?.[1];

      if (reloadUrl === undefined || linkedHref === undefined) {
        throw new Error('the root preview carries no reload url, or no link to a preview');
      }

      // Reached through the href the reader would click, so this is the page they end up on.
      expect(readFileSync(fileURLToPath(linkedHref), 'utf8')).toContain(reloadUrl);

      writeFileSync(join(directory, 'b.md'), '# B second');
      await waitForRenders(watch, 1);

      writeFileSync(join(directory, 'a.md'), '# A alone');
      await waitForRenders(watch, 2);

      writeFileSync(join(directory, 'b.md'), '# B third');
      // Nothing to wait for, so the assertion needs a window long enough that a render would have
      // been logged by now.
      await Bun.sleep(QUIET_MILLISECONDS);

      expect(renderCount(watch)).toBe(2);
      expect(await watch.stop('SIGINT')).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  test(
    'stays on the default document it started with when a higher-priority one appears',
    async () => {
      const directory = workspace('pinned', { 'README.md': '# From README' });
      const watch = spawnWatch([], directory);

      await waitUntilArmed(watch);

      const preview = previewOf(watch);

      writeFileSync(join(directory, 'index.md'), '# From index');
      writeFileSync(join(directory, 'README.md'), '# From README again');
      await waitForRenders(watch, 1);

      expect(readFileSync(preview, 'utf8')).toContain('<h1 id="from-readme-again">');
      expect(await watch.stop('SIGINT')).toBe(0);
    },
    SPAWN_TIMEOUT,
  );
});
