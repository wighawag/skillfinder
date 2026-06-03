#!/usr/bin/env node
/**
 * skillfinder: discover AI skills under a source root and interactively
 * toggle which ones are symlinked into a target directory (default
 * ~/.agents/skills).
 *
 * A "skill" is any directory that directly contains a SKILL.md file.
 * Skills are keyed by their directory name. A skill is considered "linked"
 * when <target>/<name> is a symlink pointing at that skill directory.
 *
 * Usage:
 *   skillfinder [SOURCE_ROOT] [--depth N] [--target DIR]
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
  /** short description from the SKILL.md YAML frontmatter (if any) */
  description?: string;
}

interface Row {
  name: string;
  /** absolute path to the candidate skill source dir */
  path: string;
  /** path shown in the UI, relative to the source root when possible */
  displayPath: string;
  /** same name appears under multiple sources */
  collision: boolean;
  /** this candidate is the one currently linked */
  isLinked: boolean;
  /** absolute path of the link location target/<name> */
  linkPath: string;
  /** the link location is occupied by some symlink/file (maybe another source) */
  nameOccupied: boolean;
  /** short description from the SKILL.md YAML frontmatter (if any) */
  description?: string;
}

/** Expand a leading ~ to the user's home directory. */
function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Path to display for a skill: relative to the source root when the skill
 * lives under it (prefixed with ./), otherwise the absolute path. The skill
 * dir that *is* the root renders as ".".
 */
function displayPathFor(skillDir: string, sourceRoot: string): string {
  const rel = path.relative(sourceRoot, skillDir);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return skillDir; // outside root
  return `./${rel}`;
}

// ---- Persistent config (~/.config/skillfinder/config.json) ----------------

interface Config {
  /** absolute paths of folders the user disabled (children hidden) */
  disabledFolders: string[];
}

function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(base, "skillfinder", "config.json");
}

function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    const disabled = Array.isArray(parsed.disabledFolders)
      ? parsed.disabledFolders.filter((x): x is string => typeof x === "string")
      : [];
    return { disabledFolders: disabled };
  } catch {
    return { disabledFolders: [] };
  }
}

function saveConfig(cfg: Config): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // keep the file stable & readable: sorted, unique
  const disabledFolders = [...new Set(cfg.disabledFolders)].sort();
  fs.writeFileSync(p, JSON.stringify({ disabledFolders }, null, 2) + "\n");
}

// ---- Folder tree --------------------------------------------------------

interface FolderNode {
  kind: "folder";
  /** segment label, e.g. "engineering" (the root node uses the source root) */
  label: string;
  /** absolute path of this folder */
  abs: string;
  /** depth from the (invisible) root; top-level folders are depth 0 */
  depth: number;
  folders: FolderNode[];
  skills: SkillLeaf[];
}

interface SkillLeaf {
  kind: "skill";
  name: string;
  /** absolute path to the skill dir */
  abs: string;
  depth: number;
  /** short description from the SKILL.md YAML frontmatter (if any) */
  description?: string;
}

/**
 * Build a folder tree from the flat skill list. Each skill is placed under the
 * chain of folders between the source root and the skill's parent directory.
 * Skills whose parent IS the source root are attached to a synthetic root node
 * (rendered without a header). Returns the list of top-level folder nodes and
 * the root-level skills.
 */
