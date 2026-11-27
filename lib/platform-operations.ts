import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, cp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { type PlatformJournalEntry, type PlatformPreview } from "../platform-contract.js";
import { addressKey, decodePlatformConsole, PlatformJournal, readBoundedText, readJUnit, redactLog } from "./platform-journal.js";
import { assertStandaloneFileBase, edtResultDescriptor, edtTargetState, inspectTarget, physicalPath, platformFileStamp, type EdtPlan, type PlatformPlan } from "./platform-plan.js";
import { hashPlatformFile, readCfuConfiguration, sameConfiguration, snapshotCfuBase } from "./platform-cfu.js";
import { designerSpawnArguments } from "./designer.js";

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

function runStage(exe: string, cwd: string, args: string[], active: ActiveRun, launch: boolean, capture?: (chunk: Buffer) => void): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const prepared = designerSpawnArguments(exe, args);
    const child = spawn(exe, prepared.args, {
      cwd, windowsHide: !launch, detached: launch, stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
      ...prepared.options,
    });
    active.child = child;
    if (capture) {
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
    }
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

async function snapshotEdtProject(from: string, to: string, active: ActiveRun): Promise<void> {
  mkdirSync(to);
  for (const name of [".project", "DT-INF", ".settings", "src"]) {
    const source = join(from, name);
    if (!existsSync(source)) continue;
    await cp(source, join(to, name), {
      recursive: true,
      async filter(path) {
        if (active.stop) throw new Error("Выполнение остановлено.");
        const info = await lstat(path);
        if (!info.isDirectory() && !info.isFile()) throw new Error("Проект EDT содержит ссылку или специальный файл.");
        return true;
      },
    });
  }
}

