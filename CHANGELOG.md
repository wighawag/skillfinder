# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-03

### Added

- Show the highlighted skill's description (from its `SKILL.md` YAML
  frontmatter) in a panel at the bottom of the interactive TUI. Supports
  plain, quoted, and folded/literal block-scalar descriptions. The panel is
  exempt from truncation, so long descriptions wrap onto multiple lines in
  both `--truncate` and `--wrap` modes, with the row viewport budget adjusted
  accordingly.

### Fixed

- `pnpm dev` failed on Node.js with `--experimental-strip-types` due to a
  TypeScript parameter property in `LineReader`; rewritten as a plain
  constructor parameter.

## [0.1.0]

### Added

- Initial release: recursively discover skills (directories containing
  `SKILL.md`) under a source root and interactively toggle which ones are
  symlinked into a target directory. Folder-tree grouping with compaction,
  disable-able folders persisted to config, name-collision handling,
  scrolling keyboard TUI, `--truncate`/`--wrap` modes, and a piped-stdin
  fallback.

[0.2.0]: https://github.com/wighawag/find-skills/releases/tag/v0.2.0
[0.1.0]: https://github.com/wighawag/find-skills/releases/tag/v0.1.0
