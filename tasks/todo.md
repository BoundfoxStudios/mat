# Tasks: `--follow-links` / `-f` (SPEC.md, #13)

- [x] Task 1: Add the `--follow-links` / `-f` flag and the `--output` exclusion
  - Acceptance: `mat x.md -f` and `mat x.md --follow-links` parse with
    `followLinks: true`; default is `false`; `-f` together with `--output` (any form,
    long or short) is a usage error naming both flags, exit 2; `--help` lists the flag.
  - Verify: new cases in the `arguments` suite of `tests/cli.test.ts`;
    `bun test tests/cli.test.ts`.
  - Files: `src/cli/commands/render.ts`, `src/cli/options.ts`, `tests/cli.test.ts`

- [x] Task 2: Rewrite admitted Markdown links in the render pipeline
  - Acceptance: with `matContext.followLinks` set, `a[href]` values whose decoded path
    ends in `.md`/`.markdown` (case-insensitive, scheme-less, not protocol-relative) are
    passed to `admit(absolutePath)`; admitted links carry the returned URL plus the
    original `?…`/`#…` suffix; rejected links keep the raw `file://` URL and produce one
    vfile message; external, fragment-only, and non-Markdown links are untouched; without
    `followLinks` the output is byte-identical to before.
  - Verify: new `tests/follow-links.test.ts` render-level cases with a stub `admit`;
    `bun test tests/follow-links.test.ts tests/assets-resolve.test.ts`.
  - Files: `src/render/plugins/resolve-assets.ts`, `src/render/pipeline.ts`,
    `tests/follow-links.test.ts`

- [x] Task 3: BFS render queue in the CLI
  - Acceptance: `mat root.md -f` renders root plus every transitively admitted file to
    its `previewPathFor(realpath)`; admission enforces existing guards (size, binary,
    UTF-8) and warns instead of aborting; cycles render each file once; self-links point
    at the root's own preview; warnings from linked files are prefixed with the file
    path, aggregate cap of 5 holds; browser opens only the root; stdin roots work.
  - Verify: spawn-based integration cases in `tests/follow-links.test.ts` (empty `PATH`,
    private `TMPDIR`, exit 3 pattern from `cli.test.ts`); `bun test`.
  - Files: `src/cli.ts`, `tests/follow-links.test.ts`

- [x] Task 4: Document the flag
  - Acceptance: README "Use" section shows a `-f` example and one sentence on behavior.
  - Verify: proofread; `bun run lint`.
  - Files: `README.md`

- [x] Task 5: Gates, review, commits
  - Acceptance: `bun run typecheck`, `bun run lint`, `bun test` green; multi-lens review
    findings triaged and applied; work committed in logical blocks on `main`
    (spec/plan, implementation closing #13, docs), no push.
  - Verify: command outputs; `git log --oneline`.
  - Files: —
