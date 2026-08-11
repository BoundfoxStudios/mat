import { describe, expect, test } from 'bun:test';
import { createLogger } from '../src/cli/logger.ts';

function capture(interactive: boolean) {
  const lines: string[] = [];

  return { lines, logger: createLogger((text) => lines.push(text), interactive) };
}

describe('logger', () => {
  // Consola routes info and success (level 3) to its *stdout* option and only warn and error
  // to stderr. mat's stdout belongs to the rendered document, so the logger must fold both
  // onto the stderr sink — if this test goes red, informational lines either vanish (the level
  // pin was dropped; consola defaults to `warn` under bun test's NODE_ENV=test) or leak into
  // the HTML on `--output -` (the stdout mapping was dropped).
  test('sends informational levels to the stderr sink', () => {
    const { lines, logger } = capture(false);

    logger.info('eine Info');
    logger.success('ein Erfolg');

    const output = lines.join('');

    expect(output).toContain('[info] [mat] eine Info');
    expect(output).toContain('[success] [mat] ein Erfolg');
  });

  test('sends warnings and errors to the stderr sink', () => {
    const { lines, logger } = capture(false);

    logger.warn('eine Warnung');
    logger.error('ein Fehler');

    const output = lines.join('');

    expect(output).toContain('[warn] [mat] eine Warnung');
    expect(output).toContain('[error] [mat] ein Fehler');
  });

  // The interactive format is consola's business; what must hold is that it still writes into
  // the injected sink and nowhere else.
  test('stays on the stderr sink when interactive', () => {
    const { lines, logger } = capture(true);

    logger.info('eine Info');
    logger.error('ein Fehler');

    const output = lines.join('');

    expect(output).toContain('eine Info');
    expect(output).toContain('ein Fehler');
  });
});