function buildTree(
  skills: Skill[],
  sourceRoot: string,
): { topFolders: FolderNode[]; rootSkills: SkillLeaf[] } {
  const topFolders: FolderNode[] = [];
  const rootSkills: SkillLeaf[] = [];
  // index folders by absolute path for quick lookup
  const byAbs = new Map<string, FolderNode>();

  const getFolder = (abs: string, label: string, depth: number): FolderNode => {
    let n = byAbs.get(abs);
    if (!n) {
      n = { kind: "folder", label, abs, depth, folders: [], skills: [] };
      byAbs.set(abs, n);
    }
    return n;
  };

  for (const s of skills) {
    const parent = path.dirname(s.dir);
    const rel = path.relative(sourceRoot, parent);
    // segments between root and the skill's parent
    const segments =
      rel === "" || rel.startsWith("..") || path.isAbsolute(rel)
        ? []
        : rel.split(path.sep).filter((x) => x !== "");

    if (segments.length === 0) {
      rootSkills.push({
        kind: "skill",
        name: s.name,
        abs: s.dir,
        depth: 0,
        description: s.description,
      });
      continue;
    }

    // walk/create the folder chain
    let parentList = topFolders;
    let curAbs = sourceRoot;
    let node: FolderNode | null = null;
    for (let d = 0; d < segments.length; d++) {
      curAbs = path.join(curAbs, segments[d]!);
      const existing = byAbs.get(curAbs);
      const folder = getFolder(curAbs, segments[d]!, d);
      if (!existing) parentList.push(folder);
      parentList = folder.folders;
      node = folder;
    }
    node!.skills.push({
      kind: "skill",
      name: s.name,
      abs: s.dir,
      depth: segments.length,
      description: s.description,
    });
  }

  // sort folders & skills alphabetically at every level
  const sortNode = (n: FolderNode): void => {
    n.folders.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    n.skills.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    n.folders.forEach(sortNode);
  };
  topFolders.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  topFolders.forEach(sortNode);
  rootSkills.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  topFolders.forEach(compactNode);

  return { topFolders, rootSkills };
}

/**
 * Collapse chains of single-child folders into one node. A folder with no
 * skills of its own and exactly one subfolder is merged with that subfolder:
 * the labels are joined with "/", and the merged node adopts the child's
 * absolute path (the deepest folder, used as the disable key) and contents.
 * Applied recursively so e.g. HKUDS/nanobot/nanobot/skills becomes a single
 * header. Mutates the node in place.
 */
function compactNode(node: FolderNode): void {
  while (node.skills.length === 0 && node.folders.length === 1) {
    const child = node.folders[0]!;
    node.label = `${node.label}/${child.label}`;
    node.abs = child.abs; // disable key = deepest folder in the chain
    node.skills = child.skills;
    node.folders = child.folders;
  }
  node.folders.forEach(compactNode);
}

/** Collect the absolute dirs of all skills in a folder subtree. */
function skillsInSubtree(node: FolderNode): string[] {
  const out: string[] = [];
  const walk = (n: FolderNode): void => {
    for (const s of n.skills) out.push(s.abs);
    for (const f of n.folders) walk(f);
  };
  walk(node);
  return out;
}

/**
 * Extract the `description:` field from a SKILL.md YAML frontmatter block.
 * Supports plain, single-, and double-quoted scalars plus simple folded
 * (`>`) / literal (`|`) blocks. Returns undefined when absent or unreadable.
 */
