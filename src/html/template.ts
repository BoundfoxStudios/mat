import { CHROME_CSS, GITHUB_MARKDOWN_CSS, type ThemeName } from '../generated/assets.ts';

export interface TemplateInput {
  title: string;
  theme: ThemeName;
  /** Interpolated raw: the pipeline is what sanitises it. */
  body: string;
  styles: readonly string[];
  scripts: readonly string[];
}

const CANVAS_LIGHT = '#ffffff';
const CANVAS_DARK = '#0d1117';

/**
 * The theme must be picked by *selecting a stylesheet file*, never by setting `[data-theme]`: every
 * `data-theme` selector in github-markdown-css@5.9.0 sits inside a `prefers-color-scheme` media
 * query, so the attribute is a no-op whenever the OS scheme disagrees.
 */
function canvasStyles(theme: ThemeName): string {
  if (theme === 'light') {
    return `:root { color-scheme: light; }\nhtml, body { background-color: ${CANVAS_LIGHT}; }`;
  }

  if (theme === 'dark') {
    return `:root { color-scheme: dark; }\nhtml, body { background-color: ${CANVAS_DARK}; }`;
  }

  return [
    ':root { color-scheme: light dark; }',
    `html, body { background-color: ${CANVAS_LIGHT}; }`,
    '@media (prefers-color-scheme: dark) {',
    `  html, body { background-color: ${CANVAS_DARK}; }`,
    '}',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * No `<base href>` on purpose: it would load relative images but break every in-page `#fragment`
 * link, which would then resolve against the base and navigate to a directory listing. The pipeline
 * rewrites relative URLs to absolute `file://` URLs instead.
 */
export function buildDocument({ title, theme, body, styles, scripts }: TemplateInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${GITHUB_MARKDOWN_CSS[theme]}
</style>
<style>
${canvasStyles(theme)}

${CHROME_CSS}
</style>
${styles.join('\n')}
</head>
<body>
<article class="markdown-body">
${body}</article>
${scripts.join('\n')}
</body>
</html>
`;
}
