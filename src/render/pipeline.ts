import { pathToFileURL } from 'node:url';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import type { PluggableList, Processor } from 'unified';
import { unified } from 'unified';
import { cacheAsset } from '../assets/cache.ts';
import type { Flavor } from '../flavors/index.ts';
import { ONIGURUMA_WASM_BASE64 } from '../generated/assets.ts';
import { rehypeAlertIcons } from './plugins/alert-icons.ts';
import { rehypeFences } from './plugins/fences.ts';
import { remarkFrontmatterTable } from './plugins/frontmatter-table.ts';
import { rehypeResolveAssets } from './plugins/resolve-assets.ts';
import { matSchema } from './plugins/schema.ts';
import { rehypeStarryNight } from './plugins/starry-night.ts';
import { rehypeTagfilter } from './plugins/tagfilter.ts';
import { rehypeUrlPolicy } from './plugins/url-policy.ts';

export type LinkMode = 'absolute' | 'relative';

export type EmbedMode = 'cache' | 'inline';

// The processor is built once per flavor and reused, so per-document values travel on the vfile.
export interface RenderContext {
  baseDir: string;
  linkMode: LinkMode;
  embedMode: EmbedMode;
}

declare module 'vfile' {
  interface DataMap {
    matContext: RenderContext;
  }
}

// starry-night loads the oniguruma wasm through `fs.readFile`, so it needs a real file: a `data:`
// URL is not readable that way, and the compiled binary's `/$bunfs` is not reliable either.
function onigurumaUrl(): URL {
  const wasm = Buffer.from(ONIGURUMA_WASM_BASE64, 'base64');

  return pathToFileURL(cacheAsset('onig', 'wasm', wasm));
}

function frontMatterPlugins(mode: Flavor['frontMatter']): PluggableList {
  if (mode === 'none') {
    return [];
  }

  // `hidden` needs no second plugin: the `yaml` node reaches `mdast-util-to-hast`, which has no
  // handler for that type and drops it.
  return mode === 'table'
    ? [[remarkFrontmatter, ['yaml']], remarkFrontmatterTable]
    : [[remarkFrontmatter, ['yaml']]];
}

const processors = new Map<string, Processor<never, never, never, never, string>>();

/**
 * Plugin order is load-bearing at five points, each verified by running the alternative:
 * `rehype-raw` before `rehype-slug` (else raw `<h2>` headings get no id), the tagfilter after
 * `rehype-raw` and on `element` nodes (else it is a silent no-op and live `<script>` reaches the
 * page), the sanitiser immediately after both and before everything mat generates itself (else it
 * would strip mat's own anchors, KaTeX markup and highlighting spans), fences before highlighting
 * (else mermaid sources arrive pre-wrapped in spans), and the flavor's rehype plugins after
 * highlighting (so KaTeX still finds its blocks).
 */
export function getProcessor(flavor: Flavor): Processor<never, never, never, never, string> {
  const existing = processors.get(flavor.name);

  if (existing) {
    return existing;
  }

  const processor = unified()
    .use(remarkParse)
    .use(frontMatterPlugins(flavor.frontMatter))
    .use(flavor.remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeTagfilter)
    .use(rehypeUrlPolicy)
    .use(rehypeSanitize, matSchema)
    .use(rehypeAlertIcons)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: 'append',
      properties: { className: ['anchor'] },
      // The plugin's default `<span class="icon icon-link">` renders as an empty span:
      // github-markdown-css hangs the glyph off `.anchor .octicon-link:before` instead.
      content: {
        type: 'element',
        tagName: 'span',
        properties: { className: ['octicon', 'octicon-link'] },
        children: [],
      },
    })
    .use(rehypeFences, flavor.fenceHandlers)
    .use(rehypeStarryNight, {
      getOnigurumaUrlFs: onigurumaUrl,
      claimedLanguages: Object.keys(flavor.fenceHandlers),
    })
    .use(flavor.rehypePlugins)
    .use(rehypeResolveAssets)
    // No `allowDangerousHtml`: after the sanitiser there is no `raw` node left to preserve, and
    // named references are what GitHub emits — `&lt;` rather than `&#x3C;`.
    .use(rehypeStringify, { characterReferences: { useNamedReferences: true } })
    .freeze() as unknown as Processor<never, never, never, never, string>;

  processors.set(flavor.name, processor);

  return processor;
}

export function resetProcessors(): void {
  processors.clear();
}
