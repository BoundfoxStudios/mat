const RECONNECT_DELAY_MILLISECONDS = 1000;
// Capped so a tab left open goes quiet roughly 25 seconds after mat exits, instead of reconnecting
// for as long as it stays open.
const MAX_RECONNECT_ATTEMPTS = 25;

/**
 * The url lands in a JavaScript string literal inside a classic script, so it is escaped for both
 * contexts: JSON for the literal, and a unicode escape for every `<`, because a literal `</script`
 * ends the element even inside a string. The escape is the same character to JavaScript and
 * invisible to the HTML parser.
 */
function escapeUrlLiteral(url: string): string {
  return JSON.stringify(url).replace(/</g, '\\u003c');
}

/**
 * Never `type="module"`: module scripts, dynamic imports and workers are all blocked under the
 * `file://` origin the preview is opened from.
 */
export function reloadClientTag(url: string): string {
  return `<script>
(() => {
  const url = ${escapeUrlLiteral(url)};
  let attempts = 0;

  const connect = () => {
    try {
      const socket = new WebSocket(url);

      socket.addEventListener('open', () => {
        attempts = 0;
      });

      socket.addEventListener('message', (event) => {
        if (event.data === 'reload') {
          location.reload();
        }
      });

      socket.addEventListener('close', () => {
        if (attempts < ${MAX_RECONNECT_ATTEMPTS}) {
          attempts += 1;
          setTimeout(connect, ${RECONNECT_DELAY_MILLISECONDS});
        }
      });
    } catch {}
  };

  connect();
})();
</script>`;
}
