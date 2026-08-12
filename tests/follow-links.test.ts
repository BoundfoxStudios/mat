import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matDirectoryName } from '../src/assets/cache.ts';
import { createLinkFollowQueue, previewPathFor } from '../src/cli.ts';
import { render } from '../src/render/index.ts';
import type { LinkAdmission } from '../src/render/pipeline.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

let scratch: string;

beforeEach(() => {
  // Resolved eagerly: the preview file names hash the *real* path, and `mkdtemp` may answer with
  // a path that still contains a symlinked segment.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mat-follow-test-')));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(relativePath: string, contents: string | Uint8Array): string {
  const path = join(scratch, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);

  return path;
}

describe('link rewriting', () => {
  const BASE_DIR = '/home/user/docs';
  const PREVIEW: LinkAdmission = { previewUrl: 'file:///previews/target.html' };

  async function renderWithFollower(
    markdown: string,
    admission: LinkAdmission = PREVIEW,
  ): Promise<{ body: string; messages: string[]; admitted: string[] }> {
    const admitted: string[] = [];
    const { html, messages } = await render(markdown, {
      title: 'follow.md',
      theme: 'auto',
      baseDir: BASE_DIR,
      linkMode: 'absolute',
      embedMode: 'cache',
      followLinks: {
        admit(absolutePath) {
          admitted.push(absolutePath);

          return admission;
        },
      },
    });

    const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1] ?? '';

    return { body, messages, admitted };
  }

  test('rewrites a markdown link to the admitted preview url', async () => {
    const { body, admitted } = await renderWithFollower('[setup](guides/setup.md)');

    expect(admitted).toEqual(['/home/user/docs/guides/setup.md']);
    expect(body).toContain('href="file:///previews/target.html"');
  });

  test('keeps fragment and query attached to the rewritten link', async () => {
    const { body } = await renderWithFollower('[a](setup.md#install) [b](setup.md?v=2)');

    expect(body).toContain('href="file:///previews/target.html#install"');
    expect(body).toContain('href="file:///previews/target.html?v=2"');
  });

  test('matches the extension case-insensitively, .markdown included', async () => {
    const { admitted } = await renderWithFollower('[a](guide.MD) [b](notes.markdown)');

    expect(admitted).toEqual(['/home/user/docs/guide.MD', '/home/user/docs/notes.markdown']);
  });

  test('decodes percent-encoding before admitting', async () => {
    const { admitted } = await renderWithFollower('[a](set%20up.md)');

    expect(admitted).toEqual(['/home/user/docs/set up.md']);
  });

  test('follows a file: url the way the windows url policy produces them', async () => {
    const { body, admitted } = await renderWithFollower(
      '[setup](file:///home/user/docs/setup.md#install)',
    );

    expect(admitted).toEqual(['/home/user/docs/setup.md']);
    expect(body).toContain('href="file:///previews/target.html#install"');
  });

  test('ignores a path component that only ends in .md after normalisation', async () => {
    const { admitted } = await renderWithFollower('[a](setup.md/) [b](setup.md%2F)');

    expect(admitted).toEqual([]);
  });

  test('asks nothing for links that are not local markdown documents', async () => {
    const { body, admitted } = await renderWithFollower(
      [
        '[external](https://example.com/guide.md)',
        '[fragment](#section)',
        '[text](notes.txt)',
        '![image](diagram.md)',
      ].join(' '),
    );

    expect(admitted).toEqual([]);
    expect(body).toContain('href="https://example.com/guide.md"');
    expect(body).toContain('href="#section"');
    expect(body).toContain('href="file:///home/user/docs/notes.txt"');
    expect(body).toContain('src="file:///home/user/docs/diagram.md"');
  });

  test('keeps the source url and reports when admission is refused', async () => {
    const { body, messages } = await renderWithFollower('[gone](missing.md)', {
      problem: 'no such file',
    });

    expect(body).toContain('href="file:///home/user/docs/missing.md"');
    expect(messages).toEqual(['missing.md: no such file, the link is not followed']);
  });

  test('without the flag markdown links neither warn nor change shape', async () => {
    const { html, messages } = await render('[gone](missing.md) [f](file:///elsewhere/doc.md)', {
      title: 'follow.md',
      theme: 'auto',
      baseDir: BASE_DIR,
      linkMode: 'absolute',
      embedMode: 'cache',
    });

    expect(messages).toEqual([]);
    expect(html).toContain('href="file:///home/user/docs/missing.md"');
    expect(html).toContain('href="file:///elsewhere/doc.md"');
  });
});

