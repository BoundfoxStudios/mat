import { afterEach, describe, expect, test } from 'bun:test';
import { type ReloadServer, startReloadServer } from '../src/cli/reload-server.ts';

const POLL_INTERVAL_MILLISECONDS = 10;
const DEADLINE_MILLISECONDS = 5000;

interface Client {
  socket: WebSocket;
  messages: string[];
  opened: boolean;
}

const servers: ReloadServer[] = [];
const clients: Client[] = [];

afterEach(() => {
  for (const client of clients) {
    client.socket.close();
  }

  for (const server of servers) {
    server.stop();
  }

  clients.length = 0;
  servers.length = 0;
});

function startServer(): ReloadServer {
  const server = startReloadServer();
  servers.push(server);

  return server;
}

async function waitUntil(condition: () => boolean, expectation: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MILLISECONDS;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${expectation}`);
    }

    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

function connect(url: string): Client {
  const client: Client = { socket: new WebSocket(url), messages: [], opened: false };

  client.socket.addEventListener('open', () => {
    client.opened = true;
  });
  client.socket.addEventListener('message', (event) => {
    client.messages.push(String(event.data));
  });

  clients.push(client);

  return client;
}

async function connectAndWait(url: string): Promise<Client> {
  const client = connect(url);
  await waitUntil(() => client.opened, `the client to connect to ${url}`);

  return client;
}

async function expectRefused(client: Client): Promise<void> {
  await waitUntil(
    () => client.socket.readyState === WebSocket.CLOSED,
    'the connection to be refused',
  );

  expect(client.opened).toBe(false);
}

describe('reload server', () => {
  test('exposes a loopback url with a bound port and a hex token as its path', () => {
    const match = /^ws:\/\/127\.0\.0\.1:(\d+)\/[0-9a-f]{32}$/.exec(startServer().url);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });

  test('delivers a broadcast to a connected client', async () => {
    const server = startServer();
    const client = await connectAndWait(server.url);

    server.broadcast();

    await waitUntil(() => client.messages.includes('reload'), 'the client to be reloaded');
  });

  test('delivers a broadcast to every connected client, not just the first', async () => {
    const server = startServer();
    const first = await connectAndWait(server.url);
    const second = await connectAndWait(server.url);

    server.broadcast();

    await waitUntil(
      () => first.messages.includes('reload') && second.messages.includes('reload'),
      'both clients to be reloaded',
    );
  });

  test('refuses a connection on a path other than the token and answers it with 404', async () => {
    const { host } = new URL(startServer().url);
    // Shaped like a token, so the refusal proves the token itself is compared.
    const wrongPath = '/0123456789abcdef0123456789abcdef';

    await expectRefused(connect(`ws://${host}${wrongPath}`));

    const response = await fetch(`http://${host}${wrongPath}`);

    expect(response.status).toBe(404);
  });

  test('answers a plain http request on the token path with 426, not an upgrade', async () => {
    const { host, pathname } = new URL(startServer().url);

    const response = await fetch(`http://${host}${pathname}`);

    expect(response.status).toBe(426);
  });

  test('uses a token of its own for every server', () => {
    expect(new URL(startServer().url).pathname).not.toBe(new URL(startServer().url).pathname);
  });

  test('drops attached clients on stop and refuses new ones afterwards', async () => {
    const server = startServer();
    const attached = await connectAndWait(server.url);

    server.stop();

    await waitUntil(
      () => attached.socket.readyState === WebSocket.CLOSED,
      'the attached client to be dropped',
    );
    await expectRefused(connect(server.url));
  });

  test('leaves nothing running after a stop, so the process exits on its own', async () => {
    // Only a separate process can show this: a timer or a socket that outlives `stop` is
    // invisible from inside, but would keep `mat --watch` from ever returning from Ctrl+C.
    const moduleUrl = new URL('../src/cli/reload-server.ts', import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { startReloadServer } = await import(${JSON.stringify(moduleUrl)});
         const server = startReloadServer();
         const socket = new WebSocket(server.url);
         await new Promise((resolve) => socket.addEventListener('open', resolve));
         server.stop();`,
      ],
      { stdout: 'ignore', stderr: 'inherit' },
    );

    try {
      await waitUntil(() => child.exitCode !== null, 'the process to exit by itself');
    } finally {
      child.kill();
    }

    expect(child.exitCode).toBe(0);
  });
});