function readSkillDescription(skillDir: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  // Frontmatter must start at the very top: --- ... ---
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return undefined;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const km = /^description:\s*(.*)$/.exec(line);
    if (!km) continue;
    let val = km[1]!.trim();
    // Block scalar (folded `>` or literal `|`): gather indented lines.
    if (val === ">" || val === "|" || /^[>|][+-]?$/.test(val)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() !== "" && !/^\s/.test(l)) break; // dedent ends the block
        parts.push(l.trim());
      }
      return parts.join(" ").trim() || undefined;
    }
    // Strip matching surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val.trim() || undefined;
  }
  return undefined;
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
      found.push({
        name: path.basename(dir),
        dir,
        description: readSkillDescription(dir),
      });
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
  constructor(rl: readline.Interface) {
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

/** A folder header line in the display. */
interface FolderItem {
  kind: "folder";
  label: string;
  abs: string;
  depth: number;
  disabled: boolean;
}

/** A skill row in the display (carries a Row payload). */
interface SkillItem {
  kind: "skill";
  depth: number;
  row: Row;
}

type DisplayItem = FolderItem | SkillItem;

/** Make a Row (link state) for a skill leaf, detecting collisions globally. */
function makeRow(
  abs: string,
  name: string,
  target: string,
  sourceRoot: string,
  collisionNames: Set<string>,
  description?: string,
): Row {
  const linkPath = path.join(target, name);
  const linkedTo = currentLinkTargetResolved(linkPath);
  const nameOccupied = lstatIsSymlink(linkPath) || exists(linkPath);
  const isLinked = linkedTo !== null && linkedTo === fs.realpathSync(abs);
  return {
    name,
    path: abs,
    displayPath: displayPathFor(abs, sourceRoot),
    collision: collisionNames.has(name),
    isLinked,
    linkPath,
    nameOccupied,
    description,
  };
}

/**
 * Build the ordered list of display items (folder headers + skill rows) from
 * the folder tree. Disabled folders are shown as collapsed headers; their
 * subtree (subfolders + skills) is hidden.
 */
function buildItems(
  skills: Skill[],
  target: string,
  sourceRoot: string,
  disabled: Set<string>,
): DisplayItem[] {
  // collision = same skill name appears at 2+ source dirs
  const nameCounts = new Map<string, number>();
  for (const s of skills) nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
  const collisionNames = new Set(
    [...nameCounts].filter(([, c]) => c > 1).map(([n]) => n),
  );

  const { topFolders, rootSkills } = buildTree(skills, sourceRoot);
  const items: DisplayItem[] = [];

  // root-level skills first (no header)
  for (const s of rootSkills) {
    items.push({
      kind: "skill",
      depth: 0,
      row: makeRow(s.abs, s.name, target, sourceRoot, collisionNames, s.description),
    });
  }

  // renderDepth is the display indent level; it is independent of the node's
  // original tree depth so compacted (merged) chains indent correctly.
  const emitFolder = (node: FolderNode, renderDepth: number): void => {
    const isDisabled = disabled.has(node.abs);
    items.push({
      kind: "folder",
      label: node.label,
      abs: node.abs,
      depth: renderDepth,
      disabled: isDisabled,
    });
    if (isDisabled) return; // hide subtree
    for (const f of node.folders) emitFolder(f, renderDepth + 1);
    for (const s of node.skills) {
      items.push({
        kind: "skill",
        depth: renderDepth + 1,
        row: makeRow(s.abs, s.name, target, sourceRoot, collisionNames, s.description),
      });
    }
  };
  for (const f of topFolders) emitFolder(f, 0);

  return items;
}

/** Just the skill rows from a display-item list (for collision hint etc.). */
function skillRows(items: DisplayItem[]): Row[] {
  return items.filter((i): i is SkillItem => i.kind === "skill").map((i) => i.row);
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

const INDENT = "  "; // per tree depth level

/** Render a skill row. `cursor` highlights it (TUI). `index` (1-based) is
 * shown in fallback mode when >= 1. */
function formatRow(r: Row, depth: number, cursor: boolean, index: number): string {
  const mark = r.isLinked ? `${GREEN}[x]${RESET}` : "[ ]";
  let name = r.name;
  if (r.collision) name = `${name} ${YELLOW}*${RESET}`;
  let note = "";
  if (r.nameOccupied && !r.isLinked) note = `  ${DIM}(name in use)${RESET}`;
  const indent = INDENT.repeat(depth);
  // pad on the *plain* name length so colour codes don't break alignment
  const plainName = r.collision ? `${r.name} *` : r.name;
  const nameCol = 30 - indent.length;
  const namePad = " ".repeat(Math.max(1, nameCol - plainName.length));
  const prefix =
    index >= 1
      ? `${String(index).padStart(3, " ")}  `
      : cursor
        ? `${CYAN}\u276f${RESET} `
        : "  ";
  const body = `${indent}${mark}  ${name}${namePad}${DIM}${r.displayPath}${RESET}${note}`;
  return cursor && index < 1 ? `${prefix}${BOLD}${body}${RESET}` : `${prefix}${body}`;
}

/** Render a folder header. */
function formatFolder(f: FolderItem, cursor: boolean, index: number): string {
  const indent = INDENT.repeat(f.depth);
  const mark = f.disabled ? `${RED}[X]${RESET}` : `${CYAN}\u25be${RESET}`;
  const label = f.disabled
    ? `${DIM}${f.label}/  (hidden)${RESET}`
    : `${BOLD}${f.label}/${RESET}`;
  const prefix =
    index >= 1
      ? `${String(index).padStart(3, " ")}  `
      : cursor
        ? `${CYAN}\u276f${RESET} `
        : "  ";
  const body = `${indent}${mark} ${label}`;
  return cursor && index < 1 ? `${prefix}${BOLD}${body}${RESET}` : `${prefix}${body}`;
}

/** Render any display item. */
function formatItem(it: DisplayItem, cursor: boolean, index: number): string {
  return it.kind === "folder"
    ? formatFolder(it, cursor, index)
    : formatRow(it.row, it.depth, cursor, index);
}

function collisionHint(items: DisplayItem[]): string | null {
  if (!skillRows(items).some((r) => r.collision)) return null;
  return (
    `${YELLOW}*${RESET} name collision: multiple sources share this ` +
    `name; linking one replaces the other.`
  );
}

/** Non-interactive (piped stdin) rendering: numbered list. */
function printItems(items: DisplayItem[], target: string): void {
  console.log();
  console.log(`${BOLD}Skills  (target: ${target})${RESET}`);
  items.forEach((it, i) => console.log(formatItem(it, false, i + 1)));
  const hint = collisionHint(items);
  if (hint) console.log(`\n${hint}`);
  console.log(
    `\n${DIM}Enter a number to toggle a skill or disable a folder, or 'q' to quit.${RESET}`,
  );
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

/**
 * Toggle a folder's disabled state. Disabling hides the subtree and unlinks
 * every currently-linked skill within it. Persists the config. Returns a
 * status message. `skills` is the full skill list (to locate subtree links).
 */
function toggleFolder(
  folderAbs: string,
  label: string,
  cfg: Config,
  disabled: Set<string>,
  skills: Skill[],
  target: string,
): ToggleResult {
  if (disabled.has(folderAbs)) {
    disabled.delete(folderAbs);
    cfg.disabledFolders = [...disabled];
    saveConfig(cfg);
    return { status: "unlinked", message: `${GREEN}enabled${RESET}  ${label}/` };
  }

  // Disable: unlink any linked skill whose dir is inside this folder.
  const prefix = folderAbs + path.sep;
  let unlinked = 0;
  for (const s of skills) {
    if (!(s.dir === folderAbs || s.dir.startsWith(prefix))) continue;
    const linkPath = path.join(target, s.name);
    const linkedTo = currentLinkTargetResolved(linkPath);
    if (linkedTo !== null && linkedTo === fs.realpathSync(s.dir)) {
      fs.unlinkSync(linkPath);
      unlinked++;
    }
  }
  disabled.add(folderAbs);
  cfg.disabledFolders = [...disabled];
  saveConfig(cfg);
  const suffix = unlinked > 0 ? ` (${unlinked} unlinked)` : "";
  return {
    status: "unlinked",
    message: `${RED}disabled${RESET} ${label}/${suffix}`,
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
      "skillfinder [SOURCE_ROOT] [--depth N] [--target DIR] [--truncate|--wrap]",
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
  sourceRoot: string,
  cfg: Config,
  disabled: Set<string>,
): Promise<void> {
  for (;;) {
    const items = buildItems(skills, target, sourceRoot, disabled);
    printItems(items, target);

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
    if (idx < 1 || idx > items.length) {
      console.log(`${RED}Out of range.${RESET}`);
      continue;
    }
    const it = items[idx - 1]!;
    if (it.kind === "folder") {
      console.log(
        toggleFolder(it.abs, it.label, cfg, disabled, skills, target).message,
      );
    } else {
      console.log(applyToggle(it.row).message);
    }
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
  sourceRoot: string,
  cfg: Config,
  disabled: Set<string>,
): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  readlineCb.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(HIDE_CURSOR);

  let cursor = 0;
  let statusLine = "";
  // top visible item index, adjusted to keep the cursor in view
  let top = 0;

  const render = (): void => {
    const items = buildItems(skills, target, sourceRoot, disabled);
    if (cursor >= items.length) cursor = items.length - 1;
    if (cursor < 0) cursor = 0;

    const hint = collisionHint(items);
    const termRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
    const cols = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;

    // Chrome lines around the scrolling list:
    //   header + help (2)
    //   + optional collision hint block (2: blank + hint)
    //   + scroll indicators (2: above + below, always reserved)
    //   + blank + description panel (2)
    //   + blank + status (2)
    const header = `${BOLD}Skills  (target: ${target})${RESET}`;
    const help = `${DIM}\u2191/\u2193 move \u00b7 space toggle skill / disable folder \u00b7 enter/q quit${RESET}`;
    const hintLine = hint ?? "";

    // Description of the highlighted skill, shown in a panel at the bottom.
    const current = items[cursor];
    const desc =
      current && current.kind === "skill" ? current.row.description : undefined;
    const descLine = desc
      ? `${DIM}\u2500 ${RESET}${desc}`
      : "";

    // The description panel is always exempt from truncation: it wraps onto as
    // many physical lines as it needs in either mode, so account for its real
    // height regardless of `wrap`.
    const descPanelLines = 1 /* blank */ + (desc ? physicalLines(descLine, cols) : 1);

    // In wrap mode the chrome lines can themselves wrap; account for that.
    const chromeLines =
      wrap === "wrap"
        ? physicalLines(header, cols) +
          physicalLines(help, cols) +
          (hint ? 1 + physicalLines(hintLine, cols) : 0) +
          2 /* up + down indicators */ +
          descPanelLines +
          2 /* blank + status */
        : 2 + (hint ? 2 : 0) + 2 + descPanelLines + 2;
    const budget = Math.max(1, termRows - chromeLines);

    // Determine which items are visible, keeping the cursor on-screen.
    let end: number;
    if (wrap === "truncate") {
      // 1 item == 1 physical line, so the budget is a simple count.
      const viewport = budget;
      if (cursor < top) top = cursor;
      else if (cursor >= top + viewport) top = cursor - viewport + 1;
      const maxTop = Math.max(0, items.length - viewport);
      if (top > maxTop) top = maxTop;
      end = Math.min(items.length, top + viewport);
    } else {
      // wrap mode: pack items by physical-line cost; keep cursor visible.
      if (cursor < top) top = cursor;
      const cost = (idx: number): number =>
        physicalLines(formatItem(items[idx]!, idx === cursor, 0), cols);
      if (cursor >= top) {
        let used = 0;
        let t = cursor;
        while (t >= 0 && used + cost(t) <= budget) {
          used += cost(t);
          t--;
        }
        const minTop = t + 1;
        if (top < minTop) top = minTop;
      }
      let used = 0;
      let e = top;
      while (e < items.length && used + cost(e) <= budget) {
        used += cost(e);
        e++;
      }
      end = Math.max(top + 1, e);
    }

    const fit = (s: string): string =>
      wrap === "truncate" ? truncateToWidth(s, cols) : s;

    const lines: string[] = [];
    lines.push(fit(header));
    lines.push(fit(help));
    // up indicator (reserve the line even when none, to keep layout stable)
    lines.push(top > 0 ? `${DIM}  \u2191 ${top} more${RESET}` : "");
    for (let i = top; i < end; i++) {
      lines.push(fit(formatItem(items[i]!, i === cursor, 0)));
    }
    const below = items.length - end;
    lines.push(below > 0 ? `${DIM}  \u2193 ${below} more${RESET}` : "");
    if (hint) lines.push("", fit(hintLine));
    // Description panel for the highlighted skill. Always exempt from
    // truncation so the full text wraps onto multiple lines; a blank line is
    // reserved so the layout stays stable when moving onto a folder / a skill
    // without a description.
    lines.push("", descLine);
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
    const items = buildItems(skills, target, sourceRoot, disabled);

    if (key.ctrl && key.name === "c") {
      cleanup();
      console.log("Aborted.");
      process.exit(130);
    }

    const count = items.length || 1;
    switch (key.name) {
      case "up":
      case "k":
        cursor = (cursor - 1 + count) % count;
        statusLine = "";
        render();
        break;
      case "down":
      case "j":
        cursor = (cursor + 1) % count;
        statusLine = "";
        render();
        break;
      case "space": {
        const it = items[cursor];
        if (it) {
          const res =
            it.kind === "folder"
              ? toggleFolder(it.abs, it.label, cfg, disabled, skills, target)
              : applyToggle(it.row);
          statusLine = res.message;
        }
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

  // Load persisted config (disabled folders) and build the working set.
  const cfg = loadConfig();
  const disabled = new Set(cfg.disabledFolders);

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
      await runFallback(rl, skills, target, source, cfg, disabled);
      rlInterface.close();
    }
  } catch (e) {
    rlInterface.close();
    throw e;
  }

  if (!usedFallback) {
    await runInteractive(skills, target, args.wrap, source, cfg, disabled);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
