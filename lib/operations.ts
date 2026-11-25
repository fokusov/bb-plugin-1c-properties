// Designer batch jobs and the COM connection check.
//
// One Designer operation runs at a time: 1C locks the base configuration, so a
// parallel run would fail on the lock anyway. The job survives after the host
// call returns: the host worker holds a lease until the child exits.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect as netConnect } from "node:net";
import type {
  CheckConnectionResult,
  CheckStep,
  JobSnapshot,
  ProjectParams,
  StartOperationInput,
} from "../contract.js";
import {
  buildComConnectionString,
  buildDesignerArgs,
  comErrorText,
  pickPowerShell,
  resolveBase,
  resolvePlatform,
} from "./designer.js";
import { OPERATION_LABELS, canonical, resolveDumpDir } from "./shared.js";
import { PlatformOperations } from "./platform-operations.js";
import { redactLog } from "./platform-journal.js";
import { physicalPath } from "./platform-plan.js";
import {
  cleanLockFiles,
  hasConfigurationXml,
  projectTitle,
} from "./params-store.js";

const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const JOB_TAIL_CHARS = 4000;
const COM_TIMEOUT_MS = 45 * 1000;

type Operation = StartOperationInput["operation"];

interface WorkerLease {
  dispose(): void;
}

interface InternalJob extends JobSnapshot {
  child: ReturnType<typeof spawn> | null;
  logFile: string;
  resultFile: string;
  targetDir: string;
  sourceDir: string;
  countedAt: number;
  lease: WorkerLease | null;
  timer: NodeJS.Timeout | null;
}

const IDLE_JOB: JobSnapshot = {
  state: "idle",
  operation: null,
  label: "",
  path: "",
  title: "",
  dir: "",
  startedAt: 0,
  finishedAt: null,
  elapsedMs: 0,
  command: "",
  exitCode: null,
  resultCode: null,
  files: 0,
  version: "",
  log: "",
  error: "",
};

function snapshot(job: InternalJob | null): JobSnapshot {
  if (job === null) return { ...IDLE_JOB };
  const finished = job.finishedAt ?? Date.now();
  return {
    state: job.state,
    operation: job.operation,
    label: job.label,
    path: job.path,
    title: job.title,
    dir: job.dir,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: finished - job.startedAt,
    command: job.command,
    exitCode: job.exitCode,
    resultCode: job.resultCode,
    files: job.files,
    version: job.version,
    log: job.log,
    error: job.error,
  };
}

function countFiles(dir: string, cap = 200_000): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total < cap) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

/** The Designer writes /Out in cp1251 on Russian Windows, but may write UTF-8. */
function decodeLog(file: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return "";
  }
  for (const encoding of ["utf-8", "windows-1251"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch {
      // Try the next encoding.
    }
  }
  return raw.toString("utf8");
}

function firstLogLine(text: string): string {
  return (
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || ""
  );
}

