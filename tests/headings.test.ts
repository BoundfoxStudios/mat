import { describe, expect, test } from 'bun:test';
import GithubSlugger from 'github-slugger';
import { render } from '../src/render/index.ts';

async function renderBody(markdown: string): Promise<string> {
  const { html } = await render(markdown, {
    title: 'headings.md',
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

const AWKWARD_HEADING = 'C# vs .NET — Ünïcode!!';

describe('heading ids', () => {
  test('matches github-slugger', async () => {
    const body = await renderBody(`# ${AWKWARD_HEADING}`);
    const expected = new GithubSlugger().slug(AWKWARD_HEADING);

    expect(expected).toBe('c-vs-net--ünïcode');
    expect(body).toContain(`<h1 id="${expected}"`);
  });

  test('reaches headings written as raw html', async () => {
    // Only true because `rehype-raw` runs before `rehype-slug`; the other order fails silently,
    // since markdown-native headings keep working either way.
    expect(await renderBody('<h2>Raw heading</h2>')).toContain('<h2 id="raw-heading"');
  });

  test('disambiguates duplicates', async () => {
    const body = await renderBody('## Dupe\n\n## Dupe');

    expect(body).toContain('id="dupe"');
    expect(body).toContain('id="dupe-1"');
  });

  test('does not leak the duplicate counter between renders', async () => {
    // `rehype-slug` builds a fresh slugger per file; a shared one would make the second render
    // start at `dupe-1`.
    expect(await renderBody('## Dupe')).toBe(await renderBody('## Dupe'));
  });
});

describe('anchors', () => {
  test('append an octicon link that github-markdown-css can style', async () => {
    const body = await renderBody('# Hello');

    expect(body).toContain(
      '<a class="anchor" href="#hello"><span class="octicon octicon-link"></span></a></h1>',
    );
  });
});
