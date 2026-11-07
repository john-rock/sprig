# sprig

## Every user-facing change ships as a release

Merging to `main` publishes a release automatically whenever `VERSION` is new (see `.github/workflows/release.yml`). So any branch that fixes a bug or changes behavior users see should, in the same PR:

1. Bump the patch version (or minor, for bigger features) in `src/paths.ts` (`VERSION`) and `package.json`.
2. Add a `## <version>` section to the top of `CHANGELOG.md`, with `### Fixed` / `### Added` entries. That section becomes the GitHub release notes.
3. Add a release entry to `docs/index.html` under "release notes": a new `<article class="release">` with the version, today's date, and the `latest` tag. Remove `latest` from the previous entry. Also bump the version in the footer, the `VERSIONS` map (`sprig: "sprig <version>"`) and the demo `brew install` output.
4. Don't touch `Formula/sprig.rb`. The workflow updates it after the release is published.

Changes that users don't see (tests, CI, docs-only) don't need a version bump.

## Branches and PRs

- Branch from `main`, never from another feature branch, and open one PR per change.
- Run `bun test` before pushing.
