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
  source lives.
- **Symlinked target handling:** if the target dir is itself a symlink, offers
  to convert it into a real directory (the pointed-to location is untouched).
- **Name collisions:** when the same skill name exists under multiple sources,
  each candidate is listed separately so you can pick exactly which version to
  link; selecting one re-points the link.
- Toggle by number, `q` to quit. Links are plain symlinks (Unix assumed).

## Install

```sh
npm install -g find-skills
# or
pnpm add -g find-skills
```

This exposes the `find-skills` command.

## Usage

```sh
find-skills [SOURCE_ROOT] [--depth N] [--target DIR]
```

| Argument        | Default              | Description                              |
| --------------- | -------------------- | ---------------------------------------- |
| `SOURCE_ROOT`   | `.` (current dir)    | Directory to search for skills.          |
| `--depth N`     | `5`                  | Max search depth below `SOURCE_ROOT`.    |
| `--target DIR`  | `~/.agents/skills`   | Where the symlinks are created.          |

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
