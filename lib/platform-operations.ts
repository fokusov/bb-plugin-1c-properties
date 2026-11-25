import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { type PlatformJournalEntry, type PlatformPreview } from "../platform-contract.js";
import { addressKey, PlatformJournal, readBoundedText, readJUnit, redactLog } from "./platform-journal.js";
import { inspectTarget, type PlatformPlan } from "./platform-plan.js";

const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_DURATION = 60 * 60 * 1000;
type Lease = { dispose(): void };
type Auth = { user: string; password: string; unlockCode: string };
type ActiveRun = {
  entry: PlatformJournalEntry;
  scope: string;
  plan: PlatformPlan;
  child: ChildProcess | null;
  started: boolean;
  stop: "user" | "timeout" | null;
};

function gitState(path: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return { revision: null, dirty: null };
  }
}

function runStage(exe: string, cwd: string, args: string[], active: ActiveRun, launch: boolean): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // CREATEINFOBASE parses File="…" directly from the Windows command line.
    // The generic Windows argv escaping would insert backslashes before these quotes.
    const create = process.platform === "win32" && args[0] === "CREATEINFOBASE";
    const argv = create ? args.map((arg, index) => index !== 1 && /\s/.test(arg) ? `"${arg}"` : arg) : args;
    const child = spawn(exe, argv, {
      cwd, windowsHide: !launch, detached: launch, stdio: "ignore",
      ...(create ? { windowsVerbatimArguments: true, argv0: `"${exe}"` } : {}),
    });
    active.child = child;
    child.once("spawn", () => {
      active.started = true;
      if (launch) {
        child.unref();
        resolve(null);
      }
    });
    child.once("error", reject);
    if (!launch) child.once("close", resolve);
  });
}

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill();
    return;
  }
  const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  kill.once("error", () => child.kill());
  kill.once("exit", (code) => {
    if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
  });
}