function edtArgument(value: string): string {
  const path = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  if (/[\x00-\x1f"\x24\\]/.test(path)) throw new Error("Аргумент EDT содержит неподдерживаемый символ.");
  return `"${path}"`;
}

async function convertEdt(active: ActiveRun, plan: EdtPlan, log: string[], update: () => void): Promise<void> {
  const { entry } = active;
  const { preview, source, destination, base, baseName, version } = plan;
  const scratch = mkdtempSync(join(tmpdir(), "bb-edt-"));
  try {
    const workspace = join(scratch, "workspace");
    const steps: { label: string; command: string }[] = [];
    if (base) {
      const copy = join(scratch, "base-project");
      await snapshotEdtProject(base, copy, active);
      steps.push({ label: "import базового проекта", command: `import --project ${edtArgument(copy)}` });
    }
    if (preview.action === "edt-import") {
      const baseOptions = baseName && version ? ` --base-project-name ${edtArgument(baseName)} --version ${version}` : "";
      steps.push({ label: "import", command: `import${baseOptions} --configuration-files ${edtArgument(source)} --project ${edtArgument(destination)}` });
    } else {
      const copy = join(scratch, "source-project");
      await snapshotEdtProject(source, copy, active);
      steps.push({ label: "export", command: `export --project ${edtArgument(copy)} --configuration-files ${edtArgument(destination)}` });
    }
    if (active.stop) throw new Error("Выполнение остановлено.");
    if (physicalPath(destination) !== destination) throw new Error("Выходной путь изменился после предпросмотра.");
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(destination);
    for (const [index, { label, command }] of steps.entries()) {
      if (active.stop) throw new Error("Выполнение остановлено.");
      entry.stage = index + 1;
      entry.exitCode = null;
      update();
      const script = join(scratch, `step-${entry.stage}.edt`);
      writeFileSync(script, command + "\n", { flag: "wx", encoding: "utf8" });
      let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const logLimit = Math.floor(MAX_LOG_BYTES / 4);
      const timeout = setTimeout(() => {
        if (!active.stop && active.child) {
          active.stop = "timeout";
          stopChild(active.child);
        }
      }, 125_000);
      try {
        entry.exitCode = await runStage(preview.platform, scratch, ["-data", workspace, "-timeout", "120", "-file", script], active, false, (chunk) => {
          output = Buffer.concat([output, chunk]).subarray(-logLimit);
        });
      } finally {
        clearTimeout(timeout);
        active.child = null;
        log.push(`Этап ${entry.stage}/${entry.stages}: EDT ${label}\n${decodePlatformConsole(output).trim()}`);
      }
      if (active.stop === "timeout") throw new Error("EDT превысил лимит 125 секунд на команду.");
      if (active.stop) throw new Error("Процесс EDT завершился после запроса на остановку.");
      if (entry.exitCode !== 0) throw new Error(`EDT завершил этап ${entry.stage} с кодом ${entry.exitCode ?? "нет"}.`);
    }
    const artifact = edtResultDescriptor(preview.action, destination);
    const info = statSync(artifact, { throwIfNoEntry: false });
    if (!info?.isFile() || !info.size) throw new Error("EDT не создал ожидаемый дескриптор.");
    const path = relative(preview.workspace, artifact);
    entry.artifacts.push({ kind: "output", name: basename(artifact), workspacePath: isAbsolute(path) || /^\.\.(?:[\\/]|$)/.test(path) ? null : path });
  } catch (error) {
    const detail = join(scratch, "workspace", ".metadata", ".log");
    try { if (existsSync(detail)) log.push(readBoundedText(detail, MAX_LOG_BYTES / 4, true)); }
    catch { log.push("Не удалось прочитать диагностический журнал EDT."); }
    log.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    try { await rm(scratch, { recursive: true, force: true }); }
    catch { log.push("Рабочая область EDT осталась во временном каталоге хоста."); }
  }
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
    if (plan.preview.action === "apply-cfu" && !plan.preview.cfu) throw new Error("Обнови предпросмотр CFU.");
    if (plan.mutation && (!confirmation || confirmation !== plan.preview.confirmation)) {
      throw new Error("Подтверди действие для разрешённой цели и платформы. Если цель изменилась, выполни предпросмотр повторно.");
    }
    if (plan.mutation && plan.preview.recovery && inspected !== plan.preview.recovery) {
      throw new Error(`Перед повтором проверь фактическое состояние базы после операции ${plan.preview.recovery} и подтверди проверку.`);
    }
    const { confirmation: _confirmation, recovery: _recovery, ...target } = plan.preview;
    const entry: PlatformJournalEntry = {
      ...target, ...gitState(target.workspace), id: randomUUID(), state: "running", startedAt: new Date().toISOString(),
      finishedAt: null, stage: 0, stages: plan.baseArg === null ? (plan.base ? 2 : 1) : plan.stages.length + (plan.cfu ? 1 : 0),
      exitCode: null, resultCode: null,
      needsInspection: plan.mutation || plan.baseArg === null, error: null, counts: null, artifacts: [],
    };
    this.journal.write(scope, entry);
    const active = { entry, plan, scope, child: null, started: false, stop: null };
    this.active = active;
    void this.execute(active, auth, lease);
    return { ...entry };
  }

  private async execute(active: ActiveRun, auth: Auth, lease: Lease): Promise<void> {
    const { entry, plan, scope } = active;
    const baseArg = plan.baseArg;
    const folder = this.journal.folder(scope, entry.id);
    const sensitive = [auth.password, auth.unlockCode];
    const log: string[] = [];
    const cfu = plan.baseArg === null ? null : plan.cfu;
    const cfuFiles = cfu ? {
      "/DumpCfg": join(folder, "cfu-main.cf"),
      "/DumpDBCfg": join(folder, "cfu-db.cf"),
      "/DumpIB": join(folder, "cfu-backup.dt"),
      "/UpdateCfg": join(folder, "cfu-pinned.cfu"),
    } : null;
    const distribution = ["build-distribution", "build-cfu"].includes(entry.action)
      ? join(folder, "cfu-release" + extname(entry.output!)) : null;
    let marked = false;
    let cfuScratch: string | null = null;
    const timer = setTimeout(() => this.stop("timeout"), MAX_DURATION);
    try {
      const preview = plan.preview as PlatformPreview;
      if (plan.baseArg === null) {
        await convertEdt(active, plan, log, () => this.journal.write(scope, entry));
        entry.state = "done";
        entry.needsInspection = false;
        return;
      }
      const batch = plan.stages[0].verdict !== "launch";
      const xmlDirectory = preview.action === "dump-xml" || preview.action === "unpack-configuration";
      if (preview.output) mkdirSync(xmlDirectory ? preview.output : dirname(preview.output), { recursive: true });
      let backupHash: string | null = null;
      const restore = plan.restoreSha256 ? join(folder, "cfu-restore.dt") : null;
      if (restore) {
        await copyFile(preview.input!, restore, constants.COPYFILE_EXCL);
        if (await hashPlatformFile(restore) !== plan.restoreSha256) throw new Error("SHA-256 копии DT не совпадает с ожидаемым.");
        assertStandaloneFileBase(plan.baseFile!);
        if (platformFileStamp(plan.baseFile!) !== plan.baseStamp) throw new Error("База изменилась после подтверждения восстановления.");
        log.push(`Проверен SHA-256 копии DT: ${plan.restoreSha256}`);
      }
      if (cfu && cfuFiles) {
        await copyFile(preview.input!, cfuFiles["/UpdateCfg"], constants.COPYFILE_EXCL);
        if (await hashPlatformFile(cfuFiles["/UpdateCfg"]) !== cfu.sha256) {
          throw new Error("Файл CFU изменился после подтверждения.");
        }
        cfuScratch = mkdtempSync(join(tmpdir(), "bb-cfu-run-"));
        if (await snapshotCfuBase(preview.target, join(cfuScratch, "base")) !== cfu.baseStamp) {
          throw new Error("База изменилась после подтверждения CFU.");
        }
        const details = preview.cfu!;
        log.push(`CFU ${details.current.name} · ${details.current.vendor} · ${details.current.version} → ${details.target.version}\nSHA-256 CFU: ${details.sha256}`);
      }
      const testArgs = plan.stages[0].verdict === "junit" ? configureTest(plan, folder) : [];
      if (plan.mutation && !cfu) {
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
        const command = stage.args[0];
        const cfuPath = cfuFiles?.[command as keyof NonNullable<typeof cfuFiles>];
        let stageArgs = cfuPath ? [...stage.args, cfuPath] : stage.args;
        if (distribution) stageArgs = stage.args.map((arg) => arg === preview.output ? distribution : arg);
        if (restore) stageArgs = [command, restore];
        if (cfu && command === "/UpdateCfg") {
          if (!backupHash || await hashPlatformFile(preview.output!) !== backupHash) {
            throw new Error("Резервная копия DT не подтверждена или изменилась.");
          }
          assertStandaloneFileBase(plan.baseFile!);
          if (platformFileStamp(plan.baseFile!) !== cfu.baseStamp) throw new Error("База изменилась после создания резервной копии.");
          if (active.stop) throw new Error("Выполнение остановлено.");
          this.journal.mark(plan.baseArg, entry.id);
          marked = true;
        }
        const stageBase = cfuScratch && ["/DumpCfg", "/DumpDBCfg", "/DumpIB"].includes(command)
          ? `/F${join(cfuScratch, "base")}` : plan.baseArg;
        const authArgs = stage.mode === "CREATEINFOBASE" ? [] : [
          stageBase,
          ...(auth.user ? ["/N", auth.user] : []),
          ...(auth.password ? ["/P", auth.password] : []),
          ...(auth.unlockCode ? ["/UC", auth.unlockCode] : []),
        ];
        const args = [stage.mode, ...authArgs, ...stageArgs, ...testArgs];
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
        if (cfuFiles && command === "/DumpDBCfg") {
          const [main, database] = await Promise.all([
            hashPlatformFile(cfuFiles["/DumpCfg"]), hashPlatformFile(cfuFiles["/DumpDBCfg"]),
          ]);
          if (main !== database) throw new Error("Основная конфигурация отличается от конфигурации базы. Проверь состояние до применения CFU.");
          log.push("Основная конфигурация и конфигурация базы совпадают.");
        }
        if (cfuFiles && command === "/DumpIB") {
          backupHash = await this.publishOutput(entry, cfuFiles["/DumpIB"], preview.output!);
          this.journal.write(scope, entry);
          log.push(`Резервная копия DT: ${preview.output}\nSHA-256 DT: ${backupHash}`);
        }
      }
      if (cfu) {
        if (active.stop) throw new Error("Выполнение остановлено.");
        entry.stage = entry.stages;
        this.journal.write(scope, entry);
        const { current } = await readCfuConfiguration(preview.platform, preview.target, auth);
        if (active.stop) throw new Error("Выполнение остановлено.");
        if (!sameConfiguration(current, preview.cfu!.target)) {
          throw new Error(`После обновления база вернула версию ${current.version}, ожидалась ${preview.cfu!.target.version}.`);
        }
        log.push(`Этап ${entry.stage}/${entry.stages}: COM подтвердил ${current.name} · ${current.vendor} · ${current.version}.`);
      } else if (distribution) {
        const checksum = await this.publishOutput(entry, distribution, preview.output!);
        log.push(`SHA-256 файла поставки/обновления: ${checksum}`);
      } else if (preview.output) {
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
      entry.needsInspection = plan.baseArg === null ? existsSync(plan.destination) : cfu ? marked : plan.mutation && active.started;
      entry.error = redactLog(active.stop === "timeout" && baseArg !== null ? "Превышен лимит выполнения 60 минут." : error instanceof Error ? error.message : String(error), sensitive);
      if (cfu || distribution || (plan.baseArg !== null && plan.restoreSha256)) log.push(entry.error);
    } finally {
      clearTimeout(timer);
      try {
        if (cfuScratch) {
          try { await rm(cfuScratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
          catch { log.push("Снимок FILE-базы остался во временном каталоге хоста."); }
        }
        try { entry.targetState = baseArg === null ? edtTargetState(entry.target) : inspectTarget(baseArg); }
        catch { entry.targetState = "Состояние цели недоступно."; }
        const testLog = join(folder, "yaxunit.raw");
        if (existsSync(testLog)) log.push(readBoundedText(testLog, MAX_LOG_BYTES, true));
        if (log.length) {
          writeFileSync(join(folder, "operation.log"), redactLog(log.join("\n"), sensitive), "utf8");
          const action = plan.preview.action;
          entry.artifacts.push({ kind: action === "check-syntax" || action === "check-config" ? "report" : "log", name: "operation.log", workspacePath: null });
        }
        for (const { name } of readdirSync(folder, { withFileTypes: true })) {
          if (/^stage-\d+\.raw$|^test-configuration\.json$|^yaxunit\.(raw|xml)$|^cfu-(?:main|db|backup|pinned|release|restore)\.(?:cf|dt|cfu)$/.test(name)) {
            // Never retain raw platform output or copied test settings in the journal.
            unlinkSync(join(folder, name));
          }
        }
        entry.finishedAt = new Date().toISOString();
        this.journal.write(scope, entry);
        if (baseArg !== null && marked && !entry.needsInspection) {
          if (active.started || !plan.preview.recovery) this.journal.clear(baseArg, entry.id);
          else this.journal.mark(baseArg, plan.preview.recovery);
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

  private async publishOutput(entry: PlatformJournalEntry, produced: string, destination: string): Promise<string> {
    const artifact = statSync(produced, { throwIfNoEntry: false });
    if (!artifact?.isFile() || !artifact.size) throw new Error("Ожидаемый файл отсутствует или пуст.");
    const sha256 = await hashPlatformFile(produced);
    if (physicalPath(destination) !== destination) throw new Error("Выходной путь изменился после предпросмотра.");
    await copyFile(produced, destination, constants.COPYFILE_EXCL);
    if (await hashPlatformFile(destination) !== sha256) throw new Error("Записанный файл отличается от результата платформы.");
    const path = relative(entry.workspace, destination);
    entry.artifacts.push({
      kind: "output", name: basename(destination), sha256,
      workspacePath: isAbsolute(path) || /^\.\.(?:[\\/]|$)/.test(path) ? null : path,
    });
    return sha256;
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
