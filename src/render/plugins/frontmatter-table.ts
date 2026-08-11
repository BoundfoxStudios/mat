import type { Root, TableRow } from 'mdast';
import { parse } from 'yaml';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(formatValue).join(', ');
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      // A YAML alias can point at its own ancestor, and `JSON.stringify` refuses a cycle. Front
      // matter is metadata; failing to tabulate it must not fail the document.
      return '';
    }
  }

  return String(value);
}

/** Values are plain text: GitHub does not parse front matter as Markdown. */
function row(cells: string[]): TableRow {
  return {
    type: 'tableRow',
    children: cells.map((cell) => ({
      type: 'tableCell',
      children: [{ type: 'text', value: cell }],
    })),
  };
}

/**
 * Mirrors the two-row table GitHub renders for front matter. The bail-outs need no fallback: a
 * `yaml` node left in place is dropped downstream, because `mdast-util-to-hast` has no handler
 * for it.
 */
export function remarkFrontmatterTable() {
  return (tree: Root): void => {
    const first = tree.children[0];

    if (first?.type !== 'yaml') {
      return;
    }

    let parsed: unknown;

    try {
      parsed = parse(first.value);
    } catch {
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }

    const fields = Object.entries(parsed);

    if (fields.length === 0) {
      return;
    }

    tree.children[0] = {
      type: 'table',
      align: fields.map(() => null),
      children: [
        row(fields.map(([key]) => key)),
        row(fields.map(([, value]) => formatValue(value))),
      ],
    };
  };
}