function configureTest(plan: PlatformPlan, folder: string): string[] {
  const { action, config, workspace } = plan.preview;
  const file = join(folder, "test-configuration.json");
  let options: Record<string, unknown> = {};
  if (config) {
    const text = readBoundedText(config, MAX_REPORT_BYTES);
    try { options = JSON.parse(text); }
    catch { throw new Error("Файл настроек тестов содержит некорректный JSON."); }
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Настройки тестов должны быть JSON-объектом.");
  if (file.includes(";")) throw new Error("Путь настроек запуска тестов содержит точку с запятой.");
  if (action === "yaxunit") {
    const reportPath = join(folder, "yaxunit.xml");
    writeFileSync(file, JSON.stringify({
      ...options, workspacePath: workspace, closeAfterTests: true, showReport: false,
      reportFormat: "jUnit", reportPath, reports: [{ format: "jUnit", path: reportPath }],
      logging: { enable: true, level: "info", file: join(folder, "yaxunit.raw") },
    }), { flag: "wx" });
    return ["/C", `RunUnitTests=${file}`];
  }
  const junitpath = join(folder, "vanessa");
  mkdirSync(junitpath);
  writeFileSync(file, JSON.stringify({
    ...options,
    КаталогПроекта: workspace,
    junitcreatereport: true, junitpath,
    ДелатьОтчетВФорматеjUnit: true, КаталогВыгрузкиJUnit: junitpath,
    ЗакрытьTestClientПослеЗапускаСценариев: true,
    ЗавершитьРаботуСистемы: true,
  }), { flag: "wx" });
  return ["/C", `StartFeaturePlayer;DisableFirstRunHelper;VAParams=${file}`];
}

export class PlatformOperations {
  private readonly journal: PlatformJournal;
  private active: ActiveRun | null = null;

  constructor(root: string) {
    this.journal = new PlatformJournal(join(root, "platform-operations-v1"));
  }

  get running(): boolean { return this.active !== null; }

  static scope(projectId: string, workspace: string): string {
    return addressKey(`${projectId}\n${workspace}`);
  }

  recovery(baseArg: string): string | null { return this.journal.recovery(baseArg); }

  list(scope: string): PlatformJournalEntry[] {
    return this.journal.list(scope, this.active?.entry.id);
  }

  status(scope: string, id: string): PlatformJournalEntry | null {
    return this.journal.read(scope, id, this.active?.entry.id);
  }

  report(scope: string, id: string, name: string): string {
    const entry = this.status(scope, id);
    if (!entry?.artifacts.some((artifact) => artifact.kind !== "output" && artifact.name === name)) {
      throw new Error("Артефакт этой операции не найден.");
    }
    return readBoundedText(join(this.journal.folder(scope, id), name), MAX_REPORT_BYTES);
  }

  cancel(scope: string, id: string): PlatformJournalEntry | null {
    if (this.active?.scope === scope && this.active.entry.id === id) this.stop("user");
    return this.status(scope, id);
  }

  stop(reason: "user" | "timeout"): void {
    if (!this.active || this.active.stop) return;
    this.active.stop = reason;
    if (this.active.child) stopChild(this.active.child);
  }

  start(scope: string, plan: PlatformPlan, auth: Auth, confirmation: string | undefined, inspected: string | undefined, lease: Lease): PlatformJournalEntry {
    if (this.active) throw new Error("На хосте уже выполняется операция 1С.");
    if (plan.mutation && (!confirmation || confirmation !== plan.preview.confirmation)) {
      throw new Error("Подтверди действие для разрешённой цели и платформы. Если цель изменилась, выполни предпросмотр повторно.");
    }
    if (plan.mutation && plan.preview.recovery && inspected !== plan.preview.recovery) {
      throw new Error(`Перед повтором проверь фактическое состояние базы после операции ${plan.preview.recovery} и подтверди проверку.`);
    }
    const { confirmation: _confirmation, recovery: _recovery, ...target } = plan.preview;
    const entry: PlatformJournalEntry = {
      ...target, ...gitState(target.workspace), id: randomUUID(), state: "running", startedAt: new Date().toISOString(),
      finishedAt: null, stage: 0, stages: plan.stages.length, exitCode: null, resultCode: null,
      needsInspection: plan.mutation, error: null, counts: null, artifacts: [],
    };
    this.journal.write(scope, entry);
    const active = { entry, plan, scope, child: null, started: false, stop: null };
    this.active = active;
    void this.execute(active, auth, lease);
    return { ...entry };
  }

  private async execute(active: ActiveRun, auth: Auth, lease: Lease): Promise<void> {
    const { entry, plan, scope } = active;
    const folder = this.journal.folder(scope, entry.id);
    const sensitive = [auth.password, auth.unlockCode];
    const log: string[] = [];
    let marked = false;
    const timer = setTimeout(() => this.stop("timeout"), MAX_DURATION);
    try {
      const preview = plan.preview as PlatformPreview;
      const batch = plan.stages[0].verdict !== "launch";
      const xmlDirectory = preview.action === "dump-xml" || preview.action === "unpack-configuration";
      if (preview.output) mkdirSync(xmlDirectory ? preview.output : dirname(preview.output), { recursive: true });
      const testArgs = plan.stages[0].verdict === "junit" ? configureTest(plan, folder) : [];
      if (plan.mutation) {
        this.journal.mark(plan.baseArg, entry.id);
        marked = true;
      }
      for (const [index, stage] of plan.stages.entries()) {
        if (active.stop) throw new Error("Выполнение остановлено.");
        entry.stage = index + 1;
        entry.resultCode = null;
        entry.exitCode = null;
        this.journal.write(scope, entry);
        const resultFile = join(folder, `stage-${entry.stage}.result`);
        const logFile = join(folder, `stage-${entry.stage}.raw`);
        const authArgs = stage.mode === "CREATEINFOBASE" ? [] : [
          plan.baseArg,
          ...(auth.user ? ["/N", auth.user] : []),
          ...(auth.password ? ["/P", auth.password] : []),
          ...(auth.unlockCode ? ["/UC", auth.unlockCode] : []),
        ];
        const args = [stage.mode, ...authArgs, ...stage.args, ...testArgs];
        if (batch) args.push("/DisableStartupDialogs", "/DisableStartupMessages", "/Out", logFile);
        if (stage.verdict === "platform") args.push("/DumpResult", resultFile);
        entry.exitCode = await runStage(plan.platform.exe, preview.workspace, args, active, !batch);
        active.child = null;
        const details = existsSync(logFile) ? readBoundedText(logFile, MAX_LOG_BYTES / plan.stages.length, true) : "";
        log.push(`Этап ${entry.stage}/${entry.stages}: ${stage.mode} ${stage.mode === "CREATEINFOBASE" ? "" : stage.args[0] ?? ""}\n${details}`);
        if (stage.verdict === "platform") {
          entry.resultCode = existsSync(resultFile) ? readBoundedText(resultFile, 512).trim() : null;
        }
        if (active.stop) throw new Error("Процесс завершился после запроса на остановку.");
        if (stage.verdict === "launch") continue;
        if (stage.verdict === "junit") this.publishJUnit(folder, entry, sensitive);
        if (entry.exitCode !== 0 || (stage.verdict === "platform" && entry.resultCode !== "0")) {
          throw new Error(`Платформа не подтвердила успех этапа ${entry.stage}: код процесса ${entry.exitCode ?? "нет"}, DumpResult ${entry.resultCode ?? "нет"}.`);
        }
      }
      if (preview.output) {
        const artifact = xmlDirectory ? join(preview.output, "Configuration.xml") : preview.output;
        if (!statSync(artifact, { throwIfNoEntry: false })?.size) throw new Error("Ожидаемый артефакт отсутствует или пуст.");
        const workspacePath = relative(preview.workspace, preview.output);
        entry.artifacts.push({ kind: "output", name: basename(preview.output), workspacePath: isAbsolute(workspacePath) || /^\.\.(?:[\\/]|$)/.test(workspacePath) ? null : workspacePath });
      }
      if (preview.action === "create-file-base" && !statSync(plan.baseFile!, { throwIfNoEntry: false })?.size) {
        throw new Error("Платформа не создала файл 1Cv8.1CD.");
      }
      entry.state = batch ? "done" : "launched";
      entry.needsInspection = false;
    } catch (error) {
      entry.state = active.stop === "user" ? "cancelled" : "failed";
      entry.needsInspection = plan.mutation && active.started;
      entry.error = redactLog(active.stop === "timeout" ? "Превышен лимит выполнения 60 минут." : error instanceof Error ? error.message : String(error), sensitive);
    } finally {
      clearTimeout(timer);
      try {
        try { entry.targetState = inspectTarget(plan.baseArg); }
        catch { entry.targetState = "Состояние цели недоступно. Проверь базу средствами 1С."; }
        const testLog = join(folder, "yaxunit.raw");
        if (existsSync(testLog)) log.push(readBoundedText(testLog, MAX_LOG_BYTES, true));
        if (log.length) {
          writeFileSync(join(folder, "operation.log"), redactLog(log.join("\n"), sensitive), "utf8");
          entry.artifacts.push({ kind: plan.preview.action === "check-syntax" ? "report" : "log", name: "operation.log", workspacePath: null });
        }
        for (const { name } of readdirSync(folder, { withFileTypes: true })) {
          if (/^stage-\d+\.raw$|^test-configuration\.json$|^yaxunit\.(raw|xml)$/.test(name)) {
            // Never retain raw platform output or copied test settings in the journal.
            unlinkSync(join(folder, name));
          }
        }
        entry.finishedAt = new Date().toISOString();
        this.journal.write(scope, entry);
        if (marked && !entry.needsInspection) {
          if (active.started || !plan.preview.recovery) this.journal.clear(plan.baseArg, entry.id);
          else this.journal.mark(plan.baseArg, plan.preview.recovery);
        }
      } catch (error) {
        // Keep the recovery marker if evidence could not be committed.
        console.error("Не удалось сохранить журнал операций 1С", (error as NodeJS.ErrnoException)?.code ?? "unknown");
      } finally {
        this.active = null;
        lease.dispose();
      }
    }
  }

  private publishJUnit(folder: string, entry: PlatformJournalEntry, sensitive: string[]): void {
    const paths = entry.action === "yaxunit" ? [join(folder, "yaxunit.xml")].filter(existsSync) : readdirSync(join(folder, "vanessa"), { withFileTypes: true })
      .filter((item) => item.isFile() && extname(item.name).toLowerCase() === ".xml")
      .map((item) => join(folder, "vanessa", item.name)).sort();
    if (!paths.length) throw new Error("Тестовый фреймворк не создал JUnit.");
    if (paths.length > 50) throw new Error("Слишком много файлов JUnit.");
    const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    for (const [index, path] of paths.entries()) {
      const text = readBoundedText(path, MAX_REPORT_BYTES);
      const counts = readJUnit(text);
      const name = `junit-${index + 1}.xml`;
      writeFileSync(join(folder, name), redactLog(text, sensitive), "utf8");
      unlinkSync(path);
      entry.artifacts.push({ kind: "report", name, workspacePath: null });
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += counts[key];
    }
    entry.counts = totals;
    if (!totals.tests || totals.tests === totals.skipped) throw new Error("JUnit не подтверждает выполнение тестов.");
    if (totals.failures || totals.errors) throw new Error("В JUnit есть ошибки или непройденные тесты.");
  }
}