/** Configuration version from <Version> in Configuration.xml only. */
function readConfigVersion(dir: string): string {
  try {
    const raw = readFileSync(join(dir, "Configuration.xml"));
    if (raw.length > 20 * 1024 * 1024) return "";
    const match = raw.toString("utf8").match(/<Version>([^<]+)<\/Version>/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof netConnect> | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // Already closed.
      }
      resolve(value);
    };
    socket = netConnect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Check what is visible without starting 1C: the folder, the data file, the server port. */
async function checkBaseLocally(base: { arg: string } | { error: string }): Promise<CheckStep> {
  if ("error" in base) return { label: "База", ok: false, detail: base.error };
  if (base.arg.startsWith("/F")) {
    const path = base.arg.slice(2);
    if (!existsSync(path)) return { label: "База", ok: false, detail: `папка базы не найдена: ${path}` };
    const hasData = existsSync(join(path, "1Cv8.1CD"));
    return {
      label: "База",
      ok: hasData,
      detail: hasData ? "файл 1Cv8.1CD на месте" : `в папке нет файла 1Cv8.1CD: ${path}`,
    };
  }
  const raw = base.arg.slice(2);
  const slash = raw.indexOf("\\");
  const server = slash >= 0 ? raw.slice(0, slash) : raw;
  const ref = slash >= 0 ? raw.slice(slash + 1) : "";
  const colon = server.lastIndexOf(":");
  const host = colon > 0 ? server.slice(0, colon) : server;
  const port = colon > 0 ? Number(server.slice(colon + 1)) || 1541 : 1541;
  const reachable = await tcpReachable(host, port);
  return {
    label: "Сервер",
    ok: reachable,
    detail: reachable
      ? `${host}:${port} отвечает`
      : `${host}:${port} не отвечает${ref !== "" ? ` (база ${ref})` : ""}`,
  };
}

const COM_SCRIPT = String.raw`# Проверка подключения к базе 1С внешним соединением.
$ErrorActionPreference = 'Stop'
$connStr = $env:P1C_CONN
$outFile = $env:P1C_OUT
$ok = $false
$version = ''
$errorText = ''
$connector = $null
$connection = $null
try {
    $platform = (Get-Item -LiteralPath $env:P1C_EXE).VersionInfo
    $progId = if ($platform.FileMajorPart -eq 8 -and $platform.FileMinorPart -eq 5) {
        'V85.COMConnector'
    } else {
        'V83.COMConnector'
    }
    try {
        $connector = New-Object -ComObject $progId
    } catch {
        throw "$progId : $($_.Exception.Message)"
    }
    $connection = $connector.Connect($connStr)
    $ok = $true
    try {
        $version = [string]$connection.Метаданные.Версия
    } catch {
        $version = ''
    }
} catch {
    $errorText = $_.Exception.Message
} finally {
    if ($null -ne $connection) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($connection) }
    if ($null -ne $connector) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($connector) }
    [GC]::Collect()
}
$payload = [ordered]@{ ok = $ok; version = $version; error = $errorText }
$json = $payload | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding $false))`;

interface ComResult {
  ok: boolean;
  version: string;
  error: string;
  bitness: number;
}

export class OperationRunner {
  readonly platform: PlatformOperations;
  private readonly jobsDir: string;
  private readonly tempDir: string;
  private job: InternalJob | null = null;
  private comScript: string | null = null;

  constructor(dataDir: string, tempDir: string) {
    this.platform = new PlatformOperations(dataDir);
    this.jobsDir = join(dataDir, "jobs");
    this.tempDir = tempDir;
  }

  get legacyRunning(): boolean { return this.job?.state === "running"; }

  status(): JobSnapshot {
    // While the operation runs, count files at most every five seconds: walking
    // tens of thousands of files must not compete with the dump itself.
    if (this.job !== null && this.job.state === "running" && this.job.finishedAt === null) {
      if (Date.now() - this.job.countedAt > 5000) {
        this.job.countedAt = Date.now();
        try {
          this.job.files = this.job.targetDir === "" ? 0 : countFiles(this.job.targetDir);
        } catch {
          // Keep the previous count.
        }
      }
    }
    return snapshot(this.job);
  }

  cancel(): JobSnapshot {
    const job = this.job;
    if (job === null || job.state !== "running" || job.child === null) return snapshot(job);
    const pid = job.child.pid;
    if (pid !== undefined) {
      try {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {
        // The process may have exited on its own.
      }
    }
    job.state = "cancelled";
    job.finishedAt = Date.now();
    job.error = `${job.label || "операция"} отменена`;
    this.release(job);
    return snapshot(job);
  }

  dispose(): void {
    this.platform.stop("user");
    if (this.job !== null && this.job.state === "running" && this.job.child !== null) {
      // reload/disable is a deliberate stop: kill the child instead of orphaning it.
      const pid = this.job.child.pid;
      if (pid !== undefined) {
        try {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
      this.job.state = "cancelled";
      this.job.finishedAt = Date.now();
      this.release(this.job);
    }
  }

  private release(job: InternalJob): void {
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const lease = job.lease;
    job.lease = null;
    lease?.dispose();
  }

  start(input: StartOperationInput, lease: WorkerLease): JobSnapshot {
    if (this.platform.running) throw new Error("На хосте уже выполняется операция 1С.");
    if (this.job !== null && this.job.state === "running") {
      throw new Error(
        `уже идёт ${this.job.label || "операция"} проекта «${this.job.title}» — дождись её окончания`,
      );
    }

    const params: ProjectParams = input.params;
    const platform = resolvePlatform(params.platformPath || input.platformFallback);
    if ("error" in platform) throw new Error(platform.error);
    const base = resolveBase(params.infobasePath);
    if ("error" in base) throw new Error(base.error);

    const projectPath = canonical(input.path);
    if (input.operation === "load" || input.cleanLocks) {
      const target = base.arg.startsWith("/F")
        ? `/F${physicalPath(resolve(projectPath, base.arg.slice(2)))}`
        : base.arg;
      const recovery = this.platform.recovery(target);
      if (recovery) {
        throw new Error(`Сначала проверь состояние базы после операции ${recovery}. Подтверждённый повтор доступен через platform.`);
      }
    }
    const dumpDir = resolveDumpDir(projectPath, params.dumpDir);
    const sourceDir = dumpDir;
    const targetDir = input.operation === "extensions" ? canonical(join(dumpDir, "Extensions")) : dumpDir;

    if (input.operation === "load") {
      // Loading a folder without Configuration.xml would replace the base
      // configuration with an empty one — refuse instead of asking 1C later.
      if (!hasConfigurationXml(sourceDir)) {
        throw new Error(
          `в каталоге нет Configuration.xml: ${sourceDir}. Загрузка из такого каталога заменит ` +
            "конфигурацию базы пустой — сначала выгрузи конфигурацию в файлы.",
        );
      }
    } else {
      try {
        mkdirSync(targetDir, { recursive: true });
      } catch (error) {
        throw new Error(`не удалось создать каталог: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // -update needs ConfigDumpInfo.xml; without it the Designer fails, so a
    // missing file silently becomes a full dump.
    let update = false;
    const notes: string[] = [];
    if (input.operation === "dump") {
      update = input.update;
      if (update && !existsSync(join(targetDir, "ConfigDumpInfo.xml"))) {
        update = false;
        notes.push("в каталоге выгрузки нет ConfigDumpInfo.xml — выполнена полная выгрузка, а не обновление");
      }
    }

    let removedLocks: string[] = [];
    if (input.cleanLocks && base.arg.startsWith("/F")) {
      removedLocks = cleanLockFiles(base.arg.slice(2));
    }

    try {
      mkdirSync(this.jobsDir, { recursive: true });
    } catch (error) {
      throw new Error(`не удалось создать каталог заданий: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stamp = String(Date.now());
    const logFile = join(this.jobsDir, `${input.operation}-${stamp}.log`);
    const resultFile = join(this.jobsDir, `${input.operation}-${stamp}.result`);

    const built = buildDesignerArgs({
      operation: input.operation,
      baseArg: base.arg,
      params,
      format: input.format,
      sourceDir,
      targetDir,
      update,
      updateDb: input.updateDb,
      dynamic: input.dynamic,
      logFile,
      resultFile,
    });
    notes.push(...built.notes);

    const logLines: string[] = [];
    if (removedLocks.length > 0) logLines.push(`сняты lock-файлы: ${removedLocks.join(", ")}`);
    logLines.push(...notes);

    const maskedArgs = built.args.map((argument, index) =>
      index > 0 && /^\/(P|N|UC)/.test(argument)
        ? "***"
        : argument,
    );

    const job: InternalJob = {
      state: "running",
      operation: input.operation,
      label: OPERATION_LABELS[input.operation],
      path: projectPath,
      title: projectTitle(projectPath),
      dir: targetDir,
      startedAt: Date.now(),
      finishedAt: null,
      elapsedMs: 0,
      command: [platform.exe, ...maskedArgs].join(" "),
      exitCode: null,
      resultCode: null,
      files: 0,
      version: "",
      log: logLines.length > 0 ? `${logLines.join("\n")}\n` : "",
      error: "",
      child: null,
      logFile,
      resultFile,
      targetDir,
      sourceDir,
      countedAt: 0,
      lease,
      timer: null,
    };
    this.job = job;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(platform.exe, built.args, {
        cwd: platform.cwd,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      job.state = "failed";
      job.finishedAt = Date.now();
      job.error = `не удалось запустить ${platform.exe}: ${error instanceof Error ? error.message : String(error)}`;
      this.release(job);
      return snapshot(job);
    }
    job.child = child;

    job.timer = setTimeout(() => {
      if (job.state !== "running") return;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
      job.state = "failed";
      job.finishedAt = Date.now();
      job.error = `${job.label} превысила лимит ${Math.round(JOB_TIMEOUT_MS / 60000)} мин и была остановлена`;
      job.log = `${job.log}\n${redactLog(decodeLog(logFile), [params.password, params.unlockCode])}`.slice(-JOB_TAIL_CHARS);
      this.release(job);
    }, JOB_TIMEOUT_MS);

    const finalize = () => {
      if (job.state !== "running") return;
      if (job.timer !== null) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      job.finishedAt = Date.now();
      job.exitCode = child.exitCode;
      const text = redactLog(decodeLog(logFile), [params.password, params.unlockCode]);
      job.log = `${job.log}${text ? `\n${text}` : ""}`.slice(-JOB_TAIL_CHARS);
      job.resultCode = decodeLog(resultFile).trim();
      const producesFiles = input.operation !== "load";
      job.files = producesFiles ? countFiles(targetDir) : 0;
      job.version = readConfigVersion(sourceDir);

      const finishDone = () => {
        job.state = "done";
        if (producesFiles && job.files === 0) {
          job.log = `${job.log}\n${job.label}: файлов не создано.${
            input.operation === "extensions"
              ? " Если расширений в базе нет — это нормальный результат; иначе проверь, поддерживает ли эта версия платформы ключ -AllExtensions."
              : ""
          }`.slice(-JOB_TAIL_CHARS);
        }
        this.release(job);
      };

      // 1C writes /Out and /DumpResult asynchronously: give the files a moment.
      if (job.resultCode === "" && (!producesFiles || job.files === 0)) {
        setTimeout(() => {
          if (job.state !== "running") return;
          job.resultCode = decodeLog(resultFile).trim();
          job.files = producesFiles ? countFiles(targetDir) : 0;
          if (job.resultCode === "0" || (producesFiles && job.files > 0)) {
            finishDone();
            job.version = readConfigVersion(sourceDir);
            return;
          }
          job.state = "failed";
          job.error =
            (producesFiles
              ? `${job.label} не создала файлов${job.exitCode ? ` (код ${job.exitCode})` : ""}`
              : `${job.label} не подтверждена: /DumpResult пуст${job.exitCode ? ` (код ${job.exitCode})` : ""}`) +
            (input.operation === "extensions"
              ? " Если версия платформы не знает ключ -AllExtensions у /DumpConfigToFiles, выгрузка расширений в исходники ею не поддерживается."
              : "");
          this.release(job);
        }, 3000);
        return;
      }

      // /DumpResult is the platform's own verdict (0 on success); the process
      // exit code is unreliable — a batch command may fail with exit 0.
      if (job.resultCode === "0" || (job.resultCode === "" && producesFiles && job.files > 0 && job.exitCode === 0)) {
        finishDone();
        return;
      }
      job.state = "failed";
      job.error =
        (job.resultCode === "1"
          ? `Конфигуратор сообщил об ошибке: ${firstLogLine(text) || "см. лог"}`
          : `${job.label} завершилась без результата${job.exitCode ? ` (код ${job.exitCode})` : ""}`) +
        (input.operation === "extensions"
          ? " Если версия платформы не знает ключ -AllExtensions у /DumpConfigToFiles, выгрузка расширений в исходники ею не поддерживается."
          : "");
      this.release(job);
    };

    child.on("exit", finalize);
    child.on("error", (error) => {
      job.state = "failed";
      job.finishedAt = Date.now();
      job.error = `процесс 1С: ${error.message}`;
      this.release(job);
    });

    return snapshot(job);
  }

  private comScriptFile(): string {
    if (this.comScript !== null) return this.comScript;
    mkdirSync(this.tempDir, { recursive: true });
    const file = join(this.tempDir, "com-check.ps1");
    // Windows PowerShell 5.1 reads a BOM-less script as ANSI and breaks on the
    // Cyrillic "Метаданные" identifier, so the BOM is required.
    writeFileSync(file, `\uFEFF${COM_SCRIPT}`, "utf-8");
    this.comScript = file;
    return file;
  }

  private runCom(platformExe: string, connectionString: string): Promise<ComResult> {
    const shell = pickPowerShell(platformExe);
    let script;
    try {
      script = this.comScriptFile();
    } catch (error) {
      return Promise.resolve({
        ok: false,
        version: "",
        error: `не удалось подготовить проверку: ${error instanceof Error ? error.message : String(error)}`,
        bitness: shell.bitness,
      });
    }
    const outFile = join(this.tempDir, `com-${Date.now()}.json`);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ComResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(
          shell.exe,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
          {
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, P1C_EXE: platformExe, P1C_CONN: connectionString, P1C_OUT: outFile },
          },
        );
      } catch (error) {
        return finish({
          ok: false,
          version: "",
          error: `не удалось запустить проверку: ${error instanceof Error ? error.message : String(error)}`,
          bitness: shell.bitness,
        });
      }

      const timer = setTimeout(() => {
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } catch {
            // Already gone.
          }
        }
        try {
          unlinkSync(outFile);
        } catch {
          // Never written.
        }
        finish({
          ok: false,
          version: "",
          error: `база не ответила за ${Math.round(COM_TIMEOUT_MS / 1000)} с — проверь путь и доступность сервера`,
          bitness: shell.bitness,
        });
      }, COM_TIMEOUT_MS);

      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ ok: false, version: "", error: `PowerShell: ${error.message}`, bitness: shell.bitness });
      });
      child.on("exit", () => {
        clearTimeout(timer);
        let data: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(readFileSync(outFile, "utf-8"));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>;
          }
        } catch {
          data = null;
        }
        try {
          unlinkSync(outFile);
        } catch {
          // Result already read.
        }
        if (data === null) {
          return finish({
            ok: false,
            version: "",
            error: "проверка не вернула результат",
            bitness: shell.bitness,
          });
        }
        if (data.ok === true) {
          return finish({
            ok: true,
            version: String(data.version || ""),
            error: "",
            bitness: shell.bitness,
          });
        }
        finish({
          ok: false,
          version: "",
          error: comErrorText(String(data.error || "")) || "база не открылась",
          bitness: shell.bitness,
        });
      });
    });
  }

  async checkConnection(input: {
    path: string;
    params: ProjectParams;
    platformFallback: string;
  }): Promise<CheckConnectionResult> {
    const startedAt = Date.now();
    const steps: CheckStep[] = [];

    const platform = resolvePlatform(input.params.platformPath || input.platformFallback);
    if ("error" in platform) {
      steps.push({ label: "Платформа", ok: false, detail: platform.error });
    } else {
      steps.push({ label: "Платформа", ok: true, detail: platform.exe });
    }

    const base = resolveBase(input.params.infobasePath);
    steps.push(await checkBaseLocally(base));

    let version = "";
    if ("error" in platform || "error" in base) {
      return {
        ok: false,
        steps,
        version,
        error: "не хватает данных для проверки подключения",
        elapsedMs: Date.now() - startedAt,
      };
    }

    const connection = buildComConnectionString(base, input.params);
    if ("error" in connection) {
      steps.push({ label: "Подключение", ok: false, detail: connection.error });
      return { ok: false, steps, version, error: connection.error, elapsedMs: Date.now() - startedAt };
    }

    const com = await this.runCom(platform.exe, connection.value);
    version = com.version;
    steps.push({
      label: "Подключение",
      ok: com.ok,
      detail: com.ok
        ? `база открылась внешним соединением${version !== "" ? `, версия ${version}` : ""}`
        : com.error,
    });

    return {
      ok: steps.every((step) => step.ok),
      steps,
      version,
      error: steps.find((step) => !step.ok)?.detail ?? "",
      elapsedMs: Date.now() - startedAt,
    };
  }
}
