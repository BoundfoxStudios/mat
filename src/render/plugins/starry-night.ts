import type { Grammar } from '@wooorm/starry-night';
import { createStarryNight } from '@wooorm/starry-night/lib/index.js';
import type { Element, ElementContent, Root } from 'hast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import {
  GRAMMAR_MODULES,
  SCOPE_BY_EXTENSION,
  SCOPE_BY_EXTENSION_WITH_DOT,
  SCOPE_BY_NAME,
} from '../../generated/grammars.ts';
import { collectText } from '../text.ts';

type StarryNight = Awaited<ReturnType<typeof createStarryNight>>;

const LANGUAGE_PREFIX = 'language-';

export interface StarryNightOptions {
  getOnigurumaUrlFs: () => URL;
  /**
   * `math` is why this exists: no grammar set has a `math` grammar, and highlighting the block
   * would both destroy it for KaTeX and warn once per equation.
   */
  claimedLanguages: readonly string[];
}

/** Mirrors `starryNight.flagToScope`, which cannot be used before the grammar is registered. */
function flagToScope(flag: string): string | undefined {
  const normal = flag
    .toLowerCase()
    .replace(/^[ \t]+/, '')
    .replace(/\/*[ \t]*$/g, '');

  const byName = SCOPE_BY_NAME[normal];

  if (byName) {
    return byName;
  }

  const dot = normal.lastIndexOf('.');

  if (dot === -1) {
    return SCOPE_BY_EXTENSION[`.${normal}`];
  }

  const extension = normal.slice(dot);

  return SCOPE_BY_EXTENSION[extension] ?? SCOPE_BY_EXTENSION_WITH_DOT[extension];
}

let highlighter: StarryNight | undefined;
const registeredScopes = new Set<string>();
/**
 * Serialises rebuilds.
 *
 * Two renders that need different grammars would otherwise interleave: the first marks its scopes
 * registered before the await that actually builds the highlighter containing them, and the second
 * then sees nothing left to load and highlights against the older instance — which throws
 * `Expected grammar ... to be registered`.
 */
let rebuilding: Promise<StarryNight> = Promise.resolve(undefined as unknown as StarryNight);

function loadable(scopes: Iterable<string>): string[] {
  return [...scopes].filter((scope) => !registeredScopes.has(scope) && scope in GRAMMAR_MODULES);
}

function loadGrammars(scopes: Iterable<string>): Promise<Grammar[]> {
  return Promise.all(
    [...scopes].map((scope) => GRAMMAR_MODULES[scope]?.().then((module) => module.default)),
  ).then((grammars) => grammars.filter((grammar): grammar is Grammar => grammar !== undefined));
}

/**
 * Rebuilt rather than extended with `starryNight.register()`, which is a trap: it recreates the
 * textmate registry **without** passing the options along, so the oniguruma loader falls back to
 * resolving `vscode-oniguruma` on disk — fine from `node_modules`, fatal in a compiled binary.
 * Rebuilding keeps the options attached and costs about 10 ms.
 *
 * `missingScopes()` only reports a grammar's dependencies once that grammar itself is loaded, so
 * the closure needs the loop.
 */
function highlighterFor(
  scopes: Iterable<string>,
  options: StarryNightOptions,
): Promise<StarryNight> {
  const wanted = [...scopes];

  rebuilding = rebuilding.then(async () => {
    let pending = loadable(wanted);

    if (highlighter && pending.length === 0) {
      return highlighter;
    }

    while (pending.length > 0) {
      const next = new Set([...registeredScopes, ...pending]);
      const built = await createStarryNight(await loadGrammars(next), options);

      for (const scope of pending) {
        registeredScopes.add(scope);
      }

      highlighter = built;
      pending = loadable(built.missingScopes());
    }

    highlighter ??= await createStarryNight([], options);

    return highlighter;
  });

  return rebuilding;
}

export function resetHighlighter(): void {
  highlighter = undefined;
  registeredScopes.clear();
  rebuilding = Promise.resolve(undefined as unknown as StarryNight);
}

/**
 * Grammars are registered per document rather than up front. `rehype-starry-night` builds its
 * highlighter eagerly at `.use()` time over a fixed grammar set, which for the full 694 costs
 * seconds before any file is read.
 */
export function rehypeStarryNight(options: StarryNightOptions) {
  const claimed = new Set(options.claimedLanguages);

  return async (tree: Root, file: VFile): Promise<void> => {
    const blocks: Array<{ node: Element; scope: string }> = [];

    visit(tree, 'element', (node) => {
      if (node.tagName !== 'code') {
        return;
      }

      const classNames = node.properties?.className;

      if (!Array.isArray(classNames)) {
        return;
      }

      const languageClass = classNames.find(
        (name): name is string => typeof name === 'string' && name.startsWith(LANGUAGE_PREFIX),
      );

      if (!languageClass) {
        return;
      }

      const language = languageClass.slice(LANGUAGE_PREFIX.length);

      if (claimed.has(language)) {
        return;
      }

      const scope = flagToScope(language);

      if (scope) {
        blocks.push({ node, scope });
      } else {
        file.message(`Unknown language \`${language}\`; the block is rendered unhighlighted`);
      }
    });

    if (blocks.length === 0) {
      return;
    }

    const starryNight = await highlighterFor(
      blocks.map((block) => block.scope),
      options,
    );

    for (const { node, scope } of blocks) {
      // `highlight` is typed as returning a full hast root but only ever emits elements and text.
      node.children = starryNight.highlight(collectText(node), scope).children as ElementContent[];
    }
  };
}
