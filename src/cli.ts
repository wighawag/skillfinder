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
import * as readlineCb from "node:readline";

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

// Matches ANSI SGR / control sequences so we can measure & cut visible text.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Visible (printable) length of a string, ignoring ANSI escape codes. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Truncate a string to at most `width` *visible* columns, preserving ANSI
 * codes and appending an ellipsis when cut. Returns the string unchanged if it
 * already fits. A trailing RESET is appended so styling never leaks.
 */
function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLen(s) <= width) return s;
  const keep = Math.max(0, width - 1); // room for the ellipsis
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < keep) {
    if (s[i] === "\x1b") {
      // copy the whole escape sequence without counting it
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    visible++;
    i++;
  }
  return `${out}\u2026${RESET}`;
}

/** Number of physical terminal lines a string occupies at the given width. */
function physicalLines(s: string, cols: number): number {
  const len = visibleLen(s);
  if (cols <= 0) return 1;
  return Math.max(1, Math.ceil(len / cols));
}

/** Render a single row line. `cursor` highlights it (TUI). `showIndex`
 * prefixes the 1-based number (fallback mode). */
function formatRow(r: Row, i: number, cursor: boolean, showIndex: boolean): string {
  const mark = r.isLinked ? `${GREEN}[x]${RESET}` : "[ ]";
  let name = r.name;
  if (r.collision) name = `${name} ${YELLOW}*${RESET}`;
  let note = "";
  if (r.nameOccupied && !r.isLinked) note = `  ${DIM}(name in use)${RESET}`;
  // pad on the *plain* name length so colour codes don't break alignment
  const plainName = r.collision ? `${r.name} *` : r.name;
  const namePad = " ".repeat(Math.max(0, 32 - plainName.length));
  const prefix = showIndex
    ? `${String(i + 1).padStart(3, " ")}  `
    : cursor
      ? `${CYAN}\u276f${RESET} `
      : "  ";
  const body = `${mark}  ${name}${namePad}${DIM}${r.path}${RESET}${note}`;
  return cursor && !showIndex ? `${prefix}${BOLD}${body}${RESET}` : `${prefix}${body}`;
}

function collisionHint(rows: Row[]): string | null {
  if (!rows.some((r) => r.collision)) return null;
  return (
    `${YELLOW}*${RESET} name collision: multiple sources share this ` +
    `name; linking one replaces the other.`
  );
}

/** Non-interactive (piped stdin) rendering: numbered list. */
function printRows(rows: Row[], target: string): void {
  console.log();
  console.log(`${BOLD}Skills  (target: ${target})${RESET}`);
  console.log(`${DIM}${pad("", 8)}${pad("name", 32)}source${RESET}`);
  rows.forEach((r, i) => console.log(formatRow(r, i, false, true)));
  const hint = collisionHint(rows);
  if (hint) console.log(`\n${hint}`);
  console.log(`\n${DIM}Enter a number to toggle, or 'q' to quit.${RESET}`);
}

type ToggleStatus = "linked" | "unlinked" | "repointed" | "blocked";

interface ToggleResult {
  status: ToggleStatus;
  /** human-readable line describing what happened */
  message: string;
}

/**
 * Toggle the link for the given row. Performs the filesystem change and
 * returns a status + message (does not print). Callers decide how to surface
 * the message (inline in fallback mode, status line in the TUI).
 */
function applyToggle(row: Row): ToggleResult {
  const { linkPath, name } = row;

  if (row.isLinked) {
    fs.unlinkSync(linkPath);
    return { status: "unlinked", message: `${YELLOW}unlinked${RESET} ${name}` };
  }

  let repointed = false;
  if (lstatIsSymlink(linkPath)) {
    // currently points elsewhere (collision / re-point) -> replace
    fs.unlinkSync(linkPath);
    repointed = true;
  } else if (exists(linkPath)) {
    return {
      status: "blocked",
      message: `${RED}cannot link ${name}: a real file/dir already exists at ${linkPath}${RESET}`,
    };
  }

  fs.symlinkSync(path.resolve(row.path), linkPath);
  return {
    status: repointed ? "repointed" : "linked",
    message: `${GREEN}linked${RESET}   ${name} -> ${row.path}`,
  };
}

