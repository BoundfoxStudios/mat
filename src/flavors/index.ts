import type { ElementContent } from 'hast';
import type { PluggableList } from 'unified';
import type { ThemeName } from '../generated/assets.ts';
import { gfm } from './gfm.ts';

/**
 * An element replaces the whole `<pre><code>`; `null` claims the language without touching the
 * DOM, which is how a later plugin (KaTeX) gets an untouched block. Either way the highlighter
 * skips the language.
 */
export type FenceHandler = (source: string) => ElementContent | null;

export interface FlavorScript {
  readonly name: string;
  readonly source: string;
  readonly requiresFence: string;
  readonly bootstrap: (theme: ThemeName) => string;
}

export type FrontMatterMode = 'table' | 'hidden' | 'none';

export interface Flavor {
  readonly name: string;
  readonly frontMatter: FrontMatterMode;
  readonly remarkPlugins: PluggableList;
  readonly rehypePlugins: PluggableList;
  readonly fenceHandlers: Readonly<Record<string, FenceHandler>>;
  readonly scripts: readonly FlavorScript[];
}

const FLAVORS: ReadonlyMap<string, Flavor> = new Map([[gfm.name, gfm]]);

export const DEFAULT_FLAVOR_NAME = gfm.name;

export function flavorNames(): string[] {
  return [...FLAVORS.keys()].sort();
}

export function getFlavor(name: string): Flavor | undefined {
  return FLAVORS.get(name);
}
