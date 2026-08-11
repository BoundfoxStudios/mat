import { describe, expect, test } from 'bun:test';
import { KATEX_CSS } from '../src/generated/assets.ts';
import { render } from '../src/render/index.ts';

const FENCE = '```';

async function renderMath(markdown: string) {
  const { html, messages } = await render(markdown, {
    title: 'math.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode: 'cache',
  });

  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return { body, messages };
}

describe('math', () => {
  test('renders inline math', async () => {
    const { body } = await renderMath('Text $x^2$ text.');

    expect(body).toContain('<span class="katex">');
    expect(body).not.toContain('katex-display');
  });

  test('renders display math from dollars on their own lines', async () => {
    const { body } = await renderMath('$$\n\\frac12\n$$');

    expect(body).toContain('katex-display');
  });

  test('renders display math from a math fence', async () => {
    // `rehype-katex` claims `language-math` itself; `remark-math` never touches the fence. Move or
    // drop that plugin and this silently becomes a code block.
    const { body } = await renderMath(`${FENCE}math\n\\frac12\n${FENCE}`);

    expect(body).toContain('katex-display');
    expect(body).not.toContain('<code class="language-math"');
  });

  describe("github's backtick spelling", () => {
    test('renders without the backticks', async () => {
      const { body } = await renderMath('Text $`a_1`$ text.');

      expect(body).toContain('<span class="katex">');
      // `mdast-util-math` fills `data.hChildren` at parse time, so stripping only `node.value`
      // passes an AST test while KaTeX still renders the backticks as ‘ glyphs.
      expect(body).not.toContain('`');
      expect(body).not.toContain('‘');
    });

    test('leaves a backtick that is part of the formula alone', async () => {
      const { body } = await renderMath('Text $x`y$ text.');

      expect(body).toContain('<span class="katex">');
    });

    test('does not disturb ordinary inline code', async () => {
      const { body } = await renderMath('Text `code` text.');

      expect(body).toContain('<code>code</code>');
    });
  });

  test('emits markup the embedded stylesheet actually styles', async () => {
    const { body } = await renderMath('$x^2$');

    // KaTeX 0.18 renamed these to `katex-base`/`katex-strut`; 0.16 markup with 0.18 CSS builds
    // green and renders every exponent at the wrong size.
    expect(body).toContain('class="base"');
    expect(KATEX_CSS).toContain('.base{');
  });

  test('renders every syntax without a warning', async () => {
    const { messages } = await renderMath(
      ['$x$', '', '$`y`$', '', `${FENCE}math\nz\n${FENCE}`, '', '$$\nw\n$$'].join('\n'),
    );

    expect(messages).toEqual([]);
  });

  test('treats single-line $$ as inline, unlike github', async () => {
    // A documented divergence: `remark-math@6` has no option for it. See SPEC §14.
    const { body } = await renderMath('Text $$y^2$$ text.');

    expect(body).not.toContain('katex-display');
  });
});
