import { describe, expect, test } from 'bun:test';
import { render } from '../src/render/index.ts';

async function renderBody(markdown: string): Promise<string> {
  const { html } = await render(markdown, {
    title: 'parity.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode: 'inline',
  });

  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return body;
}

/**
 * The constructs real READMEs are built from.
 *
 * The allowlist is derived from GitHub's, measured against `api.github.com/markdown` rather than
 * read out of `github/html-pipeline` — that repository is an archived fork whose own readme says
 * GitHub stopped using it. These cases are what keeps the derivation honest: every one of them
 * renders on github.com today.
 */
describe('constructs a real readme is made of', () => {
  const survives: ReadonlyArray<[string, string, string]> = [
    [
      'shields.io badge',
      '[![build](https://img.shields.io/badge/build-passing-green)](https://example.com)',
      'img.shields.io/badge/build-passing-green',
    ],
    ['centred block', '<div align="center">\n\nHello\n\n</div>', '<div align="center">'],
    ['sized logo', '<img src="./logo.png" width="120" height="60" alt="logo">', 'width="120"'],
    ['keyboard key', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>', '<kbd>Ctrl</kbd>'],
    ['named anchor', '<a name="section"></a>\n\n# Section', 'name="section"'],
    [
      'dark-mode logo',
      '<picture><source media="(prefers-color-scheme: dark)" srcset="./dark.png"><img src="./light.png" alt="logo"></picture>',
      'media="(prefers-color-scheme: dark)"',
    ],
    [
      'html table with markdown inside',
      '<table><tr><td>\n\n`code` and **bold**\n\n</td></tr></table>',
      '<code>code</code>',
    ],
    ['collapsible section', '<details><summary>More</summary>\n\nBody\n\n</details>', '<details>'],
    ['aligned columns', '| a | b |\n|:--|--:|\n| 1 | 2 |', '<th align="right">b</th>'],
    ['task list', '- [x] done', '<input type="checkbox" checked disabled>'],
    ['roman list', '<ol type="i"><li>one</li></ol>', 'type="i"'],
    ['highlight', 'a <mark>marked</mark> word', '<mark>marked</mark>'],
    ['abbreviated text survives as text', '<abbr title="HyperText">HTML</abbr>', 'HTML'],
    ['local video', '<video src="./demo.mp4" controls></video>', '<video'],
    ['local audio', '<audio src="./sound.ogg" controls></audio>', '<audio'],
  ];

  for (const [name, markdown, expected] of survives) {
    test(`keeps ${name}`, async () => {
      expect(await renderBody(markdown)).toContain(expected);
    });
  }
});

describe('what github strips, mat strips too', () => {
  const stripped: ReadonlyArray<[string, string, string]> = [
    ['author class', '<div class="mine">x</div>', 'class="mine"'],
    ['author style', '<div style="color:red">x</div>', 'style'],
    ['author data attribute', '<div data-x="1">x</div>', 'data-x'],
    ['target on a link', '<a href="https://example.com" target="_blank">x</a>', 'target'],
    ['lazy loading hint', '<img src="./a.png" loading="lazy">', 'loading'],
    ['img srcset', '<img src="./a.png" srcset="./b.png 2x">', 'srcset'],
    ['video poster', '<video src="./a.mp4" poster="./p.png" controls></video>', 'poster'],
    ['inline svg', '<svg><circle r="5"/></svg>', '<svg'],
    ['iframe', '<iframe src="https://example.com"></iframe>', '<iframe src'],
  ];

  for (const [name, markdown, forbidden] of stripped) {
    test(`drops ${name}`, async () => {
      expect(await renderBody(markdown)).not.toContain(forbidden);
    });
  }

  test('drops a protocol-relative url, where github keeps it', async () => {
    // The one deliberate deviation: on github.com such a URL inherits https behind a proxy and a
    // CSP, from a `file://` page it inherits nothing.
    expect(await renderBody('<img src="//cdn.example.com/a.png">')).not.toContain(
      'cdn.example.com',
    );
  });
});

describe('character references', () => {
  test('are named, as github emits them', async () => {
    const body = await renderBody('5 < 6 & 7 > 3');

    expect(body).toContain('&lt;');
    expect(body).toContain('&amp;');
    expect(body).not.toContain('&#x3C;');
    expect(body).not.toContain('&#x26;');
  });
});
