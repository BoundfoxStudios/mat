import type { Node } from 'hast';

/**
 * Must recurse: the highlighter may already have wrapped a code block's source in `<span>`
 * elements, so reading only direct text children returns "" with no error to notice.
 */
export function collectText(node: Node): string {
  if (node.type === 'text' && 'value' in node && typeof node.value === 'string') {
    return node.value;
  }

  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(collectText).join('');
  }

  return '';
}
