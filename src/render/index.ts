import { VFile } from 'vfile';
import { DEFAULT_FLAVOR_NAME, type Flavor, flavorNames, getFlavor } from '../flavors/index.ts';
import type { ThemeName } from '../generated/assets.ts';
import { collectPageAssets } from '../html/page-assets.ts';
import { buildDocument } from '../html/template.ts';
import { getProcessor, type RenderContext } from './pipeline.ts';

export interface RenderOptions extends RenderContext {
  title: string;
  theme: ThemeName;
  flavor?: string;
}

export interface RenderResult {
  html: string;
  messages: string[];
}

function resolveFlavor(name: string | undefined): Flavor {
  const flavor = getFlavor(name ?? DEFAULT_FLAVOR_NAME);

  if (!flavor) {
    throw new Error(`Unknown flavor \`${name}\`; available: ${flavorNames().join(', ')}`);
  }

  return flavor;
}

/**
 * Async by necessity: `processSync()` throws "`processSync` finished async" because the
 * highlighter's transformer is async.
 */
export async function render(markdown: string, options: RenderOptions): Promise<RenderResult> {
  const flavor = resolveFlavor(options.flavor);
  const file = new VFile({ value: markdown });
  file.data.matContext = {
    baseDir: options.baseDir,
    linkMode: options.linkMode,
    embedMode: options.embedMode,
  };

  const processed = await getProcessor(flavor).process(file);
  const body = String(processed);

  const assets = collectPageAssets({
    flavor,
    theme: options.theme,
    embedMode: options.embedMode,
    usedFences: file.data.usedFences ?? new Set(),
    // KaTeX always wraps its output in `.katex`, the same class the embedded stylesheet is keyed
    // on — so this sniff cannot drift from what the page needs.
    usesMath: body.includes('class="katex'),
  });

  return {
    html: buildDocument({
      title: options.title,
      theme: options.theme,
      body,
      styles: assets.styles,
      scripts: assets.scripts,
    }),
    messages: processed.messages.map((message) => message.reason),
  };
}
