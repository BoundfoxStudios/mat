import { mkdirSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

interface Target {
  /** Must be the full triple: `bun-darwin` alone silently produces the wrong artefact. */
  readonly triple: string;
  readonly binaryName: string;
}

const TARGETS: readonly Target[] = [
  { triple: 'bun-darwin-arm64', binaryName: 'mat-darwin-arm64' },
  { triple: 'bun-linux-x64', binaryName: 'mat-linux-x64' },
  { triple: 'bun-linux-arm64', binaryName: 'mat-linux-arm64' },
  { triple: 'bun-windows-x64', binaryName: 'mat-windows-x64.exe' },
];

export function hostTriple(): string {
  const operatingSystem = platform() === 'win32' ? 'windows' : platform();
  const architecture = arch() === 'arm64' ? 'arm64' : 'x64';

  return `bun-${operatingSystem}-${architecture}`;
}

function selectedTargets(argv: readonly string[]): Target[] {
  if (argv.includes('--all')) {
    return [...TARGETS];
  }

  const requested = argv
    .find((argument) => argument.startsWith('--target='))
    ?.slice('--target='.length);
  const triple = requested ?? hostTriple();
  const target = TARGETS.find((candidate) => candidate.triple === triple);

  if (!target) {
    throw new Error(
      `unknown target \`${triple}\`; expected ${TARGETS.map((t) => t.triple).join(', ')}`,
    );
  }

  return [target];
}

export async function build(target: Target, outputDirectory: string): Promise<string> {
  // Bun appends `.exe` for a Windows target even when the name already ends in it, so the path it
  // writes is not necessarily the one it was given.
  const needsExtension = target.triple.includes('windows') && !target.binaryName.endsWith('.exe');
  const outfile = join(outputDirectory, `${target.binaryName}${needsExtension ? '.exe' : ''}`);

  // Asynchronous, not `spawnSync`: `bun test` runs every file in one process, and a synchronous
  // spawn freezes its event loop for the whole compile — long enough for the Playwright tests
  // running alongside to lose their connection and time out.
  const child = Bun.spawn(
    [
      process.execPath,
      'build',
      '--compile',
      '--minify',
      // No `--bytecode`: documented as unstable for compiled binaries, and startup is dominated by
      // the embedded assets rather than by parsing.
      `--target=${target.triple}`,
      '--outfile',
      outfile,
      join(import.meta.dir, '..', 'src', 'cli.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const stderr = await new Response(child.stderr).text();

  if ((await child.exited) !== 0) {
    throw new Error(`build failed for ${target.triple}:\n${stderr}`);
  }

  return outfile;
}

if (import.meta.main) {
  const outputDirectory = join(import.meta.dir, '..', 'dist');
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  for (const target of selectedTargets(process.argv.slice(2))) {
    const started = Date.now();
    const outfile = await build(target, outputDirectory);
    const size = Bun.file(outfile).size;

    process.stdout.write(
      `${target.triple.padEnd(20)} ${(size / 1024 / 1024).toFixed(1).padStart(6)} MiB  ` +
        `${Date.now() - started} ms  ${outfile}\n`,
    );
  }
}
