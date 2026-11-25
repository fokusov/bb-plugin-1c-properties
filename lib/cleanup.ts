// Project cleanup scanner.
//
// The scanner never guesses by size alone: every candidate is a named
// top-level entry or a root file pattern. Protected project files and source
// folders are excluded explicitly, and risky groups are off by default in the
// UI. Deletion re-checks confinement and refuses anything outside the project.
//
// A safety floor applies to every candidate, whatever category selected it:
// items changed within the last hour are in use now and are never removed, a
// directory that holds a `.git` entry is never removed (worktrees are, and only
// when git reports them clean), and a worktree with uncommitted changes stays.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { CleanupCategory, CleanupItem, CleanupScan, CleanupSkipped } from "../contract.js";
import { canonical } from "./shared.js";

const MAX_FILES = 300_000;

/** Anything written this recently may still be in use by a running tool. */
const HOT_MS = 60 * 60_000;

const WORKTREES_CATEGORY = "worktrees";

const PROTECTED = new Set([
  ".git",
  ".bb",
  ".bsl-flow",
  "openspec",
  ".agents",
  ".codex",
  ".dsh",
  "src",
  "tests",
  "docs",
  "backlog",
  "runtime",
  ".1c-lite",
  "AGENTS.md",
  "AGENTS.md.bak.md",
  "USER-RULES.md",
  "bsl-flow.yaml",
  "v8project.yaml",
  "v8project.local.yaml",
  ".gitignore",
  "README.md",
  "package.json",
]);

const ROOT_DUMP_NAMES = new Set([
  "Configuration.xml",
  "ConfigDumpInfo.xml",
  "Catalogs",
  "Documents",
  "DocumentJournals",
  "DocumentNumerators",
  "Enums",
  "Reports",
  "DataProcessors",
  "ChartsOfAccounts",
  "ChartsOfCalculationType",
  "ChartsOfCharacteristicTypes",
  "InformationRegisters",
  "AccumulationRegisters",
  "AccountingRegisters",
  "CalculationRegisters",
  "BusinessProcesses",
  "Tasks",
  "CommonModules",
  "CommonForms",
  "CommonCommands",
  "CommonPictures",
  "CommonTemplates",
  "CommonAttributes",
  "Constants",
  "ExchangePlans",
  "FilterCriteria",
  "FunctionalOptions",
  "FunctionalOptionsParameters",
  "DefinedTypes",
  "EventSubscriptions",
  "ScheduledJobs",
  "SessionParameters",
  "SettingsStorages",
  "Roles",
  "Subsystems",
  "Styles",
  "StyleItems",
  "Languages",
  "Interfaces",
  "WebServices",
  "HTTPServices",
  "WSReferences",
  "XDTOPackages",
  "ExternalDataSources",
  "Sequences",
]);

interface SizeResult {
  bytes: number;
  files: number;
  truncated: boolean;
  /** Newest modification time in the tree, 0 when nothing readable was found. */
  lastModified: number;
}

function emptySize(): SizeResult {
  return { bytes: 0, files: 0, truncated: false, lastModified: 0 };
}

/** Directory size without following symlinks or junctions. */
function sizeOf(path: string): SizeResult {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return emptySize();
  }
  if (stat.isSymbolicLink()) return emptySize();
  if (stat.isFile()) {
    return { bytes: stat.size, files: 1, truncated: false, lastModified: stat.mtimeMs };
  }
  if (!stat.isDirectory()) return emptySize();

  let bytes = 0;
  let files = 0;
  let truncated = false;
  let lastModified = stat.mtimeMs;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES) {
        truncated = true;
        break;
      }
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      try {
        const childStat = lstatSync(child);
        if (childStat.isFile()) {
          bytes += childStat.size;
          files += 1;
          if (childStat.mtimeMs > lastModified) lastModified = childStat.mtimeMs;
        }
      } catch {
        // Unreadable files are ignored.
      }
    }
    if (truncated) break;
  }
  return { bytes, files, truncated, lastModified };
}

function item(path: string, kind: "dir" | "file", size: SizeResult): CleanupItem {
  return {
    path,
    kind,
    bytes: size.bytes,
    files: size.files,
    lastModified: Math.round(size.lastModified),
    hot: size.lastModified > 0 && Date.now() - size.lastModified < HOT_MS,
  };
}

function category(
  id: string,
  title: string,
  description: string,
  safe: boolean,
  warning: string,
  items: CleanupItem[],
): CleanupCategory {
  let bytes = 0;
  let files = 0;
  for (const entry of items) {
    bytes += entry.bytes;
    files += entry.files;
  }
  return { id, title, description, safe, warning, items, bytes, files };
}

function matchesTempRootFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name.startsWith("~$") ||
    name.endsWith(".log") ||
    name.endsWith(".tmp") ||
    name.startsWith("errors_migration_")
  );
}

