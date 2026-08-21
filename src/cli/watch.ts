import { openInBrowser } from '../browser.ts';
import { createFileWatcher, type FileWatcher } from './file-watcher.ts';
import type { Logger } from './logger.ts';
import { type ReloadServer, startReloadServer } from './reload-server.ts';

export interface WatchRenderResult {
  previewUrl: string;
  /** Every file whose change has to trigger the next render. */
  renderedRealPaths: readonly string[];
}

export interface WatchOptions {
  /** Renders the document and everything it links to, with the reload client pointed at the url. */
  render(reloadUrl: string): Promise<WatchRenderResult>;
  logger: Logger;
  /** Ends the session; the caller wires it to SIGINT and SIGTERM. */
  signal: AbortSignal;
  /** Runs once the first preview is on screen, for anything that would clutter the startup. */
  onFirstRender(): void;
  openBrowser?: (url: string) => Promise<boolean>;
  startServer?: () => ReloadServer;
  debounceMilliseconds?: number;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Renders once, opens the browser, and then keeps re-rendering until the signal fires, telling the
 * open tab to reload after every pass.
 *
 * A failing first render throws, because a watch session with no preview to show has nothing to
 * offer. Every later failure only prints: the last good preview stays on screen and the watch set
 * stays armed, so saving the file again recovers the session.
 */
export async function runWatch({
  render,
  logger,
  signal,
  onFirstRender,
  openBrowser = openInBrowser,
  startServer = startReloadServer,
  debounceMilliseconds,
}: WatchOptions): Promise<void> {
  const server = startServer();
  let watcher: FileWatcher | undefined;
  let rendering = false;
  let pending = false;

  const renderAndBroadcast = async (): Promise<void> => {
    try {
      const rendered = await render(server.url);

      // The session can end while a render runs: by then the server is stopped and the watcher
      // closed, so there is nobody left to tell and nothing left to arm.
      if (signal.aborted) {
        return;
      }

      watcher?.update(rendered.renderedRealPaths);
      server.broadcast();
      logger.success('re-rendered');
    } catch (error) {
      if (!signal.aborted) {
        logger.error(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const rerender = async (): Promise<void> => {
    if (rendering) {
      // Exactly one follow-up, however many changes land while a render runs: they will all be in
      // the files by the time the next pass reads them.
      pending = true;

      return;
    }

    rendering = true;

    try {
      do {
        pending = false;
        await renderAndBroadcast();
      } while (pending && !signal.aborted);
    } finally {
      rendering = false;
    }
  };

  try {
    const first = await render(server.url);

    // The first render of a large document takes seconds; an abort landing in that window must not
    // still open a tab for a session that is already over.
    if (signal.aborted) {
      return;
    }

    if (await openBrowser(first.previewUrl)) {
      logger.success(first.previewUrl);
    } else {
      // Not the exit 3 of a one-shot render: opening the url by hand is all it takes, and from
      // then on the reload channel works exactly as it would have.
      logger.error(`could not open a browser; the preview is at ${first.previewUrl}`);
    }

    onFirstRender();

    watcher = createFileWatcher(() => {
      void rerender();
    }, debounceMilliseconds);
    watcher.update(first.renderedRealPaths);

    logger.info('watching for changes, press Ctrl+C to stop');

    await untilAborted(signal);
  } finally {
    // A render still in flight is left alone: every file it writes is written atomically, so the
    // worst it can leave behind is a preview one save out of date.
    watcher?.close();
    server.stop();
  }
}
