import { describe, expect, test } from 'bun:test';
import { gfm } from '../src/flavors/gfm.ts';
import { type RenderOptions, render } from '../src/render/index.ts';
import { getProcessor } from '../src/render/pipeline.ts';

const defaults: RenderOptions = {
  title: 'test.md',
  theme: 'auto',
  baseDir: '/tmp',
  linkMode: 'absolute',
  embedMode: 'cache',
};

async function renderHtml(markdown: string, overrides: Partial<RenderOptions> = {}) {
  const { html } = await render(markdown, { ...defaults, ...overrides });
  return html;
}

describe('render', () => {
  test('wraps the body in the class github-markdown-css requires', async () => {
    const html = await renderHtml('# Hello');

    expect(html).toContain('<article class="markdown-body">');
    expect(html).toMatch(/<article class="markdown-body">[\s\S]*<h1 id="hello">Hello/);
  });

  test('emits a complete document', async () => {
    const html = await renderHtml('# Hello');

    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>test.md</title>');
  });

  test('escapes the title', async () => {
    const html = await renderHtml('x', { title: '<script>&"' });

    expect(html).toContain('<title>&lt;script&gt;&amp;&quot;</title>');
  });

  test('never emits a base tag', async () => {
    // A `<base href>` would fix relative images and break every in-page `#fragment` link.
    expect(await renderHtml('# Hello')).not.toContain('<base');
  });

  describe('theming', () => {
    test('selects the stylesheet file rather than setting an attribute', async () => {
      const light = await renderHtml('x', { theme: 'light' });
      const dark = await renderHtml('x', { theme: 'dark' });
      const auto = await renderHtml('x', { theme: 'auto' });

      expect(light).not.toContain('prefers-color-scheme: dark');
      expect(dark).not.toContain('prefers-color-scheme: light');
      expect(auto).toContain('prefers-color-scheme: dark');

      // The `[data-theme]` selectors in the combined stylesheet are no-ops nested inside the media
      // queries, so mat must never set the attribute and rely on them.
      for (const html of [light, dark, auto]) {
        const openingTag = html.match(/<html[^>]*>/)?.[0] ?? '';
        expect(openingTag).not.toContain('data-theme');
      }
    });

    test('paints the page canvas, which github-markdown-css does not', async () => {
      expect(await renderHtml('x', { theme: 'dark' })).toContain(
        'html, body { background-color: #0d1117; }',
      );
      expect(await renderHtml('x', { theme: 'light' })).toContain(
        'html, body { background-color: #ffffff; }',
      );
    });

    test('ships the sr-only rule github-markdown-css lacks', async () => {
      expect(await renderHtml('x')).toContain('.sr-only {');
    });
  });

  test('reuses one processor across renders', async () => {
    await renderHtml('# One');
    const first = getProcessor(gfm);
    await renderHtml('# Two');

    expect(getProcessor(gfm)).toBe(first);
  });

  test('is deterministic', async () => {
    expect(await renderHtml('# Same')).toBe(await renderHtml('# Same'));
  });
});
