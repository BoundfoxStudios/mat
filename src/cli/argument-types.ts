import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { oneOf, string, type Type } from 'cmd-ts';
import { DEFAULT_FLAVOR_NAME, flavorNames } from '../flavors/index.ts';
import type { ThemeName } from '../generated/assets.ts';
import { describeFileSystemError } from './errors.ts';

const THEMES: readonly ThemeName[] = ['auto', 'light', 'dark'];

export const themeType: Type<string, ThemeName> = {
  ...oneOf<ThemeName>(THEMES),
  displayName: 'name',
  defaultValue: () => 'auto',
};

export const flavorType: Type<string, string> = {
  ...oneOf(flavorNames()),
  displayName: 'name',
  defaultValue: () => DEFAULT_FLAVOR_NAME,
};

export const pathType: Type<string, string> = { ...string, displayName: 'path' };

/** Resolved and checked while parsing, so a bad directory fails before anything is rendered. */
export const directoryType: Type<string, string> = {
  ...string,
  displayName: 'dir',
  async from(value) {
    const candidate = resolve(value);
    let isDirectory: boolean;

    try {
      isDirectory = statSync(candidate).isDirectory();
    } catch (error) {
      throw new Error(`${candidate}: ${describeFileSystemError(error)}`);
    }

    if (!isDirectory) {
      throw new Error(`${candidate}: not a directory`);
    }

    return candidate;
  },
};
