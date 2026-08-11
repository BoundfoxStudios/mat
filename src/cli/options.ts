import { option, type Type } from 'cmd-ts';
import type { ParseContext, ParsingResult } from 'cmd-ts/dist/cjs/argparser';
import type { AstNode, LongOption } from 'cmd-ts/dist/cjs/newparser/parser';

export function longOptionsNamed(nodes: readonly AstNode[], long: string): LongOption[] {
  return nodes.filter(
    (node): node is LongOption => node.type === 'longOption' && node.key === long,
  );
}

interface ValuedOptionConfig<Value> {
  readonly long: string;
  readonly type: Type<string, Value>;
  readonly description: string;
}

/**
 * An option whose value is not optional. cmd-ts treats `mat x.md --output` — the name with nothing
 * behind it — like an option that was never passed and falls back to the default, which would
 * silently open a browser instead of writing the file the user meant.
 */
export function valuedOption<Value>(config: ValuedOptionConfig<Value>) {
  const parser = option(config);

  return {
    ...parser,
    async parse(context: ParseContext): Promise<ParsingResult<Value>> {
      const valueless = longOptionsNamed(context.nodes, config.long).filter(
        (node) => node.value === undefined,
      );

      if (valueless.length > 0) {
        // Claim them, or the command reports the very same nodes as unknown arguments on top.
        for (const node of valueless) {
          context.visitedNodes.add(node);
        }

        return {
          _tag: 'error',
          error: {
            errors: [{ nodes: valueless, message: `No value provided for --${config.long}` }],
          },
        };
      }

      return parser.parse(context);
    },
  };
}
