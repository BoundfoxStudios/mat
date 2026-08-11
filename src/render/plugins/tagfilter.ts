import type { Element, Root, RootContent } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';

/** GFM §6.11. The list is closed: these nine and nothing else. */
const FILTERED_TAG_NAMES: ReadonlySet<string> = new Set([
  'title',
  'textarea',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'script',
  'plaintext',
]);

/**
 * Only the two tag strings become text; the children stay real hast nodes, so they are escaped
 * exactly once and `<textarea>a & b</textarea>` still reads `a & b`.
 *
 * Text rather than a pre-escaped `raw` node, because the sanitiser that runs next drops `raw`
 * without a word. It also removes a whole class of bug: escaping is the stringifier's job now, so
 * a `<` inside an attribute value cannot climb back out and open a live element.
 */
function escapeElement(node: Element): RootContent[] {
  const closeTag = `</${node.tagName}>`;
  // None of the nine are void, so a childless clone always serialises as `<tag …></tag>`.
  const emptyClone = toHtml({ ...node, children: [] });
  const openTag = emptyClone.endsWith(closeTag)
    ? emptyClone.slice(0, -closeTag.length)
    : emptyClone;

  return [{ type: 'text', value: openTag }, ...node.children, { type: 'text', value: closeTag }];
}

/**
 * Must run **after** `rehype-raw`, which turns every `raw` node into real elements: a filter placed
 * after it that looks for `raw` nodes matches nothing and lets a live `<script>` through without a
 * single failing test. `rehype-stringify` needs `allowDangerousHtml: true` for the replacement
 * `raw` nodes to survive.
 */
export function rehypeTagfilter() {
  return (tree: Root): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (!FILTERED_TAG_NAMES.has(node.tagName)) return;

      parent.children.splice(index, 1, ...escapeElement(node));

      // Resume at the first replacement node; it is text, so this cannot loop.
      return index;
    });
  };
}