function matchesRootBinary(name: string): boolean {
  return /\.(cfe|epf|erf|cf|dt|zip)$/i.test(name);
}

/** Scan the project and return grouped, sized cleanup candidates. */
export function scanCleanup(projectPath: string): CleanupScan {
  const root = canonical(projectPath);
  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    entries = [];
  }

  const sizes = new Map<string, SizeResult>();
  let projectBytes = 0;
  let projectFiles = 0;
  let projectTruncated = false;
  for (const entry of entries) {
    if (entry.name === ".git") {
      // Git internals are not a cleanup target; counting them only slows the
      // scan and makes the "project size" number look inflated.
      continue;
    }
    const size = sizeOf(join(root, entry.name));
    sizes.set(entry.name, size);
    projectBytes += size.bytes;
    projectFiles += size.files;
    projectTruncated = projectTruncated || size.truncated;
  }

  const dirItem = (name: string): CleanupItem | null => {
    if (PROTECTED.has(name)) return null;
    const size = sizes.get(name);
    if (size === undefined || size.bytes === 0) return null;
    return item(name, "dir", size);
  };
  const dirItems = (names: string[]): CleanupItem[] =>
    names.map(dirItem).filter((entry): entry is CleanupItem => entry !== null);

  const rootFiles = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
  const fileItems = (predicate: (name: string) => boolean): CleanupItem[] =>
    rootFiles.filter(predicate).flatMap((name) => {
      const size = sizes.get(name);
      if (size === undefined || size.bytes === 0) return [];
      return [item(name, "file", size)];
    });

  // Each worktree is its own candidate: one with uncommitted work must not take
  // the clean ones down with it, and `git worktree remove` works per worktree.
  const worktreeItems = (): CleanupItem[] => {
    let children;
    try {
      children = readdirSync(join(root, ".worktrees"), { withFileTypes: true });
    } catch {
      return [];
    }
    const items: CleanupItem[] = [];
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const size = sizeOf(join(root, ".worktrees", child.name));
      if (size.files === 0) continue;
      items.push(
        item(join(".worktrees", child.name), child.isDirectory() ? "dir" : "file", size),
      );
    }
    return items;
  };

  const categories: CleanupCategory[] = [
    category(
      "temp",
      "Временные файлы",
      "Каталог tmp, кэши Python и pytest, логи, временные и офисные lock-файлы в корне.",
      true,
      "",
      [...dirItems(["tmp", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache"]), ...fileItems(matchesTempRootFile)],
    ),
    category(
      "agent-scratch",
      "Рабочие каталоги агента",
      "Выгрузки для анализа и рабочие копии задач. Пересоздаются из базы и исходников.",
      true,
      "",
      dirItems(["_analysis", "_work"]),
    ),
    category(
      "build-cache",
      "Сборочные кэши",
      "Каталог .build: тестовые базы, кэши Unica и индексы rlm. Пересоздаются, но это время.",
      false,
      "После удаления Unica и rlm могут заново скачивать движки и строить индексы.",
      dirItems([".build", "build"]),
    ),
    category(
      "artifacts",
      "Собранные артефакты",
      "Каталоги artifacts и output: отчёты, проверки и готовые файлы.",
      false,
      "Это может быть результатом работы, а не мусором. Удаляй только осознанно.",
      dirItems(["artifacts", "output"]),
    ),
    category(
      "worktrees",
      "Рабочие деревья",
      ".worktrees с копиями для отдельных задач. Дерево без коммита не удаляется.",
      false,
      "Дерево с незакоммиченными изменениями пропускается: сначала закоммить или убери правки.",
      worktreeItems(),
    ),
    category(
      "extension-sources",
      "Исходники расширений в корне",
      "Каталоги ext_src и ext_kt с выгрузками расширений рядом с src.",
      false,
      "Это исходники. Удаляй, только если они есть в git, в src или в бэкапе.",
      dirItems(["ext_src", "ext_kt"]),
    ),
    category(
      "root-binaries",
      "Собранные файлы в корне",
      "Файлы .cfe, .epf, .erf, .cf, .dt и .zip в корне проекта.",
      false,
      "Это готовые сборки и архивы. Не удаляй единственную копию.",
      fileItems(matchesRootBinary),
    ),
  ];

  const srcRoot = join(root, "src");
  const srcLooksLikeSource =
    existsSync(join(srcRoot, "Configuration.xml")) ||
    existsSync(join(srcRoot, "Configuration", "Configuration.xml")) ||
    existsSync(join(srcRoot, "cf")) ||
    existsSync(join(srcRoot, "cfe"));
  const rootDumpDirs = [...ROOT_DUMP_NAMES]
    .filter((name) => name !== "Configuration.xml" && name !== "ConfigDumpInfo.xml")
    .map(dirItem)
    .filter((entry): entry is CleanupItem => entry !== null);
  if (srcLooksLikeSource && rootDumpDirs.length > 0) {
    const configFiles = fileItems((name) => name === "Configuration.xml" || name === "ConfigDumpInfo.xml");
    categories.push(
      category(
        "root-dump",
        "Выгрузка конфигурации в корне",
        "Configuration.xml и каталоги объектов в корне при наличии src.",
        false,
        "Похоже на вторую выгрузку рядом с src. Убедись, что src — актуальный источник.",
        [...rootDumpDirs, ...configFiles],
      ),
    );
  }

  const visible = categories.filter((entry) => entry.items.length > 0);
  return {
    projectBytes,
    projectFiles,
    totalBytes: visible.reduce((sum, entry) => sum + entry.bytes, 0),
    categories: visible,
    scannedAt: Date.now(),
    truncated: projectTruncated,
  };
}

function isInside(root: string, candidate: string): boolean {
  const target = resolve(root, candidate);
  return target === root || target.startsWith(root + sep);
}

function removeEntry(target: string): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

/** Uncommitted work in a git worktree, or the reason git could not tell. */
function worktreeState(target: string): { clean: boolean; reason: string } {
  const result = spawnSync("git", ["-C", target, "status", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error !== undefined || result.status === null) {
    return { clean: false, reason: "не удалось запустить git" };
  }
  if (result.status !== 0) {
    return { clean: false, reason: "git не смог прочитать рабочее дерево" };
  }
  if (result.stdout.trim() !== "") {
    return { clean: false, reason: "есть незакоммиченные изменения" };
  }
  return { clean: true, reason: "" };
}

/**
 * A worktree is removed through `git worktree remove` so the main checkout keeps
 * a consistent worktree list and the branch survives. Everything else is a
 * plain directory removal.
 */
/** The repository git dir a worktree belongs to, or "" when git cannot tell. */
function gitCommonDir(target: string): string {
  const result = spawnSync(
    "git",
    ["-C", target, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  if (result.error !== undefined || result.status !== 0) return "";
  return result.stdout.trim();
}

/**
 * A worktree is removed through `git worktree remove` so the main checkout keeps
 * a consistent worktree list and the branch survives. The command runs from
 * outside the worktree: Windows refuses to delete a directory a process has as
 * its working directory, which is exactly what `git -C <worktree>` would do.
 * Everything else is a plain directory removal.
 */
function removeWorktree(target: string): void {
  const commonDir = gitCommonDir(target);
  if (commonDir === "") throw new Error("не удалось определить общий каталог git");
  const result = spawnSync("git", ["--git-dir", commonDir, "worktree", "remove", target], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail === "" ? "git worktree remove завершился с ошибкой" : detail);
  }
}

/** The safety floor: reasons a candidate is never removed. */
function blockReason(
  root: string,
  categoryId: string,
  candidate: CleanupItem,
): { reason: string; viaGit: boolean } {
  if (candidate.hot) {
    return { reason: "изменён меньше часа назад — может ещё использоваться", viaGit: false };
  }
  if (candidate.kind !== "dir") return { reason: "", viaGit: false };
  const target = resolve(root, candidate.path);
  if (!existsSync(join(target, ".git"))) return { reason: "", viaGit: false };
  if (categoryId !== WORKTREES_CATEGORY) {
    return { reason: "внутри есть .git — удаляй как рабочее дерево git", viaGit: false };
  }
  const state = worktreeState(target);
  if (!state.clean) return { reason: state.reason, viaGit: false };
  return { reason: "", viaGit: true };
}

/** Delete the named categories after a fresh scan, reusing its item list. */
export function runCleanup(
  projectPath: string,
  categoryIds: string[],
): {
  ok: boolean;
  removedBytes: number;
  removed: string[];
  errors: string[];
  skipped: CleanupSkipped[];
} {
  const root = canonical(projectPath);
  const scan = scanCleanup(root);
  const selected = new Set(categoryIds);
  let removedBytes = 0;
  const removed: string[] = [];
  const errors: string[] = [];
  const skipped: CleanupSkipped[] = [];

  for (const entry of scan.categories) {
    if (!selected.has(entry.id)) continue;
    for (const candidate of entry.items) {
      const name = basename(candidate.path);
      if (PROTECTED.has(name)) {
        errors.push(`${candidate.path}: защищённый путь`);
        continue;
      }
      if (!isInside(root, candidate.path)) {
        errors.push(`${candidate.path}: вне папки проекта`);
        continue;
      }
      const block = blockReason(root, entry.id, candidate);
      if (block.reason !== "") {
        skipped.push({ path: candidate.path, reason: block.reason });
        continue;
      }
      const target = resolve(root, candidate.path);
      try {
        if (block.viaGit) removeWorktree(target);
        else removeEntry(target);
        removedBytes += candidate.bytes;
        removed.push(candidate.path);
      } catch (error) {
        errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { ok: errors.length === 0, removedBytes, removed, errors, skipped };
}
