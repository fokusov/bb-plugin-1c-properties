// Settings section and sidebar page: 1C parameters per bb project.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { registerEditor } from "./editor/app.js";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { JobSnapshot, PlatformInfo, ProjectParams, ProjectState } from "./contract";
import type { CleanupScan } from "./contract";
import type { ToolsState } from "./contract";
import type { CheckResult, ProjectDetail, ProjectRow } from "./rpc";
import type { rpcContract } from "./rpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { BslFlowSettings } from "@/components/bsl-flow-settings";
import { PlatformOperationsPanel } from "./components/platform-operations.js";
import { ReviewPanel } from "./components/review-panel.js";
import { ProjectReadinessCard } from "./components/project-readiness.js";
import { cn } from "@/lib/utils";

interface StateResult {
  projects: ProjectRow[];
  common: { platformPath: string; bslflowSkillsRoot: string };
  paramsRel: string;
  legacyParamsRel: string;
  infobases: ProjectState["infobases"];
  infobasesWebSkipped: number;
  operation: JobSnapshot;
}

function reportError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${seconds % 60} с`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint === undefined ? null : <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Notice({ kind, children }: { kind: "error" | "info" | "ok"; children: ReactNode }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        kind === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        kind === "info" && "border-border bg-muted/40 text-muted-foreground",
        kind === "ok" && "border-border bg-muted/40 text-foreground",
      )}
    >
      {children}
    </p>
  );
}

function OperationBlock({
  job,
  onCancel,
  busy,
}: {
  job: JobSnapshot;
  onCancel: () => void;
  busy: boolean;
}) {
  if (job.state === "idle") {
    return <Notice kind="info">Операций пока не было.</Notice>;
  }
  const tone =
    job.state === "running"
      ? "border-primary/40 bg-primary/5"
      : job.state === "done"
        ? "border-border bg-muted/40"
        : "border-destructive/40 bg-destructive/10";
  return (
    <div className={cn("rounded-md border p-3 text-xs", tone)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">
          {job.state === "running"
            ? "Операция идёт"
            : job.state === "done"
              ? "Операция завершена"
              : job.state === "cancelled"
                ? "Операция отменена"
                : "Операция не удалась"}
        </span>
        <span className="text-muted-foreground">{job.label}</span>
        {job.state === "running" ? (
          <Button size="sm" variant="outline" className="ml-auto h-7 px-2" onClick={onCancel} disabled={busy}>
            <Icon name="X" className="size-3.5" />
            Отменить
          </Button>
        ) : null}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-4">
        <div>
          <dt className="inline">Время: </dt>
          <dd className="inline text-foreground">{formatDuration(job.elapsedMs)}</dd>
        </div>
        <div>
          <dt className="inline">Файлов: </dt>
          <dd className="inline text-foreground">{job.files}</dd>
        </div>
        {job.version === "" ? null : (
          <div className="col-span-2">
            <dt className="inline">Версия: </dt>
            <dd className="inline text-foreground">{job.version}</dd>
          </div>
        )}
      </dl>
      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{job.dir}</p>
      {job.error === "" ? null : <p className="mt-2 text-destructive">{job.error}</p>}
      {job.log.trim() === "" ? null : (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground">Лог Конфигуратора</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] text-foreground">
            {job.log.trim()}
          </pre>
        </details>
      )}
    </div>
  );
}

function ProjectEditor({
  row,
  detail,
  common,
  onSaved,
  onCleared,
  onRefreshed,
  onJob,
  onClose,
}: {
  row: ProjectRow;
  detail: ProjectDetail;
  common: { platformPath: string };
  onSaved: (detail: ProjectDetail) => void;
  onCleared: (detail: ProjectDetail) => void;
  onRefreshed: (detail: ProjectDetail) => void;
  onJob: (job: JobSnapshot) => void;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<ProjectParams>(detail.state.params);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [format, setFormat] = useState<"Hierarchical" | "Plain">("Hierarchical");
  const [update, setUpdate] = useState(false);
  const [cleanLocks, setCleanLocks] = useState(false);
  const [updateDb, setUpdateDb] = useState(true);
  const [dynamic, setDynamic] = useState(true);
  const [readinessRefresh, setReadinessRefresh] = useState(0);
  const [preparationStage, setPreparationStage] = useState<string | null>(null);
  const [preparationFailure, setPreparationFailure] = useState<string | null>(null);
  const [skillsNotice, setSkillsNotice] = useState<string | null>(null);
  const [rlmNotice, setRlmNotice] = useState<string | null>(null);

  const job = detail.state.operation;
  const baseId = `1c-${row.projectId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  useEffect(() => {
    if (job.state !== "running") return;
    const timer = setInterval(() => {
      rpc.call("operation", { projectId: row.projectId }).then(
        (result) => onJob(result.job),
        () => undefined,
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [job.state, onJob, rpc, row.projectId]);

  const setParam = (key: keyof ProjectParams, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setCheck(null);
    setNotice(null);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(reportError(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const saved = await rpc.call("saveProject", { projectId: row.projectId, params: form });
      onSaved(saved);
      setReadinessRefresh((value) => value + 1);
      setForm(saved.state.params);
      setCheck(null);
      setNotice("Параметры сохранены.");
    });

  const clear = () =>
    run("clear", async () => {
      const cleared = await rpc.call("clearProject", { projectId: row.projectId });
      onCleared(cleared);
      setReadinessRefresh((value) => value + 1);
      setForm(cleared.state.params);
      setConfirmClear(false);
      setCheck(null);
      setNotice("Файл параметров удалён.");
    });

  const runCheck = () =>
    run("check", async () => {
      const result = await rpc.call("checkConnection", { projectId: row.projectId, params: form });
      setCheck(result);
    });

  const start = (operation: "dump" | "load" | "extensions") =>
    run(operation, async () => {
      const result = await rpc.call("startOperation", {
        projectId: row.projectId,
        operation,
        params: form,
        format,
        update,
        updateDb,
        dynamic,
        cleanLocks,
      });
      onJob(result.job);
      setConfirmLoad(false);
      setNotice("Операция запущена.");
    });

  const cancel = () =>
    run("cancel", async () => {
      const result = await rpc.call("cancelOperation", { projectId: row.projectId });
      onJob(result.job);
    });

  const initBslFlow = () =>
    run("bslflow", async () => {
      const target = { projectId: row.projectId };
      let stage = "Проверка проекта";
      setPreparationFailure(null);
      setPreparationStage(stage);
      try {
        const { files } = await rpc.call("projectReadiness", target);
        if (!files.exists || !files.hasSources) throw new Error("Исходники 1С в каталоге проекта не обнаружены.");
        if (files.schema && files.schema !== "bsl-flow") throw new Error("Несовместимая схема OpenSpec: " + files.schema);
        if (files.flow.enabled === false) throw new Error("BSL Flow отключён для проекта.");
        stage = "Подготовка BSL Flow Core";
        setPreparationStage(stage);
        const tools = await rpc.call("toolsEnsure", { ...target, update: true });
        if (!tools.ok) throw new Error(tools.log.join("\n") || "Не удалось подготовить Core.");
        stage = "Bootstrap проекта";
        setPreparationStage(stage);
        const init = await rpc.call("initProject", target);
        onRefreshed(init.detail);
        if (!init.ok) throw new Error(init.output || init.error || "Bootstrap завершился с ошибкой.");
        stage = "Подключение скиллов";
        setPreparationStage(stage);
        const skills = await rpc.call("connectSkills", target);
        onRefreshed(skills.detail);
        if (!skills.ok) throw new Error(skills.error || "Не удалось подключить скиллы.");
      } catch (cause) {
        setPreparationFailure(stage + " · " + reportError(cause));
      } finally {
        setPreparationStage(null);
        setReadinessRefresh((value) => value + 1);
      }
    });

  const connectSkills = () =>
    run("skills", async () => {
      const result = await rpc.call("connectSkills", { projectId: row.projectId });
      onSaved(result.detail);
      setReadinessRefresh((value) => value + 1);
      if (!result.ok) throw new Error(result.error || "не удалось подключить скиллы");
      setSkillsNotice(
        `Скиллы обновлены: ${result.copied.length} скопировано, ${result.preserved.length} сохранено` +
          `${result.removed.length > 0 ? `, ${result.removed.length} удалено` : ""}` +
          `${result.skipped.length > 0 ? `, ${result.skipped.length} пропущено` : ""}.`,
      );
    });

  const startRlm = () =>
    run("rlm", async () => {
      const status = await rpc.call("rlmStart", { projectId: row.projectId });
      const next = await rpc.call("project", { projectId: row.projectId });
      onSaved(next);
      setRlmNotice(
        status.running
          ? `rlm-tools-bsl запущен на порту ${status.port ?? "?"}.`
          : status.error || "rlm-tools-bsl не запустился.",
      );
    });

  const stopRlm = () =>
    run("rlm-stop", async () => {
      const status = await rpc.call("rlmStop", { projectId: row.projectId });
      const next = await rpc.call("project", { projectId: row.projectId });
      onSaved(next);
      setRlmNotice(status.running ? "rlm всё ещё работает." : "rlm остановлен.");
    });

  const changeRlmOptIn = (enabled: boolean) =>
    run("rlm-opt-in", async () => {
      const result = await rpc.call("setRlmOptIn", { projectId: row.projectId, enabled });
      onRefreshed({
        ...detail,
        state: { ...detail.state, rlmOptIn: result.enabled },
      });
      setNotice(result.enabled ? "rlm включён для этого проекта." : "rlm выключен для этого проекта.");
    });

  const effectivePlatform = form.platformPath.trim() || common.platformPath;

  return (
    <div className="space-y-4 border-t border-border p-4">
      {error === null ? null : <Notice kind="error">{error}</Notice>}
      {notice === null ? null : <Notice kind="ok">{notice}</Notice>}

      <ProjectReadinessCard key={row.projectId} scope={{ projectId: row.projectId }}
        refresh={readinessRefresh} prepare={initBslFlow} busy={busy !== null}
        stage={preparationStage} failure={preparationFailure}
        checkedConnection={check?.ok === true && JSON.stringify(form) === JSON.stringify(detail.state.params)} />

      <ToolsCard projectId={row.projectId} />


      <BslFlowSettings key={row.projectId} projectId={row.projectId} hostId={row.hostId} sourcePath={row.path} initialized={detail.state.bslflow.initialized}
        onSaved={(enabled) => {
          onSaved({ ...detail, state: { ...detail.state, bslflow: { ...detail.state.bslflow, enabled } } });
          setReadinessRefresh((value) => value + 1);
        }} />

      <div className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium">Проект 1С</span>
          <span className="text-xs text-muted-foreground">
            BSL Flow: {detail.state.bslflow.enabled === false
              ? "отключён"
              : detail.state.bslflow.initialized ? `есть${detail.state.bslflow.version ? ` ${detail.state.bslflow.version}` : ""}` : "не инициализирован"}
          </span>
          <span className="text-xs text-muted-foreground">
            Скиллы BSL Flow: {detail.state.skills.bslflow}
          </span>
          <span className="text-xs text-muted-foreground">
            rlm:{" "}
            {detail.state.rlm.running
              ? `работает, порт ${detail.state.rlm.port ?? "?"}`
              : detail.state.rlm.installed
                ? "установлен, не запущен"
                : "не установлен"}
          </span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={detail.state.rlmOptIn}
              onCheckedChange={(value) => changeRlmOptIn(value === true)}
              disabled={busy !== null}
            />
            Использовать инструменты rlm
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={connectSkills} disabled={busy !== null}>
            <Icon name="Layers" className="size-4" />
            {detail.state.skills.total > 0 ? "Обновить скиллы" : "Подключить скиллы"}
          </Button>
          {detail.state.rlm.running ? (
            <Button size="sm" variant="outline" onClick={stopRlm} disabled={busy !== null}>
              <Icon name="Square" className="size-4" />
              Остановить rlm
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={startRlm} disabled={busy !== null}>
              <Icon name="Play" className="size-4" />
              Запустить rlm
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Инициализация проверяет и при необходимости ставит BSL Flow, затем копирует скиллы в{" "}
          <code className="font-mono">.bb/skills</code>. rlm запускается на машине проекта и
          подхватывается автоматически при первом вызове <code className="font-mono">rlm_*</code>.
        </p>
        {skillsNotice === null ? null : <div className="mt-2"><Notice kind="ok">{skillsNotice}</Notice></div>}
        {rlmNotice === null ? null : <div className="mt-2"><Notice kind="info">{rlmNotice}</Notice></div>}
        {detail.state.rlm.error === "" ? null : <div className="mt-2"><Notice kind="error">{detail.state.rlm.error}</Notice></div>}
        {detail.state.bslflow.initialized && !row.hasFile ? (
          <div className="mt-2">
            <Notice kind="info">
              BSL Flow уже инициализирован, но параметры базы ещё не заполнены. Заполни путь к базе,
              пользователя и пароль ниже и нажми «Сохранить».
            </Notice>
          </div>
        ) : null}
      </div>

      <CleanupCard projectId={row.projectId} />

      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="Путь к базе"
          hint={
            row.hasFile
              ? detail.state.legacy
                ? "Параметры читаются из .dsh/1c-project.json; сохранение создаст .bb/1c-project.json."
                : `Файл: ${detail.state.file}`
              : `Файл появится после сохранения: ${detail.state.file}`
          }
        >
          <div className="flex items-center gap-2">
            <select
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
              value={
                detail.state.infobases.some((candidate) => candidate.value === form.infobasePath)
                  ? form.infobasePath
                  : ""
              }
              onChange={(event) => {
                if (event.target.value !== "") setParam("infobasePath", event.target.value);
              }}
              aria-label="Выбрать базу из списка 1С"
            >
              <option value="">Выбрать из списка баз 1С…</option>
              {detail.state.infobases.map((candidate) => (
                <option key={`${candidate.value}-${candidate.name}`} value={candidate.value}>
                  {candidate.name} — {candidate.kind === "file" ? "файловая" : candidate.kind === "server" ? "серверная" : "база"}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-9 shrink-0 px-2"
              onClick={() =>
                run("refresh", async () => {
                  const next = await rpc.call("project", { projectId: row.projectId });
                  onRefreshed(next);
                })
              }
              disabled={busy !== null}
              aria-label="Перечитать ibases.v8i и список баз 1С"
            >
              <Icon name="RefreshCw" className="size-3.5" />
            </Button>
          </div>
          <Input
            value={form.infobasePath}
            onChange={(event) => setParam("infobasePath", event.target.value)}
            list={`${baseId}-bases`}
            placeholder='C:\\Bases\\Buh или Srvr="srv";Ref="buh";'
          />
          <datalist id={`${baseId}-bases`}>
            {detail.state.infobases.map((item) => (
              <option key={`${item.value}-${item.name}`} value={item.value}>
                {item.name} — {item.source}
              </option>
            ))}
          </datalist>
          {detail.state.infobases.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              Список баз 1С пуст или файл ibases.v8i не найден. Путь можно ввести вручную.
            </span>
          ) : (
            <span className="block text-xs text-muted-foreground">
              Загружено {detail.state.infobases.length} баз из списка 1С. Поле ниже можно править вручную.
              {detail.state.infobasesWebSkipped > 0
                ? ` Веб-базы пропущены: ${detail.state.infobasesWebSkipped}.`
                : ""}
            </span>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Пользователь">
            <Input
              value={form.user}
              onChange={(event) => setParam("user", event.target.value)}
              placeholder="Администратор"
            />
          </Field>
          <Field label="Пароль">
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setParam("password", event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Field
          label="Путь к платформе"
          hint={
            effectivePlatform === ""
              ? "Задай платформу в проекте или в общих настройках."
              : form.platformPath.trim() === ""
                ? `Берётся общая: ${effectivePlatform}`
                : effectivePlatform
          }
        >
          <Input
            value={form.platformPath}
            onChange={(event) => setParam("platformPath", event.target.value)}
            list={`${baseId}-platforms`}
            placeholder="Пусто — общее значение"
          />
          <datalist id={`${baseId}-platforms`}>
            {detail.state.platforms.map((platform) => (
              <option key={platform.path} value={platform.path}>
                {platform.version}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Код доступа к базе (/UC)">
          <Input
            value={form.unlockCode}
            onChange={(event) => setParam("unlockCode", event.target.value)}
            placeholder="Пусто — не передаётся"
          />
        </Field>
        <Field label="Каталог выгрузки" hint="Пусто — корень проекта. Относительный путь считается от проекта.">
          <Input
            value={form.dumpDir}
            onChange={(event) => setParam("dumpDir", event.target.value)}
            placeholder="Пусто — корень проекта"
          />
        </Field>
      </div>

      <p className="text-xs text-muted-foreground">
        Пароль хранится открытым текстом в файле проекта. Не коммить {detail.state.file.replace(/\\[^\\]+$/, "")}.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={busy !== null}>
          <Icon name="Save" className="size-4" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={runCheck} disabled={busy !== null}>
          <Icon name="PlugZap" className="size-4" />
          Проверить подключение
        </Button>
        {confirmClear ? (
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Удалить файл параметров?</span>
            <Button variant="destructive" size="sm" onClick={clear} disabled={busy !== null}>
              Удалить
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
              Отмена
            </Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmClear(true)} disabled={busy !== null || !row.hasFile}>
            <Icon name="Trash2" className="size-4" />
            Удалить файл
          </Button>
        )}
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Свернуть
        </Button>
      </div>

      {check === null ? null : (
        <div className="rounded-md border border-border p-3 text-xs">
          <ul className="space-y-1">
            {check.steps.map((step) => (
              <li key={step.label} className="flex gap-2">
                <span className={step.ok ? "text-foreground" : "text-destructive"}>{step.ok ? "✓" : "✗"}</span>
                <span className="font-medium">{step.label}:</span>
                <span className="text-muted-foreground">{step.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 font-medium">
            {check.ok ? `База открывается (${formatDuration(check.elapsedMs)}).` : check.error}
          </p>
        </div>
      )}

      <section className="rounded-md border border-border p-3 text-xs">
        <h4 className="font-medium">Состояние проекта</h4>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <h5 className="font-medium">Исходники</h5>
            <p className="text-muted-foreground">Рабочая папка: <code className="font-mono">{row.path}</code></p>
            <p className="text-muted-foreground">
              Распознавание 1С: {row.is1c ? row.markers.join("; ") || "параметры проекта" : "признаки исходников не найдены"}
            </p>
            <p className="text-muted-foreground">
              Git: {!row.sourceGit.available
                ? row.sourceGit.detail || "недоступен"
                : row.sourceGit.repository === null
                  ? row.sourceGit.detail || "состояние неизвестно"
                  : row.sourceGit.repository ? "репозиторий обнаружен" : row.sourceGit.detail || "репозиторий не обнаружен"}
            </p>
            <p className="text-muted-foreground">
              BSL Flow проекта: {detail.state.bslflow.initialized
                ? `инициализирован${detail.state.bslflow.version ? `, ${detail.state.bslflow.version}` : ""}${detail.state.bslflow.enabled === false ? ", отключён" : ""}`
                : "не инициализирован"}
            </p>
          </div>
          <div className="space-y-1">
            <h5 className="font-medium">Тестовая цель</h5>
            <p className="text-muted-foreground">
              Источник параметров: {!row.hasFile ? "не задан" : detail.state.legacy ? ".dsh/1c-project.json (старый формат)" : detail.state.file}
            </p>
            <p className="text-muted-foreground">Информационная база: {form.infobasePath.trim() || "не выбрана"}</p>
            <p className="text-muted-foreground">Платформа: {effectivePlatform || "не выбрана"}</p>
            <p className="text-muted-foreground">
              Подключение: {check === null ? "не проверено" : check.ok ? `проверено (${formatDuration(check.elapsedMs)})` : `ошибка — ${check.error}`}
            </p>
          </div>
        </div>
      </section>

      <div className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Операции Конфигуратора</span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Формат
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
              value={format}
              onChange={(event) => setFormat(event.target.value === "Plain" ? "Plain" : "Hierarchical")}
            >
              <option value="Hierarchical">иерархический</option>
              <option value="Plain">плоский</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={cleanLocks} onCheckedChange={(value) => setCleanLocks(value === true)} />
            снять .cfl
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={update} onCheckedChange={(value) => setUpdate(value === true)} />
            только изменения
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={updateDb} onCheckedChange={(value) => setUpdateDb(value === true)} />
            обновить конфигурацию базы
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={dynamic} onCheckedChange={(value) => setDynamic(value === true)} />
            динамически
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => start("dump")} disabled={busy !== null || job.state === "running"}>
            <Icon name="Download" className="size-4" />
            Выгрузить конфигурацию
          </Button>
          {confirmLoad ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-destructive">
                Загрузка заменит конфигурацию базы. Откат — только из бэкапа.
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => start("load")}
                disabled={busy !== null || job.state === "running"}
              >
                Загрузить
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmLoad(false)}>
                Отмена
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmLoad(true)}
              disabled={busy !== null || job.state === "running"}
            >
              <Icon name="Upload" className="size-4" />
              Загрузить конфигурацию
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => start("extensions")}
            disabled={busy !== null || job.state === "running"}
          >
            <Icon name="Package" className="size-4" />
            Выгрузить расширения
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Операции используют значения из формы; сохранять их перед запуском не обязательно.
        </p>
      </div>

      <OperationBlock job={job} onCancel={cancel} busy={busy !== null} />
      <PlatformOperationsPanel scope={{ projectId: row.projectId }} />
    </div>
  );
}

function ToolsCard({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ToolsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    (check: boolean) => {
      setBusy(check ? "check" : "status");
      setError(null);
      const call = check
        ? rpc.call("toolsCheck", { projectId })
        : rpc.call("toolsStatus", { projectId });
      call.then(
        (next) => setState(next),
        (cause) => setError(reportError(cause)),
      ).finally(() => setBusy(null));
    },
    [projectId, rpc],
  );

  useEffect(() => {
    load(true);
  }, [load]);
  useRealtime("projects-changed", () => load(false));

  const ensure = () => {
    setBusy("ensure");
    setError(null);
    setNotice(null);
    rpc
      .call("toolsEnsure", { projectId, update: true })
      .then(
        (result) => {
          setState(result.state);
          setNotice(result.log.join(" · "));
          if (!result.ok) setError(result.log.at(-1) ?? "не удалось установить инструменты");
        },
        (cause) => setError(reportError(cause)),
      )
      .finally(() => setBusy(null));
  };

  const describe = (label: string, info: ToolsState["bslflow"]) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
      <span className="w-24 text-sm">{label}</span>
      <span className="text-sm">
        {info.installed ? info.version || "установлен" : "не установлен"}
      </span>
      {info.latest === "" ? null : (
        <span className="text-xs text-muted-foreground">последняя {info.latest}</span>
      )}
      {info.updateAvailable ? (
        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground">
          есть обновление
        </span>
      ) : info.installed && info.latest !== "" ? (
        <span className="text-xs text-muted-foreground">актуально</span>
      ) : null}
      {info.error === "" ? null : <span className="text-xs text-destructive">{info.error}</span>}
    </div>
  );

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">Инструменты 1С</span>
        <span className="text-xs text-muted-foreground">BSL Flow для этой машины</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2"
          onClick={() => load(true)}
          disabled={busy !== null}
        >
          <Icon name="RefreshCw" className="size-3.5" />
          Проверить обновления
        </Button>
      </div>

      {state === null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {busy === null ? "Версии ещё не получены" : "Проверяю установленные версии…"}
        </p>
      ) : (
        <>
          <div className="mt-2 divide-y divide-border">
            {describe("BSL Flow", state.bslflow)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={ensure} disabled={busy !== null}>
              <Icon name="Download" className="size-4" />
              Установить или обновить
            </Button>
            {state.checkedAt === null ? null : (
              <span className="text-xs text-muted-foreground">
                проверено {new Date(state.checkedAt).toLocaleString("ru-RU")}
              </span>
            )}
          </div>
        </>
      )}

      {error === null ? null : <div className="mt-2"><Notice kind="error">{error}</Notice></div>}
      {notice === null ? null : <div className="mt-2"><Notice kind="info">{notice}</Notice></div>}
    </div>
  );
}

function CleanupCard({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [scan, setScan] = useState<CleanupScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [result, setResult] = useState<{
    bytes: number;
    removed: number;
    errors: string[];
    skipped: { path: string; reason: string }[];
  } | null>(null);

  const scanNow = useCallback(() => {
    setBusy("scan");
    setError(null);
    setConfirm(false);
    setRiskAccepted(false);
    rpc.call("cleanupScan", { projectId }).then(
      (next) => {
        setScan(next);
        setSelected(new Set(next.categories.filter((entry) => entry.safe).map((entry) => entry.id)));
      },
      (cause) => setError(reportError(cause)),
    ).finally(() => setBusy(null));
  }, [projectId, rpc]);

  useEffect(() => {
    scanNow();
  }, [scanNow]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirm(false);
    setRiskAccepted(false);
  };

  const selectSafe = () => {
    if (scan === null) return;
    setSelected(new Set(scan.categories.filter((entry) => entry.safe).map((entry) => entry.id)));
    setConfirm(false);
    setRiskAccepted(false);
  };
  const selectAll = () => {
    if (scan === null) return;
    setSelected(new Set(scan.categories.map((entry) => entry.id)));
    setConfirm(false);
    setRiskAccepted(false);
  };
  const clearSelection = () => {
    setSelected(new Set());
    setConfirm(false);
    setRiskAccepted(false);
  };

  const selectedCategories = (scan?.categories ?? []).filter((entry) => selected.has(entry.id));
  const selectedBytes = selectedCategories.reduce((sum, entry) => sum + entry.bytes, 0);
  const selectedFiles = selectedCategories.reduce((sum, entry) => sum + entry.files, 0);
  const risky = selectedCategories.some((entry) => !entry.safe);

  const run = () => {
    if (scan === null || selectedCategories.length === 0) return;
    setBusy("run");
    setError(null);
    rpc
      .call("cleanupRun", { projectId, categories: selectedCategories.map((entry) => entry.id) })
      .then((removed) => {
        setResult({
          bytes: removed.removedBytes,
          removed: removed.removed.length,
          errors: removed.errors,
          skipped: removed.skipped,
        });
        setConfirm(false);
        setRiskAccepted(false);
      }, (cause) => setError(reportError(cause)))
      .finally(() => {
        setBusy(null);
        scanNow();
      });
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">Очистка проекта</span>
        {scan === null ? (
          <span className="text-xs text-muted-foreground">
            {busy === "scan" ? "Считаю размеры…" : "Размеры ещё не посчитаны"}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            проект {formatBytes(scan.projectBytes)}; временные и сборочные {formatBytes(scan.totalBytes)}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2"
          onClick={scanNow}
          disabled={busy !== null}
        >
          <Icon name="RefreshCw" className="size-3.5" />
          Обновить
        </Button>
      </div>

      {error === null ? null : <div className="mt-2"><Notice kind="error">{error}</Notice></div>}
      {scan?.truncated ? (
        <div className="mt-2">
          <Notice kind="info">
            Размеры приблизительные: в проекте больше 300 000 файлов, обход остановлен на лимите.
          </Notice>
        </div>
      ) : null}

      {scan === null ? null : scan.categories.length === 0 ? (
        <div className="mt-2"><Notice kind="info">Временных и сборочных файлов не найдено.</Notice></div>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-border">
            {scan.categories.map((entry) => (
              <li key={entry.id} className="py-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={selected.has(entry.id)}
                    onCheckedChange={() => toggle(entry.id)}
                    aria-label={`Очистить: ${entry.title}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm">{entry.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{formatBytes(entry.bytes)}</span>
                      <span className="text-xs text-muted-foreground">{entry.files} файлов</span>
                      {entry.safe ? (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          безопасно
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{entry.description}</span>
                    {entry.warning === "" ? null : (
                      <span className="mt-0.5 block text-xs text-destructive">{entry.warning}</span>
                    )}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {entry.items.length} объектов
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {entry.items.slice(0, 30).map((candidate) => (
                          <li key={candidate.path} className="flex gap-2 font-mono text-[11px] text-muted-foreground">
                            <span className="truncate">{candidate.path}</span>
                            {candidate.hot ? (
                              <span className="shrink-0 rounded border border-border px-1 text-[10px]">
                                в работе
                              </span>
                            ) : null}
                            <span className="ml-auto shrink-0">{formatBytes(candidate.bytes)}</span>
                          </li>
                        ))}
                        {entry.items.length > 30 ? (
                          <li className="text-[11px] text-muted-foreground">
                            … ещё {entry.items.length - 30}
                          </li>
                        ) : null}
                      </ul>
                    </details>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={selectSafe} disabled={busy !== null}>
              Только безопасные
            </Button>
            <Button size="sm" variant="outline" onClick={selectAll} disabled={busy !== null}>
              Выбрать всё
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection} disabled={busy !== null}>
              Снять
            </Button>
            <span className="text-xs text-muted-foreground">
              Выбрано: {formatBytes(selectedBytes)} ({selectedFiles} файлов)
            </span>
            <Button
              size="sm"
              variant={risky ? "destructive" : "default"}
              className="ml-auto"
              onClick={() => {
                setConfirm(true);
                setRiskAccepted(false);
                setResult(null);
              }}
              disabled={busy !== null || selectedBytes === 0}
            >
              <Icon name="Trash2" className="size-4" />
              Очистить выбранное
            </Button>
          </div>

          {confirm ? (
            <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <p className="text-xs text-foreground">
                Будет удалено {formatBytes(selectedBytes)} в {selectedCategories.length} категориях. Действие
                необратимо.
              </p>
              {risky ? (
                <label className="mt-2 flex items-start gap-2 text-xs text-destructive">
                  <Checkbox checked={riskAccepted} onCheckedChange={(value) => setRiskAccepted(value === true)} />
                  Понимаю, что выбранные данные будут удалены без возможности отката.
                </label>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={run}
                  disabled={busy !== null || (risky && !riskAccepted)}
                >
                  Удалить {formatBytes(selectedBytes)}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={busy !== null}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : null}

          {result === null ? null : (
            <div className="mt-3">
              <Notice kind={result.errors.length > 0 ? "error" : "ok"}>
                Освобождено {formatBytes(result.bytes)}; удалено {result.removed} объектов.
                {result.errors.length > 0 ? ` Ошибок: ${result.errors.length}.` : ""}
                {result.skipped.length > 0 ? ` Пропущено: ${result.skipped.length}.` : ""}
              </Notice>
              {result.errors.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {result.errors.slice(0, 10).map((item) => (
                    <li key={item} className="font-mono text-[11px] text-destructive">{item}</li>
                  ))}
                </ul>
              ) : null}
              {result.skipped.length === 0 ? null : (
                <ul className="mt-1 space-y-0.5">
                  {result.skipped.slice(0, 10).map((item) => (
                    <li key={item.path} className="font-mono text-[11px] text-muted-foreground">
                      {item.path}: {item.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProjectsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<StateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [platformPath, setPlatformPath] = useState("");
  const [savingCommon, setSavingCommon] = useState(false);
  const platformPathDirty = useRef(false);
  const platformPathValue = useRef("");

  const loadState = useCallback(() => {
    rpc.call("state").then(
      (result) => {
        setState(result);
        if (!platformPathDirty.current) {
          platformPathValue.current = result.common.platformPath;
          setPlatformPath(result.common.platformPath);
        }
        setError(null);
      },
      (cause) => setError(reportError(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    loadState();
  }, [loadState]);
  useRealtime("projects-changed", loadState);

  const open = useCallback(
    (projectId: string) => {
      if (selected === projectId) {
        setSelected(null);
        setDetail(null);
        return;
      }
      setSelected(projectId);
      setDetail(null);
      setDetailError(null);
      rpc.call("project", { projectId }).then(setDetail, (cause) => setDetailError(reportError(cause)));
    },
    [rpc, selected],
  );

  const platforms = useMemo(() => {
    const seen = new Map<string, PlatformInfo>();
    for (const row of state?.projects ?? []) {
      for (const platform of row.platforms) seen.set(platform.path.toLowerCase(), platform);
    }
    return [...seen.values()].sort((a, b) => b.version.localeCompare(a.version));
  }, [state]);

  const saveCommon = async () => {
    setSavingCommon(true);
    const snapshot = platformPathValue.current;
    try {
      const saved = await rpc.call("saveCommon", { platformPath });
      if (platformPathValue.current === snapshot) {
        platformPathDirty.current = false;
        platformPathValue.current = saved.platformPath;
        setPlatformPath(saved.platformPath);
        setState((current) =>
          current === null
            ? current
            : { ...current, common: { ...current.common, platformPath: saved.platformPath } },
        );
      }
      setError(null);
    } catch (cause) {
      setError(reportError(cause));
    } finally {
      setSavingCommon(false);
    }
  };

  const updateDetailJob = useCallback((job: JobSnapshot) => {
    setDetail((current) =>
      current === null ? current : { ...current, state: { ...current.state, operation: job } },
    );
  }, []);

  const acceptDetail = (next: ProjectDetail) => {
    setDetail(next);
    loadState();
  };

  if (state === null) {
    return (
      <div className="mx-auto w-full max-w-4xl p-4 md:p-5">
        <Notice kind={error === null ? "info" : "error"}>
          {error === null ? "Загружаю проекты…" : error}
        </Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-5">
      {error === null ? null : <Notice kind="error">{error}</Notice>}

      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-medium">Общие настройки</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Путь к платформе по умолчанию для проектов, где своё значение не задано. Список платформ и баз
          собирается на машине проекта.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            className="min-w-64 flex-1"
            value={platformPath}
            onChange={(event) => {
              platformPathDirty.current = true;
              platformPathValue.current = event.target.value;
              setPlatformPath(event.target.value);
            }}
            disabled={savingCommon}
            list="1c-common-platforms"
            placeholder="C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe"
          />
          <datalist id="1c-common-platforms">
            {platforms.map((platform) => (
              <option key={platform.path} value={platform.path}>
                {platform.version}
              </option>
            ))}
          </datalist>
          <Button onClick={saveCommon} disabled={savingCommon || platformPath === state.common.platformPath}>
            <Icon name="Save" className="size-4" />
            Сохранить
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Параметры проекта: <code className="font-mono">{state.paramsRel}</code>; старый{" "}
          <code className="font-mono">{state.legacyParamsRel}</code> читается для совместимости.
        </p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Проекты</h3>
          <Button variant="ghost" size="sm" onClick={loadState}>
            <Icon name="RefreshCw" className="size-3.5" />
            Обновить
          </Button>
        </div>
        {state.projects.length === 0 ? (
          <Notice kind="info">В bb пока нет проектов с папкой-источником.</Notice>
        ) : (
          <ul className="space-y-2">
            {state.projects.map((row) => {
              const expanded = selected === row.projectId;
              return (
                <li key={row.projectId} className="overflow-hidden rounded-lg border border-border bg-card">
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-state-hover"
                    onClick={() => open(row.projectId)}
                    aria-expanded={expanded}
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        row.error !== null
                          ? "bg-destructive"
                          : row.hasFile
                            ? "bg-foreground"
                            : "border border-muted-foreground",
                      )}
                      aria-label={row.hasFile ? "Файл параметров есть" : "Файла параметров нет"}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{row.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{row.path}</span>
                    </span>
                    <span className="ml-auto hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
                      {row.error === null ? null : <span className="text-destructive">{row.error}</span>}
                      {row.bslflow.initialized ? <span className="rounded border border-border px-1.5 py-0.5">
                        {row.bslflow.enabled === false ? "BSL Flow отключён" : "BSL Flow"}
                      </span> : null}
                      {row.bslflow.initialized && !row.hasFile ? (
                        <span className="rounded border border-border px-1.5 py-0.5 text-foreground">заполни параметры</span>
                      ) : null}
                      {row.skills.total > 0 ? <span className="rounded border border-border px-1.5 py-0.5">{row.skills.total} ск.</span> : null}
                      {row.rlm.running ? <span className="rounded border border-border px-1.5 py-0.5">rlm</span> : null}
                      {row.effectivePlatformPath === "" ? null : (
                        <span className="truncate font-mono" title={row.effectivePlatformPath}>
                          {row.effectivePlatformPath}
                        </span>
                      )}
                    </span>
                    <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-4 shrink-0" />
                  </button>
                  {expanded ? (
                    detail !== null && detail.project.projectId === row.projectId ? (
                      <ProjectEditor
                        key={row.projectId}
                        row={detail.project}
                        detail={detail}
                        common={state.common}
                        onSaved={acceptDetail}
                        onCleared={acceptDetail}
                        onRefreshed={(next) => setDetail(next)}
                        onJob={updateDetailJob}
                        onClose={() => {
                          setSelected(null);
                          setDetail(null);
                        }}
                      />
                    ) : (
                      <div className="border-t border-border p-4">
                        <Notice kind={detailError === null ? "info" : "error"}>
                          {detailError === null ? "Загружаю параметры…" : detailError}
                        </Notice>
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettingsProjectsSection() {
  return (
    <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto overscroll-contain pr-1">
      <ProjectsSection />
    </div>
  );
}

function NavProjectsPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <ProjectsSection />
    </div>
  );
}

export default definePluginApp((app) => {
  registerEditor(app);
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "second-opinion",
    title: "Второе мнение", icon: "MessageSquare", component: ReviewPanel });
  app.slots.settingsSection({
    id: "projects",
    title: "Параметры 1С по проектам",
    description: "Подключение, платформа и операции Конфигуратора для каждого проекта bb.",
    component: SettingsProjectsSection,
  });
  app.slots.navPanel({
    id: "1c-projects",
    title: "1С: параметры",
    icon: "Database",
    path: "projects",
    component: NavProjectsPage,
  });
});
