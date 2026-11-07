# Changelog

Each `## <version>` section becomes the GitHub release notes when that version is tagged.

## 0.1.3

### Fixed

- `code .`, `cd ..` and the like run as typed again. When the word was just `.` or `..`, the dropdown listed only dotfiles, so Enter replaced it with the first one (`code .gitignore`). Now `./` and `../` are offered first.

## 0.1.2

### Fixed

- Remote names show up again for `git fetch`, `git push`, `git pull`, `git remote rm` and the rest. Generator scripts now get their output without the trailing newline, as they did under Fig, so specs that split on lines no longer fail on the empty last one.

## 0.1.1

### Fixed

- The shell no longer freezes on commands with long option lists, like `grep -`. Replies larger than the socket buffer (about 8 KB on macOS) were cut off, which left zsh waiting for the rest of the line.

### Added

- `sprig update` installs the latest release. It checks the download against the release's `SHA256SUMS`, then switches to the new version and stops the old daemon. Homebrew installs get pointed to `brew upgrade sprig` instead.

### Upgrading from 0.1.0

0.1.0 doesn't have `sprig update`, so reinstall this time with `scripts/install.sh` from a checkout, or with a release tarball: `scripts/install.sh sprig-0.1.1-<os>-<arch>.tar.gz`. After that, `sprig update` handles it.

## 0.1.0

- First version.
