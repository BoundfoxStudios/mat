# Spec: Follow links to local Markdown files (`--follow-links` / `-f`)

Implements #13.

## Objective

When rendering a file, links to other local Markdown files (e.g. `[Setup](docs/setup.md)`)
currently resolve to `file://` URLs of the raw `.md` sources — following them in the browser
leads nowhere useful. With the new `--follow-links` / `-f` flag, `mat` renders every reachable
local Markdown file into the preview cache and rewrites those links so that following a link
in the browser just works.

The default invocation stays exactly as cheap and predictable as today; following links is
opt-in per call. A config-file default comes later (#16, depends on #14).

## Decisions (resolved open questions from #13)

| Question | Decision |
| --- | --- |
| Recursive? | Yes, fully recursive. Deduplicated via a visited set keyed by `realpath`, which also terminates cycles. No artificial file-count bound; the per-file 10 MB limit still applies. |
| Interaction with stable preview URLs | Each linked file renders to its existing stable preview path (`sha256(realpath).html` in the cache directory). Links are rewritten deterministically to those paths; fragments and query strings are preserved (`docs/setup.md#install` → `<hash>.html#install`). Fragment anchors keep working because every render uses the same rehype-slug slugs. Open tabs pick up a re-render on plain reload, as today. |
| `--output`? | Usage error: `--follow-links is only valid without --output`, reported from `parse` like the existing `--base-dir` rule (exit 2). Multi-file output is a separate feature. |
| Configurable default? | Not here. Tracked in #16, which depends on the global configuration file (#14). |
| Missing link targets | Link stays as-is (absolute `file://` URL, as today) plus a warning on stderr. Without `-f`, links still never warn. |

## Behavior

- A link is followed when its path component (before `?`/`#`) ends in `.md` or `.markdown`
  (case-insensitive) and it either carries no scheme and is not protocol-relative (resolved
  against the document's directory) or is a `file:` URL naming a local path — the form
  Windows drive-letter links take after URL normalisation. The resolved target must exist
  as a local regular file; FIFOs and device files are refused on their stat alone.
- Traversal is breadth-first from the root document. The root's real path seeds the visited
  set, so self-links resolve to the root's own preview URL.
- Deduplication compares real paths as the platform reports them: two differently-cased
  spellings on a case-insensitive filesystem count as two documents — the same trade-off
  the stable preview tab already makes for differently-cased invocations.
- Per linked file, relative links and assets resolve against *that file's* directory
  (its own `baseDir`), exactly as if it had been rendered directly.
- The browser opens only the root document.
- A linked file that cannot be rendered (unreadable, binary, not UTF-8, over 10 MB) produces
  a warning naming the file and is skipped; its link keeps pointing at the raw source.
  Errors on the *root* document keep failing the run, as today.
- Warnings from linked files are prefixed with the file they come from; the existing cap of
  5 printed messages applies to the aggregate.
- `mat - -f` (stdin) works; links resolve against `--base-dir`/cwd. The stdin document keeps
  its content-hash preview path.
- Without `-f`, output is byte-identical to today.

## Tech Stack

Bun ≥ 1.3.14, TypeScript, cmd-ts 0.15.0 (supports `short: 'f'` on `flag()`; `-f` collides
with no existing short form), unified/remark/rehype pipeline.

## Commands

- Build: `bun run build` (assets first: `bun run build:assets`)
- Test: `bun test --timeout 60000` (script: `bun run test`)
- Typecheck: `bun run typecheck`
- Lint: `bun run lint` / `bun run lint:fix`
- Dev run: `bun run dev -- README.md -f`

## Project Structure

- `src/cli/commands/render.ts` — flag definition (`flag({ long: 'follow-links', short: 'f' })`),
  `Invocation` field, `--output` exclusion rule in `parse`
- `src/cli.ts` — render queue (visited set, BFS), per-file preview writes
- `src/render/plugins/` — link collection/rewriting (extend `resolve-assets.ts` or a sibling
  plugin fed via `matContext`; linked targets reported back through `file.data`)
- `tests/follow-links.test.ts` — new; existing suites in `tests/` stay untouched

## Code Style

Existing repo conventions: no comments unless they explain what code cannot
(see `src/cli.ts` for the tone), spelled-out identifiers, Biome for lint/format,
strong typing. Example shape for the flag:

```ts
followLinks: flag({
  long: 'follow-links',
  short: 'f',
  description: 'Also render linked local Markdown files and rewrite their links.',
}),
```

## Testing Strategy

`bun test`, tests in `tests/follow-links.test.ts`, driven through `render()` and `main()`
with injected `OutputStreams` like the existing CLI tests. Cover application behavior only:

- link rewriting (plain, with fragment, with query, `.markdown`, case-insensitive)
- what is *not* rewritten (external URLs, fragment-only, non-Markdown files, missing targets)
- recursion with a cycle (A ↔ B terminates, both rendered once)
- missing target → warning + unchanged link
- unreadable linked file → warning, run still succeeds
- `--follow-links` + `--output` → usage error, exit 2
- without `-f` → unchanged output for a document with `.md` links

## Boundaries

- **Always:** run `bun run typecheck`, `bun run lint`, `bun test` before each commit;
  keep the no-`-f` path byte-identical; commit on the current branch, never push.
- **Ask first:** new dependencies, changes to the preview-path scheme, widening the flag's
  scope (e.g. multi-file `--output`).
- **Never:** follow links outside the local filesystem, weaken the URL sanitizer,
  touch unrelated plugins or tests.

## Success Criteria

- `mat README.md -f` renders README plus all transitively linked local Markdown files into
  the preview cache; clicking any such link in the browser shows the rendered target.
- Fragments survive rewriting and scroll to the right heading.
- Cyclic links terminate; each file renders exactly once per invocation.
- `mat x.md -f --output y.html` exits 2 with a usage error.
- A link to a missing `.md` file warns and stays unchanged.
- `mat --help` lists `-f, --follow-links`.
- All existing tests stay green; typecheck and lint pass.

## Open Questions

None — all resolved above.
