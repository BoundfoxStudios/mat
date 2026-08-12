import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { matDirectoryName } from '../src/assets/cache.ts';
import { render } from '../src/render/index.ts';

const fixtures = join(import.meta.dir, 'fixtures');
const source = readFileSync(join(fixtures, 'torture.md'), 'utf8');

let browser: Browser;
let page: Page;
let scratch: string;
const consoleErrors: string[] = [];
const failedRequests: string[] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-e2e-'));

  const { html } = await render(source, {
    title: 'torture.md',
    theme: 'auto',
    // The relative image lives beside the fixture, not beside the generated HTML.
    baseDir: fixtures,
    linkMode: 'absolute',
    embedMode: 'cache',
  });

  const previewPath = join(scratch, 'preview.html');
  writeFileSync(previewPath, html);

  browser = await chromium.launch();
  page = await browser.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  await page.goto(pathToFileURL(previewPath).href);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForSelector('pre.mermaid svg', { timeout: 15_000 });
});

afterAll(async () => {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the page as the browser sees it', () => {
  test('raises no script error', () => {
    // The fixture links an unreachable `https://` image on purpose, and whether that logs depends
    // on the network in front of the test — so resource failures are filtered, script errors kept.
    const scriptErrors = consoleErrors.filter(
      (message) => !message.includes('Failed to load resource'),
    );

    expect(scriptErrors).toEqual([]);
  });

  test('makes no local request that fails', () => {
    expect(failedRequests.filter((url) => url.startsWith('file:'))).toEqual([]);
  });

  test('leaves the absolute remote image untouched', () => {
    expect(failedRequests).toContain('https://example.com/bild.png');
  });

  test('loads exactly one external script, the mermaid bundle', async () => {
    const sources = await page.$$eval('script[src]', (nodes) =>
      nodes.map((node) => (node as HTMLScriptElement).src),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(
      new RegExp(`/${matDirectoryName()}/assets/mermaid-[0-9a-f]{16}\\.js$`),
    );
  });

  test('uses no module script, which file:// would block', async () => {
    const modules = await page.$$eval('script[type="module"]', (nodes) => nodes.length);

    expect(modules).toBe(0);
  });
});

describe('mermaid', () => {
  test('renders the diagram to svg', async () => {
    const shape = await page.$eval('pre.mermaid', (node) => ({
      svgCount: node.querySelectorAll('svg').length,
      width: (node.querySelector('svg') as SVGElement | null)?.getBoundingClientRect().width ?? 0,
    }));

    expect(shape.svgCount).toBe(1);
    expect(shape.width).toBeGreaterThan(0);
  });
});

describe('katex', () => {
  test('loads the embedded fonts', async () => {
    const loaded = await page.evaluate(() => {
      const families: string[] = [];

      for (const font of document.fonts as unknown as Iterable<FontFace>) {
        families.push(`${font.family}:${font.status}`);
      }

      return families;
    });

    expect(loaded).toContain('KaTeX_Main:loaded');
  });

  test('lays formulas out with the stylesheet, not with fallback metrics', async () => {
    // `.strut` gets its height from the KaTeX stylesheet; unstyled it collapses to zero.
    const height = await page.$eval('.katex .strut', (node) => node.getBoundingClientRect().height);

    expect(height).toBeGreaterThan(0);
  });
});

describe('assets and navigation', () => {
  test('shows the relative image', async () => {
    const natural = await page.$eval(
      'img[alt="Relatives Bild"]',
      (node) => (node as HTMLImageElement).naturalWidth,
    );

    expect(natural).toBeGreaterThan(0);
  });

  test('scrolls an internal link instead of navigating away', async () => {
    // With a `<base href>` the fragment resolves against the base and the browser navigates to a
    // directory listing instead.
    const before = await page.evaluate(() => location.pathname);

    await page.click('a[href^="#c-vs-net"]');
    await page.waitForFunction(() => window.scrollY > 0);

    expect(await page.evaluate(() => location.pathname)).toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
});

describe('chrome', () => {
  test('hides the footnotes heading github does not show', async () => {
    const height = await page.$eval('h2.sr-only', (node) => node.getBoundingClientRect().height);

    expect(height).toBeLessThanOrEqual(1);
  });

  test('reveals the anchor icon on hover', async () => {
    // github-markdown-css hides the `.octicon-link` span, not the `a.anchor` around it, and has no
    // `.icon-link` rule — hence the plugin's explicit content instead of its default span.
    const selector = 'h1 a.anchor .octicon-link';
    const hidden = await page.$eval(selector, (node) => getComputedStyle(node).visibility);

    await page.hover('h1');

    const shown = await page.$eval(selector, (node) => getComputedStyle(node).visibility);

    expect(hidden).toBe('hidden');
    expect(shown).toBe('visible');
  });

  test('constrains the body the way github does', async () => {
    const box = await page.$eval('article.markdown-body', (node) => ({
      maxWidth: getComputedStyle(node).maxWidth,
      boxSizing: getComputedStyle(node).boxSizing,
    }));

    expect(box.maxWidth).toBe('980px');
    expect(box.boxSizing).toBe('border-box');
  });
});
