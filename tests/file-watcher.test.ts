import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFileWatcher, type FileWatcher } from '../src/cli/file-watcher.ts';

const DEBOUNCE_MILLISECONDS = 20;
const SLOW_DEBOUNCE_MILLISECONDS = 500;
const QUIET_MILLISECONDS = 250;
const DEADLINE_MILLISECONDS = 5000;
const POLL_INTERVAL_MILLISECONDS = 5;

let scratch: string;
const openWatchers: FileWatcher[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-file-watcher-'));
});

afterEach(() => {
  for (const watcher of openWatchers) {
    watcher.close();
  }

  openWatchers.length = 0;
  rmSync(scratch, { recursive: true, force: true });
});

async function waitUntil(
  condition: () => boolean,
  timeoutMilliseconds = DEADLINE_MILLISECONDS,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

function startWatching(paths: readonly string[], debounceMilliseconds = DEBOUNCE_MILLISECONDS) {
  let changes = 0;

  const watcher = createFileWatcher(() => {
    changes += 1;
  }, debounceMilliseconds);

  openWatchers.push(watcher);
  watcher.update(paths);

  return {
    watcher,
    changeCount: () => changes,
    /**
     * Waits for the expected calls and then for a quiet window in which a straggler would still
     * arrive. How many raw events one write produces differs between macOS and Linux, so only a
     * count taken after the debounce has settled says anything.
     */
    async settledChangeCount(
      expected: number,
      quietMilliseconds = QUIET_MILLISECONDS,
    ): Promise<number> {
      await waitUntil(() => changes >= expected);
      await waitUntil(() => changes > expected, quietMilliseconds);

      return changes;
    },
  };
}

describe('file watcher', () => {
  test('reports a single change when a watched file is rewritten', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);

    writeFileSync(file, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('coalesces a burst of writes into a single change', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);

    for (let revision = 0; revision < 5; revision += 1) {
      writeFileSync(file, `# revision ${revision}`);
    }

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports a change when an atomic save renames a sibling over the file', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);
    const staging = join(scratch, 'index.md.tmp');

    writeFileSync(staging, '# second');
    renameSync(staging, file);

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports an atomic save that lands before update refreshes the watched set', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);
    const staging = join(scratch, 'index.md.tmp');

    writeFileSync(staging, '# second');
    renameSync(staging, file);
    // The re-arm a finished render performs. It runs before the event for the save is delivered,
    // and the save is only visible as a replaced inode, so a baseline taken here would hide it.
    session.watcher.update([file]);

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports a change when a watched file is deleted and recreated', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);

    rmSync(file);
    writeFileSync(file, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports nothing when an unrelated file in the same directory is written', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);

    writeFileSync(join(scratch, 'notes.md'), '# unrelated');

    expect(await session.settledChangeCount(0)).toBe(0);
  });

  test('reports nothing for an unrelated sibling written after the watched file changed', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);

    writeFileSync(file, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);

    // The re-arm a finished render performs. It keeps the baselines, so the event for the edit
    // above has to have refreshed them itself, or the sibling below inherits its replacement.
    session.watcher.update([file]);

    writeFileSync(join(scratch, 'notes.md'), '# unrelated');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('coalesces changes to files in two directories into a single change', async () => {
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    mkdirSync(first);
    mkdirSync(second);

    const readme = join(first, 'readme.md');
    const guide = join(second, 'guide.md');
    writeFileSync(readme, '# first');
    writeFileSync(guide, '# first');

    const session = startWatching([readme, guide]);

    writeFileSync(readme, '# second');
    writeFileSync(guide, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports the added file and no longer the dropped one after update', async () => {
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    mkdirSync(first);
    mkdirSync(second);

    const dropped = join(first, 'dropped.md');
    const added = join(second, 'added.md');
    writeFileSync(dropped, '# first');
    writeFileSync(added, '# first');

    const session = startWatching([dropped]);
    session.watcher.update([added]);

    writeFileSync(dropped, '# second');

    expect(await session.settledChangeCount(0)).toBe(0);

    writeFileSync(added, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports a change to a file that update added to an already watched directory', async () => {
    const readme = join(scratch, 'readme.md');
    const guide = join(scratch, 'guide.md');
    writeFileSync(readme, '# first');
    writeFileSync(guide, '# first');

    const session = startWatching([readme]);
    session.watcher.update([readme, guide]);

    writeFileSync(guide, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports nothing for a file that update dropped from a directory it keeps', async () => {
    const readme = join(scratch, 'readme.md');
    const guide = join(scratch, 'guide.md');
    writeFileSync(readme, '# first');
    writeFileSync(guide, '# first');

    const session = startWatching([readme, guide]);
    session.watcher.update([readme]);

    writeFileSync(guide, '# second');

    expect(await session.settledChangeCount(0)).toBe(0);
  });

  test('reports nothing when a watched path sits in a directory that cannot be watched', async () => {
    const file = join(scratch, 'missing', 'index.md');

    const session = startWatching([file]);

    mkdirSync(dirname(file));
    writeFileSync(file, '# first');

    // A change reported from a directory that could not be watched would spin the render loop:
    // every pass would fail on the same unreadable path and immediately ask for the next one.
    expect(await session.settledChangeCount(0)).toBe(0);
  });

  test('keeps reporting changes when update repeats the same set', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);
    session.watcher.update([file]);

    writeFileSync(file, '# second');

    expect(await session.settledChangeCount(1)).toBe(1);
  });

  test('reports nothing when a watched file is written after close', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const session = startWatching([file]);
    session.watcher.close();

    writeFileSync(file, '# second');

    expect(await session.settledChangeCount(0)).toBe(0);
  });

  test('reports nothing when close arrives while a change is still debounced', async () => {
    const file = join(scratch, 'index.md');
    writeFileSync(file, '# first');

    const slow = startWatching([file], SLOW_DEBOUNCE_MILLISECONDS);
    // A second watcher on the same file with the short debounce: once it has reported, the event
    // has been delivered, so the slow one is sitting on a timer that close must clear.
    const probe = startWatching([file]);

    writeFileSync(file, '# second');
    await waitUntil(() => probe.changeCount() > 0);

    slow.watcher.close();

    expect(await slow.settledChangeCount(0, SLOW_DEBOUNCE_MILLISECONDS * 2)).toBe(0);
  });
});
