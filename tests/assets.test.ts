import { describe, expect, test } from 'bun:test';
import {
  GITHUB_MARKDOWN_CSS,
  KATEX_CSS,
  KATEX_FONTS,
  KATEX_VERSION,
  MERMAID_SCRIPT,
  ONIGURUMA_WASM_BASE64,
} from '../src/generated/assets.ts';

function captureGroups(subject: string, pattern: RegExp): string[] {
  return Array.from(subject.matchAll(pattern), (match) => match[1]).filter(
    (group): group is string => group !== undefined,
  );
}

describe('generated assets', () => {
  describe('katex', () => {
    test('is resolved from the 0.16 line', () => {
      // rehype-katex@7 pins `katex: ^0.16.0` and renders the math HTML itself; a top-level 0.18
      // adds a second copy whose CSS class names are disjoint, so math silently renders at the
      // wrong size.
      expect(KATEX_VERSION).toStartWith('0.16.');
    });

    test('ships the class names 0.16 actually emits', () => {
      expect(KATEX_CSS).toContain('.base{');
      expect(KATEX_CSS).not.toContain('.katex-base{');
    });

    test('references woff2 fonts only', () => {
      expect(KATEX_CSS).toContain('url(fonts/');
      expect(KATEX_CSS).not.toMatch(/url\(fonts\/[^)]+\.(?:ttf|woff)\)/);
    });

    test('embeds every font the stylesheet can ask for', () => {
      expect(KATEX_FONTS).toHaveLength(20);

      const referenced = new Set(captureGroups(KATEX_CSS, /url\(fonts\/([^)]+\.woff2)\)/g));
      const embedded = new Set(KATEX_FONTS.map((font) => font.fileName));

      for (const fileName of referenced) {
        expect(embedded).toContain(fileName);
      }
    });
  });

  describe('github-markdown-css', () => {
    test('provides one file per theme', () => {
      for (const theme of ['auto', 'light', 'dark'] as const) {
        expect(GITHUB_MARKDOWN_CSS[theme].length).toBeGreaterThan(20_000);
      }
    });

    test('forces the theme by file, not by attribute', () => {
      // Every `[data-theme]` selector in the combined stylesheet sits inside a
      // `prefers-color-scheme` query, so the attribute is a no-op whenever the OS disagrees.
      expect(GITHUB_MARKDOWN_CSS.auto).toContain('prefers-color-scheme');
      expect(GITHUB_MARKDOWN_CSS.light).not.toContain('prefers-color-scheme');
      expect(GITHUB_MARKDOWN_CSS.dark).not.toContain('prefers-color-scheme');
    });

    test('carries the pl-* rules starry-night emits classes for', () => {
      // The combined file uses `--color-prettylights-syntax-*` variables, the single-theme files
      // literal hex; only the class names are common to both.
      for (const theme of ['auto', 'light', 'dark'] as const) {
        const selectors = new Set(captureGroups(GITHUB_MARKDOWN_CSS[theme], /\.(pl-[a-z0-9]+)\b/g));

        expect(selectors.size).toBeGreaterThanOrEqual(30);
        for (const required of ['pl-k', 'pl-c', 'pl-s', 'pl-en', 'pl-smi']) {
          expect(selectors).toContain(required);
        }
      }
    });

    test('has no .sr-only rule, which is why mat ships its own', () => {
      // remark-gfm emits `<h2 class="sr-only">Footnotes</h2>`; with no rule for it, that renders
      // as a large visible heading GitHub hides.
      for (const theme of ['auto', 'light', 'dark'] as const) {
        expect(GITHUB_MARKDOWN_CSS[theme]).not.toContain('sr-only');
      }
    });
  });

  test('mermaid is the classic IIFE build', () => {
    expect(MERMAID_SCRIPT).toContain('globalThis["mermaid"]');
    expect(MERMAID_SCRIPT).not.toMatch(/\bimport\s*\(/);
  });

  test('oniguruma wasm decodes to a wasm module', () => {
    const wasm = Buffer.from(ONIGURUMA_WASM_BASE64, 'base64');

    expect(wasm.byteLength).toBe(473_151);
    // \0asm — the WebAssembly magic number.
    expect(Array.from(wasm.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
