import { describe, expect, test } from 'bun:test';
import { launchCommands, openWith } from '../src/browser.ts';

const URL = 'file:///tmp/mat/preview.html';

describe('launchCommands', () => {
  test('uses open on macOS', () => {
    expect(launchCommands(URL, 'darwin')).toEqual([{ command: 'open', args: [URL] }]);
  });

  test('uses rundll32 on Windows, not cmd /c start', () => {
    const [first] = launchCommands(URL, 'win32');

    expect(first).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', URL] });
    // `cmd /c start` mangles URLs containing `&` or `^`.
    expect(launchCommands(URL, 'win32').map((entry) => entry.command)).not.toContain('cmd');
  });

  test('falls back through the freedesktop launchers on Linux', () => {
    expect(launchCommands(URL, 'linux').map((entry) => entry.command)).toEqual([
      'xdg-open',
      'x-www-browser',
      'www-browser',
    ]);
  });

  test('never routes the url through a shell', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const { command } of launchCommands(URL, platform)) {
        expect(['sh', 'bash', 'cmd', 'cmd.exe']).not.toContain(command);
      }
    }
  });

  test('passes the url as a single argument, never through a shell', () => {
    const awkward = 'file:///tmp/Über%20gr%C3%B6%C3%9Fe.html?a=1&b=2';

    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const { args } of launchCommands(awkward, platform)) {
        expect(args).toContain(awkward);
      }
    }
  });
});

describe('openWith', () => {
  const MISSING = { command: 'mat-no-such-launcher', args: [] };
  const PRESENT = { command: 'true', args: [] };

  test('reports failure when nothing can be started', async () => {
    // Drives exit code 3, where `mat` prints the url for the user to paste.
    expect(await openWith([MISSING, MISSING])).toBe(false);
  });

  test('falls through to the next candidate', async () => {
    expect(await openWith([MISSING, PRESENT])).toBe(true);
  });

  test('stops at the first candidate that starts', async () => {
    expect(await openWith([PRESENT, MISSING])).toBe(true);
  });

  test('reports failure for an empty list', async () => {
    expect(await openWith([])).toBe(false);
  });

  test('does not wait for the launcher to finish', async () => {
    // Detached and unref'd; otherwise `mat` blocks for as long as the browser stays open.
    const started = Date.now();

    expect(await openWith([{ command: 'sleep', args: ['5'] }])).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
