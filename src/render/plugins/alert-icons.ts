import type { Element, ElementContent, Properties, Root } from 'hast';
import { getAlertIcon } from 'remark-github-blockquote-alert';
import { visit } from 'unist-util-visit';

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

type AlertKind = (typeof ALERT_KINDS)[number];

interface IconNode {
  data: { hName: string; hProperties: Properties };
  children?: IconNode[];
}

function toElement(node: IconNode): ElementContent {
  return {
    type: 'element',
    tagName: node.data.hName,
    properties: { ...node.data.hProperties },
    children: (node.children ?? []).map(toElement),
  };
}

function classNamesOf(node: Element): string[] {
  const value = node.properties?.className;

  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Puts the octicon back into each alert title.
 *
 * The alert plugin emits it as inline `<svg>` at the remark stage, and the sanitiser strips SVG
 * wholesale — as GitHub does, and for good reason: SVG is a scripting surface. Regenerating it
 * afterwards from the same upstream source keeps the markup byte-identical without letting
 * author-written SVG through.
 */
export function rehypeAlertIcons() {
  return (tree: Root): void => {
    visit(tree, 'element', (node) => {
      const classNames = classNamesOf(node);

      if (!classNames.includes('markdown-alert')) {
        return;
      }

      const kind = ALERT_KINDS.find((candidate: AlertKind) =>
        classNames.includes(`markdown-alert-${candidate}`),
      );

      if (!kind) {
        return;
      }

      const title = node.children.find(
        (child): child is Element =>
          child.type === 'element' &&
          child.tagName === 'p' &&
          classNamesOf(child).includes('markdown-alert-title'),
      );

      title?.children.unshift(toElement(getAlertIcon(kind) as unknown as IconNode));
    });
  };
}
