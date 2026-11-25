import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  platformProfileSchema,
  type PlatformPreview,
  type PlatformProfile,
  type PlatformRequest,
} from "../platform-contract.js";
import { resolveBase, resolvePlatform } from "./designer.js";
import { writeJson } from "./platform-journal.js";

const profilesSchema = z.object({ profiles: z.array(platformProfileSchema).max(50) }).strict();
const mutations = new Set<PlatformRequest["action"]>([
  "load-xml", "load-binary", "build-configuration", "unpack-configuration",
  "create-file-base", "restore-dt", "update-db", "open-enterprise", "yaxunit", "vanessa",
]);
const fileOnly = new Set<PlatformRequest["action"]>([
  "build-configuration", "unpack-configuration", "create-file-base",
  "dump-dt", "restore-dt", "update-db", "yaxunit", "vanessa",
]);

export function readPlatformProfiles(path: string): PlatformProfile[] {
  const file = join(path, ".bb", "1c-platform-profiles.json");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let settings: unknown;
  try { settings = JSON.parse(text); }
  catch { throw new Error("Файл .bb/1c-platform-profiles.json содержит некорректный JSON."); }
  const { profiles } = profilesSchema.parse(settings);
  if (new Set(profiles.map(({ name }) => name)).size !== profiles.length) {
    throw new Error("Имена профилей 1С должны быть уникальны.");
  }
  return profiles;
}

export function savePlatformProfile(path: string, profile: PlatformProfile): PlatformProfile[] {
  const profiles = readPlatformProfiles(path).filter(({ name }) => name !== profile.name);
  profiles.push(profile);
  profilesSchema.parse({ profiles });
  const folder = join(path, ".bb");
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, "1c-platform-profiles.json"), { profiles });
  return profiles;
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}

// Resolve existing parent directories as well, including junctions and symlinks.
export function physicalPath(path: string): string {
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), relative(current, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === dirname(current)) throw error;
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Путь содержит ссылку на отсутствующий файл или каталог.");
      }
      current = dirname(current);
    }
  }
}

function workspacePath(root: string, value: string): string {
  const path = physicalPath(resolve(root, value));
  if (!isAbsolute(value) && !contains(root, path)) throw new Error("Относительный путь выходит за пределы рабочей копии.");
  return path;
}

function mustExist(path: string, directory: boolean): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (directory ? !stat?.isDirectory() : !stat?.isFile()) {
    throw new Error(`${directory ? "Каталог" : "Файл"} не найден: ${path}`);
  }
}

function stamp(path: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":") : "";
}

export function inspectTarget(baseArg: string): string {
  if (!baseArg.startsWith("/F")) return "Серверная ИБ. Состояние проверь в Конфигураторе.";
  const file = join(baseArg.slice(2), "1Cv8.1CD");
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat?.isFile()
    ? `1Cv8.1CD: ${stat.size} Б, изменён ${stat.mtime.toISOString()}`
    : "Файл 1Cv8.1CD отсутствует.";
}

type Stage = { mode: "DESIGNER" | "ENTERPRISE" | "CREATEINFOBASE"; args: string[]; verdict: "platform" | "launch" | "junit" };

