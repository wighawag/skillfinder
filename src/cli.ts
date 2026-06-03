#!/usr/bin/env node
/**
 * find-skills: discover AI skills under a source root and interactively
 * toggle which ones are symlinked into a target directory (default
 * ~/.agents/skills).
 *
 * A "skill" is any directory that directly contains a SKILL.md file.
 * Skills are keyed by their directory name. A skill is considered "linked"
 * when <target>/<name> is a symlink pointing at that skill directory.
 *
 * Usage:
 *   find-skills [SOURCE_ROOT] [--depth N] [--target DIR]
 *
 *   SOURCE_ROOT   directory to search (default: current directory)
 *   --depth N     max search depth below SOURCE_ROOT (default: 5)
 *   --target DIR  where links live (default: ~/.agents/skills)
 *
 * Linux/Unix assumed (creates symlinks, i.e. `ln -s`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline/promises";

// Directories we never descend into while searching for skills.
const PRUNE_DIRS = new Set([
  ".git", ".hg", ".svn",
  "node_modules", ".venv", "venv", "__pycache__",
  "dist", "build", ".out-of-scope", ".next", ".cache",
  ".idea", ".vscode", "target", "vendor",
]);

// ---- ANSI colours (disabled when not a tty) -------------------------------

const tty = process.stdout.isTTY;
const BOLD = tty ? "\x1b[1m" : "";
const DIM = tty ? "\x1b[2m" : "";
const GREEN = tty ? "\x1b[32m" : "";
const YELLOW = tty ? "\x1b[33m" : "";
const RED = tty ? "\x1b[31m" : "";
const CYAN = tty ? "\x1b[36m" : "";
const RESET = tty ? "\x1b[0m" : "";

interface Skill {
  name: string;
  dir: string; // absolute, resolved path to the skill directory
}

interface Row {
  name: string;
  /** absolute path to the candidate skill source dir */
  path: string;
  /** same name appears under multiple sources */
  collision: boolean;
  /** this candidate is the one currently linked */
  isLinked: boolean;
  /** absolute path of the link location target/<name> */
  linkPath: string;
  /** the link location is occupied by some symlink/file (maybe another source) */
  nameOccupied: boolean;
}

/** Expand a leading ~ to the user's home directory. */
function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Return skills for every directory under root (within maxDepth) that
 * directly contains a SKILL.md. Skills are not nested inside skills, so we
 * stop descending once one is found.
 */
