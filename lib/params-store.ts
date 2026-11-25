// Project parameter file: <project>/.bb/1c-project.json.
//
// The `.dsh/1c-project.json` of the DSH plugin is read as a fallback so an
// existing project keeps its connection data. Saving always writes the `.bb`
// file and leaves the legacy file untouched.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProjectParams, ProjectState } from "../contract.js";
import { LEGACY_PARAMS_REL, PARAM_KEYS, PARAMS_FILE, PARAMS_DIR, EMPTY_PARAMS, SCHEMA_ID, canonical, mergeParams } from "./shared.js";

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic write: a crash never leaves a truncated JSON file behind. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporary, file);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function paramsFile(projectPath: string): string {
  return join(projectPath, PARAMS_DIR, PARAMS_FILE);
}

export function legacyParamsFile(projectPath: string): string {
  return join(projectPath, LEGACY_PARAMS_REL);
}

interface ParamsReadResult {
  file: string;
  hasFile: boolean;
  legacy: boolean;
  params: ProjectParams;
}

/** Read the project file; fall back to the DSH file for an existing project. */
export function readParams(projectPath: string): ParamsReadResult {
  const file = paramsFile(projectPath);
  const legacyFile = legacyParamsFile(projectPath);
  const own = readJson(file);
  const legacy = own === null ? readJson(legacyFile) : null;
  const raw = own ?? legacy;
  const params: ProjectParams = { ...EMPTY_PARAMS };
  for (const key of PARAM_KEYS) {
    if (typeof raw?.[key] === "string") params[key] = raw[key] as string;
  }
  return {
    file,
    hasFile: raw !== null,
    legacy: own === null && legacy !== null,
    params,
  };
}

/** Save form fields only; foreign keys and their value types survive. */
export function saveParams(projectPath: string, patch: Partial<ProjectParams>): ParamsReadResult {
  const file = paramsFile(projectPath);
  const raw = readJson(file) ?? readJson(legacyParamsFile(projectPath));
  writeJson(file, mergeParams(raw, patch));
  return readParams(projectPath);
}

/** Delete own and legacy files; no params then apply to the project. */
export function clearParams(projectPath: string): ParamsReadResult {
  for (const file of [paramsFile(projectPath), legacyParamsFile(projectPath)]) {
    try {
      unlinkSync(file);
    } catch {
      // Missing file is the desired state.
    }
  }
  return readParams(projectPath);
}

/** Explicit per-project RLM tools preference, independent of Unica status. */
export function readRlmOptIn(projectPath: string): boolean {
  const raw = readJson(paramsFile(projectPath)) ?? readJson(legacyParamsFile(projectPath));
  return raw?.rlmOptIn === true;
}

export function saveRlmOptIn(projectPath: string, enabled: boolean): boolean {
  const raw = readJson(paramsFile(projectPath)) ?? readJson(legacyParamsFile(projectPath)) ?? {};
  writeJson(paramsFile(projectPath), { ...raw, $schema: SCHEMA_ID, rlmOptIn: enabled });
  return enabled;
}

const DETECT_BUDGET = 4000;
const DETECT_DEPTH = 4;

function hasBslSources(dir: string, depth: number, budget: { left: number }): boolean {
  if (depth > DETECT_DEPTH || budget.left <= 0) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    budget.left -= 1;
    if (budget.left <= 0) return false;
    if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith(".bsl")) return true;
      continue;
    }
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      if (hasBslSources(join(dir, entry.name), depth + 1, budget)) return true;
    }
  }
  return false;
}

export interface ProjectMarkers {
  exists: boolean;
  is1c: boolean;
  hasDump: boolean;
  markers: string[];
}

/** Cheap "is this a 1C project" check for the project list. */
export function detectProject(projectPath: string): ProjectMarkers {
  const markers: string[] = [];
  const exists = isDirectory(projectPath);
  if (exists) {
    if (existsSync(join(projectPath, "Configuration.xml"))) markers.push("выгрузка конфигурации в файлы");
    if (existsSync(join(projectPath, "ConfigDumpInfo.xml"))) markers.push("файл версий выгрузки");
    if (existsSync(join(projectPath, "src", "Configuration", "Configuration.xml"))) {
      markers.push("исходники проекта 1С:EDT");
    }
    if (existsSync(join(projectPath, "DT-INF"))) markers.push("служебные файлы 1С");
    if (hasBslSources(projectPath, 0, { left: DETECT_BUDGET })) markers.push("исходные тексты модулей");
  }
  const hasFile = readParams(projectPath).hasFile;
  return {
    exists,
    is1c: markers.length > 0 || hasFile,
    hasDump: existsSync(join(projectPath, "Configuration.xml")),
    markers,
  };
}

/** Human-facing project title used by job rows. */
export function projectTitle(projectPath: string): string {
  return basename(canonical(projectPath));
}

/** True when the folder looks like a 1C dump (used by the Load guard). */
export function hasConfigurationXml(dir: string): boolean {
  return existsSync(join(dir, "Configuration.xml"));
}

/** Remove stale `.cfl` locks of a file infobase. */
export function cleanLockFiles(dir: string): string[] {
  const removed: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith(".cfl")) {
        try {
          unlinkSync(join(dir, name));
          removed.push(name);
        } catch {
          // Locked by another process: report only what was removed.
        }
      }
    }
  } catch {
    // Missing folder is reported by the base check.
  }
  return removed;
}

export type { ProjectState };
