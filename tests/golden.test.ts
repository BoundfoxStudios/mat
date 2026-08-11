import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RenderOptions, render } from '../src/render/index.ts';

const fixtures = join(import.meta.dir, 'fixtures');
const source = readFileSync(join(fixtures, 'torture.md'), 'utf8');
const goldenPath = join(fixtures, 'torture.html');

/** A fixed base directory keeps the resolved `file://` image URLs the same on every machine. */
const options: RenderOptions = {
  title: 'torture.md',
  theme: 'auto',
  baseDir: '/tmp/mat-golden',
  linkMode: 'absolute',
  embedMode: 'cache',
};

/**
 * Only the body is snapshotted: the surrounding document embeds machine-specific cache paths and
 * 3.4 MB of mermaid. The head and the scripts are pinned by `tests/output-modes.test.ts` instead.
 */
function bodyOf(html: string): string {
  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return body;
}

describe('torture fixture', () => {
  test('matches the golden file', async () => {
    const { html } = await render(source, options);
    const body = bodyOf(html);

    if (process.env.MAT_UPDATE_GOLDEN === '1') {
      writeFileSync(goldenPath, body);
    }

    expect(body).toBe(readFileSync(goldenPath, 'utf8'));
  });

  test('warns about nothing but the deliberately unresolvable images', async () => {
    // The fixed base directory cannot contain the fixture's two relative images; every other
    // construct must stay silent.
    const { messages } = await render(source, options);

    expect(messages).toEqual([
      './bilder/beispiel.png: no such file, the img will not load',
      './bilder/beispiel.png: no such file, the img will not load',
    ]);
  });

  test('is byte-identical across two renders', async () => {
    const first = await render(source, options);
    const second = await render(source, options);

    const digest = (html: string) => createHash('sha256').update(html).digest('hex');

    expect(digest(second.html)).toBe(digest(first.html));
  });
});

describe('coverage of the constructs the fixture exists for', () => {
  const expectations: ReadonlyArray<[string, string]> = [
    ['front matter table', '<th>title</th>'],
    ['aligned table', '<th align="right">Rechts</th>'],
    ['task list', '<input type="checkbox" checked disabled>'],
    ['nested list', '<ul>\n<li>Dritte Ebene</li>'],
    ['strikethrough', '<del>zwei Tilden</del>'],
    ['single-tilde strikethrough', '<del>einer Tilde</del>'],
    ['autolink', '<a href="http://www.example.com">'],
    ['email autolink', '<a href="mailto:kontakt@example.com">'],
    ['heading id with umlauts', 'id="c-vs-net--ünïcode"'],
    ['anchor icon', '<span class="octicon octicon-link"></span>'],
    ['highlighted code', 'class="pl-k"'],
    ['mermaid block', '<pre class="mermaid">'],
    ['inline math', '<span class="katex">'],
    ['display math', 'katex-display'],
    ['details', '<summary>Aufklappbarer Abschnitt mit <em>Inline-Markup</em></summary>'],
    ['footnotes', 'class="footnotes"'],
    ['screen-reader heading', '<h2 class="sr-only" id="footnote-label">'],
    ['resolved relative image', 'file:///tmp/mat-golden/bilder/beispiel.png'],
  ];

  for (const [name, expected] of expectations) {
    test(`covers ${name}`, async () => {
      const { html } = await render(source, options);

      expect(bodyOf(html)).toContain(expected);
    });
  }

  const absences: ReadonlyArray<[string, string]> = [
    ['live script', '<script'],
    ['live iframe', '<iframe'],
    ['event handler', 'onerror'],
    ['bare domain autolink', '>foo.com</a>'],
    ['unresolved relative image', 'src="./bilder/'],
  ];

  for (const [name, forbidden] of absences) {
    test(`has no ${name}`, async () => {
      const { html } = await render(source, options);

      expect(bodyOf(html)).not.toContain(forbidden);
    });
  }
});
