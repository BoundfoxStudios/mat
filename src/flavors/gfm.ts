import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import remarkMath from 'remark-math';
import { MERMAID_SCRIPT } from '../generated/assets.ts';
import { remarkGithubBacktickMath } from '../render/plugins/backtick-math.ts';
import type { Flavor } from './index.ts';

export const gfm: Flavor = {
  name: 'gfm',

  frontMatter: 'table',

  remarkPlugins: [
    remarkGfm,
    // Emits the `markdown-alert*` class names github-markdown-css styles; the common alternatives
    // emit `gh-alert*` and render unstyled.
    remarkAlert,
    remarkMath,
    remarkGithubBacktickMath,
  ],

  rehypePlugins: [
    // Also claims `<code class="language-math">`, which is how a ```math fence becomes display
    // math — `remark-math` never touches fences.
    rehypeKatex,
  ],

  fenceHandlers: {
    mermaid: (source) => ({
      type: 'element',
      tagName: 'pre',
      properties: { className: ['mermaid'] },
      children: [{ type: 'text', value: source }],
    }),
    // Claimed only to keep the highlighter off it; `rehype-katex` wants the block untouched.
    math: () => null,
  },

  scripts: [
    {
      name: 'mermaid',
      source: MERMAID_SCRIPT,
      requiresFence: 'mermaid',
      // Mermaid reads no CSS, so the theme must be handed to it explicitly — and for `auto` that
      // decision can only be made in the browser.
      bootstrap: (theme) => {
        const chosen =
          theme === 'auto'
            ? "window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'"
            : JSON.stringify(theme === 'dark' ? 'dark' : 'default');

        return `mermaid.initialize({ startOnLoad: true, theme: ${chosen} });`;
      },
    },
  ],
};