type WrapMode = "truncate" | "wrap";

interface Args {
  source: string;
  depth: number;
  target: string;
  wrap: WrapMode;
}

function parseArgs(argv: string[]): Args {
  let source = ".";
  let depth = 5;
  let target = "~/.agents/skills";
  let wrap: WrapMode = "truncate"; // default: option 1
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
    } else if (a === "--wrap") {
      wrap = "wrap";
    } else if (a === "--truncate") {
      wrap = "truncate";
    } else if (a.startsWith("--wrap=")) {
      const v = a.slice("--wrap=".length);
      if (v !== "truncate" && v !== "wrap")
        fail(`invalid --wrap: ${v} (use truncate|wrap)`);
      wrap = v;
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

  return { source, depth, target, wrap };
}

function fail(msg: string): never {
  console.error(`${RED}error:${RESET} ${msg}`);
  console.error("run with --help for usage");
  process.exit(2);
}

function printHelp(): void {
  console.log(
    [
      "find-skills [SOURCE_ROOT] [--depth N] [--target DIR] [--truncate|--wrap]",
      "",
      "  SOURCE_ROOT   directory to search (default: current directory)",
      "  --depth N     max search depth below SOURCE_ROOT (default: 5)",
      "  --target DIR  where links live (default: ~/.agents/skills)",
      "  --truncate    cut long lines to terminal width (default)",
      "  --wrap        let long lines wrap; viewport accounts for wrapping",
      "",
      "A skill is any directory directly containing a SKILL.md file.",
      "Interactively toggle which skills are symlinked into the target dir.",
    ].join("\n"),
  );
}

/**
 * Non-interactive fallback loop: read numbers from stdin to toggle. Used when
 * stdin is not a TTY (piped input, scripts, tests).
 */
async function runFallback(
  rl: LineReader,
  skills: Skill[],
  target: string,
): Promise<void> {
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
    console.log(applyToggle(rows[idx - 1]!).message);
  }
}

// ANSI screen-control helpers for the interactive TUI.
const ESC = "\x1b[";
const CLEAR_SCREEN = `${ESC}2J${ESC}H`; // clear + home
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

/**
 * Interactive full-screen TUI: arrow keys (or j/k) to move, space to toggle
 * the highlighted skill, enter/q/Esc to finish, Ctrl-C to abort.
 */
