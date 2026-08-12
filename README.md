# mat

Preview a Markdown file in your browser, the way GitHub renders it.

```console
$ mat README.md
```

Renders the file, writes it to your temp directory and opens your default browser on it. No server,
no runtime to install, no configuration. Named after `cat`, and meant to be used as casually.

What you get is what github.com shows: GitHub-Flavored Markdown, syntax highlighting in 694
languages, Mermaid diagrams, KaTeX math, alerts, footnotes, task lists and the light/dark themes.

## Install

```console
$ brew install BoundfoxStudios/tap/mat
```

Or download a binary for your platform from the [releases page](https://github.com/BoundfoxStudios/mat/releases)
and put it on your `PATH`.

### Supported platforms

| Platform | Architecture | Prebuilt binary | Homebrew formula |
| --- | --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | yes | yes |
| Linux | `x86_64` | yes | yes |
| Linux | `arm64` | yes | yes |
| Windows | `x86_64` | yes | — |

## Use

```console
$ mat README.md                      # render and open the browser
$ mat                                # render this directory's standard document
$ cat notes.md | mat -               # read from stdin
$ mat README.md --output readme.html # write a self-contained file, open nothing
$ mat README.md --output -           # write the HTML to stdout
$ mat README.md --theme dark         # force a theme; default follows the OS
```

Run `mat --help` for the full list.

Without a file, `mat` renders the first of `index.md`, `README.md`, `docs/index.md`,
`docs/README.md` and `SPEC.md` that exists in the current directory. If none does, it exits `1` and
tells you what it looked for.

The preview URL is stable per file, so running `mat` again on the same document reuses the tab —
a reload is enough, and you keep your scroll position.

`--output` produces a file you can move or send: the diagram script and the fonts are embedded.
Images are not — they stay absolute `file://` links to wherever they are on your disk.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The file could not be read or rendered |
| `2` | Wrong invocation |
| `3` | The HTML was written, but no browser could be started. The URL is on stderr. |

Code `3` exists so that `mat file.md || fallback` stays correct: the preview is there, only the
browser is not.

## Develop

```console
$ bun install
$ bun run build:assets   # generate the embedded assets and grammar index
$ bun run dev README.md  # run from source
$ bun run test
$ MAT_BUILD_TEST=1 bun test tests/build.test.ts   # compile and exercise a real binary
$ bun run build          # compile a binary for this platform
```

`bun run build:assets` is required before anything else: `src/generated/` is produced, not
committed. `bun run build -- --all` compiles every target.

## Third-party code

The binary embeds Mermaid, the KaTeX stylesheet and fonts, github-markdown-css, the starry-night
grammars, Oniguruma and the unified pipeline. An `--output` file carries a subset of that. The
licences of every npm package in the tree, and the copyright notices they require you to pass on,
are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which CI regenerates with
license-checker-rseidelsohn. Two components fall outside the npm tree and carry their notices as
verbatim vendor files: the 694 grammar licences in
[third-party/starry-night-grammars-notice.txt](third-party/starry-night-grammars-notice.txt) and
the Oniguruma licence in
[third-party/vscode-oniguruma-notice.txt](third-party/vscode-oniguruma-notice.txt). Pass all three
files on when you redistribute.

## License

MIT
