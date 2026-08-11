import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import type { FenceHandler } from '../../flavors/index.ts';
import { collectText } from '../text.ts';

declare module 'vfile' {
  interface DataMap {
    usedFences: Set<string>;
  }
}

const LANGUAGE_PREFIX = 'language-';

function fenceLanguageOf(node: Element): { code: Element; language: string } | undefined {
  if (node.tagName !== 'pre') {
    return undefined;
  }

  const code = node.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  );

  const classNames = code?.properties?.className;

  if (!code || !Array.isArray(classNames)) {
    return undefined;
  }

  const languageClass = classNames.find(
    (name): name is string => typeof name === 'string' && name.startsWith(LANGUAGE_PREFIX),
  );

  // Lowercased once, here: the highlighter resolves grammars case-insensitively, so without this
  // a ```Mermaid fence highlights as source code instead of rendering as a diagram.
  return languageClass
    ? { code, language: languageClass.slice(LANGUAGE_PREFIX.length).toLowerCase() }
    : undefined;
}

/**
 * Must run before the highlighter: `source.mermaid` is one of the 694 grammars, so in the other
 * order the diagram source arrives wrapped in `<span>` elements and the diagram comes out empty
 * with no error to notice.
 */
export function rehypeFences(handlers: Readonly<Record<string, FenceHandler>>) {
  return (tree: Root, file: VFile): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (index === undefined || parent === undefined) {
        return;
      }

      const fence = fenceLanguageOf(node);

      if (!fence) {
        return;
      }

      const used = file.data.usedFences ?? new Set<string>();
      used.add(fence.language);
      file.data.usedFences = used;

      const replacement = handlers[fence.language]?.(collectText(fence.code));

      if (replacement) {
        parent.children[index] = replacement;
      }
    });
  };
}
