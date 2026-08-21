import { randomBytes } from 'node:crypto';

const RELOAD_TOPIC = 'reload';

export interface ReloadServer {
  url: string;
  broadcast(): void;
  stop(): void;
}

/**
 * A page cannot be stopped from opening a WebSocket to a loopback port, because same-origin rules
 * do not apply to it, so the random path is what keeps a foreign tab from attaching to this
 * session; binding to 127.0.0.1 keeps the rest of the network out.
 */
export function startReloadServer(): ReloadServer {
  const path = `/${randomBytes(16).toString('hex')}`;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      // `new URL` would throw on a request whose Host header cannot form one, and a throwing fetch
      // handler takes the whole watch session down; `URL.parse` returns null instead.
      if (URL.parse(request.url)?.pathname !== path) {
        return new Response('not found', { status: 404 });
      }

      if (server.upgrade(request)) {
        return undefined;
      }

      return new Response('expected a websocket upgrade', { status: 426 });
    },
    websocket: {
      // Nothing crosses this socket between renders, and Bun drops a connection idle for 120
      // seconds; what holds a tab nobody is typing in is `sendPings`, which is on by default.
      open(socket) {
        socket.subscribe(RELOAD_TOPIC);
      },
      message() {},
    },
  });

  return {
    // `server.port` is typed as optional because a unix socket has none; the bound url always
    // carries the port that was actually assigned.
    url: `ws://127.0.0.1:${server.url.port}${path}`,
    broadcast() {
      server.publish(RELOAD_TOPIC, 'reload');
    },
    stop() {
      // Force-closing is what lets the process exit at once: an open socket keeps it alive.
      server.stop(true);
    },
  };
}
