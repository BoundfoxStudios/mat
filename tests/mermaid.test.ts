import { describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { fromHtml } from 'hast-util-from-html';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { cacheAsset } from '../src/assets/cache.ts';
import { gfm } from '../src/flavors/gfm.ts';
import { ONIGURUMA_WASM_BASE64 } from '../src/generated/assets.ts';
import { render } from '../src/render/index.ts';
import { rehypeFences } from '../src/render/plugins/fences.ts';
import { rehypeStarryNight } from '../src/render/plugins/starry-night.ts';
import { collectText } from '../src/render/text.ts';

const DIAGRAM = [
  'graph TD;',
  '  A[Start] --> B{Ist es <b>ok</b>?};',
  '  B -- ja --> C[Ende];',
  '  B -- nein --> A;',
].join('\n');

const FENCE = '```';

function fence(language: string, body: string): string {
  return [`${FENCE}${language}`, body, FENCE].join('\n');
}

async function renderBody(markdown: string): Promise<string> {
  const { html } = await render(markdown, {
    title: 'mermaid.md',
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

function diagramTextOf(html: string): string {
  const tree = fromHtml(html, { fragment: true });
  const blocks: string[] = [];

  const walk = (node: {
    type: string;
    tagName?: string;
    properties?: unknown;
    children?: unknown;
  }) => {
    const classNames = (node.properties as { className?: unknown } | undefined)?.className;

    if (node.tagName === 'pre' && Array.isArray(classNames) && classNames.includes('mermaid')) {
      blocks.push(collectText(node as never));
      return;
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as never);
      }
    }
  };

  walk(tree as never);

  if (blocks.length !== 1) {
    throw new Error(`expected exactly one mermaid block, found ${blocks.length}`);
  }

  return blocks[0] ?? '';
}

describe('mermaid', () => {
  test('emits a pre.mermaid block mermaid can pick up', async () => {
    const body = await renderBody(fence('mermaid', DIAGRAM));

    expect(body).toContain('<pre class="mermaid">');
    expect(body).not.toContain('language-mermaid');
  });

  test('preserves the fence content byte for byte', async () => {
    const body = await renderBody(fence('mermaid', DIAGRAM));

    // `mdast-util-to-hast` terminates the code value with a newline; everything before it must
    // survive untouched, including the raw `<b>` mermaid renders as markup in a node label.
    expect(diagramTextOf(body)).toBe(`${DIAGRAM}\n`);
  });

  test('survives the wrong plugin order', async () => {
    // `source.mermaid` is one of the 694 grammars, so highlighting first wraps the diagram source
    // in `<span>`s; collecting text recursively is what keeps both plugin orders equivalent.
    const wrongOrder = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStarryNight, {
        getOnigurumaUrlFs: () =>
          pathToFileURL(cacheAsset('onig', 'wasm', Buffer.from(ONIGURUMA_WASM_BASE64, 'base64'))),
        claimedLanguages: [],
      })
      .use(rehypeFences, gfm.fenceHandlers)
      .use(rehypeStringify, { allowDangerousHtml: true });

    const emitted = String(await wrongOrder.process(fence('mermaid', DIAGRAM)));

    expect(diagramTextOf(emitted)).toBe(`${DIAGRAM}\n`);
  });
});

describe('syntax highlighting', () => {
  test('emits the pl-* classes github-markdown-css styles', async () => {
    const body = await renderBody(fence('ts', 'const value: string = "hi";'));

    expect(body).toContain('<code class="language-ts">');
    expect(body).toContain('class="pl-k"');
  });

  test('covers languages outside the common grammar set', async () => {
    // `common` is 34 grammars and has none of these; loading all 694 up front costs seconds, so
    // they are registered per document.
    for (const [language, source] of [
      ['haskell', 'main = putStrLn "hi"'],
      ['scala', 'val x: Int = 1'],
      ['dockerfile', 'FROM alpine'],
      ['toml', 'key = "value"'],
    ] as const) {
      expect(await renderBody(fence(language, source))).toContain('class="pl-');
    }
  });

  test('resolves a language by extension as well as by name', async () => {
    expect(await renderBody(fence('.hs', 'main = putStrLn "hi"'))).toContain('class="pl-');
  });

  test('leaves math blocks to katex without warning about them', async () => {
    const { messages } = await render(fence('math', 'x^2'), {
      title: 'math.md',
      theme: 'auto',
      baseDir: '/tmp',
      linkMode: 'absolute',
      embedMode: 'cache',
    });

    expect(messages).toEqual([]);
  });

  test('reports an unknown language instead of failing', async () => {
    const { messages, html } = await render(fence('nosuchlang', 'x'), {
      title: 'unknown.md',
      theme: 'auto',
      baseDir: '/tmp',
      linkMode: 'absolute',
      embedMode: 'cache',
    });

    expect(messages).toEqual([
      'Unknown language `nosuchlang`; the block is rendered unhighlighted',
    ]);
    expect(html).toContain('<code class="language-nosuchlang">x\n</code>');
  });

  test('leaves a fence without a language alone', async () => {
    expect(await renderBody(fence('', 'plain'))).toContain('<pre><code>plain\n</code></pre>');
  });
});

describe('concurrent renders', () => {
  test('do not race the shared highlighter', async () => {
    // Rebuilding the highlighter is not atomic: the first render used to mark its scopes
    // registered before the instance containing them existed, so a second render highlighting at
    // the same moment threw `Expected grammar ... to be registered`.
    await renderBody(fence('python', 'print(1)'));

    const results = await Promise.allSettled([
      renderBody(fence('ruby', 'p 1')),
      renderBody(fence('ruby', 'p 1')),
      renderBody(fence('go', 'x := 1')),
      renderBody(fence('rust', 'fn main() {}')),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
  });
});
