import { type FSWatcher, statSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface FileWatcher {
  /** Replaces the watched set; a path that falls out of it stops being reported. */
  update(paths: readonly string[]): void;
  close(): void;
}

interface WatchedDirectory {
  watcher: FSWatcher;
  identities: Map<string, string>;
}

/** Inode included: an atomic save leaves size and timestamp free to repeat, but not the inode. */
function identityOf(path: string): string {
  try {
    const stats = statSync(path);

    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'gone';
  }
}

function refreshIdentities(directory: string, identities: Map<string, string>): boolean {
  let replaced = false;

  for (const [fileName, previous] of identities) {
    const identity = identityOf(join(directory, fileName));

    if (identity !== previous) {
      identities.set(fileName, identity);
      replaced = true;
    }
  }

  return replaced;
}

/**
 * Watches the parent directories and filters the events by file name, rather than watching the
 * files themselves: an editor saving atomically writes a sibling file and renames it over the
 * target, which replaces the inode. A watch on the file keeps pointing at the inode that was
 * replaced and stays silent from then on, while the directory sees the rename.
 */
export function createFileWatcher(onChange: () => void, debounceMilliseconds = 200): FileWatcher {
  const watched = new Map<string, WatchedDirectory>();

  let pendingChange: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function scheduleChange(): void {
    if (closed) {
      return;
    }

    if (pendingChange !== undefined) {
      clearTimeout(pendingChange);
    }

    pendingChange = setTimeout(() => {
      pendingChange = undefined;
      onChange();
    }, debounceMilliseconds);
  }

  function isInteresting(directory: string, fileName: string | null | undefined): boolean {
    const entry = watched.get(directory);

    if (entry === undefined) {
      return false;
    }

    // Bun's inotify watcher reports a rename inside the directory under the name that vanished: an
    // atomic save arrives as `index.md.tmp`, never as `index.md`. An unwatched name alone is
    // therefore no reason to drop the event, so the watched files decide whether one was replaced.
    // Every event refreshes the baselines, those matched by name included, or an edit reported
    // under its own name would leave them stale and the next unrelated event would fire on them.
    const replaced = refreshIdentities(directory, entry.identities);

    // Some platforms report an event without naming the file. Rendering once too often is cheaper
    // than missing an edit, so an unnamed event counts as one of ours.
    if (fileName === undefined || fileName === null || entry.identities.has(fileName)) {
      return true;
    }

    return replaced;
  }

  function stopWatching(directory: string): void {
    const entry = watched.get(directory);

    if (entry === undefined) {
      return;
    }

    watched.delete(directory);
    entry.watcher.close();
  }

  function startWatching(directory: string, identities: Map<string, string>): void {
    let watcher: FSWatcher;

    try {
      watcher = watch(directory, (_eventType, fileName: string | null | undefined) => {
        if (isInteresting(directory, fileName)) {
          scheduleChange();
        }
      });
    } catch {
      // Deliberately without scheduling a change: the pass that reads these paths reports the
      // directory as a read error itself, and a render from here would spin while it stays gone.
      return;
    }

    // A watcher that errors out is dropped rather than kept as a handle that reports nothing ever
    // again; the scheduled pass lets whatever went wrong surface as a real read error.
    watcher.on('error', () => {
      stopWatching(directory);
      scheduleChange();
    });

    watched.set(directory, { watcher, identities });
  }

  return {
    update(paths) {
      if (closed) {
        return;
      }

      const wanted = new Map<string, Map<string, string>>();

      for (const path of paths) {
        const directory = dirname(path);
        const fileName = basename(path);
        const identities = wanted.get(directory) ?? new Map<string, string>();

        // A name that stays watched keeps its baseline: re-reading it here would swallow a save
        // that landed while the pass was rendering, because its event is still on its way and
        // would then find the file exactly as this line recorded it.
        identities.set(
          fileName,
          watched.get(directory)?.identities.get(fileName) ?? identityOf(path),
        );
        wanted.set(directory, identities);
      }

      for (const directory of watched.keys()) {
        if (!wanted.has(directory)) {
          stopWatching(directory);
        }
      }

      for (const [directory, identities] of wanted) {
        const entry = watched.get(directory);

        if (entry === undefined) {
          startWatching(directory, identities);
        } else {
          entry.identities = identities;
        }
      }
    },
    close() {
      closed = true;

      if (pendingChange !== undefined) {
        clearTimeout(pendingChange);
        pendingChange = undefined;
      }

      for (const { watcher } of watched.values()) {
        watcher.close();
      }

      watched.clear();
    },
  };
}
