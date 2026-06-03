# skillfinder

Interactively link AI **skills** into a target directory via symlinks.

A *skill* is any directory that directly contains a `SKILL.md` file.
`skillfinder` recursively discovers skills under a source root, then lets you
toggle which ones are symlinked into a target directory (default
`~/.agents/skills`).

## Features

- Recursive discovery with **bounded depth** and pruning of noise dirs
  (`.git`, `node_modules`, `dist`, …) and **all dotfolders** (e.g. `.agents`,
  which holds repo-specific installed skills rather than source skills).
- Shows which skills are currently linked (`[x]` / `[ ]`) and where each
  source lives. Source paths are shown **relative to the search root** (e.g.
  `./engineering/tdd`) to keep lines short and readable.
- **Grouped by folder:** skills are organised into the folder hierarchy they
  live in (e.g. `engineering/`, `productivity/`), shown as an indented tree.
  Chains of single-child folders are **compacted** into one header (e.g.
  `HKUDS/nanobot/nanobot/skills/`) so deep nesting stays readable.
- **Disable folders:** put the cursor on a folder header and press `space` to
  disable it. A disabled folder is shown as `[X] name/  (hidden)` and its whole
  subtree (subfolders + skills) is hidden. Disabling a folder also **unlinks**
  every currently-linked skill within it. Disabled folders are remembered in
  `~/.config/skillfinder/config.json` (by absolute path) and persist across
  runs. Re-enabling a folder reveals its skills again but does not re-create
  any links.
- **Symlinked target handling:** if the target dir is itself a symlink, offers
  to convert it into a real directory (the pointed-to location is untouched).
- **Name collisions:** when the same skill name exists under multiple sources,
  each candidate is listed separately so you can pick exactly which version to
  link; selecting one re-points the link.
- **Interactive keyboard UI** (when run in a terminal): `↑`/`↓` (or `j`/`k`) to
  move, `space` to toggle the highlighted skill, `enter`/`q`/`Esc` to finish.
  Links update **live** as you toggle. The list **scrolls** to keep the cursor
  on-screen when there are more skills than terminal rows, showing `↑ N more` /
  `↓ N more` indicators, and re-renders on terminal resize. When stdin is piped
  (scripts/CI), it falls back to a numbered list you toggle by typing a number,
  then `q`.
- **Narrow terminals:** by default (`--truncate`) long lines are cut to the
  terminal width with an ellipsis so each skill stays on one line and the
  cursor never scrolls off-screen. Pass `--wrap` to let long lines wrap
  instead; the viewport then budgets by physical lines so the cursor still
  stays visible.
- Links are plain symlinks (Unix assumed).

## Configuration

Disabled folders are stored in `~/.config/skillfinder/config.json` (or
`$XDG_CONFIG_HOME/skillfinder/config.json` when set):

```json
{
  "disabledFolders": [
    "/abs/path/to/some/folder"
  ]
}
```

Folders are keyed by absolute path, so a disabled folder stays disabled
regardless of which `SOURCE_ROOT` you launch from.

## Install

```sh
npm install -g skillfinder
# or
pnpm add -g skillfinder
```

This exposes the `skillfinder` command.

## Usage

```sh
skillfinder [SOURCE_ROOT] [--depth N] [--target DIR] [--truncate|--wrap]
```

| Argument        | Default              | Description                                      |
| --------------- | -------------------- | ------------------------------------------------ |
| `SOURCE_ROOT`   | `.` (current dir)    | Directory to search for skills.                  |
| `--depth N`     | `5`                  | Max search depth below `SOURCE_ROOT`.            |
| `--target DIR`  | `~/.agents/skills`   | Where the symlinks are created.                  |
| `--truncate`    | (default)            | Cut long lines to the terminal width.            |
| `--wrap`        |                      | Let long lines wrap; viewport accounts for it.   |

### Examples

```sh
# Search the current repo, link into ~/.agents/skills
skillfinder

# Search across all your repos
skillfinder ~/dev/github --depth 5

# Use a different target directory
skillfinder . --target ~/some/other/skills
```

## Development

Requires Node.js >= 18.

```sh
pnpm install
pnpm dev          # run from source (node --experimental-strip-types)
pnpm typecheck    # tsc --noEmit
pnpm build        # compile TypeScript to dist/
```

The CLI is plain TypeScript compiled with `tsc` to `dist/` (ESM). No bundler.
The `bin` entry points at `dist/cli.js`.

## License

MIT
