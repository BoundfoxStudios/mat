import { createConsola, LogLevels } from 'consola';

export type Logger = ReturnType<typeof createLogger>;

/**
 * Every log line goes to the stderr sink, whatever its level: stdout carries the rendered
 * document (`--output -`) and has to stay clean.
 *
 * Two consola defaults are environment-sniffed and are pinned here because they would change
 * behavior between machines. The default level drops to `warn` when NODE_ENV is `test` — which
 * `bun test` always sets — silently swallowing every info line. And the reporter choice (fancy
 * versus plain) follows NODE_ENV/CI detection, which rewrites the message text itself: the fancy
 * reporter strips backticks and turns levels into badges. Tying the format to `interactive`
 * instead keeps redirected output, CI logs and the test suite byte-identical on every machine.
 */
export function createLogger(writeStderr: (text: string) => void, interactive: boolean) {
  const sink = {
    write(text: string): boolean {
      writeStderr(text);

      return true;
    },
  } as NodeJS.WriteStream;

  return createConsola({
    fancy: interactive,
    level: LogLevels.info,
    stdout: sink,
    stderr: sink,
  }).withTag('mat');
}
