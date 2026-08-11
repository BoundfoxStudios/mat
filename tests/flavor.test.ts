import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FLAVOR_NAME, flavorNames, getFlavor } from '../src/flavors/index.ts';
import { render } from '../src/render/index.ts';

const flavors = flavorNames().map((name) => {
  const flavor = getFlavor(name);

  if (!flavor) {
    throw new Error(`registry lists ${name} but does not return it`);
  }

  return flavor;
});

describe('registry', () => {
  test('registers gfm as the default', () => {
    expect(flavorNames()).toEqual(['gfm']);
    expect(DEFAULT_FLAVOR_NAME).toBe('gfm');
  });

  test('returns undefined for an unknown name', () => {
    expect(getFlavor('gitlab')).toBeUndefined();
  });

  test('names itself consistently', () => {
    for (const flavor of flavors) {
      expect(getFlavor(flavor.name)).toBe(flavor);
    }
  });
});

describe('scripts', () => {
  for (const flavor of flavors) {
    for (const script of flavor.scripts) {
      test(`${flavor.name}: ${script.name} is a classic script`, () => {
        // On a `file://` page every engine silently blocks module scripts, dynamic imports and
        // workers, and the failure shows up as a blank diagram rather than an error.
        expect(script.source).not.toContain('import(');
        expect(script.source).not.toContain('import.meta');
        expect(script.source).not.toContain('new Worker');
        expect(script.source).not.toContain('importScripts');
      });

      test(`${flavor.name}: ${script.name} only ships when its fence is used`, () => {
        expect(script.requiresFence).not.toBe('');
        expect(Object.keys(flavor.fenceHandlers)).toContain(script.requiresFence);
      });

      test(`${flavor.name}: ${script.name} bootstraps both themes`, () => {
        expect(script.bootstrap('dark')).not.toBe(script.bootstrap('light'));
      });
    }
  }
});

describe('renderer core', () => {
  const sourceDirectories = ['src/render', 'src/html', 'src/assets'];

  test('never branches on a flavor name', () => {
    const names = flavorNames();

    for (const directory of sourceDirectories) {
      for (const fileName of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
        const path = join(directory, fileName);

        if (!path.endsWith('.ts')) {
          continue;
        }

        const source = readFileSync(path, 'utf8');

        for (const name of names) {
          expect(source).not.toContain(`'${name}'`);
        }
      }
    }
  });
});

describe('flavor selection', () => {
  const options = {
    title: 'flavor.md',
    theme: 'auto',
    baseDir: '/tmp',
    linkMode: 'absolute',
    embedMode: 'cache',
  } as const;

  test('defaults to gfm', async () => {
    const { html } = await render('~~x~~', options);

    expect(html).toContain('<del>x</del>');
  });

  test('rejects an unknown flavor by name', async () => {
    expect(render('x', { ...options, flavor: 'gitlab' })).rejects.toThrow(
      'Unknown flavor `gitlab`; available: gfm',
    );
  });
});
