import { describe, expect, test } from 'bun:test';
import { GITHUB_MARKDOWN_CSS } from '../src/generated/assets.ts';
import { render } from '../src/render/index.ts';

async function renderBody(markdown: string): Promise<string> {
  const { html } = await render(markdown, {
    title: 'gfm.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode: 'cache',
  });

  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return body;
}

function frontMatter(...lines: string[]): string {
  return ['---', ...lines, '---', '', 'Body.'].join('\n');
}

describe('front matter', () => {
  test('becomes a two-row table with the keys as the header', async () => {
    const body = await renderBody(frontMatter('title: Hallo', 'draft: true'));

    expect(body).toContain(
      '<table><thead><tr><th>title</th><th>draft</th></tr></thead>' +
        '<tbody><tr><td>Hallo</td><td>true</td></tr></tbody></table>',
    );
  });

  test('flattens lists and objects into one cell', async () => {
    const body = await renderBody(frontMatter('tags: [a, b]', 'meta: { x: 1 }'));

    expect(body).toContain('<td>a, b</td>');
    expect(body).toContain('<td>{"x":1}</td>');
  });

  test('renders values as text, never as markdown', async () => {
    const body = await renderBody(frontMatter('title: "**bold** and [link](x)"'));

    expect(body).toContain('<td>**bold** and [link](x)</td>');
  });

  test('drops front matter it cannot turn into a table', async () => {
    for (const source of [frontMatter('- just', '- a list'), frontMatter(''), frontMatter(': :')]) {
      const body = await renderBody(source);

      expect(body).not.toContain('<table>');
      expect(body).toContain('<p>Body.</p>');
    }
  });

  test('only treats front matter at the very top as front matter', async () => {
    const body = await renderBody(['Intro.', '', '---', 'title: Hallo', '---'].join('\n'));

    expect(body).not.toContain('<table>');
  });
});

describe('alerts', () => {
  const TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;

  for (const type of TYPES) {
    test(`renders ${type} with a class github-markdown-css defines`, async () => {
      const body = await renderBody(`> [!${type.toUpperCase()}]\n> Text.`);

      expect(body).toContain(`class="markdown-alert markdown-alert-${type}"`);
      expect(body).toContain('class="markdown-alert-title"');
      expect(GITHUB_MARKDOWN_CSS.auto).toContain(`.markdown-alert-${type}`);
    });
  }

  test('leaves a plain blockquote alone', async () => {
    const body = await renderBody('> Just a quote.');

    expect(body).toContain('<blockquote>');
    expect(body).not.toContain('markdown-alert');
  });
});

describe('gfm constructs', () => {
  test('renders tables with column alignment', async () => {
    const body = await renderBody('| a | b |\n|:--|--:|\n| 1 | 2 |');

    expect(body).toContain('<th align="left">a</th>');
    expect(body).toContain('<td align="right">2</td>');
  });

  test('renders task lists with the classes the stylesheet expects', async () => {
    const body = await renderBody('- [x] done\n- [ ] open');

    expect(body).toContain('<ul class="contains-task-list">');
    expect(body).toContain('<li class="task-list-item"><input type="checkbox" checked disabled>');
    expect(body).toContain('<li class="task-list-item"><input type="checkbox" disabled>');
  });

  test('renders both strikethrough spellings as del', async () => {
    expect(await renderBody('~~two~~ and ~one~')).toContain('<del>two</del> and <del>one</del>');
  });

  test('autolinks exactly what the gfm extension covers', async () => {
    const body = await renderBody('https://example.com www.example.com a@b.com foo.com');

    expect(body).toContain('<a href="https://example.com">https://example.com</a>');
    expect(body).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(body).toContain('<a href="mailto:a@b.com">a@b.com</a>');
    // Bare `foo.com` staying unlinked is correct, not a gap — see SPEC §14.
    expect(body).not.toContain('>foo.com</a>');
  });

  test('renders footnotes into a labelled section', async () => {
    const body = await renderBody('Text[^1]\n\n[^1]: The note.');

    expect(body).toContain('data-footnote-ref');
    expect(body).toContain('class="footnotes"');
    // github-markdown-css has no `.sr-only` rule; without the one `chrome.css` adds, this is a
    // visible "Footnotes" title GitHub does not show.
    expect(body).toContain('<h2 class="sr-only" id="footnote-label">');
    expect(GITHUB_MARKDOWN_CSS.auto).not.toContain('.sr-only');
  });
});

describe('fence languages', () => {
  test('are matched case-insensitively, like the highlighter', async () => {
    const body = await renderBody('```Mermaid\ngraph TD;\n  A-->B;\n```');

    expect(body).toContain('<pre class="mermaid">');
  });

  test('accept mixed case for highlighted languages too', async () => {
    expect(await renderBody('```TypeScript\nconst a = 1;\n```')).toContain('class="pl-k"');
  });
});

describe('front matter that cannot be tabulated', () => {
  test('does not fail the document', async () => {
    // A YAML alias can point at its own ancestor; `JSON.stringify` refuses the cycle.
    const body = await renderBody('---\na: &x\n b: *x\n---\n\n# Titel');

    expect(body).toContain('<h1 id="titel">');
  });
});
