import { describe, expect, test } from 'bun:test';
import { render } from '../src/render/index.ts';
import type { LinkMode } from '../src/render/pipeline.ts';

const BASE_DIR = '/home/user/Meine Dokumente/größe';

async function renderBody(markdown: string, linkMode: LinkMode = 'absolute'): Promise<string> {
  const { html } = await render(markdown, {
    title: 'assets.md',
    theme: 'auto',
    baseDir: BASE_DIR,
    linkMode,
    embedMode: 'cache',
  });

  const body = html.match(/<article class="markdown-body">([\s\S]*)<\/article>/)?.[1];

  if (body === undefined) {
    throw new Error('rendered document has no markdown-body article');
  }

  return body;
}

describe('relative assets', () => {
  test('rewrites a relative image to an absolute file url', async () => {
    const body = await renderBody('![](./pictures/diagram.png)');

    expect(body).toContain(
      'src="file:///home/user/Meine%20Dokumente/gr%C3%B6%C3%9Fe/pictures/diagram.png"',
    );
  });

  test('percent-encodes spaces and non-ascii in the file name too', async () => {
    const body = await renderBody('![](Bild%20mit%20Ümlaut.png)');

    expect(body).toContain('Bild%20mit%20%C3%9Cmlaut.png');
  });

  test('resolves parent-directory paths', async () => {
    const body = await renderBody('![](../shared/logo.svg)');

    expect(body).toContain('src="file:///home/user/Meine%20Dokumente/shared/logo.svg"');
  });

  test('keeps the fragment attached to the resolved path', async () => {
    const body = await renderBody('[link](./other.md#section)');

    expect(body).toContain(
      'href="file:///home/user/Meine%20Dokumente/gr%C3%B6%C3%9Fe/other.md#section"',
    );
  });

  test('covers every element that carries a url', async () => {
    const body = await renderBody(
      [
        '<video src="clip.mp4" controls></video>',
        '<audio src="sound.ogg" controls></audio>',
        '<picture><source src="wide.webp"></picture>',
      ].join('\n\n'),
    );

    for (const name of ['clip.mp4', 'sound.ogg', 'wide.webp']) {
      expect(body).toContain(`file:///home/user/Meine%20Dokumente/gr%C3%B6%C3%9Fe/${name}`);
    }
  });

  test('does not resolve an attribute the allowlist drops', async () => {
    // GitHub strips `poster`, so by the time this plugin runs there is nothing left to resolve.
    expect(await renderBody('<video src="clip.mp4" poster="thumb.png"></video>')).not.toContain(
      'thumb.png',
    );
  });

  test('rewrites every candidate in a srcset', async () => {
    const body = await renderBody(
      '<picture><source srcset="small.png 1x, large.png 2x"></picture>',
    );

    expect(body).toContain('gr%C3%B6%C3%9Fe/small.png 1x');
    expect(body).toContain('gr%C3%B6%C3%9Fe/large.png 2x');
  });

  test('leaves a srcset containing a data url intact', async () => {
    // Splitting on commas would tear the base64 payload apart.
    const value = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    const body = await renderBody(`<picture><source srcset="${value} 1x"></picture>`);

    expect(body).toContain(value);
  });
});

describe('urls that must stay untouched', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['absolute http', '[x](https://example.com/a.png)'],
    ['protocol-relative', '<img src="//cdn.example.com/a.png">'],
    ['pure fragment', '[x](#heading)'],
    ['mailto', '[x](mailto:a@b.com)'],
    [
      'data image',
      '![](data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==)',
    ],
  ];

  for (const [name, markdown] of cases) {
    test(`leaves ${name} alone`, async () => {
      expect(await renderBody(markdown)).not.toContain('file:///');
    });
  }

  test('never emits a base tag', async () => {
    // A `<base href>` would fix images but break every in-page fragment link.
    const { html } = await render('![](a.png)', {
      title: 'assets.md',
      theme: 'auto',
      baseDir: BASE_DIR,
      linkMode: 'absolute',
      embedMode: 'cache',
    });

    expect(html).not.toContain('<base');
  });
});

describe('relative link mode', () => {
  test('leaves relative urls relative', async () => {
    const body = await renderBody('![](./pictures/diagram.png)', 'relative');

    expect(body).toContain('src="./pictures/diagram.png"');
    expect(body).not.toContain('file:///');
  });
});

describe('platform-specific paths', () => {
  test.skipIf(process.platform !== 'win32')('resolves a windows drive path', async () => {
    expect(await renderBody('![l](C:/pics/logo.png)')).toContain('file:///C:/pics/logo.png');
  });

  test.skipIf(process.platform === 'win32')(
    'drops a windows drive path elsewhere, as github does',
    async () => {
      // `c:` is a scheme no allowlist contains, and appending the path to a POSIX base would
      // only make it wrong in a new way.
      expect(await renderBody('![l](C:/pics/logo.png)')).not.toContain('C:/pics');
    },
  );
});
