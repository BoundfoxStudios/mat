import { pathToFileURL } from 'node:url';
import { cacheAsset } from '../assets/cache.ts';
import type { Flavor } from '../flavors/index.ts';
import { KATEX_CSS, KATEX_FONTS, type ThemeName } from '../generated/assets.ts';
import type { RenderContext } from '../render/pipeline.ts';

export interface PageAssetInput {
  flavor: Flavor;
  theme: ThemeName;
  embedMode: RenderContext['embedMode'];
  usedFences: ReadonlySet<string>;
  usesMath: boolean;
}

export interface PageAssets {
  styles: string[];
  scripts: string[];
}

/**
 * `</script>` ends a classic script wherever it appears, including inside a string literal.
 * Breaking the sequence keeps the JavaScript identical and the HTML valid.
 */
function escapeScriptBody(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * The KaTeX stylesheet ships with 60 `url(fonts/…)` references into a directory that is not there;
 * without rewriting them every formula silently falls back to a system font.
 */
function katexStylesheet(embedMode: RenderContext['embedMode']): string {
  const sources = new Map(
    KATEX_FONTS.map((font) => {
      const value =
        embedMode === 'cache'
          ? pathToFileURL(
              cacheAsset(
                font.fileName.replace(/\.woff2$/, ''),
                'woff2',
                Buffer.from(font.base64, 'base64'),
              ),
            ).href
          : `data:font/woff2;base64,${font.base64}`;

      return [font.fileName, value];
    }),
  );

  return KATEX_CSS.replace(/url\((fonts\/([^)]+\.woff2))\)/g, (match, _path, fileName: string) => {
    const source = sources.get(fileName);

    return source ? `url("${source}")` : match;
  });
}

/**
 * Nothing may be emitted unconditionally: the mermaid bundle is 3.4 MB and the KaTeX fonts 338 KiB
 * as data URIs, against a typical preview of ~40 KiB.
 */
export function collectPageAssets({
  flavor,
  theme,
  embedMode,
  usedFences,
  usesMath,
}: PageAssetInput): PageAssets {
  const styles: string[] = [];
  const scripts: string[] = [];

  if (usesMath) {
    styles.push(`<style>\n${katexStylesheet(embedMode)}\n</style>`);
  }

  for (const script of flavor.scripts) {
    if (!usedFences.has(script.requiresFence)) {
      continue;
    }

    if (embedMode === 'cache') {
      // Never `type="module"`: module scripts, dynamic imports and workers are all blocked under
      // the `file://` origin.
      const href = pathToFileURL(cacheAsset(script.name, 'js', script.source)).href;
      scripts.push(`<script src="${href}"></script>`);
    } else {
      scripts.push(`<script>\n${escapeScriptBody(script.source)}\n</script>`);
    }

    scripts.push(`<script>\n${escapeScriptBody(script.bootstrap(theme))}\n</script>`);
  }

  return { styles, scripts };
}
