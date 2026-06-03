# find-skills

Interactively link AI **skills** into a target directory via symlinks.

A *skill* is any directory that directly contains a `SKILL.md` file.
`find-skills` recursively discovers skills under a source root, then lets you
toggle which ones are symlinked into a target directory (default
`~/.agents/skills`).

## Features

- Recursive discovery with **bounded depth** and pruning of noise dirs
  (`.git`, `node_modules`, `dist`, …) and **all dotfolders** (e.g. `.agents`,
  which holds repo-specific installed skills rather than source skills).
- Shows which skills are currently linked (`[x]` / `[ ]`) and where each
  source lives. Source paths are shown **relative to the search root** (e.g.
  `./engineering/tdd`) to keep lines short and readable.
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

## Install

```sh
npm install -g find-skills
# or
pnpm add -g find-skills
```

This exposes the `find-skills` command.

## Usage

```sh
find-skills [SOURCE_ROOT] [--depth N] [--target DIR] [--truncate|--wrap]
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
find-skills

# Search across all your repos
find-skills ~/dev/github --depth 5

# Use a different target directory
find-skills . --target ~/some/other/skills
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
