import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { render } from '../src/render/index.ts';

// The nine tag names from GFM §6.11.
const FILTERED_TAGS = [
  'title',
  'textarea',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'script',
  'plaintext',
] as const;

const hostile = readFileSync(new URL('./fixtures/hostile.md', import.meta.url), 'utf8');

// The document shell legitimately contains `<title>` and two `<style>` blocks, so asserting on the
// whole document would pass or fail for the wrong reason.
function bodyOf(html: string): string {
  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return body;
}

async function renderBody(markdown: string): Promise<string> {
  const { html } = await render(markdown, {
    title: 'hostile.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode: 'cache',
  });

  return bodyOf(html);
}

const body = await renderBody(hostile);

/**
 * Attributes that survived on real elements, as the browser will see them.
 *
 * Substring matching cannot answer this any more: the fixture deliberately contains an escaped
 * payload whose *text* reads `onerror=…`, and a live handler and an inert one look identical to
 * `String.includes`.
 */
function liveAttributes(html: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];

  visit(fromHtml(html, { fragment: true }), 'element', (node) => {
    for (const [name, value] of Object.entries(node.properties ?? {})) {
      found.push([name, String(value)]);
    }
  });

  return found;
}

const attributes = liveAttributes(body);

describe('tagfilter', () => {
  for (const tag of FILTERED_TAGS) {
    test(`escapes <${tag}>`, () => {
      expect(body).not.toContain(`<${tag}`);
      expect(body).toContain(`&lt;${tag}`);
    });
  }

  test('escapes only the leading angle bracket, as GFM specifies', () => {
    // `&lt;script&gt;` would be over-escaping: GitHub emits `&lt;script>`.
    expect(body).toContain("&lt;script>alert('xss')&lt;/script>");
  });

  test('escapes the filtered content exactly once', () => {
    // Serialising the element through hast-util-to-html and reinserting it as text escapes the
    // children twice, so `a & b` reaches the browser as `a &#x26; b`.
    expect(body).not.toMatch(/&(#x26|amp);(#x26|amp);/);
    expect(body).toMatch(/&lt;textarea>a &(#x26|amp); b&lt;\/textarea>/);
  });
});

describe('url policy and allowlist', () => {
  test('leaves no event handler on any element', () => {
    expect(attributes.filter(([name]) => name.toLowerCase().startsWith('on'))).toEqual([]);
  });

  test('leaves no executable url on any element', () => {
    const executable = attributes.filter(([, value]) =>
      /^\s*(?:javascript|vbscript|data:text\/html)/i.test(value),
    );

    expect(executable).toEqual([]);
  });

  test('keeps no data: url that is not an image', () => {
    const dataUrls = attributes
      .map(([, value]) => value)
      .filter((value) => value.toLowerCase().startsWith('data:'));

    expect(dataUrls.every((value) => value.startsWith('data:image/'))).toBe(true);
  });

  test('keeps data:image/ urls', () => {
    expect(body).toContain('data:image/gif;base64,');
  });

  test('is not fooled by casing or by characters browsers ignore', async () => {
    const evasions = await renderBody(
      [
        '<a href="JaVaScRiPt:alert(1)">upper</a>',
        '<a href="  javascript:alert(2)">leading space</a>',
        '<a href="java\tscript:alert(3)">tab</a>',
        '<a href="java\nscript:alert(4)">newline</a>',
      ].join('\n\n'),
    );

    expect(evasions.toLowerCase()).not.toContain('javascript:');
    expect(evasions).not.toContain('alert(');
  });

  test('keeps a colon that belongs to the path', async () => {
    const paths = await renderBody(
      ['<a href="./a:b.md">relative</a>', '<a href="#x:y">fragment</a>'].join('\n\n'),
    );

    // The guard leaves both in place; `rehypeResolveAssets` then makes the relative one absolute.
    expect(paths).toContain('/a:b.md"');
    expect(paths).toContain('href="#x:y"');
  });

  test('drops a url list in which any entry is blocked', async () => {
    const hostileList = await renderBody('<img srcset="a.png 1x, javascript:alert(1) 2x">');

    expect(hostileList).not.toContain('srcset');
    expect(hostileList).not.toContain('javascript:');
  });

  test('keeps a url list in which every entry is harmless', async () => {
    // On `img` GitHub drops `srcset` outright, so `source` is the spelling that survives at all.
    const harmlessList = await renderBody(
      '<picture><source srcset="a.png 1x, b.png 2x"></picture>',
    );

    expect(harmlessList).toMatch(/srcset="[^"]*a\.png 1x,[^"]*b\.png 2x"/);
  });

  test('inspects a url list candidate by candidate', async () => {
    // The executable URL is the second candidate; checking the whole string reads
    // `./a.png 1x, javascript` as the scheme and passes.
    const hostileList = await renderBody(
      '<picture><source srcset="./a.png 1x, javascript:alert(1) 2x"></picture>',
    );

    expect(hostileList).not.toContain('srcset');
  });
});

describe('indirection', () => {
  test('escapes a `<` inside the attribute value of a filtered tag', () => {
    // `hast-util-to-html` leaves `<` alone inside attribute values, so escaping only the leading
    // one lets the value close the escaped tag and open a live element.
    expect(body).not.toContain('<img src=q');
    expect(body).toContain('&lt;img src=q');
  });

  test('removes svg entirely, as github does', () => {
    // SVG is the scripting surface behind `xlink:href`, SMIL `<animate>` and `<foreignObject>`.
    // It is not in the allowlist, so the markup goes and the text stays.
    expect(body).not.toContain('<svg');
    expect(body).not.toContain('xlink:href');
    expect(body).not.toContain('<animate');
    expect(body).toContain('xlink');
    expect(body).toContain('smil');
  });

  test('removes elements that navigate or fetch on their own', () => {
    expect(body).not.toContain('http-equiv');
    expect(body).not.toContain('<link');
    expect(body).not.toContain('<form');
    expect(body).not.toContain('evil.example');
  });

  test('keeps the content of an unwrapped element', () => {
    expect(body).toContain('form body survives');
  });

  test('strips vbscript: as well as javascript:', () => {
    expect(body).not.toContain('vbscript:');
    expect(body).toContain('>vbscript</a>');
  });

  test('keeps the link inside a removed svg', () => {
    // Unwrapping rather than deleting: a legitimate diagram link is not silently lost.
    expect(body).toContain('svg link');
    expect(body).toMatch(/<a href="file:\/\/[^"]*page\.html"/);
  });
});

describe('untouched constructs', () => {
  test('keeps details and summary', () => {
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>A <em>collapsible</em> section</summary>');
  });

  test('keeps inline markup inside raw html', () => {
    expect(body).toContain('<p>Body text with a <a href="https://example.com">link</a>.</p>');
  });

  test('keeps tables and task lists', () => {
    expect(body).toContain('<td>1</td>');
    expect(body).toContain('<li class="task-list-item"><input type="checkbox" checked disabled>');
  });
});
