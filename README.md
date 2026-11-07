# 🌿 sprig

IDE-style autocomplete for zsh, like Fig used to be. As you type, a dropdown under the cursor shows subcommands, options, branches, files and descriptions. It uses Fig's open-source completion specs ([withfig/autocomplete](https://github.com/withfig/autocomplete)), 700+ CLIs.

```
~/dev ❯ git ch█
         › checkout     Switch branches or restore working tree files
         › cherry-pick  Apply the changes introduced by some existing commits
```

## Install

With Homebrew:

```sh
brew tap john-rock/sprig https://github.com/john-rock/sprig
brew install john-rock/sprig/sprig && sprig install
```

This repo is its own tap, so the `brew tap` line needs the URL. Without it, Homebrew looks for a `homebrew-sprig` repo, which doesn't exist.

From this checkout (needs [Bun](https://bun.sh) to build):

```sh
scripts/install.sh      # builds, installs to ~/.local/share/sprig, links ~/.local/bin/sprig, adds one line to ~/.zshrc
exec zsh                # or open a new tab
```

`sprig install` backs up `~/.zshrc` and appends a marked block at the end. `sprig uninstall` removes it and stops the daemon.

## Update

```sh
sprig update            # installs the latest release, then open a new tab
```

`sprig update` checks the download against the release's `SHA256SUMS`, switches to the new version, and stops the old daemon. Homebrew installs update with `brew upgrade sprig`; source checkouts with `git pull && scripts/install.sh`.

## Keys

The dropdown only takes over these keys while it's open:

| Key | Action |
| --- | --- |
| `↑` / `↓`, `Ctrl-P` / `Ctrl-N` | move the selection |
| `Tab` | insert the selected item |
| `Shift-Tab` | move the selection up |
| `Enter` | insert the selected item and run the line. To run the line as typed, press `Esc` first. |
| `Esc` | close the dropdown until you start the next word |

When the dropdown is closed, every key behaves as before. For commands without a spec, `Tab` falls through to normal zsh completion.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPRIG_MAX_ROWS` | `8` | rows shown before scrolling |
| `SPRIG_NO_DSR` | unset | don't ask the terminal for the cursor column; the dropdown starts at the left edge |
| `SPRIG_DEBUG` | unset | path of a file to trace requests and replies to |

Set these before the sprig block in `~/.zshrc`.

Your own specs, in Fig's compiled `.js` format, go in `~/.config/sprig/specs/` and override the built-in ones.

## How it works

```
zsh (ZLE widgets)  ── unix socket ──>  sprig daemon (Bun)
  sends the text left of the cursor        tokenizes, walks the Fig spec,
  on each keystroke, gets replies async    runs generators (git branches, npm scripts…),
  draws the dropdown with POSTDISPLAY      ranks results (prefix > typo match, spec priority, your picks)
```

- **No terminal wrapper.** Unlike Fig, Amazon Q or inshellisense, sprig doesn't run your shell inside a pseudo-terminal. zsh's own line editor draws the dropdown, so scrollback, resizing, tmux and SSH behave normally.
- **Starts on demand.** The daemon starts with your first shell and exits after an hour idle. It never blocks typing: if it isn't up yet, that keystroke just gets no dropdown.
- **Learns your picks.** The suggestions you choose rank higher next time. They're stored in `~/.local/state/sprig/usage.json`.
- **Debugging.** Run `sprig doctor` to check the setup. The daemon logs to `~/.local/state/sprig/daemon.log`.

## Development

```sh
bun install
bun src/cli.ts complete "git checkout -"     # completions without a shell
bun test                                     # engine tests
SPRIG_PYTHON=/path/to/python-with-pyte bun test   # + real zsh in a headless terminal
scripts/build.sh                             # release tarballs in dist/
```

### Releasing

1. Bump `VERSION` in `src/paths.ts` (and `package.json`), and add a `## <version>` section to `CHANGELOG.md`.
2. Merge to `main`, then tag it: `git tag v<version> && git push origin v<version>`.
3. The `Release` workflow checks that the tag matches `VERSION`, runs the tests, builds the tarballs and publishes a GitHub release with that changelog section as its notes. `sprig update` picks it up from there.
4. Once the release is up, run `scripts/update-formula.sh <version>`, then commit `Formula/sprig.rb` and push it to `main`. The script fills in the checksums from the release's `SHA256SUMS`, which don't exist until step 3, so this comes after the tag. Until it's pushed, `brew upgrade` stays on the previous version.

Bump the version for every release: each version gets its own daemon socket, which is what moves running shells off the old daemon.

The parser's behavior follows Fig's and Microsoft's [inshellisense](https://github.com/microsoft/inshellisense) (MIT). Completion specs © Fig/Hercules Labs and contributors, MIT.