describe('link follow queue', () => {
  test('admits an existing markdown file and queues it exactly once', () => {
    const path = fixture('a.md', '# A');
    const queue = createLinkFollowQueue(undefined);

    const first = queue.admit(path);
    const second = queue.admit(path);

    expect(first).toEqual({ previewUrl: pathToFileURL(previewPathFor(path)).href });
    expect(second).toEqual(first);
    expect(queue.nextQueued()).toEqual({ realPath: path, markdown: '# A' });
    expect(queue.nextQueued()).toBeUndefined();
  });

  test('shares the verdict across symlinked spellings', () => {
    const path = fixture('a.md', '# A');
    const alias = join(scratch, 'alias.md');
    symlinkSync(path, alias);
    const queue = createLinkFollowQueue(undefined);

    expect(queue.admit(alias)).toEqual(queue.admit(path));
    expect(queue.nextQueued()).toEqual({ realPath: path, markdown: '# A' });
    expect(queue.nextQueued()).toBeUndefined();
  });

  test('seeds the root so self links point at its preview without re-rendering it', () => {
    const path = fixture('root.md', '# Root');
    const queue = createLinkFollowQueue(path);

    expect(queue.admit(path)).toEqual({ previewUrl: pathToFileURL(previewPathFor(path)).href });
    expect(queue.nextQueued()).toBeUndefined();
  });

  test('refuses what cannot render', () => {
    mkdirSync(join(scratch, 'folder.md'));
    const binary = fixture('binary.md', new Uint8Array([0x23, 0x00, 0x01]));
    const garbled = fixture('garbled.md', new Uint8Array([0xff, 0xfe, 0xfd]));
    const oversized = fixture('oversized.md', new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61));
    const queue = createLinkFollowQueue(undefined);

    expect(queue.admit(join(scratch, 'missing.md'))).toEqual({ problem: 'no such file' });
    expect(queue.admit(join(scratch, 'folder.md'))).toEqual({ problem: 'is a directory' });
    expect(queue.admit(binary)).toEqual({ problem: 'looks like a binary file' });
    expect(queue.admit(garbled)).toEqual({ problem: 'not valid UTF-8' });
    expect(queue.admit(oversized)).toEqual({
      problem: '10485761 bytes exceeds the 10485760 byte limit',
    });
    // Reading a FIFO would block forever, a device file without end; both must be turned away on
    // their stat alone.
    expect(queue.admit('/dev/null')).toEqual({ problem: 'not a regular file' });
    expect(queue.nextQueued()).toBeUndefined();
  });
});

/** See the spawn helper in cli.test.ts for why every descriptor is a file and never a pipe. */
const SPAWN_TIMEOUT = 180_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let spawnCounter = 0;

