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

The fully qualified name is not optional: since Homebrew 6.0.0 a third-party tap has to be trusted
explicitly, and this form does it in one step.

Or download a binary for your platform from the [releases page](https://github.com/BoundfoxStudios/mat/releases)
and put it on your `PATH`.

### Supported platforms

| Platform | Architecture | Prebuilt binary | Homebrew formula |
| --- | --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | yes | yes |
| macOS | Intel (`x86_64`) | **no** | **no** |
| Linux | `x86_64` | yes | yes |
| Linux | `arm64` | yes | yes |
| Windows | `x86_64` | yes | — |

**macOS on Intel is not built.** Neither the releases nor the Homebrew formula carry an `x86_64`
macOS binary, so `brew install BoundfoxStudios/tap/mat` will not install on an Intel Mac. Bun itself
runs there, so you can still use `mat` from source — clone the repository and follow
[Develop](#develop) — but `bun run build` has no `darwin-x64` target and will refuse it.

## Use

```console
$ mat README.md                      # render and open the browser
$ cat notes.md | mat -               # read from stdin
$ mat README.md --output readme.html # write a self-contained file, open nothing
$ mat README.md --output -           # write the HTML to stdout
$ mat README.md --theme dark         # force a theme; default follows the OS
```

Run `mat --help` for the full list.

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

## A word on trust

**`mat` renders untrusted Markdown into trusted HTML** and opens it in your real browser.

Author-written HTML goes through the same kind of allowlist GitHub uses: known elements with known
attributes survive, everything else is unwrapped or dropped. The list is derived from
`rehype-sanitize`'s GitHub-modelled default and corrected against GitHub's measured behaviour, so
what renders here is what renders on github.com.

One thing `mat` cannot do that GitHub does: GitHub routes every external image through a proxy, so
the reader's address never reaches the third-party host. A local tool has no proxy. **Opening a
document tells every host it links to your IP address, user agent and the time you opened it.**
Point `mat` at documents you trust.

## Known differences from github.com

Deliberate, so they do not get reported as bugs:

- Protocol-relative URLs (`//host/path`) are dropped, where GitHub keeps them. On github.com they
  inherit https behind a proxy and a content security policy; from a local file they inherit
  nothing.
- `data:image/` URLs, `<audio>` and `<source src>` are kept, where GitHub drops them. A `data:`
  document has an opaque origin and can reach neither the previewed file nor the page around it,
  and in a local document `<source src="./demo.mp4">` is the only way to write a video.
- External images load directly rather than through a proxy — see the note on trust above.
- Single-line `$$x$$` renders as inline math, not display math. `remark-math` has no option for it;
  display math needs `$$` on its own lines.
- Bare `foo.com` is not linked. That is correct — the GFM autolink extension only covers `www.`,
  `http(s)://` and email addresses.
- GitHub's custom emoji (`:shipit:`, `:octocat:`) are missing. GitHub serves them as images from its
  own CDN, and they are not available offline.
- A lone `<plaintext>` swallows the rest of the document. That is the HTML parser doing what the
  standard says.
- Anything a diagram or formula needs is embedded, but images are read from disk. A preview of a
  document whose images are missing shows broken images and says so on stderr.

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

## Releases

Releases run on [release-please](https://github.com/googleapis/release-please): Conventional Commits
on `main` accumulate into a release pull request, and merging it bumps the version, writes the
changelog, tags, and builds and attaches the binaries for all four targets: `darwin-arm64`,
`linux-x64`, `linux-arm64` and `windows-x64`. The Homebrew formula is generated from three of them —
Windows has no formula.

Publishing that formula to `BoundfoxStudios/homebrew-tap` needs a token the default `GITHUB_TOKEN`
cannot provide, because it never reaches a second repository. A GitHub App supplies it: the
organisation secrets `BFS_APP_BOT_CLIENT_ID` and `BFS_APP_BOT_PRIVATE_KEY`, plus that app installed
on the tap with `contents: write`. The workflow mints an installation token scoped to that one
repository and revokes it when the job ends. If the secrets do not reach the job the two tap steps
are skipped, so a release still ships its binaries and only the formula goes unpublished.

## Third-party code

The binary embeds Mermaid, the KaTeX stylesheet and fonts, github-markdown-css, the starry-night
grammars, Oniguruma and the unified pipeline. An `--output` file carries a subset of that. Their
licences, and the copyright notices they require you to pass on, are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

MIT
