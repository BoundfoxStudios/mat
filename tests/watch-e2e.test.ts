import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const STARTUP_TIMEOUT_MILLISECONDS = 120_000;
const RELOAD_TIMEOUT_MILLISECONDS = 30_000;
const POLL_INTERVAL_MILLISECONDS = 25;

let scratch: string;
let notePath: string;
let watch: Bun.Subprocess;
let browser: Browser;
let page: Page;
const socketUrls: string[] = [];
const consoleErrors: string[] = [];

function readStderr(stderrPath: string): string {
  try {
    return readFileSync(stderrPath, 'utf8');
  } catch {
    return '';
  }
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-watch-e2e-'));

  const directory = join(scratch, 'workspace');
  const emptyPath = join(scratch, 'no-launchers');
  mkdirSync(directory, { recursive: true });
  mkdirSync(emptyPath, { recursive: true });

  notePath = join(directory, 'note.md');
  writeFileSync(notePath, '# First');

  const stderrPath = join(scratch, 'stderr');

  // The empty `PATH` keeps mat from opening a browser of its own; this test drives the one it
  // controls, against the url mat prints instead.
  watch = Bun.spawn([process.execPath, 'run', CLI, 'note.md', '--watch'], {
    env: {
      ...process.env,
      TMPDIR: scratch,
      PATH: emptyPath,
      XDG_CONFIG_HOME: join(scratch, 'config-home'),
    },
    cwd: directory,
    stdin: 'ignore',
    stdout: Bun.file(join(scratch, 'stdout')),
    stderr: Bun.file(stderrPath),
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MILLISECONDS;

  while (!readStderr(stderrPath).includes('watching for changes')) {
    if (Date.now() >= deadline) {
      throw new Error(`mat never armed its watcher; stderr was:\n${readStderr(stderrPath)}`);
    }

    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }

  const previewUrl = /file:\/\/\S+/.exec(readStderr(stderrPath))?.[0];

  if (previewUrl === undefined) {
    throw new Error(`no preview url on stderr:\n${readStderr(stderrPath)}`);
  }

  browser = await chromium.launch();
  page = await browser.newPage();

  page.on('websocket', (socket) => socketUrls.push(socket.url()));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(previewUrl);
  // The client opens its socket while the document is parsed, so by `load` the object exists; the
  // wait only guards against asserting before playwright has reported it.
  await page.waitForEvent('websocket', { timeout: RELOAD_TIMEOUT_MILLISECONDS });
}, STARTUP_TIMEOUT_MILLISECONDS);

afterAll(async () => {
  await browser?.close();
  watch?.kill('SIGINT');
  await watch?.exited;
  rmSync(scratch, { recursive: true, force: true });
});

describe('a watched preview in the browser', () => {
  test('lets the injected client reach the session from a file:// page', () => {
    // A `file://` document has the opaque origin `null`, which is exactly the case this proves is
    // allowed to open a loopback WebSocket.
    expect(socketUrls).toHaveLength(1);
    expect(socketUrls[0]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(consoleErrors).toEqual([]);
  });

  test('reloads the tab when the document changes', async () => {
    writeFileSync(notePath, '# Second');

    await page.waitForFunction(() => document.querySelector('h1')?.id === 'second', undefined, {
      timeout: RELOAD_TIMEOUT_MILLISECONDS,
    });
  });
});