async function spawn(args: readonly string[], stdin?: string): Promise<RunResult> {
  const emptyPath = join(scratch, 'no-launchers');
  mkdirSync(emptyPath, { recursive: true });

  const id = spawnCounter++;
  const stdoutPath = join(scratch, `stdout-${id}`);
  const stderrPath = join(scratch, `stderr-${id}`);
  let stdinSource: 'ignore' | ReturnType<typeof Bun.file> = 'ignore';

  if (stdin !== undefined) {
    const stdinPath = join(scratch, `stdin-${id}`);
    writeFileSync(stdinPath, stdin);
    stdinSource = Bun.file(stdinPath);
  }

  const child = Bun.spawn([process.execPath, 'run', CLI, ...args], {
    env: { ...process.env, TMPDIR: scratch, PATH: emptyPath },
    cwd: scratch,
    stdin: stdinSource,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });

  const code = await child.exited;

  return {
    code,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

/** The preview path as the child computes it: its `TMPDIR` is the scratch directory. */
function childPreviewPath(realPath: string): string {
  const digest = createHash('sha256').update(realPath).digest('hex');

  return join(scratch, matDirectoryName(), `${digest}.html`);
}

function childPreviewUrl(realPath: string): string {
  return pathToFileURL(childPreviewPath(realPath)).href;
}

describe('following links end to end', () => {
  test(
    'renders the reachable graph once, rewrites its links and reports the refused ones',
    async () => {
      const root = fixture(
        'docs/root.md',
        '# Root\n\n[a](a.md)\n[missing](missing.md)\n[self](./root.md)\n',
      );
      const a = fixture('docs/a.md', '# A\n\n[b](sub/b.md)\n[back](root.md)\n[bin](bin.md)\n');
      const b = fixture('docs/sub/b.md', '# B\n\n[up](../root.md)\n');
      const bin = fixture('docs/bin.md', new Uint8Array([0x00, 0x01]));

      const { code, stderr } = await spawn(['docs/root.md', '-f']);

      expect(code).toBe(3);
      expect(stderr).toContain('could not open a browser');

      const rootHtml = readFileSync(childPreviewPath(root), 'utf8');
      const aHtml = readFileSync(childPreviewPath(a), 'utf8');
      const bHtml = readFileSync(childPreviewPath(b), 'utf8');

      expect(rootHtml).toContain(`href="${childPreviewUrl(a)}"`);
      expect(rootHtml).toContain(`href="${childPreviewUrl(root)}"`);
      expect(rootHtml).toContain(`href="${pathToFileURL(join(scratch, 'docs/missing.md')).href}"`);
      expect(aHtml).toContain(`href="${childPreviewUrl(b)}"`);
      expect(aHtml).toContain(`href="${childPreviewUrl(root)}"`);
      expect(aHtml).toContain(`href="${pathToFileURL(bin).href}"`);
      expect(bHtml).toContain(`href="${childPreviewUrl(root)}"`);

      // The cycle through root must not multiply previews: one file per document, nothing more.
      const previews = readdirSync(join(scratch, matDirectoryName())).filter((name) =>
        name.endsWith('.html'),
      );
      expect(previews.sort()).toEqual(
        [root, a, b]
          .map((path) => `${createHash('sha256').update(path).digest('hex')}.html`)
          .sort(),
      );

      expect(stderr).toContain('missing.md: no such file, the link is not followed');
      expect(stderr).toContain(
        'docs/a.md: bin.md: looks like a binary file, the link is not followed',
      );
    },
    SPAWN_TIMEOUT,
  );

  test(
    'caps the aggregate warning list across all rendered files',
    async () => {
      fixture('docs/root.md', '# Root\n\n[a](a.md)\n[m1](m1.md)\n[m2](m2.md)\n[m3](m3.md)\n');
      fixture('docs/a.md', '# A\n\n[m4](m4.md)\n[m5](m5.md)\n[m6](m6.md)\n');

      const { code, stderr } = await spawn(['docs/root.md', '-f']);

      expect(code).toBe(3);
      expect(stderr.match(/the link is not followed/g)).toHaveLength(5);
      expect(stderr).toContain('1 more warnings');
      // Warnings out of linked files carry the file they were found in.
      expect(stderr).toContain('docs/a.md: m4.md: no such file, the link is not followed');
    },
    SPAWN_TIMEOUT,
  );

  test(
    'follows links from stdin against the base directory',
    async () => {
      const target = fixture('docs/target.md', '# Target');
      const markdown = '[target](target.md)\n';

      const { code, stderr } = await spawn(
        ['-', '-f', '--base-dir', join(scratch, 'docs')],
        markdown,
      );

      expect(code).toBe(3);
      expect(stderr).toContain('could not open a browser');

      const stdinPreview = join(
        scratch,
        matDirectoryName(),
        `${createHash('sha256').update(markdown).digest('hex')}.html`,
      );

      expect(readFileSync(stdinPreview, 'utf8')).toContain(`href="${childPreviewUrl(target)}"`);
      expect(readFileSync(childPreviewPath(target), 'utf8')).toContain('Target');
    },
    SPAWN_TIMEOUT,
  );
});
