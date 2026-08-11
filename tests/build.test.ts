import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, hostTriple } from '../scripts/build.ts';

const HEADERS: Readonly<Record<string, readonly number[]>> = {
  elf: [0x7f, 0x45, 0x4c, 0x46],
  machO64: [0xcf, 0xfa, 0xed, 0xfe],
  pe: [0x4d, 0x5a],
};

const FOREIGN_TRIPLE = hostTriple().startsWith('bun-windows') ? 'bun-linux-x64' : 'bun-windows-x64';

/**
 * Compiling is opt-in.
 *
 * Each binary is ~100 MiB and every run rebuilds it. Alongside the eight tests that spawn a fresh
 * `bun run src/cli.ts` and the two that drive Chromium, a cold run pushed individual children past
 * a minute — the suite went from 4 s to 300 s and produced timeouts that said nothing about the
 * code. CI sets both variables, and `bun run build` is one command away locally.
 */
const compile = process.env.MAT_BUILD_TEST === '1';
const crossCompile = compile && process.env.MAT_CROSS_COMPILE_TEST === '1';

let outputDirectory: string;
let hostBinary: string;
let foreignBinary: string | undefined;

beforeAll(async () => {
  if (!compile) {
    return;
  }

  outputDirectory = mkdtempSync(join(tmpdir(), 'mat-build-'));

  hostBinary = await build({ triple: hostTriple(), binaryName: 'mat-host' }, outputDirectory);

  if (crossCompile) {
    foreignBinary = await build(
      { triple: FOREIGN_TRIPLE, binaryName: 'mat-foreign' },
      outputDirectory,
    );
  }
}, 300_000);

afterAll(() => {
  if (outputDirectory) {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

function firstBytes(path: string, count: number): number[] {
  return [...readFileSync(path).subarray(0, count)];
}

/**
 * Asynchronous on purpose: `bun test` shares one process across every file, and `spawnSync`
 * freezes its event loop — long enough for the Playwright tests alongside to time out.
 */
async function run(command: readonly string[]) {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

function expectedHeader(triple: string): readonly number[] {
  if (triple.includes('windows')) {
    return HEADERS.pe ?? [];
  }

  return triple.includes('darwin') ? (HEADERS.machO64 ?? []) : (HEADERS.elf ?? []);
}

describe.skipIf(!compile)('compiled binary', () => {
  test('is an executable in the right container format', () => {
    const expected = expectedHeader(hostTriple());

    expect(firstBytes(hostBinary, expected.length)).toEqual([...expected]);
  });

  test.skipIf(!crossCompile)('cross-compiles to a different container format', () => {
    // Checking the header, not the `--target` string: a partial triple such as `bun-darwin` is
    // accepted and quietly produces something else.
    const expected = expectedHeader(FOREIGN_TRIPLE);

    expect(firstBytes(foreignBinary ?? '', expected.length)).toEqual([...expected]);
  });

  test('bakes in no developer path', () => {
    // Bun embeds the build machine's `__dirname` into compiled binaries, which is why every asset
    // is a generated constant instead of a runtime file read.
    const contents = readFileSync(hostBinary, 'latin1');

    expect(contents).not.toContain(join(import.meta.dir, '..'));
    expect(contents).not.toContain('/Users/');
    expect(contents).not.toContain('/home/');
  });

  test('reports its version', async () => {
    const result = await run([hostBinary, '--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^mat \d+\.\d+\.\d+\n$/);
  });

  test('renders the torture fixture without a warning', async () => {
    // Unit tests cannot reach this: resolving `vscode-oniguruma` from disk works in
    // `node_modules` and fails inside a compiled binary.
    const fixture = join(import.meta.dir, 'fixtures', 'torture.md');
    const result = await run([hostBinary, fixture, '--output', '-']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    const html = result.stdout;

    expect(html).toContain('class="pl-k"');
    expect(html).toContain('<span class="katex">');
    expect(html).toContain('<pre class="mermaid">');
  });

  test('writes nothing but the binaries', () => {
    // Bun appends `.exe` for a Windows target whatever name it was given, so the build script has
    // to report the path it actually wrote.
    const foreignName = FOREIGN_TRIPLE.includes('windows') ? 'mat-foreign.exe' : 'mat-foreign';

    const expected = crossCompile ? [foreignName, 'mat-host'].sort() : ['mat-host'];

    expect(readdirSync(outputDirectory).sort()).toEqual(expected);

    if (crossCompile) {
      expect(foreignBinary?.endsWith(foreignName)).toBe(true);
    }
  });
});