export function planPlatformOperation(input: {
  path: string;
  profile: PlatformProfile | { name: "project"; kind: "project"; infobase: string; platform?: string; user?: string };
  fallback: string;
  request: PlatformRequest;
  recovery: string | null;
}) {
  const { action, extension, format, profile } = input.request;
  const workspace = physicalPath(resolve(input.path));
  mustExist(workspace, true);
  const requestedPlatform = input.profile.platform || input.fallback;
  const platform = resolvePlatform(requestedPlatform ? resolve(workspace, requestedPlatform) : "");
  if ("error" in platform) throw new Error(platform.error);
  platform.exe = physicalPath(platform.exe);
  platform.cwd = dirname(platform.exe);
  if (!/^1cv8(?:c)?\.exe$/i.test(basename(platform.exe))) {
    throw new Error("Укажи полный клиент 1cv8.exe или тонкий клиент 1cv8c.exe для Предприятия.");
  }
  if (basename(platform.exe).toLowerCase() === "1cv8c.exe" &&
      !["open-enterprise", "yaxunit", "vanessa"].includes(action)) {
    throw new Error("Для этой операции требуется полный клиент 1cv8.exe.");
  }
  const raw = resolveBase(input.profile.infobase);
  if ("error" in raw) throw new Error("Укажи FILE-каталог или строку соединения Srvr/Ref.");
  const fileBase = raw.arg.startsWith("/F");
  if (!fileBase && fileOnly.has(action)) throw new Error("Для этой операции требуется FILE-база.");
  if (fileOnly.has(action) && ["yaxunit", "vanessa", "restore-dt"].includes(action) && input.profile.kind !== "test") {
    throw new Error("Для этой операции выбери именованный test-профиль.");
  }
  const target = fileBase ? workspacePath(workspace, raw.arg.slice(2)) : raw.arg.slice(2);
  if (/[\r\n"\0]/.test(target)) throw new Error("Недопустимые символы в адресе базы.");
  const baseArg = (fileBase ? "/F" : "/S") + target;
  const baseFile = fileBase ? join(target, "1Cv8.1CD") : null;
  if (action === "create-file-base") {
    if (existsSync(target)) throw new Error(`Для создания базы нужен новый каталог: ${target}`);
    mustExist(dirname(target), true);
  } else if (baseFile) mustExist(baseFile, false);

  const source = input.request.input ? workspacePath(workspace, input.request.input) : null;
  const output = input.request.output ? workspacePath(workspace, input.request.output) : null;
  const config = input.request.config ? workspacePath(workspace, input.request.config) : null;
  const stages: Stage[] = [];
  const designer = (...args: string[]) => stages.push({ mode: "DESIGNER", args, verdict: "platform" });
  const tag = extension ? ["-Extension", extension] : [];
  const xmlFormat = ["-Format", format];
  const usesExtension = ["dump-xml", "load-xml", "dump-binary", "load-binary", "build-configuration", "unpack-configuration", "update-db", "check-syntax"].includes(action);
  if (extension && !usesExtension) throw new Error("Эта операция не использует имя расширения.");
  const usesConfig = action === "yaxunit" || action === "vanessa";
  if (config && !usesConfig) throw new Error("Эта операция не использует файл настроек запуска.");
  if (config) mustExist(config, false);
  if (action === "vanessa" && !config) throw new Error("Укажи файл VAParams.json.");

  let inputUsed = false;
  let outputUsed = false;
  const read = (...suffixes: string[]) => {
    inputUsed = true;
    if (!source) throw new Error("Укажи вход операции.");
    mustExist(source, suffixes.length === 0);
    if (suffixes.length === 0) mustExist(join(source, "Configuration.xml"), false);
    else if (!suffixes.includes(extname(source).toLowerCase())) throw new Error(`Ожидается вход ${suffixes.join(" или ")}.`);
    return source;
  };
  const write = (...suffixes: string[]) => {
    outputUsed = true;
    if (!output) throw new Error("Укажи выход операции.");
    if (existsSync(output)) throw new Error(`Путь выхода уже существует: ${output}`);
    if (fileBase && contains(target, output)) throw new Error("Выход должен находиться за пределами каталога FILE-базы.");
    if (suffixes.length && !suffixes.includes(extname(output).toLowerCase())) {
      throw new Error(`Ожидается выход ${suffixes.join(" или ")}.`);
    }
    return output;
  };
  const loadXml = () => designer("/LoadConfigFromFiles", read(), ...tag, ...xmlFormat);
  const dumpXml = () => designer("/DumpConfigToFiles", write(), ...tag, ...xmlFormat);
  const loadBinary = () => designer("/LoadCfg", read(extension ? ".cfe" : ".cf"), ...tag);
  const dumpBinary = () => designer("/DumpCfg", write(extension ? ".cfe" : ".cf"), ...tag);
  switch (action) {
    case "dump-xml": dumpXml(); break;
    case "load-xml": loadXml(); break;
    case "dump-binary": dumpBinary(); break;
    case "load-binary": loadBinary(); break;
    case "build-configuration": loadXml(); dumpBinary(); break;
    case "unpack-configuration": loadBinary(); dumpXml(); break;
    case "build-external": designer("/LoadExternalDataProcessorOrReportFromFiles", read(".xml"), write(".epf", ".erf")); break;
    case "unpack-external": designer("/DumpExternalDataProcessorOrReportToFiles", write(".xml"), read(".epf", ".erf"), ...xmlFormat); break;
    case "create-file-base": stages.push({ mode: "CREATEINFOBASE", args: [`File="${target}";`], verdict: "platform" }); break;
    case "open-enterprise": stages.push({ mode: "ENTERPRISE", args: [], verdict: "launch" }); break;
    case "open-designer": stages.push({ mode: "DESIGNER", args: [], verdict: "launch" }); break;
    case "dump-dt": designer("/DumpIB", write(".dt")); break;
    case "restore-dt": designer("/RestoreIB", read(".dt")); break;
    case "update-db": designer("/UpdateDBCfg", ...tag); break;
    case "check-syntax": designer("/CheckModules", "-ThinClient", "-Server", "-ExternalConnection", ...tag); break;
    case "yaxunit": stages.push({ mode: "ENTERPRISE", args: [], verdict: "junit" }); break;
    case "vanessa": stages.push({ mode: "ENTERPRISE", args: ["/TestManager", "/Execute", read(".epf")], verdict: "junit" }); break;
  }
  if ((source && !inputUsed) || (output && !outputUsed)) throw new Error("У операции нет указанного входа или выхода.");
  if (source && output && contains(source, output)) throw new Error("Выход операции не должен попадать во входной каталог.");
  if (action === "unpack-external" && output && existsSync(output.slice(0, -4))) {
    throw new Error("Рядом с выходным XML уже существует каталог объектов обработки или отчёта.");
  }
  const preview: PlatformPreview = {
    action, profile, kind: input.profile.kind, workspace, target, platform: platform.exe, input: source, output,
    extension: extension ?? null, config, format, confirmation: null, recovery: input.recovery, targetState: inspectTarget(baseArg),
  };
  if (mutations.has(action)) {
    preview.confirmation = createHash("sha256").update(JSON.stringify([
      preview, input.profile, stamp(platform.exe), baseFile && stamp(baseFile), source && stamp(source), config && stamp(config),
    ])).digest("hex");
  }
  return { preview, platform, baseArg, stages, mutation: mutations.has(action), baseFile };
}

export type PlatformPlan = ReturnType<typeof planPlatformOperation>;
