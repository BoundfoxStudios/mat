import { command, optional, positional } from 'cmd-ts';
import type { ParseContext, ParsingResult } from 'cmd-ts/dist/cjs/argparser';
import { DEFAULT_FLAVOR_NAME } from '../../flavors/index.ts';
import { MAT_VERSION, type ThemeName } from '../../generated/assets.ts';
import { directoryType, flavorType, pathType, themeType } from '../argument-types.ts';
import { DEFAULT_DOCUMENTS } from '../default-document.ts';
import { longOptionsNamed, valuedOption } from '../options.ts';

export interface Invocation {
  source: string | undefined;
  output: string | undefined;
  theme: ThemeName;
  flavor: string;
  baseDir: string | undefined;
}

const renderArguments = command({
  name: 'mat',
  version: MAT_VERSION,
  description: 'Render a Markdown file the way GitHub does and open it in your browser.',
  examples: [
    { description: 'Render a file and open it in the browser', command: 'mat README.md' },
    { description: "Render this directory's first standard document", command: 'mat' },
    { description: 'Read the document from stdin', command: 'cat notes.md | mat -' },
    {
      description: 'Write a self-contained file and open nothing',
      command: 'mat README.md --output readme.html',
    },
  ],
  args: {
    source: positional({
      displayName: 'file.md',
      type: optional(pathType),
      description: `The file to render, or - to read stdin. Default: the first of ${DEFAULT_DOCUMENTS.join(', ')} that exists here.`,
    }),
    // Single line each: cmd-ts prints a description as it is given, so a line break here would
    // leave the second line hanging in the first column.
    output: valuedOption({
      long: 'output',
      type: optional(pathType),
      description: 'Write the self-contained HTML there and open no browser. - is stdout.',
    }),
    theme: valuedOption({
      long: 'theme',
      type: themeType,
      description: `auto, light or dark. Default: ${themeType.defaultValue?.()}.`,
    }),
    flavor: valuedOption({
      long: 'flavor',
      type: flavorType,
      description: `Markdown dialect. Default: ${DEFAULT_FLAVOR_NAME}.`,
    }),
    baseDir: valuedOption({
      long: 'base-dir',
      type: optional(directoryType),
      description:
        'Directory relative links resolve against, only valid with -. Default: the current directory.',
    }),
  },
  handler: (invocation): Invocation => invocation,
});

/**
 * The command, plus the one rule that no single argument can check on its own. Reporting it from
 * `parse` rather than from the handler puts it in the same error box as every other usage error.
 */
export const renderCommand = {
  ...renderArguments,
  async parse(context: ParseContext): Promise<ParsingResult<Invocation>> {
    const parsed = await renderArguments.parse(context);

    if (parsed._tag === 'ok' && parsed.value.baseDir !== undefined && parsed.value.source !== '-') {
      // Whenever a file is rendered — named or defaulted to — the base is that file's directory;
      // an override would silently resolve images against a directory it knows nothing about.
      return {
        _tag: 'error',
        error: {
          errors: [
            {
              nodes: longOptionsNamed(context.nodes, 'base-dir'),
              message: '--base-dir is only valid together with -',
            },
          ],
        },
      };
    }

    return parsed;
  },
};
