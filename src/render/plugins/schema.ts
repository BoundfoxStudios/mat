import { defaultSchema } from 'rehype-sanitize';

type Schema = typeof defaultSchema;

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

const alertClasses = ['markdown-alert', ...ALERT_KINDS.map((kind) => `markdown-alert-${kind}`)];

/**
 * `border` and `action` come out: GitHub strips both, and `action` is the one global attribute
 * that names a request target, which makes it a URL the policy below would otherwise never see.
 */
const globalAttributes = (defaultSchema.attributes?.['*'] ?? []).filter(
  (name) => name !== 'border' && name !== 'action',
);

/**
 * What author-written HTML may contain, derived from `rehype-sanitize`'s GitHub-modelled default
 * and corrected against GitHub's live behaviour, measured against `api.github.com/markdown` on
 * 2026-08-11. `github/html-pipeline` is not that behaviour — it is an archived fork whose own
 * readme says GitHub stopped using it.
 *
 * Three deliberate deviations, each because mat renders a local file rather than a page on
 * github.com:
 *
 * - `file:` is allowed. Without it every relative image mat resolves would lose its `src`.
 * - `data:image/` is allowed where GitHub drops it. A `data:` document gets an opaque origin, so
 *   it can neither read the previewed file nor reach the surrounding `file://` origin.
 * - `audio` and `source[src]` are allowed where GitHub drops them. GitHub hosts media itself; in a
 *   local document `<source src="./demo.mp4">` is the only way to write it.
 *
 * Protocol-relative URLs (`//host/x`) are removed although GitHub keeps them — on github.com they
 * inherit https behind a proxy and a CSP, from a `file://` page they inherit nothing.
 */
export const matSchema: Schema = {
  ...defaultSchema,

  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'video', 'audio'],

  attributes: {
    ...defaultSchema.attributes,
    '*': globalAttributes,
    audio: ['ariaDescribedBy', 'ariaLabel', 'ariaLabelledBy', 'controls', 'muted', 'src'],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', ...alertClasses]],
    // Only ever a disabled checkbox: `remark-gfm` emits task lists this way, and an author's own
    // `<input>` must not become anything else.
    input: [['type', 'checkbox'], 'checked', 'disabled'],
    li: [...(defaultSchema.attributes?.li ?? []), 'type'],
    ol: [...(defaultSchema.attributes?.ol ?? []), 'type'],
    p: [['className', 'markdown-alert-title']],
    source: ['media', 'sizes', 'src', 'srcSet', 'type'],
    ul: [...(defaultSchema.attributes?.ul ?? []), 'type'],
    video: ['ariaDescribedBy', 'ariaLabel', 'ariaLabelledBy', 'controls', 'muted', 'src'],
  },

  ancestors: { ...defaultSchema.ancestors, input: ['li'] },

  required: { ...defaultSchema.required, input: { type: 'checkbox', disabled: true } },

  // The default prefixes `id` and `name` with `user-content-`, which is how GitHub keeps a heading
  // anchor from clobbering `document.forms`. mat's own ids are generated after this plugin, and a
  // prefix would only make its fragment links ugly.
  clobber: [],

  protocols: {
    cite: ['http', 'https'],
    href: ['http', 'https', 'mailto', 'xmpp', 'github-mac', 'github-windows', 'file'],
    longDesc: ['http', 'https'],
    src: ['http', 'https', 'file', 'data'],
    srcSet: ['http', 'https', 'file', 'data'],
  },
};
