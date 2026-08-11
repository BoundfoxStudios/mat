import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

function withoutSurroundingBackticks(value: string): string {
  return value.length > 1 && value.startsWith('`') && value.endsWith('`')
    ? value.slice(1, -1)
    : value;
}

/**
 * GitHub's ``$`x`$`` spelling for inline math: `remark-math` parses it but leaves the backticks
 * inside the node, and KaTeX then renders them as literal ‘ glyphs.
 *
 * Both `value` and `data.hChildren` have to be fixed — `remark-rehype` renders `hChildren` and
 * ignores `value`, so rewriting only `value` passes an AST unit test and still emits backticks
 * into the HTML.
 */
export function remarkGithubBacktickMath() {
  return (tree: Root): void => {
    visit(tree, 'inlineMath', (node) => {
      const stripped = withoutSurroundingBackticks(node.value);

      if (stripped === node.value) {
        return;
      }

      node.value = stripped;

      for (const child of node.data?.hChildren ?? []) {
        if (child.type === 'text') {
          child.value = withoutSurroundingBackticks(child.value);
        }
      }
    });
  };
}
