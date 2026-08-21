import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/cli/logger.ts';
import type { ReloadServer } from '../src/cli/reload-server.ts';
import { runWatch, type WatchRenderResult } from '../src/cli/watch.ts';

const DEBOUNCE_MILLISECONDS = 20;
const DEADLINE_MILLISECONDS = 5000;
const POLL_INTERVAL_MILLISECONDS = 5;
const QUIET_MILLISECONDS = 250;

let scratch: string;
const running: Array<() => Promise<void>> = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-watch-'));
});

afterEach(async () => {
  for (const stop of running) {
    await stop();
  }

  running.length = 0;
  rmSync(scratch, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, expectation: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MILLISECONDS;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${expectation}`);
    }

    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

function stubServer(): ReloadServer {
  return { url: 'ws://127.0.0.1:1/token', broadcast() {}, stop() {} };
}

interface Session {
  renders(): number;
  /** True once the watch set is armed, which is the only point a write can be seen from. */
  armed(): boolean;
  stop(): Promise<void>;
}

/**
 * Drives `runWatch` with a render step the test controls, which is what makes the window below
 * reachable at all: it depends on changes landing while a render is still running.
 */
function startSession(file: string, onRender: (call: number) => Promise<void> | void): Session {
  const controller = new AbortController();
  let renders = 0;
  let log = '';

  const finished = runWatch({
    logger: createLogger((text) => {
      log += text;
    }, false),
    signal: controller.signal,
    onFirstRender() {},
    openBrowser: () => Promise.resolve(true),
    startServer: stubServer,
    debounceMilliseconds: DEBOUNCE_MILLISECONDS,
    async render(): Promise<WatchRenderResult> {
      renders += 1;
      await onRender(renders);

      return { previewUrl: 'file:///preview.html', renderedRealPaths: [file] };
    },
  });

  const stop = async (): Promise<void> => {
    controller.abort();
    await finished;
  };

  running.push(stop);

  return {
    renders: () => renders,
    armed: () => log.includes('watching for changes'),
    stop,
  };
}

describe('watch session', () => {
  test('collapses every change that lands during a render into one follow-up', async () => {
    const file = join(scratch, 'note.md');
    writeFileSync(file, '# first');

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const session = startSession(file, async (call) => {
      if (call === 2) {
        await held;
      }
    });

    await waitFor(() => session.armed(), 'the watch set to be armed');

    writeFileSync(file, '# second');
    await waitFor(() => session.renders() >= 2, 'the render that change triggered');

    // Far enough apart to debounce separately, so two changes really do arrive while the render
    // above is still held.
    writeFileSync(file, '# third');
    await Bun.sleep(DEBOUNCE_MILLISECONDS * 4);
    writeFileSync(file, '# fourth');
    await Bun.sleep(DEBOUNCE_MILLISECONDS * 4);

    expect(session.renders()).toBe(2);

    release?.();

    await waitFor(() => session.renders() >= 3, 'the queued follow-up');
    await Bun.sleep(QUIET_MILLISECONDS);

    expect(session.renders()).toBe(3);
    await session.stop();
  });
});