function findSkills(root: string, maxDepth: number): Skill[] {
  const found: Skill[] = [];
  const resolvedRoot = path.resolve(root);

  function walk(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Is this directory itself a skill?
    const isSkill = entries.some((e) => e.name === "SKILL.md" && e.isFile());
    if (isSkill) {
      found.push({ name: path.basename(dir), dir });
      return; // do not descend into a skill
    }

    if (depth >= maxDepth) return;

    for (const e of entries) {
      if (!e.isDirectory()) continue; // isDirectory() does not follow symlinks for Dirent
      // Skip dotfolders (e.g. .agents holds repo-specific installed skills,
      // not source skills) and known noise dirs.
      if (e.name.startsWith(".")) continue;
      if (PRUNE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  walk(resolvedRoot, 0);
  found.sort((a, b) => {
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return byName !== 0 ? byName : a.dir.localeCompare(b.dir);
  });
  return found;
}

/** True if p exists as a symlink (does not follow it). */
function lstatIsSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True if p exists (following symlinks). */
function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * If linkPath is a symlink, return the absolute, resolved path it points to.
 * Otherwise null.
 */
function currentLinkTargetResolved(linkPath: string): string | null {
  if (!lstatIsSymlink(linkPath)) return null;
  let dest: string;
  try {
    dest = fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
  const abs = path.isAbsolute(dest)
    ? dest
    : path.resolve(path.dirname(linkPath), dest);
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}

/**
 * A line reader backed by a single async iterator over stdin. Using one
 * iterator (instead of repeated rl.question calls) avoids dropped lines when
 * stdin is piped/non-interactive: readline.question pauses the stream between
 * calls and buffered lines can be lost.
 */
class LineReader {
  private it: AsyncIterator<string>;
  constructor(private rl: readline.Interface) {
    this.it = rl[Symbol.asyncIterator]();
  }
  /** Print a prompt (no newline) and read the next line, trimmed. Returns
   * null on EOF. */
  async prompt(q: string): Promise<string | null> {
    process.stdout.write(q);
    const { value, done } = await this.it.next();
    if (done) {
      process.stdout.write("\n");
      return null;
    }
    return value.trim();
  }
}

/**
 * Ensure target is a real directory. If it's a symlink, offer to replace it
 * with a real directory. Returns true if usable, false to abort.
 */
async function ensureRealTarget(
  rl: LineReader,
  target: string,
): Promise<boolean> {
  if (lstatIsSymlink(target)) {
    const dest = fs.readlinkSync(target);
    console.log(`${YELLOW}Target ${target} is a symlink -> ${dest}${RESET}`);
    const ans = (
      await rl.prompt(
        "Replace this symlink with a real directory? " +
          "(the link is removed; the target it points to is untouched) [y/N] ",
      )
    )?.toLowerCase();
    if (ans !== "y") {
      console.log("Aborted.");
      return false;
    }
    fs.unlinkSync(target);
    fs.mkdirSync(target, { recursive: true });
    console.log(`${GREEN}Created real directory ${target}${RESET}`);
    return true;
  }

  if (exists(target)) {
    if (!fs.statSync(target).isDirectory()) {
      console.log(`${RED}Target ${target} exists and is not a directory.${RESET}`);
      return false;
    }
    return true;
  }

  // does not exist
  const ans = (
    await rl.prompt(`Target ${target} does not exist. Create it? [Y/n] `)
  )?.toLowerCase();
  if (ans === null || ans === undefined) {
    console.log("Aborted.");
    return false;
  }
  if (ans === "" || ans === "y") {
    fs.mkdirSync(target, { recursive: true });
    return true;
  }
  console.log("Aborted.");
  return false;
}

/**
 * Build display rows. Each row is a distinct (name, source dir) candidate.
 * Marks whether it is the currently-linked version and flags name collisions.
 */
function buildRows(skills: Skill[], target: string): Row[] {
  const byName = new Map<string, string[]>();
  for (const s of skills) {
    const arr = byName.get(s.name) ?? [];
    arr.push(s.dir);
    byName.set(s.name, arr);
  }

  const rows: Row[] = [];
  const names = [...byName.keys()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  for (const name of names) {
    const paths = (byName.get(name) ?? []).slice().sort();
    const collision = paths.length > 1;
    const linkPath = path.join(target, name);
    const linkedTo = currentLinkTargetResolved(linkPath);
    const nameOccupied = lstatIsSymlink(linkPath) || exists(linkPath);

    for (const p of paths) {
      const isLinked = linkedTo !== null && linkedTo === fs.realpathSync(p);
      rows.push({ name, path: p, collision, isLinked, linkPath, nameOccupied });
    }
  }
  return rows;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printRows(rows: Row[], target: string): void {
  console.log();
  console.log(`${BOLD}Skills  (target: ${target})${RESET}`);
  console.log(`${DIM}${pad("", 8)}${pad("name", 32)}source${RESET}`);
  rows.forEach((r, i) => {
    const idx = String(i + 1).padStart(3, " ");
    const mark = r.isLinked ? `${GREEN}[x]${RESET}` : "[ ]";
    let name = r.name;
    if (r.collision) name = `${name} ${YELLOW}*${RESET}`;
    let note = "";
    if (r.nameOccupied && !r.isLinked) note = `  ${DIM}(name in use)${RESET}`;
    // pad on the *plain* name length so colour codes don't break alignment
    const plainName = r.collision ? `${r.name} *` : r.name;
    const namePad = " ".repeat(Math.max(0, 32 - plainName.length));
    console.log(`${idx}  ${mark}  ${name}${namePad}${DIM}${r.path}${RESET}${note}`);
  });
  if (rows.some((r) => r.collision)) {
    console.log(
      `\n${YELLOW}*${RESET} name collision: multiple sources share this ` +
        `name; linking one replaces the other.`,
    );
  }
  console.log(`\n${DIM}Enter a number to toggle, or 'q' to quit.${RESET}`);
}

/** Toggle the link for the given row. */
function toggle(row: Row): void {
  const { linkPath, name } = row;

  if (row.isLinked) {
    fs.unlinkSync(linkPath);
    console.log(`${YELLOW}unlinked${RESET} ${name}`);
    return;
  }

  if (lstatIsSymlink(linkPath)) {
    // currently points elsewhere (collision / re-point) -> replace
    const old = currentLinkTargetResolved(linkPath);
    fs.unlinkSync(linkPath);
    console.log(`${DIM}removed existing link ${name} -> ${old}${RESET}`);
  } else if (exists(linkPath)) {
    console.log(
      `${RED}cannot link ${name}: a real file/dir already exists at ${linkPath}${RESET}`,
    );
    return;
  }

  fs.symlinkSync(path.resolve(row.path), linkPath);
  console.log(`${GREEN}linked${RESET}   ${name} -> ${row.path}`);
}

interface Args {
  source: string;
  depth: number;
  target: string;
}

function parseArgs(argv: string[]): Args {
  let source = ".";
  let depth = 5;
  let target = "~/.agents/skills";
  let sourceSet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--depth") {
      const v = argv[++i];
      if (v === undefined) fail("--depth requires a number");
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) fail(`invalid --depth: ${v}`);
      depth = n;
    } else if (a.startsWith("--depth=")) {
      const n = Number(a.slice("--depth=".length));
      if (!Number.isInteger(n) || n < 0) fail(`invalid --depth: ${a}`);
      depth = n;
    } else if (a === "--target") {
      const v = argv[++i];
      if (v === undefined) fail("--target requires a directory");
      target = v;
    } else if (a.startsWith("--target=")) {
      target = a.slice("--target=".length);
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      fail(`unknown option: ${a}`);
    } else {
      if (sourceSet) fail(`unexpected argument: ${a}`);
      source = a;
      sourceSet = true;
    }
  }

  return { source, depth, target };
}

function fail(msg: string): never {
  console.error(`${RED}error:${RESET} ${msg}`);
  console.error("run with --help for usage");
  process.exit(2);
}

function printHelp(): void {
  console.log(
    [
      "find-skills [SOURCE_ROOT] [--depth N] [--target DIR]",
      "",
      "  SOURCE_ROOT   directory to search (default: current directory)",
      "  --depth N     max search depth below SOURCE_ROOT (default: 5)",
      "  --target DIR  where links live (default: ~/.agents/skills)",
      "",
      "A skill is any directory directly containing a SKILL.md file.",
      "Interactively toggle which skills are symlinked into the target dir.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(expandUser(args.source));
  const target = expandUser(args.target);

  if (!exists(source) || !fs.statSync(source).isDirectory()) {
    console.error(`${RED}Source ${source} is not a directory.${RESET}`);
    process.exit(1);
  }

  console.log(`Searching ${CYAN}${source}${RESET} (max depth ${args.depth}) ...`);
  const skills = findSkills(source, args.depth);
  if (skills.length === 0) {
    console.log(
      `${YELLOW}No skills (directories containing SKILL.md) found.${RESET}`,
    );
    process.exit(0);
  }

  // terminal:false so we control prompting via process.stdout.write and read
  // lines from a single async iterator (uniform for TTY and piped stdin).
  const rlInterface = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  const rl = new LineReader(rlInterface);

  try {
    if (!(await ensureRealTarget(rl, target))) {
      process.exit(1);
    }

    for (;;) {
      const rows = buildRows(skills, target);
      printRows(rows, target);

      const line = await rl.prompt("> ");
      if (line === null) break; // EOF
      const choice = line.toLowerCase();

      if (choice === "q" || choice === "quit" || choice === "exit") break;
      if (choice === "") continue;
      if (!/^\d+$/.test(choice)) {
        console.log(`${RED}Enter a number or 'q'.${RESET}`);
        continue;
      }
      const idx = Number(choice);
      if (idx < 1 || idx > rows.length) {
        console.log(`${RED}Out of range.${RESET}`);
        continue;
      }
      toggle(rows[idx - 1]!);
    }
  } finally {
    rlInterface.close();
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
