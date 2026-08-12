# Plan: `--follow-links` / `-f` (SPEC.md, #13)

## Architecture

The feature has three parts, wired through the existing `matContext` on the vfile:

1. **Flag** — `render.ts` gains `followLinks: flag({ long: 'follow-links', short: 'f' })`.
   The `--output` exclusion is reported from `parse`, like the existing `--base-dir` rule.
   The node-lookup helper in `options.ts` must also match short-option AST nodes, since the
   user may have typed `-f`.

2. **Admission callback + link rewrite** — `rehypeResolveAssets` already resolves every
   `a[href]` against `baseDir`. When `matContext.followLinks` is set and the decoded path
   component ends in `.md`/`.markdown` (case-insensitive), the plugin calls
   `followLinks.admit(absolutePath)`:
   - **admitted** → the plugin writes the returned preview `file://` URL (suffix `?…#…`
     preserved) instead of the raw source URL;
   - **rejected** → the plugin keeps today's raw `file://` URL and emits the returned
     problem via `file.message(...)`.

   The callback lives on the CLI side (closure), so the render layer stays free of
   preview-path policy and filesystem traversal. Rejections are cached per path, so a
   broken target warns per referring file but is checked once.

3. **BFS queue** — `cli.ts` builds the follower before rendering the root:
   - visited map keyed by `realpath`, seeded with the root's real path → root preview URL
     (stdin seeds nothing);
   - `admit` does the full admission check *at rewrite time*: `realpath` + `isFile`,
     size ≤ 10 MB, binary sniff, UTF-8 decode (reusing `decodeMarkdown`). Only a file that
     will actually render gets its link rewritten — this is what makes "failed targets
     keep pointing at the raw source" exact rather than best-effort. The decoded markdown
     is kept on the queue entry so each file is read once;
   - after the root renders, the loop drains the queue: each entry renders with
     `baseDir = dirname(file)`, `title = basename(file)`, `embedMode: 'cache'`, the same
     follower (discovering more files), and is written to `previewPathFor(realpath)`;
   - messages are collected per file and reported once at the end — root messages as
     today, linked files prefixed with their path — under the existing aggregate cap of 5;
   - the browser opens only the root preview.

## Implementation order

1. Flag + `Invocation` + `--output` rule (self-contained, testable via `runSafely`)
2. `FollowLinks` context type + plugin rewrite/admission in `resolve-assets.ts`
   (testable via `render()` with a stub `admit`)
3. CLI follower + BFS queue + message prefixes (integration via `main()` and `spawn`)
4. README documentation
5. Full gates (`typecheck`, `lint`, `test`), multi-lens review, fixes, commits

## Risks

- **cmd-ts short-option AST shape** — the error-highlight helper filters `longOption`
  nodes; `-f` produces a different node type. Mitigation: extend the helper after reading
  `cmd-ts/dist/cjs/newparser/parser` types; covered by an argument test using `-f`.
- **Sanitizer stripping rewritten URLs** — preview URLs are `file://` like today's
  resolved links, and `rehypeResolveAssets` runs *after* `rehypeSanitize`, so no schema
  change is needed. Verified against the pipeline order comment in `pipeline.ts`.
- **TOCTOU between admit and render** — a file can disappear between admission and its
  render. The queue render guards reads and downgrades failures to a warning; the link
  then dangles for this one race, which is acceptable.
- **Symlinks** — two links to one document must share a preview. `realpath` keying gives
  this for free and matches `previewPathFor`'s existing contract.

## Verification checkpoints

- After step 1: `bun test tests/cli.test.ts` (argument suite) green, `-f` parses,
  `-f --output x` exits 2.
- After step 2: new render-level tests green; a stubbed `admit` sees the right absolute
  paths; non-Markdown and external links untouched.
- After step 3: spawn-based integration test shows all preview files in `$TMPDIR/mat`,
  links rewritten, cycles terminating; full suite green.
- After step 5: `bun run typecheck && bun run lint && bun test` all green; review
  findings addressed.
