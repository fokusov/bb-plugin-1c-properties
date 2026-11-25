// Pure helpers shared by the host entry and the server entry. They never touch
// the filesystem; the host owns paths and processes.
import { isAbsolute, join, resolve } from "node:path";
import type { ProjectParams } from "../contract.js";

export const PARAM_KEYS = [
  "infobasePath",
  "user",
  "password",
  "platformPath",
  "unlockCode",
  "dumpDir",
] as const;

/** File written into the project. `.dsh/1c-project.json` is read as a fallback. */
export const PARAMS_DIR = ".bb";
export const PARAMS_FILE = "1c-project.json";
export const PARAMS_REL = `${PARAMS_DIR}/${PARAMS_FILE}`;
export const LEGACY_PARAMS_REL = ".dsh/1c-project.json";
export const SCHEMA_ID = "bb-1c-project-properties/v1";

export const EMPTY_PARAMS: ProjectParams = {
  infobasePath: "",
  user: "",
  password: "",
  platformPath: "",
  unlockCode: "",
  dumpDir: "",
};

/** Absolute path without a trailing separator, so equal folders compare equal. */
export function canonical(value: string): string {
  const absolute = resolve(String(value));
  const stripped = absolute.replace(/[\\/]+$/, "");
  return stripped || absolute;
}

export function pathKey(value: string): string {
  const normalized = canonical(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Pick only string values from an untrusted patch and keep absent keys out. */
export function pickParams(raw: unknown): Partial<ProjectParams> {
  if (raw === null || typeof raw !== "object") return {};
  const patch: Partial<ProjectParams> = {};
  for (const key of PARAM_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string") patch[key] = value;
  }
  return patch;
}

/** Merge a form patch over a file, preserving foreign keys and key order. */
export function mergeParams(
  current: Record<string, unknown> | null,
  patch: Partial<ProjectParams>,
): Record<string, unknown> {
  const source = current ?? {};
  const next: Record<string, unknown> = { $schema: SCHEMA_ID };
  for (const key of PARAM_KEYS) {
    if (typeof patch[key] === "string") next[key] = patch[key];
    else if (key in source) next[key] = source[key];
    else next[key] = "";
  }
  for (const [key, value] of Object.entries(source)) {
    if (!(key in next)) next[key] = value;
  }
  return next;
}

/** Dump directory: empty means the project root, relative paths stay inside it. */
export function resolveDumpDir(projectPath: string, raw: string): string {
  const value = String(raw || "").trim();
  if (value === "") return canonical(projectPath);
  return canonical(isAbsolute(value) ? value : join(projectPath, value));
}

/** True when the value is a connection string rather than a folder path. */
export function isConnectionString(value: string): boolean {
  return /(^|;)\s*(Srvr|Ref|File|IBName)\s*=/i.test(value);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (Number(left[index]) || 0) - (Number(right[index]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const OPERATION_LABELS = {
  dump: "выгрузка конфигурации",
  load: "загрузка конфигурации из файлов",
  extensions: "выгрузка расширений",
} as const;
