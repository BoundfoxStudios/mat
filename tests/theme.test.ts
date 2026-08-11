import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, chromium } from 'playwright';
import type { ThemeName } from '../src/generated/assets.ts';
import { render } from '../src/render/index.ts';

const FENCE = '```';
const DOCUMENT = ['# Titel', '', `${FENCE}mermaid`, 'graph TD;', '  A-->B;', `${FENCE}`].join('\n');

const LIGHT_CANVAS = 'rgb(255, 255, 255)';
const DARK_CANVAS = 'rgb(13, 17, 23)';

let browser: Browser;
let scratch: string;
let counter = 0;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mat-theme-'));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Measurement {
  bodyBackground: string;
  articleBackground: string;
  mermaidTheme: string;
}

/**
 * Measuring a theme under the *opposite* OS scheme is the point: github-markdown-css's
 * `[data-theme]` selectors all sit inside `prefers-color-scheme` queries, so a theme built on the
 * attribute works for whoever tests it in their own scheme and silently fails for everyone else.
 */
const measurements = new Map<string, Promise<Measurement>>();

function measure(theme: ThemeName, colorScheme: 'light' | 'dark'): Promise<Measurement> {
  const key = `${theme}/${colorScheme}`;
  const cached = measurements.get(key);

  if (cached) {
    return cached;
  }

  const pending = renderAndMeasure(theme, colorScheme);
  measurements.set(key, pending);

  return pending;
}

async function renderAndMeasure(
  theme: ThemeName,
  colorScheme: 'light' | 'dark',
): Promise<Measurement> {
  counter += 1;

  const { html } = await render(DOCUMENT, {
    title: 'theme.md',
    theme,
    baseDir: scratch,
    linkMode: 'absolute',
    embedMode: 'cache',
  });

  const path = join(scratch, `preview-${counter}.html`);
  writeFileSync(path, html);

  const page = await browser.newPage({ colorScheme });

  try {
    await page.goto(pathToFileURL(path).href);
    await page.waitForSelector('pre.mermaid svg', { timeout: 15_000 });

    return await page.evaluate(() => ({
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      articleBackground: getComputedStyle(
        document.querySelector('article.markdown-body') as Element,
      ).backgroundColor,
      // Mermaid reads no CSS; the bootstrap hands it a theme, which is what changes the node fill.
      mermaidTheme: getComputedStyle(
        document.querySelector('pre.mermaid svg .node rect, pre.mermaid svg rect') as Element,
      ).fill,
    }));
  } finally {
    await page.close();
  }
}

describe('an explicit theme wins over the operating system', () => {
  test('dark stays dark on a light system', async () => {
    const measured = await measure('dark', 'light');

    expect(measured.articleBackground).toBe(DARK_CANVAS);
    expect(measured.bodyBackground).toBe(DARK_CANVAS);
  });

  test('light stays light on a dark system', async () => {
    const measured = await measure('light', 'dark');

    expect(measured.articleBackground).toBe(LIGHT_CANVAS);
    expect(measured.bodyBackground).toBe(LIGHT_CANVAS);
  });
});

describe('auto follows the operating system', () => {
  test('renders light on a light system', async () => {
    const measured = await measure('auto', 'light');

    expect(measured.articleBackground).toBe(LIGHT_CANVAS);
    expect(measured.bodyBackground).toBe(LIGHT_CANVAS);
  });

  test('renders dark on a dark system', async () => {
    const measured = await measure('auto', 'dark');

    expect(measured.articleBackground).toBe(DARK_CANVAS);
    expect(measured.bodyBackground).toBe(DARK_CANVAS);
  });
});

describe('mermaid follows the same theme', () => {
  test('differs between light and dark', async () => {
    const dark = await measure('dark', 'light');
    const light = await measure('light', 'dark');

    expect(dark.mermaidTheme).not.toBe(light.mermaidTheme);
  });

  test('follows the operating system when the theme is auto', async () => {
    const onDark = await measure('auto', 'dark');
    const onLight = await measure('auto', 'light');

    expect(onDark.mermaidTheme).not.toBe(onLight.mermaidTheme);
  });
});
