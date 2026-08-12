import { describe, expect, test } from 'bun:test';
import { assetDirectory, matDirectoryName } from '../src/assets/cache.ts';
import { MERMAID_SCRIPT } from '../src/generated/assets.ts';
import { render } from '../src/render/index.ts';
import type { EmbedMode } from '../src/render/pipeline.ts';

const FENCE = '```';
const DIAGRAM = `${FENCE}mermaid\ngraph TD;\n  A-->B;\n${FENCE}`;

async function renderHtml(markdown: string, embedMode: EmbedMode): Promise<string> {
  const { html } = await render(markdown, {
    title: 'output.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode,
  });

  return html;
}

describe('optional assets', () => {
  test('ships no script and no katex stylesheet for a plain document', async () => {
    const html = await renderHtml('# Just text', 'cache');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('katex');
    // The mermaid bundle alone is 3.4 MB.
    expect(html.length).toBeLessThan(150_000);
  });

  test('ships the mermaid script only when a mermaid fence was used', async () => {
    expect(await renderHtml(`${FENCE}ts\nconst x = 1;\n${FENCE}`, 'cache')).not.toContain(
      '<script',
    );
    expect(await renderHtml(DIAGRAM, 'cache')).toContain('<script');
  });

  test('ships the katex stylesheet only when the document has math', async () => {
    expect(await renderHtml('No formulas here', 'cache')).not.toContain('@font-face');
    expect(await renderHtml('$x^2$', 'cache')).toContain('@font-face');
  });
});

describe('preview mode', () => {
  test('references the mermaid bundle from the shared cache', async () => {
    const html = await renderHtml(DIAGRAM, 'cache');

    expect(html).toMatch(
      new RegExp(
        `<script src="file://[^"]*/${matDirectoryName()}/assets/mermaid-[0-9a-f]{16}\\.js"></script>`,
      ),
    );
    // Referenced, not inlined: ~40 KiB instead of ~3.8 MiB per preview.
    expect(html).not.toContain(MERMAID_SCRIPT.slice(0, 200));
    expect(html.length).toBeLessThan(200_000);
  });

  test('references the katex fonts from the shared cache', async () => {
    const html = await renderHtml('$x^2$', 'cache');

    expect(html).toMatch(
      new RegExp(
        `url\\("file://[^"]*/${matDirectoryName()}/assets/KaTeX_Main-Regular-[0-9a-f]{16}\\.woff2"\\)`,
      ),
    );
    expect(html).not.toContain('data:font/woff2');
    expect(html).not.toContain('url(fonts/');
  });
});

describe('output mode', () => {
  test('inlines the mermaid bundle', async () => {
    const html = await renderHtml(DIAGRAM, 'inline');

    expect(html).toContain(MERMAID_SCRIPT.slice(0, 200));
    expect(html).not.toContain('<script src=');
  });

  test('inlines the katex fonts', async () => {
    const html = await renderHtml('$x^2$', 'inline');

    expect(html).toContain('url("data:font/woff2;base64,');
    expect(html).not.toContain('url(fonts/');
  });

  test('leaves no reference to the temp directory', async () => {
    const html = await renderHtml(`${DIAGRAM}\n\n$x^2$`, 'inline');

    expect(html).not.toContain(assetDirectory());
    expect(html).not.toContain(`/${matDirectoryName()}/assets/`);
  });
});

describe('script embedding', () => {
  test('emits classic scripts, never modules', async () => {
    for (const embedMode of ['cache', 'inline'] as const) {
      const html = await renderHtml(DIAGRAM, embedMode);

      expect(html).not.toContain('type="module"');
    }
  });

  test('hands mermaid a theme, since it reads no css', async () => {
    const dark = await render(DIAGRAM, {
      title: 'x',
      theme: 'dark',
      baseDir: '/tmp',
      linkMode: 'absolute',
      embedMode: 'cache',
    });
    const auto = await render(DIAGRAM, {
      title: 'x',
      theme: 'auto',
      baseDir: '/tmp',
      linkMode: 'absolute',
      embedMode: 'cache',
    });

    expect(dark.html).toContain('mermaid.initialize({ startOnLoad: true, theme: "dark" });');
    expect(auto.html).toContain("prefers-color-scheme: dark)').matches ? 'dark' : 'default'");
  });

  test('never lets an inlined script terminate its own element', async () => {
    // `</script>` ends the element even inside a string literal, so it has to be broken up.
    const html = await renderHtml(DIAGRAM, 'inline');
    const scriptTags = html.match(/<\/script>/g) ?? [];

    expect(scriptTags).toHaveLength(2);
  });
});
