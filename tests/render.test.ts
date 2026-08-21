import { describe, expect, test } from 'bun:test';
import { gfm } from '../src/flavors/gfm.ts';
import { type RenderOptions, render } from '../src/render/index.ts';
import { getProcessor } from '../src/render/pipeline.ts';

const defaults: RenderOptions = {
  title: 'test.md',
  theme: 'auto',
  baseDir: '/tmp',
  linkMode: 'absolute',
  embedMode: 'cache',
};

async function renderHtml(markdown: string, overrides: Partial<RenderOptions> = {}) {
  const { html } = await render(markdown, { ...defaults, ...overrides });
  return html;
}

describe('render', () => {
  test('wraps the body in the class github-markdown-css requires', async () => {
    const html = await renderHtml('# Hello');

    expect(html).toContain('<article class="markdown-body">');
    expect(html).toMatch(/<article class="markdown-body">[\s\S]*<h1 id="hello">Hello/);
  });

  test('emits a complete document', async () => {
    const html = await renderHtml('# Hello');

    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>test.md</title>');
  });

  test('escapes the title', async () => {
    const html = await renderHtml('x', { title: '<script>&"' });

    expect(html).toContain('<title>&lt;script&gt;&amp;&quot;</title>');
  });

  test('never emits a base tag', async () => {
    // A `<base href>` would fix relative images and break every in-page `#fragment` link.
    expect(await renderHtml('# Hello')).not.toContain('<base');
  });

  describe('theming', () => {
    test('selects the stylesheet file rather than setting an attribute', async () => {
      const light = await renderHtml('x', { theme: 'light' });
      const dark = await renderHtml('x', { theme: 'dark' });
      const auto = await renderHtml('x', { theme: 'auto' });

      expect(light).not.toContain('prefers-color-scheme: dark');
      expect(dark).not.toContain('prefers-color-scheme: light');
      expect(auto).toContain('prefers-color-scheme: dark');

      // The `[data-theme]` selectors in the combined stylesheet are no-ops nested inside the media
      // queries, so mat must never set the attribute and rely on them.
      for (const html of [light, dark, auto]) {
        const openingTag = html.match(/<html[^>]*>/)?.[0] ?? '';
        expect(openingTag).not.toContain('data-theme');
      }
    });

    test('paints the page canvas, which github-markdown-css does not', async () => {
      expect(await renderHtml('x', { theme: 'dark' })).toContain(
        'html, body { background-color: #0d1117; }',
      );
      expect(await renderHtml('x', { theme: 'light' })).toContain(
        'html, body { background-color: #ffffff; }',
      );
    });

    test('ships the sr-only rule github-markdown-css lacks', async () => {
      expect(await renderHtml('x')).toContain('.sr-only {');
    });
  });

  test('reuses one processor across renders', async () => {
    await renderHtml('# One');
    const first = getProcessor(gfm);
    await renderHtml('# Two');

    expect(getProcessor(gfm)).toBe(first);
  });

  test('is deterministic', async () => {
    expect(await renderHtml('# Same')).toBe(await renderHtml('# Same'));
  });

  describe('reload client', () => {
    const reloadUrl = 'ws://127.0.0.1:4711/reload';

    function scriptTagCount(html: string): number {
      return html.match(/<script/g)?.length ?? 0;
    }

    interface RunningClient {
      socketCount: () => number;
      reloadCount: () => number;
      currentUrl: () => string;
      receive: (data: unknown) => void;
      open: () => void;
      /** Returns false when the close scheduled no reconnect. */
      closeAndReconnect: () => boolean;
    }

    /**
     * Runs the injected client with stand-ins for the three globals it touches, which is the only
     * way to reach its behaviour without a browser.
     */
    function runClientFrom(html: string): RunningClient {
      const source = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)]
        .map((script) => script[1])
        .find((body) => body?.includes('new WebSocket'));

      if (source === undefined) {
        throw new Error('the rendered page carries no reload client');
      }

      const sockets: SocketStub[] = [];
      const scheduled: { callback: () => void; delayMilliseconds: number }[] = [];
      let reloads = 0;

      class SocketStub {
        readonly listeners = new Map<string, (event: { data: unknown }) => void>();
        readonly url: string;

        constructor(url: string) {
          this.url = url;
          sockets.push(this);
        }

        addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
          this.listeners.set(type, listener);
        }
      }

      const runSource = new Function('WebSocket', 'location', 'setTimeout', source) as (
        socketConstructor: new (url: string) => unknown,
        locationStub: { reload: () => void },
        schedule: (callback: () => void, delayMilliseconds: number) => void,
      ) => void;

      runSource(
        SocketStub,
        {
          reload: () => {
            reloads += 1;
          },
        },
        (callback, delayMilliseconds) => {
          scheduled.push({ callback, delayMilliseconds });
        },
      );

      function currentSocket(): SocketStub {
        const socket = sockets[sockets.length - 1];

        if (socket === undefined) {
          throw new Error('the client opened no socket');
        }

        return socket;
      }

      function dispatch(type: string, data?: unknown): void {
        const listener = currentSocket().listeners.get(type);

        if (listener === undefined) {
          throw new Error(`the client registered no ${type} listener`);
        }

        listener({ data });
      }

      return {
        socketCount: () => sockets.length,
        reloadCount: () => reloads,
        currentUrl: () => currentSocket().url,
        receive: (data) => {
          dispatch('message', data);
        },
        open: () => {
          dispatch('open');
        },
        closeAndReconnect: () => {
          dispatch('close');

          const reconnect = scheduled.shift();

          if (reconnect === undefined) {
            return false;
          }

          expect(reconnect.delayMilliseconds).toBe(1000);
          reconnect.callback();

          return true;
        },
      };
    }

    test('adds exactly one classic script carrying the escaped url when reload is set', async () => {
      const plain = await renderHtml('# Hello');
      const watched = await renderHtml('# Hello', {
        reload: { url: `${reloadUrl}?x=</script><script>alert(1)</script>` },
      });

      expect(scriptTagCount(watched)).toBe(scriptTagCount(plain) + 1);
      expect(watched).not.toContain('type="module"');
      expect(watched).not.toContain('</script><script>');
      expect(watched).toContain(
        `const url = "${reloadUrl}?x=\\u003c/script>\\u003cscript>alert(1)\\u003c/script>";`,
      );
    });

    test('hands the socket the unescaped url when it carries script-terminating characters', async () => {
      const hostileUrl = `${reloadUrl}?x=</script><script>alert(1)</script>`;
      const client = runClientFrom(await renderHtml('# Hello', { reload: { url: hostileUrl } }));

      expect(client.currentUrl()).toBe(hostileUrl);
    });

    test('leaves the page without any socket code when reload is not set', async () => {
      expect(await renderHtml('# Hello')).not.toContain('WebSocket');
    });

    test('reloads on the reload message and ignores every other message', async () => {
      const client = runClientFrom(await renderHtml('# Hello', { reload: { url: reloadUrl } }));

      expect(client.currentUrl()).toBe(reloadUrl);

      client.receive('ping');

      expect(client.reloadCount()).toBe(0);

      client.receive('reload');

      expect(client.reloadCount()).toBe(1);
    });

    test('stops reconnecting after twenty-five closes without a connection in between', async () => {
      const client = runClientFrom(await renderHtml('# Hello', { reload: { url: reloadUrl } }));

      for (let attempt = 0; attempt < 25; attempt += 1) {
        expect(client.closeAndReconnect()).toBe(true);
      }

      expect(client.closeAndReconnect()).toBe(false);
      expect(client.socketCount()).toBe(26);
    });

    test('reconnects past the cap once a connection has opened', async () => {
      const client = runClientFrom(await renderHtml('# Hello', { reload: { url: reloadUrl } }));

      for (let attempt = 0; attempt < 25; attempt += 1) {
        expect(client.closeAndReconnect()).toBe(true);
      }

      client.open();

      expect(client.closeAndReconnect()).toBe(true);
    });

    test('reloads on a reload message from the socket a reconnect opened', async () => {
      const client = runClientFrom(await renderHtml('# Hello', { reload: { url: reloadUrl } }));

      expect(client.closeAndReconnect()).toBe(true);

      client.receive('reload');

      expect(client.reloadCount()).toBe(1);
    });
  });
});
