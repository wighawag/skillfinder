# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Show the highlighted skill's description (from its `SKILL.md` YAML
  frontmatter) in a panel at the bottom of the interactive TUI. Supports
  plain, quoted, and folded/literal block-scalar descriptions. The panel is
  exempt from truncation, so long descriptions wrap onto multiple lines in
  both `--truncate` and `--wrap` modes, with the row viewport budget adjusted
  accordingly.
