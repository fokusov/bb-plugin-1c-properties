// BSL Flow bootstrap and skill wiring for one project.
//
// The plugin does not ship its own rules: it runs the installed BSL Flow
// bootstrap script and copies the skill sets the user already has on the
// machine into <project>/.bb/skills, where bb discovers project skills.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { isMap, parseDocument } from "yaml";
import type { BslFlowState, SkillsState } from "../contract.js";
import { canonical } from "./shared.js";
import { readWorkflowEnabled } from "./bslflow-config.js";
import { WORKFLOW_DISABLED } from "./bslflow-fields.js";

const SKILLS_MANIFEST = join(".bb", "1c-skills.json");
const SKILLS_DIR = join(".bb", "skills");
const MANIFEST_SCHEMA = "bb-1c-skills/v1";

interface SkillsManifest {
  $schema?: string;
  updatedAt?: number;
  bslflowRoot?: string;
  // Leave legacy fields and skill ownership entries available for migration and rollback.
  [key: string]: unknown;
  skills?: Record<string, "bslflow" | "unica">;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  try {
    rmSync(file, { force: true });
  } catch {
    // Missing file is fine.
  }
  renameSync(temporary, file);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Installed BSL Flow skills live next to the 1c-init-project skill. */
export function resolveBslFlowRoot(explicit: string): string {
  const value = explicit.trim();
  return value === "" ? join(homedir(), ".agents", "skills") : canonical(value);
}

export function bslFlowInitScript(root: string): string {
  return join(root, "1c-init-project", "scripts", "Initialize-BSLFlowProject.ps1");
}

/** Directories with SKILL.md are skills; anything else is ignored. */
export function listSkillDirs(root: string): string[] {
  if (!isDirectory(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function versionFrom(text: string): string {
  const match = text.match(/(?:^|\n)\s*(?:framework_)?version\s*:\s*([^\s#]+)/i);
  return match ? match[1].trim().replaceAll('"', "").replaceAll("'", "") : "";
}

export function readOpenSpecSchema(projectPath: string): string {
  const openspec = join(projectPath, "openspec", "config.yaml");
  try {
    const doc = parseDocument(readFileSync(openspec, "utf-8"));
    if (doc.errors.length || !isMap(doc.contents)) return "некорректная конфигурация";
    const schema = doc.get("schema");
    return typeof schema === "string" && schema.trim() ? schema.trim() : "схема не указана";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "" : "конфигурация недоступна";
  }
}

/** What BSL Flow left in the project: the files the bootstrap validates. */
export function detectBslFlow(projectPath: string, openspecSchema = readOpenSpecSchema(projectPath)): BslFlowState {
  const sentinel = join(projectPath, ".bsl-flow", "project.yaml");
  let version = "";
  try {
    version = versionFrom(readFileSync(sentinel, "utf-8"));
  } catch {
    version = "";
  }
  const hasAgents = existsSync(join(projectPath, "AGENTS.md"));
  const hasOpenspec = openspecSchema === "bsl-flow";
  const hasSentinel = existsSync(sentinel);
  let enabled: boolean | null = null;
  try { enabled = readWorkflowEnabled(projectPath); }
  catch { /* The editor reports errors without blocking 1C project settings. */ }
  return {
    initialized: hasAgents && hasOpenspec && hasSentinel && hasOpenSpecFlag(projectPath),
    enabled,
    version,
    hasAgents,
    hasOpenspec,
    hasSentinel,
  };
}

function hasOpenSpecFlag(projectPath: string): boolean {
  return existsSync(join(projectPath, "bsl-flow.yaml"));
}

function readManifest(projectPath: string): SkillsManifest {
  return readJson<SkillsManifest>(join(projectPath, SKILLS_MANIFEST)) ?? {};
}

/** Count skills belonging to BSL Flow only. */
export function readSkillsState(projectPath: string): SkillsState {
  const manifest = readManifest(projectPath);
  const bslflow = Object.entries(manifest.skills ?? {}).filter(([name, source]) =>
    source === "bslflow" && existsSync(join(projectPath, SKILLS_DIR, name, "SKILL.md")),
  ).length;
  return {
    total: bslflow,
    bslflow,
    sourceBslflow: manifest.bslflowRoot ?? "",
    updatedAt: typeof manifest.updatedAt === "number" ? manifest.updatedAt : null,
  };
}

export interface ConnectSkillsResult {
  ok: boolean;
  copied: string[];
  preserved: string[];
  skipped: string[];
  removed: string[];
  sourceBslflow: string;
  error: string;
}

/**
 * Copy skill sets into <project>/.bb/skills. Directories the user created in
 * that folder are preserved; only names listed in our manifest are replaced
 * when `overwrite` is true.
 */
export function connectSkills(
  projectPath: string,
  options: { bslflowRoot: string; overwrite: boolean },
): ConnectSkillsResult {
  const root = canonical(projectPath);
  const flowDisabled = readWorkflowEnabled(root) === false;
  const bslflowRoot = flowDisabled ? "" : resolveBslFlowRoot(options.bslflowRoot);
  const result: ConnectSkillsResult = {
    ok: true,
    copied: [],
    preserved: [],
    skipped: [],
    removed: [],
    sourceBslflow: bslflowRoot,
    error: "",
  };

  const previous = readManifest(root);
  const previousSkills = previous.skills ?? {};
  const next: Record<string, "bslflow" | "unica"> = {};
  for (const [name, source] of Object.entries(previousSkills)) {
    if (source !== "bslflow" || flowDisabled) next[name] = source;
  }
  const destinationRoot = join(root, SKILLS_DIR);
  mkdirSync(destinationRoot, { recursive: true });

  let installedFromSource = false;
  const install = (sourceRoot: string) => {
    const source = "bslflow";
    if (sourceRoot === "") {
      result.skipped.push(`${source}: источник не найден`);
      return;
    }
    const names = listSkillDirs(sourceRoot).filter((name) => name.startsWith("1c-"));
    if (names.length === 0) {
      result.skipped.push(`${source}: в источнике нет skills (${sourceRoot})`);
      return;
    }
    installedFromSource = true;
    for (const name of names) {
      if (name in next) {
        result.skipped.push(`${name}: уже подключён из ${next[name]}`);
        continue;
      }
      const from = join(sourceRoot, name);
      const to = join(destinationRoot, name);
      const exists = existsSync(to);
      const managed = name in previousSkills;
      if (exists && (!managed || !options.overwrite)) {
        result.preserved.push(name);
        if (managed) next[name] = previousSkills[name];
        continue;
      }
      try {
        if (exists) rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, force: true });
        result.copied.push(name);
        next[name] = source;
      } catch (error) {
        result.error = `${name}: ${error instanceof Error ? error.message : String(error)}`;
        result.ok = false;
      }
    }
  };

  // The BSL Flow skills share ~/.agents/skills with unrelated agent skills;
  // only the 1c-* set belongs to the framework.
  if (flowDisabled) result.skipped.push(WORKFLOW_DISABLED);
  else install(bslflowRoot);
  // Drop managed skills that disappeared from the source sets. User-owned
  // directories are never listed in the manifest and therefore never removed.
  for (const name of Object.keys(previousSkills)) {
    if (name in next) continue;
    if (!installedFromSource || previousSkills[name] !== "bslflow") continue;
    const to = join(destinationRoot, name);
    if (existsSync(to)) {
      try {
        rmSync(to, { recursive: true, force: true });
        result.removed.push(name);
      } catch (error) {
        result.error = `${name}: ${error instanceof Error ? error.message : String(error)}`;
        result.ok = false;
      }
    }
  }

  writeJson(join(root, SKILLS_MANIFEST), {
    ...previous,
    $schema: MANIFEST_SCHEMA,
    updatedAt: Date.now(),
    bslflowRoot: flowDisabled ? previous.bslflowRoot : bslflowRoot,
    skills: next,
  } satisfies SkillsManifest);

  return result;
}

/** Run the installed 1c-init-project bootstrap against one confirmed project. */
export function initProject(projectPath: string, bslflowRoot: string): {
  ok: boolean;
  created: string[];
  preserved: string[];
  output: string;
  error: string;
} {
  if (readWorkflowEnabled(projectPath) === false) {
    return { ok: false, created: [], preserved: [], output: "", error: WORKFLOW_DISABLED };
  }
  const script = bslFlowInitScript(resolveBslFlowRoot(bslflowRoot));
  if (!existsSync(script)) {
    return {
      ok: false,
      created: [],
      preserved: [],
      output: "",
      error: `не найден скрипт BSL Flow: ${script}. Установи BSL Flow skills в ~/.agents/skills.`,
    };
  }

  const pwsh = spawnSync("where", ["pwsh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const shell = pwsh.status === 0 ? "pwsh" : "powershell";
  const child = spawnSync(
    shell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProjectPath", canonical(projectPath)],
    {
      cwd: canonical(projectPath),
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`.trim();
  const created: string[] = [];
  const preserved: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const plus = line.match(/^\s*\+\s+(.+)$/);
    if (plus) created.push(plus[1].trim());
    const equals = line.match(/^\s*=\s+(.+)$/);
    if (equals) preserved.push(equals[1].trim());
  }
  const ok = child.status === 0;
  return {
    ok,
    created,
    preserved,
    output: output.slice(-4000),
    error: ok ? "" : output.split(/\r?\n/).find((line) => line.trim() !== "") || "BSL Flow bootstrap завершился с ошибкой",
  };
}

/** Read the project title used in reports. */
export function projectTitle(projectPath: string): string {
  return basename(canonical(projectPath));
}