async function runInteractive(
  skills: Skill[],
  target: string,
  wrap: WrapMode,
): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  readlineCb.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(HIDE_CURSOR);

  let cursor = 0;
  let statusLine = "";
  // top visible skill-row index, adjusted to keep the cursor in view
  let top = 0;

  const render = (): void => {
    const rows = buildRows(skills, target);
    if (cursor >= rows.length) cursor = rows.length - 1;
    if (cursor < 0) cursor = 0;

    const hint = collisionHint(rows);
    const termRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
    const cols = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;

    // Chrome lines around the scrolling list:
    //   header + help + column-header (3)
    //   + optional collision hint block (2: blank + hint)
    //   + scroll indicators (2: above + below, always reserved)
    //   + blank + status (2)
    const header = `${BOLD}Skills  (target: ${target})${RESET}`;
    const help = `${DIM}\u2191/\u2193 move \u00b7 space toggle \u00b7 enter/q quit${RESET}`;
    const colHeader = `${DIM}  ${pad("", 4)}${pad("name", 32)}source${RESET}`;
    const hintLine = hint ?? "";

    // In wrap mode the chrome lines can themselves wrap; account for that.
    const chromeLines =
      wrap === "wrap"
        ? physicalLines(header, cols) +
          physicalLines(help, cols) +
          physicalLines(colHeader, cols) +
          (hint ? 1 + physicalLines(hintLine, cols) : 0) +
          2 /* up + down indicators */ +
          2 /* blank + status */
        : 3 + (hint ? 2 : 0) + 2 + 2;
    const budget = Math.max(1, termRows - chromeLines);

    // Determine which rows are visible, keeping the cursor on-screen.
    let end: number;
    if (wrap === "truncate") {
      // 1 row == 1 physical line, so the budget is a simple row count.
      const viewport = budget;
      if (cursor < top) top = cursor;
      else if (cursor >= top + viewport) top = cursor - viewport + 1;
      const maxTop = Math.max(0, rows.length - viewport);
      if (top > maxTop) top = maxTop;
      end = Math.min(rows.length, top + viewport);
    } else {
      // wrap mode: pack rows by physical-line cost; keep cursor visible.
      if (cursor < top) top = cursor;
      // grow window downward from `top` until cursor fits within budget
      const cost = (idx: number): number =>
        physicalLines(formatRow(rows[idx]!, idx, idx === cursor, false), cols);
      // If cursor is below the current window, scroll top down until the
      // cursor's row fits in the budget counting upward from the cursor.
      if (cursor >= top) {
        let used = 0;
        let t = cursor;
        // include rows from cursor upward while they fit
        while (t >= 0 && used + cost(t) <= budget) {
          used += cost(t);
          t--;
        }
        const minTop = t + 1; // smallest top that still shows the cursor
        if (top < minTop) top = minTop;
      }
      // compute end by filling the budget downward from top
      let used = 0;
      let e = top;
      while (e < rows.length && used + cost(e) <= budget) {
        used += cost(e);
        e++;
      }
      end = Math.max(top + 1, e); // always show at least the top row
    }

    const fit = (s: string): string =>
      wrap === "truncate" ? truncateToWidth(s, cols) : s;

    const lines: string[] = [];
    lines.push(fit(header));
    lines.push(fit(help));
    lines.push(fit(colHeader));
    // up indicator (reserve the line even when none, to keep layout stable)
    lines.push(top > 0 ? `${DIM}  \u2191 ${top} more${RESET}` : "");
    for (let i = top; i < end; i++) {
      lines.push(fit(formatRow(rows[i]!, i, i === cursor, false)));
    }
    const below = rows.length - end;
    lines.push(below > 0 ? `${DIM}  \u2193 ${below} more${RESET}` : "");
    if (hint) lines.push("", fit(hintLine));
    lines.push("", fit(statusLine || " "));
    stdout.write(CLEAR_SCREEN + lines.join("\n") + "\n");
  };

  const onResize = (): void => render();

  const cleanup = (): void => {
    stdout.write(SHOW_CURSOR);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener("keypress", onKey);
    stdout.removeListener("resize", onResize);
  };

  let resolveDone: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  function onKey(_str: string, key: readlineCb.Key): void {
    if (!key) return;
    const rows = buildRows(skills, target);

    if (key.ctrl && key.name === "c") {
      cleanup();
      console.log("Aborted.");
      process.exit(130);
    }

    switch (key.name) {
      case "up":
      case "k":
        cursor = (cursor - 1 + rows.length) % rows.length;
        statusLine = "";
        render();
        break;
      case "down":
      case "j":
        cursor = (cursor + 1) % rows.length;
        statusLine = "";
        render();
        break;
      case "space": {
        const res = applyToggle(rows[cursor]!);
        statusLine = res.message;
        render();
        break;
      }
      case "return":
      case "enter":
      case "q":
      case "escape":
        cleanup();
        resolveDone();
        break;
      default:
        break;
    }
  }

  stdin.on("keypress", onKey);
  stdout.on("resize", onResize);
  render();
  await done;
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

  // Use a line reader (terminal:false) for the y/N setup prompts; this works
  // uniformly for TTY and piped stdin.
  const rlInterface = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  const rl = new LineReader(rlInterface);
  let usedFallback = false;
  try {
    if (!(await ensureRealTarget(rl, target))) {
      process.exit(1);
    }
    // Decide UI mode: interactive TUI when stdin AND stdout are TTYs.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      rlInterface.close(); // hand stdin to the keypress loop
    } else {
      usedFallback = true;
      await runFallback(rl, skills, target);
      rlInterface.close();
    }
  } catch (e) {
    rlInterface.close();
    throw e;
  }

  if (!usedFallback) {
    await runInteractive(skills, target, args.wrap);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
