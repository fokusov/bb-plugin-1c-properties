// Batch operations of the 1C Designer and the COM connection string.
//
// The argument list is a pure function: the platform silently ignores an
// unknown key, so a typo produces a "successful" run that did nothing.
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isConnectionString } from "./shared.js";
import type { ProjectParams } from "../contract.js";

export interface ResolvedPlatform {
  exe: string;
  cwd: string;
}

export interface ResolvedBase {
  arg: string;
}

function failure(message: string): { error: string } {
  return { error: message };
}

/** Platform path → the executable and its working directory. Accepts a file or a folder. */
export function resolvePlatform(raw: string): ResolvedPlatform | { error: string } {
  const value = String(raw || "").trim();
  if (value === "") {
    return failure("не задан путь к платформе 1С — заполни его в проекте или в общих настройках");
  }
  let stat;
  try {
    stat = statSync(value);
  } catch {
    return failure(`путь к платформе не найден: ${value}`);
  }
  if (stat.isFile()) return { exe: value, cwd: dirname(value) };
  if (!stat.isDirectory()) return failure(`путь к платформе не файл и не каталог: ${value}`);

  // 1cv8.exe is the full client and works in a user session; the server agent
  // and the thin client keep their batch commands but behave differently.
  for (const dir of [value, join(value, "bin")]) {
    for (const name of ["1cv8.exe", "1cv8s.exe", "1cv8c.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { exe: candidate, cwd: dir };
    }
  }
  return failure(`в каталоге нет 1cv8.exe: ${value}`);
}

/** Infobase path or connection string → `/F` or `/S` argument. */
export function resolveBase(raw: string): ResolvedBase | { error: string } {
  const value = String(raw || "").trim();
  if (value === "") return failure("не задан путь к базе 1С");
  if (!isConnectionString(value)) return { arg: `/F${value}` };

  const pick = (key: string): string => {
    const match = value.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"?([^";]+)"?`, "i"));
    return match ? match[1].trim() : "";
  };
  const file = pick("File");
  if (file !== "") return { arg: `/F${file}` };
  const server = pick("Srvr");
  const ref = pick("Ref");
  if (server !== "" && ref !== "") return { arg: `/S${server}\\${ref}` };
  return failure(`в строке соединения нет File либо Srvr/Ref: ${value}`);
}

export interface DesignerArgsOptions {
  operation: "dump" | "load" | "extensions";
  baseArg: string;
  params: ProjectParams;
  format: "Hierarchical" | "Plain";
  sourceDir: string;
  targetDir: string;
  update: boolean;
  updateDb: boolean;
  dynamic: boolean;
  logFile: string;
  resultFile: string;
}

/** Arguments for `1cv8.exe DESIGNER ...`. No shell quoting: spawn passes them positionally. */
export function buildDesignerArgs(options: DesignerArgsOptions): { args: string[]; notes: string[] } {
  const {
    operation,
    baseArg,
    params,
    format,
    sourceDir,
    targetDir,
    update,
    updateDb,
    dynamic,
    logFile,
    resultFile,
  } = options;

  const args = [
    "DESIGNER",
    baseArg,
    ...(params.user !== "" ? [`/N${params.user}`] : []),
    ...(params.password !== "" ? [`/P${params.password}`] : []),
    ...(params.unlockCode !== "" ? [`/UC${params.unlockCode}`] : []),
  ];
  const notes: string[] = [];

  if (operation === "dump") {
    args.push(
      "/DumpConfigToFiles",
      targetDir,
      "-Format",
      format,
      ...(update ? ["-update", "-force"] : []),
    );
    if (update) notes.push("выгружаются только изменившиеся объекты (-update -force)");
  } else if (operation === "extensions") {
    // A separate folder is mandatory: -AllExtensions in the shared folder
    // would mix extension objects into the main configuration.
    args.push("/DumpConfigToFiles", targetDir, "-Format", "Hierarchical", "-AllExtensions");
    notes.push(`выгружаются все расширения базы в ${targetDir}`);
  } else {
    args.push("/LoadConfigFromFiles", sourceDir, "-Format", format);
    notes.push(`источник: ${sourceDir}`);
    if (updateDb) {
      args.push("/UpdateDBCfg");
      if (dynamic) {
        args.push("-Dynamic+", "-SessionTerminate", "force");
        notes.push("конфигурация базы обновляется динамически (-Dynamic+, сеансы не прерываются)");
      } else {
        notes.push("обновление базы без динамики — нужны монопольный доступ и выход всех пользователей");
      }
    } else {
      notes.push("конфигурация базы не обновляется — изменения останутся только в конфигурации");
    }
  }

  args.push(
    `/Out${logFile}`,
    `/DumpResult${resultFile}`,
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
  );
  return { args, notes };
}

/** External connection string from the same data the Designer receives. */
export function buildComConnectionString(
  base: ResolvedBase | { error: string },
  params: ProjectParams,
): { value: string } | { error: string } {
  if ("error" in base) return { error: base.error };
  const parts: string[] = [];
  if (base.arg.startsWith("/F")) {
    parts.push(`File="${base.arg.slice(2)}";`);
  } else if (base.arg.startsWith("/S")) {
    const raw = base.arg.slice(2);
    const slash = raw.indexOf("\\");
    const server = slash >= 0 ? raw.slice(0, slash) : raw;
    const ref = slash >= 0 ? raw.slice(slash + 1) : "";
    if (server === "" || ref === "") {
      return { error: `в строке соединения нет сервера или имени базы: ${raw}` };
    }
    parts.push(`Srvr="${server}";`);
    parts.push(`Ref="${ref}";`);
  } else {
    return { error: `непонятный путь к базе: ${base.arg}` };
  }
  if (params.user !== "") parts.push(`Usr="${params.user}";`);
  if (params.password !== "") parts.push(`Pwd="${params.password}";`);
  return { value: parts.join("") };
}

/** PowerShell of the same bitness as the platform: the COM class lives under it. */
export function pickPowerShell(platformExe: string): { exe: string; bitness: number } {
  const exe = platformExe.toLowerCase();
  if (exe.includes("program files (x86)")) {
    const wow = join(
      process.env.SystemRoot || "C:\\Windows",
      "SysWOW64",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(wow)) return { exe: wow, bitness: 32 };
  }
  return { exe: "powershell.exe", bitness: 64 };
}

export function designerSpawnArguments(exe: string, args: string[]) {
  // CREATEINFOBASE parses File="…" from the Windows command line, not from the standard argv decoder.
  if (process.platform !== "win32" || args[0] !== "CREATEINFOBASE") return { args, options: {} };
  return {
    args: args.map((arg, index) => index !== 1 && /\s/.test(arg) ? `"${arg}"` : arg),
    options: { windowsVerbatimArguments: true, argv0: `"${exe}"` },
  };
}

/** Platform words instead of an HRESULT: the user needs a reason, not a code. */
export function comErrorText(message: string): string {
  const text = String(message || "").trim();
  if (/80040154|class not registered|класс не зарегистрирован/i.test(text)) {
    const connector = text.match(/^V8[35]\.COMConnector/i)?.[0];
    return (
      `компонент внешнего соединения 1С${connector ? ` (${connector})` : ""} не зарегистрирован — платформа установлена без него ` +
      "или его разрядность не совпадает с разрядностью платформы"
    );
  }
  if (/800401F3|invalid class string|invalid syntax/i.test(text) && !text.includes("Пользователь")) {
    return `компонент внешнего соединения 1С недоступен: ${text}`;
  }
  return text;
}
