import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface LaunchCommand {
  command: string;
  args: string[];
}

/** WSL reports `platform === 'linux'` but has no working `xdg-open`; the kernel string is the tell. */
function isWindowsSubsystemForLinux(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') {
    return false;
  }

  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * Hand-rolled rather than the `open` package: it ships a non-JavaScript `xdg-open` helper script
 * that bundlers silently drop, so the build stays green and breaks for Linux users only.
 */
export function launchCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
): LaunchCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'open', args: [url] }];
  }

  if (platform === 'win32') {
    // Avoids `cmd /c start`, whose quoting rules mangle URLs containing `&` or `^`.
    return [{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }];
  }

  if (isWindowsSubsystemForLinux(platform)) {
    return [{ command: 'powershell.exe', args: ['-NoProfile', 'Start-Process', url] }];
  }

  return [
    { command: 'xdg-open', args: [url] },
    { command: 'x-www-browser', args: [url] },
    { command: 'www-browser', args: [url] },
  ];
}

function trySpawn({ command, args }: LaunchCommand): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });

    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openWith(commands: readonly LaunchCommand[]): Promise<boolean> {
  for (const candidate of commands) {
    if (await trySpawn(candidate)) {
      return true;
    }
  }

  return false;
}

export function openInBrowser(url: string): Promise<boolean> {
  return openWith(launchCommands(url));
}
