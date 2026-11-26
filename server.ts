// bb-plugin-1c-properties — backend entry.
//
// Per-project 1C connection parameters live in <project>/.bb/1c-project.json.
// File and process work runs on the project's own machine through the host
// entry, so remote bb environments behave like the local one. The settings
// page, the `bb 1c-properties` CLI, and the agent tool all use the same RPC.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hostContract } from "./contract.js";
import type {
  ProjectParams,
  ProjectReadiness,
  ProjectState,
} from "./contract.js";
import type { ProjectRow } from "./rpc.js";
import { rpcContract } from "./rpc.js";
import type { ProjectDetail } from "./rpc.js";
import { LEGACY_PARAMS_REL, PARAMS_REL, canonical } from "./lib/shared.js";
import { editorConfigSchema } from "./editor/contract.js";
import { editorAvailable, registerEditorRoutes } from "./editor/server.js";
import { WORKFLOW_DISABLED } from "./lib/bslflow-fields.js";
import { shouldExposeRlmTools } from "./lib/agent-tools.js";
import { registerReview } from "./lib/review-server.js";
import {
  diagnosticImportSchema, platformActions, platformArtifactNameSchema, platformDashboardContract, platformProfileSchema, platformRequestSchema,
  platformRunIdSchema, platformRunOptions, platformScopeSchema,
  type PlatformJournalEntry,
  type PlatformPreview, type PlatformRequest, type PlatformScope,
} from "./platform-contract.js";
import { recordedPlatformVersion } from "./lib/infobases.js";

const CHANGED = "projects-changed";
const runCli = promisify(execFile);
const DISABLED_WORKFLOW_INSTRUCTIONS = [
  "Для этого проекта в BB явно выключен BSL Flow (workflow.enabled: false).",
  "Используй обычные правила проекта. Это решение действует и при наличии скиллов BSL Flow, bootstrap-файлов и общих инструкций для проектов 1С.",
  "Для этой задачи пропусти BSL Flow, его скиллы (включая 1c-spec, 1c-spec-review, 1c-task) и Council. Ревью выполняй обычным маршрутом проекта.",
  "Если при создании изменения OpenSpec в openspec/config.yaml осталась схема bsl-flow, явно передай --schema spec-driven в openspec new change либо выбери другую обычную схему, указанную проектом. Сохрани существующие настройки и изменения.",
].join("\n");

interface ProjectTarget {
  projectId: string;
  name: string;
  path: string;
  hostId: string;
  hostName: string;
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskParams(params: ProjectParams): ProjectParams {
  return {
    ...params,
    password: params.password === "" ? "" : "***",
    unlockCode: params.unlockCode === "" ? "" : "***",
  };
}

function effectivePlatform(params: ProjectParams, common: { platformPath: string }): string {
  return params.platformPath || common.platformPath;
}

function addSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} с`;
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

function formatJob(job: ProjectState["operation"]): string {
  if (job.state === "idle") return "Операций нет.";
  const lines = [
    `Состояние: ${job.state}`,
    `Операция: ${job.label}`,
    `Проект: ${job.title} (${job.path})`,
    `Каталог: ${job.dir}`,
    `Время: ${addSeconds(job.elapsedMs)}`,
    `Файлов: ${job.files}`,
  ];
  if (job.version !== "") lines.push(`Версия конфигурации: ${job.version}`);
  if (job.error !== "") lines.push(`Ошибка: ${job.error}`);
  if (job.log.trim() !== "") lines.push("", "Лог:", job.log.trim());
  return lines.join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("операция прервана"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    interceptChatOpen: {
      type: "boolean",
      label: "Редактор 1С — открывать ссылки на BSL и XML",
      default: true,
    },
    gitPath: {
      type: "string",
      label: "Редактор 1С — путь к Git (пусто для автоопределения)",
      default: "",
    },
    gitReadTimeoutSec: {
      type: "number",
      label: "Редактор 1С — таймаут чтения Git в секундах",
      default: 300,
    },
    platformPath: {
      type: "string",
      label: "Путь к платформе 1С по умолчанию (1cv8.exe или каталог bin)",
      default: "",
    },
    bslflowSkillsRoot: {
      type: "string",
      label: "Каталог skills BSL Flow (пусто — ~/.agents/skills)",
      default: "",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  registerEditorRoutes(bb, async () => {
    const { interceptChatOpen, gitPath, gitReadTimeoutSec } = await settings.get();
    return editorConfigSchema.parse({ interceptChatOpen, gitPath, gitReadTimeoutSec });
  }, (input, hostId, signal) => host.call("editorRequest", input, { hostId, signal }));
  /** Cached 1C project flags, used by the synchronous agent-config callback. */
  const projectKinds = new Map<string, boolean>();
  const rlmOptIn = new Map<string, boolean>();
  const workflowEnabled = new Map<string, boolean>();

  async function readCommon(): Promise<{
    platformPath: string;
    bslflowSkillsRoot: string;
  }> {
    const values = await settings.get();
    return {
      platformPath: values.platformPath.trim(),
      bslflowSkillsRoot: values.bslflowSkillsRoot.trim(),
    };
  }

  async function hostName(hostId: string): Promise<string> {
    try {
      const info = await bb.sdk.hosts.get({ hostId });
      return info.name;
    } catch {
      return hostId;
    }
  }

  async function resolveProjectSource(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
    if (source === undefined) {
      throw new Error(`у проекта «${project.name}» нет папки-источника`);
    }
    return { project, source };
  }

  /** Project + the source folder and machine its parameters belong to. */
  async function resolveTarget(projectId: string): Promise<ProjectTarget> {
    const { project, source } = await resolveProjectSource(projectId);
    return {
      projectId: project.id,
      name: project.name,
      path: canonical(source.path),
      hostId: source.hostId,
      hostName: await hostName(source.hostId),
    };
  }

  async function readState(target: ProjectTarget): Promise<ProjectState> {
    return host.call("projectState", { path: target.path }, { hostId: target.hostId });
  }

  function rowFrom(target: ProjectTarget, state: ProjectState, common: { platformPath: string }): ProjectRow {
    return {
      projectId: target.projectId,
      name: target.name,
      path: target.path,
      hostId: target.hostId,
      hostName: target.hostName,
      exists: state.exists,
      hasFile: state.hasFile,
      legacy: state.legacy,
      is1c: state.is1c,
      markers: state.markers,
      sourceGit: state.sourceGit,
      bslflow: state.bslflow,
      skills: state.skills,
      rlm: state.rlm,
      effectivePlatformPath: effectivePlatform(state.params, common),
      platformFromCommon: state.params.platformPath === "",
      platforms: state.platforms,
      error: null,
    };
  }

  function errorRow(target: ProjectTarget, message: string): ProjectRow {
    return {
      projectId: target.projectId,
      name: target.name,
      path: target.path,
      hostId: target.hostId,
      hostName: target.hostName,
      exists: false,
      hasFile: false,
      legacy: false,
      is1c: false,
      markers: [],
      sourceGit: { available: false, repository: null, detail: message },
      bslflow: {
        initialized: false,
        enabled: null,
        version: "",
        hasAgents: false,
        hasOpenspec: false,
        hasSentinel: false,
      },
      skills: {
        total: 0,
        bslflow: 0,
        sourceBslflow: "",
        updatedAt: null,
      },
      rlm: { installed: false, running: false, port: null, version: "", error: message },
      effectivePlatformPath: "",
      platformFromCommon: true,
      platforms: [],
      error: message,
    };
  }

  interface CollectedState {
    projects: ProjectRow[];
    platforms: ProjectRow["platforms"];
    infobases: ProjectState["infobases"];
    infobasesWebSkipped: number;
    operation: ProjectState["operation"];
  }

  async function collectState(): Promise<CollectedState> {
    const common = await readCommon();
    const projects = await bb.sdk.projects.list();
    const entries = projects.flatMap((project) => {
      const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
      return source === undefined ? [] : [{ project, source }];
    });

    const hostNames = new Map<string, string>();
    await Promise.all(
      [...new Set(entries.map((entry) => entry.source.hostId))].map(async (hostId) => {
        hostNames.set(hostId, await hostName(hostId));
      }),
    );

    const results = await Promise.all(
      entries.map(async ({ project, source }) => {
        const target: ProjectTarget = {
          projectId: project.id,
          name: project.name,
          path: canonical(source.path),
          hostId: source.hostId,
          hostName: hostNames.get(source.hostId) as string,
        };
        try {
          return { target, state: await readState(target) };
        } catch (error) {
          return { target, state: null, error: errorText(error) };
        }
      }),
    );

    const rows: ProjectRow[] = [];
    const platforms = new Map<string, ProjectRow["platforms"][number]>();
    let environment: ProjectState | null = null;

    for (const result of results) {
      if (result.state === null) {
        rows.push(errorRow(result.target, result.error));
        continue;
      }
      environment ??= result.state;
      projectKinds.set(result.target.projectId, result.state.is1c);
      rlmOptIn.set(result.target.projectId, result.state.rlmOptIn);
      for (const platform of result.state.platforms) {
        platforms.set(platform.path.toLowerCase(), platform);
      }
      rows.push(rowFrom(result.target, result.state, common));
    }

    return {
      projects: rows,
      platforms: [...platforms.values()],
      infobases: environment?.infobases ?? [],
      infobasesWebSkipped: environment?.infobasesWebSkipped ?? 0,
      operation: environment?.operation ?? {
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
      },
    };
  }

  async function detail(target: ProjectTarget): Promise<ProjectDetail> {
    const common = await readCommon();
    const state = await readState(target);
    projectKinds.set(target.projectId, state.is1c);
    rlmOptIn.set(target.projectId, state.rlmOptIn);
    return { project: rowFrom(target, state, common), state };
  }

  async function findProject(argument: string | undefined, fallbackProjectId?: string): Promise<ProjectTarget> {
    if (argument === undefined || argument.trim() === "") {
      if (fallbackProjectId !== undefined && fallbackProjectId !== "") return resolveTarget(fallbackProjectId);
      throw new Error("не указан проект: передай имя, id или путь проекта");
    }
    const value = argument.trim();
    const projects = await bb.sdk.projects.list();
    const byId = projects.find((project) => project.id === value);
    if (byId !== undefined) return resolveTarget(byId.id);
    const byPath = projects.find((project) =>
      project.sources.some((source) => canonical(source.path).toLowerCase() === canonical(value).toLowerCase()),
    );
    if (byPath !== undefined) return resolveTarget(byPath.id);
    const matches = projects.filter((project) => project.name.toLowerCase() === value.toLowerCase());
    if (matches.length === 1) return resolveTarget(matches[0].id);
    if (matches.length > 1) {
      throw new Error(
        `имя «${value}» неоднозначно: ${matches.map((project) => `${project.name} (${project.id})`).join(", ")}`,
      );
    }
    throw new Error(`проект «${value}» не найден. Посмотри список: bb 1c-properties list`);
  }

  async function checkProject(
    projectId: string,
    params: ProjectParams,
    signal?: AbortSignal,
  ) {
    const target = await resolveTarget(projectId);
    const common = await readCommon();
    return host.call(
      "checkConnection",
      { path: target.path, params, platformFallback: common.platformPath },
      { hostId: target.hostId, signal },
    );
  }

  async function startProjectOperation(
    projectId: string,
    operation: "dump" | "load" | "extensions",
    params: ProjectParams,
    options: {
      format?: "Hierarchical" | "Plain";
      update?: boolean;
      updateDb?: boolean;
      dynamic?: boolean;
      cleanLocks?: boolean;
    },
    signal?: AbortSignal,
  ) {
    const target = await resolveTarget(projectId);
    const common = await readCommon();
    const result = await host.call(
      "startOperation",
      {
        path: target.path,
        operation,
        params,
        platformFallback: common.platformPath,
        format: options.format ?? "Hierarchical",
        update: options.update === true,
        updateDb: options.updateDb !== false,
        dynamic: options.dynamic !== false,
        cleanLocks: options.cleanLocks === true,
      },
      { hostId: target.hostId, signal },
    );
    bb.realtime.publish(CHANGED, { reason: "operation", projectId });
    return result;
  }

  async function waitForJob(
    projectId: string,
    signal?: AbortSignal,
    timeoutMs = 60 * 60 * 1000,
  ): Promise<ProjectState["operation"]> {
    const target = await resolveTarget(projectId);
    const startedAt = Date.now();
    for (;;) {
      const result = await host.call("operationStatus", {}, { hostId: target.hostId, signal });
      if (result.job.state !== "running") return result.job;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`операция не завершилась за ${Math.round(timeoutMs / 60000)} мин`);
      }
      await sleep(1000, signal);
    }
  }

  async function resolvePlatformScope(scope: PlatformScope) {
    const project = await resolveTarget(scope.projectId);
    let environmentId = scope.environmentId;
    if (scope.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: scope.threadId });
      if (thread.projectId !== project.projectId || !thread.environmentId ||
          (environmentId && environmentId !== thread.environmentId)) {
        throw new Error("Тред не связан с указанным проектом и рабочей копией.");
      }
      environmentId = thread.environmentId;
    }
    if (!environmentId) return { project, target: project, source: project.path };
    const environment = await bb.sdk.environments.get({ environmentId });
    if (environment.projectId !== project.projectId || environment.status !== "ready" || !environment.path) {
      throw new Error("Рабочая копия проекта недоступна.");
    }
    const target = { ...project, path: environment.path, hostId: environment.hostId };
    return { project, target, source: target.hostId === project.hostId ? project.path : target.path, environmentId };
  }

  async function operationTarget(scope: PlatformScope) {
    const { target, project, source } = await resolvePlatformScope(scope);
    return { project, target, source, hostScope: { projectId: target.projectId, path: target.path }, hostId: target.hostId };
  }

  async function preparePlatform(scope: PlatformScope, request: PlatformRequest, signal?: AbortSignal) {
    const { hostScope, hostId, source } = await operationTarget(scope);
    const parameters = { ...hostScope, source, request, fallback: (await readCommon()).platformPath };
    const reply = await host.call("platformPreview", parameters, { hostId, signal });
    return { parameters, hostId, ...reply };
  }

  async function catalogSecret(name: string | undefined, scope: PlatformScope, signal?: AbortSignal): Promise<string> {
    if (!name) return "";
    try {
      const options = { signal, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 };
      let executable = process.env.BB_CLI || "bb";
      let prefix: string[] = [];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BB_SERVER_URL: bb.server.loopbackBaseUrl,
        BB_PROJECT_ID: scope.projectId,
        BB_THREAD_ID: scope.threadId ?? "",
      };
      if (process.platform === "win32" && !/\.exe$/i.test(executable)) {
        if (executable === "bb") {
          const { stdout } = await runCli("where.exe", ["bb.cmd"], options);
          executable = join(dirname(stdout.trim().split(/\r?\n/)[0]), "bb");
        } else if (basename(executable).toLowerCase() === "bb.cmd") {
          executable = join(dirname(executable), "bb");
        }
        // BB 0.50.1 can exit before its Windows IPC handles have closed.
        // BB can delegate the command to another Node process, so pass the drain through its environment.
        const drain = "const exit = process.exit.bind(process); process.exit = code => setTimeout(() => exit(code), 100);";
        env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=data:text/javascript,${encodeURIComponent(drain)}`].filter(Boolean).join(" ");
        prefix = [executable];
        executable = "node.exe";
      }
      const { stdout } = await runCli(executable, [
        ...prefix,
        "env-catalog", "get", name, "--raw", "--purpose", "1C Platform Operations",
      ], {
        ...options,
        env,
      });
      return stdout.replace(/\r?\n$/, "");
    } catch {
      throw new Error(`Секрет ${name} недоступен через Env Catalog.`);
    }
  }

  async function startPlatform(scope: PlatformScope, request: PlatformRequest, confirmation?: string, inspected?: string, signal?: AbortSignal) {
    const { parameters, hostId, preview, secrets } = await preparePlatform(scope, request, signal);
    if (preview.confirmation && preview.confirmation !== confirmation) {
      throw new Error("Подтверди действие, адрес базы и платформу по актуальному предпросмотру.");
    }
    if (preview.confirmation && preview.recovery && preview.recovery !== inspected) {
      throw new Error(`Подтверди проверку фактического состояния результата ${preview.recovery}.`);
    }
    const [password, unlockCode] = await Promise.all([
      catalogSecret(secrets.passwordSecret, scope, signal),
      catalogSecret(secrets.unlockCodeSecret, scope, signal),
    ]);
    const entry = await host.call("platformStart", {
      ...parameters, ...(confirmation ? { confirmation } : {}), ...(inspected ? { inspected } : {}),
      password, unlockCode, secretNames: secrets,
    }, { hostId, signal });
    bb.realtime.publish("platform-operations", { projectId: scope.projectId });
    return entry;
  }

  function formatPreview(preview: PlatformPreview): string {
    return [
      platformActions[preview.action],
      `Рабочая копия: ${preview.workspace}`,
      `Профиль: ${preview.profile} (${preview.kind})`,
      `Платформа: ${preview.platform}`,
      `База: ${preview.target}`,
      preview.input && `Вход: ${preview.input}`,
      preview.output && `Выход: ${preview.output}`,
      preview.extension && `Расширение: ${preview.extension}`,
      preview.config && `Настройки тестов: ${preview.config}`,
      preview.targetState,
      preview.recovery && `После проверки предыдущего запуска передай --inspected ${preview.recovery}`,
      preview.confirmation && `Для подтверждения передай --confirm ${preview.confirmation}`,
    ].filter(Boolean).join("\n");
  }

  registerReview(bb, {
    head: (path, hostId) => host.call("reviewHead", { path }, { hostId }),
    evidence: (path, hostId, change) => host.call("reviewEvidence", { path, change }, { hostId }),
    files: (path, hostId, target) => host.call("reviewFiles", { path, target }, { hostId }),
  });

  function dashboardEntry({ id, action, profile, kind, state, startedAt, finishedAt, revision, dirty, needsInspection, counts, artifacts }: PlatformJournalEntry) {
    return {
      id, action, profile, kind, state, startedAt, finishedAt, revision, dirty, needsInspection, counts,
      reports: artifacts.filter(({ kind }) => kind === "report" || kind === "log")
        .map(({ name }) => ({ id, name: platformArtifactNameSchema.parse(name) })),
    };
  }

  bb.rpc.register(platformDashboardContract, {
    async platformDashboardV1(scope) {
      const { hostScope, hostId } = await operationTarget(scope);
      const entries = await host.call("platformJournal", hostScope, { hostId });
      return {
        version: 1 as const,
        entries: entries.map(dashboardEntry),
      };
    },
    async platformDashboardV2(scope, { experimental_signal: signal }) {
      const { hostScope, hostId } = await operationTarget(scope);
      const [entries, diagnostics] = await Promise.all([
        host.call("platformJournal", hostScope, { hostId, signal }),
        host.call("diagnosticReports", hostScope, { hostId, signal }),
      ]);
      return {
        version: 2 as const,
        entries: entries.map((entry) => ({ ...dashboardEntry(entry), platformVersion: recordedPlatformVersion(entry.platform) })),
        diagnostics,
      };
    },
  }, { experimental_discoverable: true, experimental_description: "Сводка операций и диагностик 1С для дашборда" });

  bb.rpc.register(rpcContract, {
    async platformProfiles(scope) {
      const { hostScope, hostId, source } = await operationTarget(scope);
      return host.call("platformProfiles", { ...hostScope, source }, { hostId });
    },
    async platformSaveProfile({ profile, ...scope }) {
      const { source, hostId } = await operationTarget(scope);
      return host.call("platformSaveProfile", { path: source, profile }, { hostId });
    },
    async platformPreview({ request, ...scope }, { experimental_signal: signal }) {
      return (await preparePlatform(scope, request, signal)).preview;
    },
    async platformStart({ request, confirmation, inspected, ...scope }, { experimental_signal: signal }) {
      return startPlatform(scope, request, confirmation, inspected, signal);
    },
    async platformJournal(scope) {
      const { hostScope, hostId } = await operationTarget(scope);
      return host.call("platformJournal", hostScope, { hostId });
    },
    async platformStatus({ id, ...scope }) {
      const { hostScope, hostId } = await operationTarget(scope);
      return host.call("platformStatus", { ...hostScope, id }, { hostId });
    },
    async platformCancel({ id, ...scope }) {
      const { hostScope, hostId } = await operationTarget(scope);
      return host.call("platformCancel", { ...hostScope, id }, { hostId });
    },
    async platformArtifact({ id, name, ...scope }) {
      const { hostScope, hostId } = await operationTarget(scope);
      return host.call("platformArtifact", { ...hostScope, id, name }, { hostId });
    },
    async editorAvailability() { return { available: await editorAvailable(bb) }; },
    async projectReadiness({ probeUnica, ...scope }, { experimental_signal: signal }) {
      const { project, target, source, environmentId } = await resolvePlatformScope(scope);
      const { platformPath } = await readCommon();
      const options = { hostId: target.hostId, signal };
      const [files, testBase, inventory, name] = await Promise.all([
        host.call("readinessFiles", { path: target.path }, options),
        host.call("readinessTestBase", { path: target.path, source, platform: platformPath }, options),
        bb.sdk.plugins.list(),
        target.hostId === project.hostId ? project.hostName : hostName(target.hostId),
      ]);
      let unica: ProjectReadiness["unica"] = {
        status: "missing", detail: "Установите и включите bb-unica, чтобы проверять исходники из этого каталога.",
      };
      if (inventory.plugins.some(({ id, enabled }) => id === "bb-unica" && enabled)) {
        try {
          const report = await bb.sdk.plugins.callRpc({
            pluginId: "bb-unica",
            method: "diagnose",
            input: { projectId: scope.projectId, ...(environmentId ? { environmentId } : {}), probe: probeUnica === true },
            outputSchema: z.object({
              path: z.string(),
              runtime: z.object({ status: z.string(), packageVersion: z.string() }),
              source: z.object({ ok: z.boolean(), workspaceRoot: z.string().optional() }).nullable(),
            }),
            signal,
          });
          const samePath = (left: string, right: string) => left.replaceAll("\\", "/").replace(/\/$/, "") === right.replaceAll("\\", "/").replace(/\/$/, "");
          if (!samePath(report.path, target.path)) {
            unica = { status: "error", detail: "Unica вернула другое рабочее окружение." };
          } else if (report.source?.ok && report.source.workspaceRoot && samePath(report.source.workspaceRoot, target.path)) {
            unica = { status: "ready", detail: "Unica прочитала исходники из этого каталога." };
          } else if (report.runtime.status !== "ready") {
            unica = { status: "missing", detail: "Подготовьте рантайм на машине окружения во вкладке bb-unica." };
          } else if (probeUnica) {
            unica = { status: "error", detail: "Чтение исходников не подтверждено. Проверьте диагностику bb-unica." };
          } else {
            unica = { status: "unchecked", detail: "Рантайм установлен. Проверьте чтение исходников." };
          }
        } catch {
          unica = { status: "unchecked", detail: "Диагностика bb-unica недоступна. Проверьте плагин на машине окружения." };
        }
      }
      return {
        projectPath: project.path, path: target.path, hostName: name, files, testBase, unica,
        editor: !inventory.plugins.some(({ id, enabled }) => id === "bsl-editor" && enabled),
      };
    },
    async passport({ projectId, environmentId }, { experimental_signal: signal }) {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
      if (!source) throw new Error(`у проекта «${project.name}» нет папки-источника`);
      let path = source.path;
      let hostId = source.hostId;
      if (environmentId) {
        const environment = await bb.sdk.environments.get({ environmentId });
        if (environment.projectId !== project.id || environment.status !== "ready" || !environment.path) {
          throw new Error("рабочая папка не принадлежит проекту или недоступна");
        }
        path = environment.path;
        hostId = environment.hostId;
      }
      const passport = await host.call("passport", { path }, { hostId, signal });
      return { ...passport, sourceId: environmentId ? null : source.id, environmentId: environmentId ?? null, hostId };
    },
    async bslFlowConfig({ projectId }, { experimental_signal: signal }) {
      const target = await resolveTarget(projectId);
      return host.call("bslFlowConfig", { path: target.path }, { hostId: target.hostId, signal });
    },
    async saveBslFlowConfig({ projectId, revision, text }, { experimental_signal: signal }) {
      const target = await resolveTarget(projectId);
      const saved = await host.call("saveBslFlowConfig", { path: target.path, revision, text }, { hostId: target.hostId, signal });
      workflowEnabled.set(projectId, saved.enabled);
      bb.realtime.publish(CHANGED, { reason: "bslflow-settings", projectId });
      return saved;
    },
    async unicaOwnership() {
      // bb-unica v0.1.0 uses this RPC to claim the agent tools.
      return { version: 1 as const, mode: "external" as const };
    },
    async state() {
      const common = await readCommon();
      const collected = await collectState();
      return {
        projects: collected.projects,
        common,
        paramsRel: PARAMS_REL,
        legacyParamsRel: LEGACY_PARAMS_REL,
        infobases: collected.infobases,
        infobasesWebSkipped: collected.infobasesWebSkipped,
        operation: collected.operation,
      };
    },
    async project({ projectId }) {
      return detail(await resolveTarget(projectId));
    },
    async saveProject({ projectId, params }) {
      const target = await resolveTarget(projectId);
      const state = await host.call("saveParams", { path: target.path, params }, { hostId: target.hostId });
      bb.realtime.publish(CHANGED, { reason: "save", projectId });
      const common = await readCommon();
      return { project: rowFrom(target, state, common), state };
    },
    async clearProject({ projectId }) {
      const target = await resolveTarget(projectId);
      const state = await host.call("clearParams", { path: target.path }, { hostId: target.hostId });
      bb.realtime.publish(CHANGED, { reason: "clear", projectId });
      const common = await readCommon();
      return { project: rowFrom(target, state, common), state };
    },
    async saveCommon({ platformPath }) {
      const values = await settings.experimental_set({ platformPath: platformPath.trim() });
      bb.realtime.publish(CHANGED, { reason: "common" });
      return { platformPath: values.platformPath };
    },
    async checkConnection({ projectId, params }, context) {
      return checkProject(projectId, params, context.experimental_signal);
    },
    async startOperation(input, context) {
      const { projectId, operation, params, format, update, updateDb, dynamic, cleanLocks } = input;
      const result = await startProjectOperation(
        projectId,
        operation,
        params,
        { format, update, updateDb, dynamic, cleanLocks },
        context.experimental_signal,
      );
      return { job: result.job };
    },
    async operation({ projectId }) {
      const target = await resolveTarget(projectId);
      const result = await host.call("operationStatus", {}, { hostId: target.hostId });
      return { job: result.job };
    },
    async cancelOperation({ projectId }) {
      const target = await resolveTarget(projectId);
      const result = await host.call("cancelOperation", {}, { hostId: target.hostId });
      bb.realtime.publish(CHANGED, { reason: "cancel", projectId });
      return { job: result.job };
    },
    async initProject({ projectId }) {
      const target = await resolveTarget(projectId);
      const common = await readCommon();
      const result = await host.call(
        "initProject",
        { path: target.path, bslflowRoot: common.bslflowSkillsRoot },
        { hostId: target.hostId, timeoutMs: 240_000 },
      );
      bb.realtime.publish(CHANGED, { reason: "bslflow", projectId });
      return { ...result, detail: await detail(target) };
    },
    async connectSkills({ projectId }) {
      const target = await resolveTarget(projectId);
      const common = await readCommon();
      const result = await host.call(
        "connectSkills",
        {
          path: target.path,
          bslflowRoot: common.bslflowSkillsRoot,
          overwrite: true,
        },
        { hostId: target.hostId, timeoutMs: 120_000 },
      );
      bb.realtime.publish(CHANGED, { reason: "skills", projectId });
      return { ...result, detail: await detail(target) };
    },
    async rlmStatus({ projectId }) {
      const target = await resolveTarget(projectId);
      return host.call("rlmStatus", { path: target.path }, { hostId: target.hostId });
    },
    async rlmStart({ projectId }, context) {
      const target = await resolveTarget(projectId);
      return host.call(
        "rlmStart",
        { path: target.path },
        { hostId: target.hostId, signal: context.experimental_signal, timeoutMs: 600_000 },
      );
    },
    async rlmStop({ projectId }) {
      const target = await resolveTarget(projectId);
      return host.call("rlmStop", {}, { hostId: target.hostId });
    },
    async cleanupScan({ projectId }) {
      const target = await resolveTarget(projectId);
      return host.call(
        "cleanupScan",
        { path: target.path },
        { hostId: target.hostId, timeoutMs: 180_000 },
      );
    },
    async cleanupRun({ projectId, categories }) {
      const target = await resolveTarget(projectId);
      const result = await host.call(
        "cleanupRun",
        { path: target.path, categories },
        { hostId: target.hostId, timeoutMs: 600_000 },
      );
      bb.realtime.publish(CHANGED, { reason: "cleanup", projectId });
      return result;
    },
    async toolsStatus({ projectId }) {
      const target = await resolveTarget(projectId);
      return host.call("toolsStatus", {}, { hostId: target.hostId, timeoutMs: 60_000 });
    },
    async toolsCheck({ projectId }) {
      const target = await resolveTarget(projectId);
      return host.call("toolsCheck", {}, { hostId: target.hostId, timeoutMs: 180_000 });
    },
    async toolsEnsure({ projectId, update }) {
      const target = await resolveTarget(projectId);
      const result = await host.call(
        "toolsEnsure",
        { update },
        { hostId: target.hostId, timeoutMs: 900_000 },
      );
      return result;
    },
    async setRlmOptIn({ projectId, enabled }) {
      const target = await resolveTarget(projectId);
      const result = await host.call(
        "setRlmOptIn",
        { path: target.path, enabled },
        { hostId: target.hostId, timeoutMs: 30_000 },
      );
      rlmOptIn.set(projectId, result.enabled);
      bb.realtime.publish(CHANGED, { reason: "rlm-opt-in", projectId });
      return result;
    },
  });

  bb.agents.registerTool({
    name: "project_1c_params",
    description:
      "Read the effective 1C infobase, platform, user, and dump parameters of a bb project. " +
      "The password is never returned.",
    instructions:
      "Перед работой с базой 1С, выгрузкой или загрузкой конфигурации вызови project_1c_params, " +
      "чтобы взять путь к базе и платформе из параметров проекта, а не угадывать их.",
    presentation: {
      label: { pending: "Читаю параметры 1С", completed: "Прочитал параметры 1С" },
      icon: { glyph: "Database" },
    },
    parameters: z.object({ projectId: z.string().optional() }),
    async execute({ projectId }, context) {
      const id = projectId ?? context.projectId;
      if (id === null || id === undefined || id === "") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Не указан проект: передай projectId или вызови инструмент из потока проекта.",
            },
          ],
          isError: true,
        };
      }
      const target = await resolveTarget(id);
      const state = await readState(target);
      const common = await readCommon();
      const params = maskParams(state.params);
      const lines = [
        `Проект: ${target.name} (${target.path})`,
        `Машина: ${target.hostName}`,
        `Файл параметров: ${state.hasFile ? state.file : `нет (${state.file})`}${state.legacy ? " — читается .dsh/1c-project.json" : ""}`,
        `1С-проект: ${state.is1c ? `да (${state.markers.join(", ")})` : "нет"}`,
        `Путь к базе: ${params.infobasePath || "не задан"}`,
        `Пользователь: ${params.user || "не задан"}`,
        `Пароль: ${params.password === "" ? "не задан" : "задан"}`,
        `Платформа: ${effectivePlatform(state.params, common) || "не задана"}${
          state.params.platformPath === "" ? " (общая настройка)" : " (своя)"
        }`,
        `Код доступа: ${params.unlockCode === "" ? "не задан" : "задан"}`,
        `Каталог выгрузки: ${params.dumpDir || "корень проекта"}`,
        `Выгрузка в файлах: ${state.hasDump ? "есть Configuration.xml" : "нет"}`,
        `BSL Flow: ${state.bslflow.initialized ? `инициализирован${state.bslflow.version ? ` (${state.bslflow.version})` : ""}` : "не инициализирован"}`,
        `Скиллы проекта: ${state.skills.total}`,
        `rlm-tools-bsl: ${
          state.rlm.running
            ? `запущен на порту ${state.rlm.port ?? "?"}`
            : state.rlm.installed
              ? "установлен, не запущен"
              : "не установлен"
        }${state.rlm.error === "" ? "" : ` — ${state.rlm.error}`}`,
      ];
      return lines.join("\n");
    },
  });

  const RLM_TOOL_NAMES = [
    "rlm_start",
    "rlm_execute",
    "rlm_end",
    "rlm_help",
    "rlm_projects",
    "rlm_index",
  ];

  const nullableString = { type: ["string", "null"] };
  const nullableDomains = {
    anyOf: [
      { type: "array", items: { type: "string" } },
      { type: "string" },
      { type: "null" },
    ],
  };

  const rlmTools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> = [
    {
      name: "rlm_start",
      description:
        "Открыть анализ исходников 1С/BSL: запрос и проект. Дальше работа идёт через rlm_execute.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Что нужно найти или разобрать" },
          domains: { ...nullableDomains, description: "документ | структура | код | связи | расширения | поиск | весь каталог" },
          path: { ...nullableString, description: "Корень конфигурации; по умолчанию корень проекта" },
          project: { ...nullableString, description: "Имя зарегистрированного проекта rlm" },
          effort: { type: "string", default: "auto", description: "auto|low|medium|high|max" },
          max_output_chars: { type: "integer", default: 15000 },
          max_llm_calls: { type: ["integer", "null"] },
          max_execute_calls: { type: ["integer", "null"] },
          execution_timeout_seconds: { type: "integer", default: 45 },
          include_metadata: { type: "boolean", default: false },
        },
        required: ["query"],
      },
    },
    {
      name: "rlm_execute",
      description:
        "Выполнить Python-код с хелперами rlm в открытой сессии; переменные сохраняются между вызовами.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", default: "" },
          sid: { type: "string", default: "" },
          code: { type: "string", description: "Python с хелперами rlm" },
          detail_level: { type: "string", enum: ["compact", "usage", "full"], default: "compact" },
          max_new_variables: { type: "integer", default: 20 },
          domains: { ...nullableDomains, description: "Догрузить домены хелперов" },
        },
        required: ["code"],
      },
    },
    {
      name: "rlm_end",
      description: "Закрыть сессию rlm и освободить ресурсы.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", default: "" },
          sid: { type: "string", default: "" },
        },
      },
    },
    {
      name: "rlm_help",
      description:
        "Справка rlm: тема, домен хелперов, категория, раздел или подписи конкретных хелперов.",
      parameters: {
        type: "object",
        properties: {
          topic: nullableString,
          helpers: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          category: {
            anyOf: [
              {
                type: "string",
                enum: ["discovery", "code", "xml", "composite", "business", "extension", "navigation"],
              },
              { type: "null" },
            ],
          },
          section: {
            anyOf: [
              {
                type: "string",
                enum: ["workflow", "disambiguation", "performance", "batching", "io", "critical", "coverage"],
              },
              { type: "null" },
            ],
          },
          format: { type: "string", enum: ["compact", "full"], default: "compact" },
          include_code: { type: "boolean", default: true },
          domain: nullableDomains,
        },
      },
    },
    {
      name: "rlm_projects",
      description:
        "Список или изменение зарегистрированных проектов rlm. Изменения требуют пароль проекта — спроси пользователя.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove", "rename", "update"] },
          name: nullableString,
          path: nullableString,
          description: nullableString,
          new_name: nullableString,
          password: nullableString,
          clear_password: { type: "boolean", default: false },
        },
        required: ["action"],
      },
    },
    {
      name: "rlm_index",
      description:
        "Построить, обновить, показать или удалить индекс rlm. Изменения требуют проект и пароль.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["build", "update", "info", "drop"] },
          path: nullableString,
          project: nullableString,
          no_calls: { type: "boolean", default: false },
          no_metadata: { type: "boolean", default: false },
          no_fts: { type: "boolean", default: false },
          no_synonyms: { type: "boolean", default: false },
          confirm: nullableString,
        },
        required: ["action"],
      },
    },
  ];

  for (const definition of rlmTools) {
    bb.agents.registerTool({
      name: definition.name,
      description: definition.description,
      instructions:
        "Инструменты rlm работают с исходниками 1С: сначала rlm_start, затем rlm_execute, в конце rlm_end. " +
        "Не заменяй ими чтение файлов, если вопрос простой.",
      presentation: {
        label: { pending: `Выполняю ${definition.name}`, completed: `Выполнил ${definition.name}` },
        icon: { glyph: "Database" },
      },
      parameters: definition.parameters,
      async execute(args, context) {
        const target = await resolveTarget(context.projectId);
        const toolArgs = { ...(args as Record<string, unknown>) };
        if (definition.name === "rlm_start" && toolArgs.path == null && toolArgs.project == null) {
          toolArgs.path = target.path;
        }
        const result = await host.call(
          "rlmCall",
          { path: target.path, tool: definition.name, arguments: toolArgs },
          { hostId: target.hostId, signal: context.signal, timeoutMs: 300_000 },
        );
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }
        return result.text;
      },
    });
  }

  // A call that opened the confirmation form is detached from its request: bb
  // delivers its result as a system message, and there a successful result
  // steers the running turn or starts a new one, while an `isError` result only
  // steers. A failure reported as `isError` therefore reaches nobody once the
  // turn has ended, so failures that happen after the form was opened are
  // returned as a successful result whose text states the failure explicitly.
  // The configure callback is synchronous. Refresh the project setting on the
  // source host before dispatch, including when nobody has opened the card yet.
  bb.experimental_hooks.on("message.dispatch", async ({ attempt, project }) => {
    if (attempt === "start-turn" && project.kind === "standard") {
      try {
        const { source } = await resolveProjectSource(project.id);
        const enabled = await host.call("workflowEnabled", { path: source.path }, {
          hostId: source.hostId, timeoutMs: 2_000,
        });
        if (enabled === null) workflowEnabled.delete(project.id);
        else workflowEnabled.set(project.id, enabled);
      } catch (error) {
        workflowEnabled.delete(project.id);
        bb.log.warn(`Не удалось прочитать режим BSL Flow проекта ${project.id}: ${errorText(error)}`);
      }
    }
    return { action: "proceed" };
  });

  bb.agents.configure((context) => {
    const isOneC = projectKinds.get(context.project.id) ?? true;
    const instructions = workflowEnabled.get(context.project.id) === false
      ? DISABLED_WORKFLOW_INSTRUCTIONS
      : undefined;
    if (!isOneC) {
      return { tools: ["project_1c_params"], skills: ["1c-project-properties"], instructions };
    }
    const useRlm = shouldExposeRlmTools(
      isOneC,
      rlmOptIn.get(context.project.id) ?? false,
    );
    return {
      instructions,
      tools: [
        "project_1c_params",
        ...(useRlm ? RLM_TOOL_NAMES : []),
      ],
      skills: [
        "1c-project-properties",
        ...(useRlm ? ["rlm-tools-bsl"] : []),
      ],
    };
  });

  const warmup = setTimeout(() => {
    collectState().catch(() => {
      // A failed warm-up scan must not affect plugin activation.
    });
  }, 1500);

  const cliUsage = [
    "Usage:",
    "  bb 1c-properties list [--json]",
    "  bb 1c-properties show [проект] [--json]",
    "  bb 1c-properties check [проект] [--json]",
    "  bb 1c-properties dump [проект] [--dir <каталог>] [--format hierarchical|plain] [--update] [--clean-locks] [--no-wait] [--json]",
    "  bb 1c-properties load [проект] --yes [--dir <каталог>] [--format hierarchical|plain] [--no-update-db] [--no-dynamic] [--no-wait] [--json]",
    "  bb 1c-properties extensions [проект] [--dir <каталог>] [--clean-locks] [--no-wait] [--json]",
    "  bb 1c-properties status [проект] [--json]",
    "  bb 1c-properties cancel [проект] [--json]",
    "  bb 1c-properties init [проект] [--json]",
    "  bb 1c-properties skills [проект] [--json]",
    "  bb 1c-properties rlm <tool> [--args '<json>'] [--args-file <путь>] [--project <проект>] [--json]",
    "  bb 1c-properties cleanup [проект] [--scan] [--categories temp,agent-scratch|all] [--yes] [--json]",
    "  bb 1c-properties tools [проект] [--check] [--update] [--json]",
    "",
    "Проект — имя, id или путь. Без него берётся проект текущего потока.",
  ].join("\n");

  const VALUE_OPTIONS = new Set([
    "thread", "environment", "profile", "input", "output", "extension", "config", "confirm", "inspected", "artifact",
    "finished-at", "revision",
    "dir",
    "format",
    "timeout",
    "args",
    "args-file",
    "project",
    "categories",
  ]);

  function parseArgv(argv: string[]) {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const positionals: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === "--") {
        positionals.push(...argv.slice(index + 1));
        break;
      }
      if (!argument.startsWith("--")) {
        positionals.push(argument);
        continue;
      }
      const equals = argument.indexOf("=");
      if (equals > 0) {
        values.set(argument.slice(2, equals), argument.slice(equals + 1));
        continue;
      }
      const name = argument.slice(2);
      const next = argv[index + 1];
      if (VALUE_OPTIONS.has(name) && next !== undefined && !next.startsWith("--")) {
        values.set(name, next);
        index += 1;
        continue;
      }
      flags.add(name);
    }
    return { flags, values, positionals };
  }

  function formatParams(state: ProjectState, common: { platformPath: string }): string {
    const params = maskParams(state.params);
    return [
      `Файл параметров: ${state.hasFile ? state.file : `нет (${state.file})`}${state.legacy ? " — читается .dsh/1c-project.json" : ""}`,
      `1С-проект: ${state.is1c ? `да (${state.markers.join(", ")})` : "нет"}`,
      `Путь к базе: ${params.infobasePath || "не задан"}`,
      `Пользователь: ${params.user || "не задан"}`,
      `Пароль: ${params.password === "" ? "не задан" : "задан"}`,
      `Платформа: ${effectivePlatform(state.params, common) || "не задана"}${
        state.params.platformPath === "" ? " (общая настройка)" : " (своя)"
      }`,
      `Код доступа: ${params.unlockCode === "" ? "не задан" : "задан"}`,
      `Каталог выгрузки: ${params.dumpDir || "корень проекта"}`,
      `Выгрузка в файлах: ${state.hasDump ? "есть Configuration.xml" : "нет"}`,
    ].join("\n");
  }

  async function runPlatformCommand(
    { flags, values, positionals }: ReturnType<typeof parseArgv>,
    context: { projectId?: string; threadId?: string; signal?: AbortSignal },
  ) {
    const [verb = "help", first] = positionals;
    const reference = (["preview", "run", "show", "cancel", "artifact", "import-diagnostics"].includes(verb) ? positionals[2] : first) ?? values.get("project");
    const respond = (value: unknown, message = "", exitCode = 0) => ({
      exitCode, stdout: flags.has("json") ? JSON.stringify(value, null, 2) : message || JSON.stringify(value, null, 2),
    });
    if (verb === "help" || flags.has("help")) {
      return respond(Object.keys(platformActions), [
        "bb 1c-properties platform preview|run <операция> [проект]",
        "  [--thread ID | --environment ID] [--profile ИМЯ] [--input ПУТЬ] [--output ПУТЬ]",
        "  [--extension ИМЯ] [--config JSON] [--format Hierarchical|Plain] [--json]",
        "  run: [--confirm КОД] [--inspected ID] [--no-wait]",
        "bb 1c-properties platform profiles|journal [проект] [--json]",
        "bb 1c-properties platform save-profile [проект] --args-file <JSON>",
        "bb 1c-properties platform show|cancel|artifact <ID> [проект] [--artifact ИМЯ]",
        "bb 1c-properties platform import-diagnostics bsl-ls|apk [проект]",
        "  --environment ID --input ПУТЬ --finished-at ISO8601 [--revision SHA] [--profile ИМЯ] [--json]",
        "", ...Object.entries(platformActions).map(([name, label]) => `  ${name}  ${label}`),
      ].join("\n"));
    }
    const project = await findProject(reference, context.projectId);
    const scope = platformScopeSchema.parse({
      projectId: project.projectId,
      threadId: values.get("thread") ?? (!values.has("environment") && context.projectId === project.projectId ? context.threadId : undefined),
      environmentId: values.get("environment"),
    });
    const { hostScope, hostId, source } = await operationTarget(scope);
    const options = { hostId, signal: context.signal };
    switch (verb) {
      case "profiles":
        return respond(await host.call("platformProfiles", { ...hostScope, source }, options));
      case "save-profile": {
        const parsed = readJsonArgs(values);
        if (parsed.error) throw new Error(parsed.error);
        return respond(await host.call("platformSaveProfile", { path: source, profile: platformProfileSchema.parse(parsed.args) }, options));
      }
      case "journal":
        return respond(await host.call("platformJournal", hostScope, options));
      case "import-diagnostics": {
        if (!scope.threadId && !scope.environmentId) throw new Error("Выбери рабочую копию через --environment или --thread.");
        const report = diagnosticImportSchema.parse({
          tool: first, file: values.get("input"), finishedAt: values.get("finished-at"),
          revision: values.get("revision"), profile: values.get("profile"),
        });
        return respond(await host.call("diagnosticImport", { ...hostScope, report }, options));
      }
      case "show":
      case "cancel": {
        const id = platformRunIdSchema.parse(first);
        const result = await host.call(verb === "show" ? "platformStatus" : "platformCancel", { ...hostScope, id }, options);
        if (!result) throw new Error("Операция в этой рабочей копии не найдена.");
        return respond(result);
      }
      case "artifact": {
        const id = platformRunIdSchema.parse(first);
        const name = platformArtifactNameSchema.parse(values.get("artifact"));
        const artifact = await host.call("platformArtifact", { ...hostScope, id, name }, options);
        return respond(artifact, artifact.text);
      }
      case "preview":
      case "run": {
        const request = platformRequestSchema.parse({
          action: first, profile: values.get("profile"), input: values.get("input"), output: values.get("output"),
          extension: values.get("extension"), config: values.get("config"), format: values.get("format"),
        });
        if (verb === "preview") {
          const { preview } = await preparePlatform(scope, request, context.signal);
          return respond(preview, formatPreview(preview));
        }
        const confirmation = platformRunOptions.confirmation.parse(values.get("confirm"));
        const inspected = platformRunOptions.inspected.parse(values.get("inspected"));
        let entry = await startPlatform(scope, request, confirmation, inspected, context.signal);
        if (!flags.has("no-wait")) {
          while (entry.state === "running") {
            await sleep(500, context.signal);
            const current = await host.call("platformStatus", { ...hostScope, id: entry.id }, options);
            if (!current) throw new Error(`Запуск ${entry.id} недоступен. Проверь журнал перед повтором.`);
            entry = current;
          }
        }
        return respond(entry, "", ["failed", "cancelled", "interrupted"].includes(entry.state) ? 1 : 0);
      }
      default:
        throw new Error("Неизвестная команда platform. Справка: bb 1c-properties platform --help");
    }
  }

  function formatCheck(result: Awaited<ReturnType<typeof checkProject>>): string {
    const lines = result.steps.map((step) => `${step.ok ? "OK" : "ОШИБКА"}  ${step.label}: ${step.detail}`);
    lines.push(`Итог: ${result.ok ? "база открывается" : "подключение не подтверждено"} (${addSeconds(result.elapsedMs)})`);
    return lines.join("\n");
  }

  function readJsonArgs(values: Map<string, string>): { args: Record<string, unknown>; error: string } {
    const rawFile = values.get("args-file");
    const raw = values.get("args");
    try {
      if (rawFile !== undefined && rawFile.trim() !== "") {
        const parsed: unknown = JSON.parse(readFileSync(rawFile, "utf-8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { args: {}, error: "аргументы должны быть JSON-объектом" };
        }
        return { args: parsed as Record<string, unknown>, error: "" };
      }
      if (raw !== undefined && raw.trim() !== "") {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { args: {}, error: "аргументы должны быть JSON-объектом" };
        }
        return { args: parsed as Record<string, unknown>, error: "" };
      }
      return { args: {}, error: "" };
    } catch (error) {
      return { args: {}, error: `не удалось разобрать JSON аргументов: ${errorText(error)}` };
    }
  }

  async function runOperationCommand(
    command: "dump" | "load" | "extensions",
    parsed: { flags: Set<string>; values: Map<string, string>; positionals: string[] },
    context: { projectId?: string; signal?: AbortSignal },
  ) {
    const { flags, values, positionals } = parsed;
    const json = flags.has("json");
    const project = await findProject(positionals[0], context.projectId);
    const state = await readState(project);
    if (command === "load" && !flags.has("yes")) {
      return {
        exitCode: 1,
        stderr:
          "Загрузка заменит конфигурацию базы данными из файлов; откат возможен только из твоего бэкапа. " +
          "Повтори с --yes, когда решение принято.",
      };
    }
    const format = values.get("format") === "plain" ? "Plain" : "Hierarchical";
    const params: ProjectParams = {
      ...state.params,
      ...(values.get("dir") !== undefined ? { dumpDir: values.get("dir") as string } : {}),
    };
    const result = await startProjectOperation(
      project.projectId,
      command,
      params,
      {
        format,
        update: flags.has("update"),
        updateDb: !flags.has("no-update-db"),
        dynamic: !flags.has("no-dynamic"),
        cleanLocks: flags.has("clean-locks"),
      },
      context.signal,
    );
    if (flags.has("no-wait")) {
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify(result.job) : formatJob(result.job),
      };
    }
    const timeoutMinutes = Number(values.get("timeout") ?? "60");
    const job = await waitForJob(
      project.projectId,
      context.signal,
      Math.max(1, timeoutMinutes) * 60 * 1000,
    );
    const text = formatJob(job);
    if (job.state !== "done") return { exitCode: 1, stderr: json ? JSON.stringify(job) : text };
    return { exitCode: 0, stdout: json ? JSON.stringify(job) : text };
  }

  bb.cli.register({
    name: "1c-properties",
    summary: "Параметры 1С по проектам: подключение, проверка, выгрузка и загрузка конфигурации",
    commands: [
      { name: "platform", summary: "Операции платформы 1С и журнал", usage: "bb 1c-properties platform <команда> …" },
      { name: "list", summary: "Список проектов и наличие параметров", usage: "bb 1c-properties list [--json]" },
      { name: "show", summary: "Параметры проекта", usage: "bb 1c-properties show [проект] [--json]" },
      { name: "check", summary: "Проверить подключение к базе", usage: "bb 1c-properties check [проект] [--json]" },
      {
        name: "dump",
        summary: "Выгрузить конфигурацию в файлы",
        usage: "bb 1c-properties dump [проект] [--dir <каталог>] [--update] [--no-wait]",
      },
      {
        name: "load",
        summary: "Загрузить конфигурацию из файлов в базу",
        usage: "bb 1c-properties load [проект] --yes [--no-update-db] [--no-dynamic]",
      },
      {
        name: "extensions",
        summary: "Выгрузить все расширения базы",
        usage: "bb 1c-properties extensions [проект] [--dir <каталог>]",
      },
      { name: "status", summary: "Состояние операции", usage: "bb 1c-properties status [проект] [--json]" },
      { name: "cancel", summary: "Отменить операцию", usage: "bb 1c-properties cancel [проект] [--json]" },
      {
        name: "init",
        summary: "Инициализировать BSL Flow и подключить скиллы",
        usage: "bb 1c-properties init [проект] [--json]",
      },
      {
        name: "skills",
        summary: "Подключить или обновить скиллы BSL Flow",
        usage: "bb 1c-properties skills [проект] [--json]",
      },
      {
        name: "rlm",
        summary: "Вызвать инструмент rlm-tools-bsl",
        usage: "bb 1c-properties rlm <tool> [--args '<json>'] [--args-file <путь>] [--project <проект>] [--json]",
      },
      {
        name: "cleanup",
        summary: "Оценить и удалить временные и сборочные файлы проекта",
        usage: "bb 1c-properties cleanup [проект] [--scan] [--categories <ids|all>] [--yes] [--json]",
      },
      {
        name: "tools",
        summary: "Версия BSL Flow, проверка и установка обновлений",
        usage: "bb 1c-properties tools [проект] [--check] [--update] [--json]",
      },
    ],
    async run(argv, context) {
      const { flags, values, positionals } = parseArgv(argv);
      const command = positionals.shift();
      const json = flags.has("json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: cliUsage };
          case "list": {
            const common = await readCommon();
            const collected = await collectState();
            if (json) {
              return reply({ paramsRel: PARAMS_REL, common, projects: collected.projects }, "");
            }
            if (collected.projects.length === 0) return { exitCode: 0, stdout: "Проектов нет." };
            const lines = collected.projects.map(
              (row) =>
                `${row.hasFile ? "●" : "○"} ${row.name}  ${row.path}${row.error === null ? "" : `  (${row.error})`}`,
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "show": {
            const project = await findProject(positionals[0], context.projectId);
            const state = await readState(project);
            const common = await readCommon();
            if (json) {
              return reply(
                {
                  project: { id: project.projectId, name: project.name, path: project.path, host: project.hostName },
                  file: state.file,
                  hasFile: state.hasFile,
                  legacy: state.legacy,
                  params: maskParams(state.params),
                  effectivePlatformPath: effectivePlatform(state.params, common),
                  platformFromCommon: state.params.platformPath === "",
                  is1c: state.is1c,
                  markers: state.markers,
                },
                "",
              );
            }
            return {
              exitCode: 0,
              stdout: `Проект: ${project.name} (${project.path})\nМашина: ${project.hostName}\n${formatParams(state, common)}`,
            };
          }
          case "check": {
            const project = await findProject(positionals[0], context.projectId);
            const state = await readState(project);
            const result = await checkProject(project.projectId, state.params, context.signal);
            if (json) return reply(result, "");
            return { exitCode: result.ok ? 0 : 1, stdout: formatCheck(result) };
          }
          case "dump":
          case "load":
          case "extensions":
            return runOperationCommand(command, { flags, values, positionals }, context);
          case "platform":
            return await runPlatformCommand({ flags, values, positionals }, context);
          case "status": {
            const project = await findProject(positionals[0], context.projectId);
            const target = await resolveTarget(project.projectId);
            const result = await host.call("operationStatus", {}, { hostId: target.hostId });
            if (json) return reply(result.job, "");
            return { exitCode: 0, stdout: formatJob(result.job) };
          }
          case "cancel": {
            const project = await findProject(positionals[0], context.projectId);
            const target = await resolveTarget(project.projectId);
            const result = await host.call("cancelOperation", {}, { hostId: target.hostId });
            bb.realtime.publish(CHANGED, { reason: "cancel", projectId: project.projectId });
            if (json) return reply(result.job, "");
            return { exitCode: 0, stdout: formatJob(result.job) };
          }
          case "init": {
            const project = await findProject(positionals[0], context.projectId);
            if ((await readState(project)).bslflow.enabled === false) {
              return { exitCode: 1, stderr: WORKFLOW_DISABLED };
            }
            const common = await readCommon();
            const tools = await host.call(
              "toolsEnsure",
              { update: true },
              { hostId: project.hostId, timeoutMs: 900_000 },
            );
            if (!tools.ok) {
              return { exitCode: 1, stderr: `инструменты: ${tools.log.join("; ")}` };
            }
            const init = await host.call(
              "initProject",
              { path: project.path, bslflowRoot: common.bslflowSkillsRoot },
              { hostId: project.hostId, timeoutMs: 240_000 },
            );
            if (!init.ok) return { exitCode: 1, stderr: init.error };
            const skills = await host.call(
              "connectSkills",
              {
                path: project.path,
                bslflowRoot: common.bslflowSkillsRoot,
                overwrite: true,
              },
              { hostId: project.hostId, timeoutMs: 120_000 },
            );
            bb.realtime.publish(CHANGED, { reason: "init", projectId: project.projectId });
            if (json) return reply({ tools, init, skills }, "");
            return {
              exitCode: 0,
              stdout: [
                `BSL Flow: ${tools.state.bslflow.installed ? tools.state.bslflow.version : "не установлен"}`,
                `BSL Flow: создано ${init.created.length}, сохранено ${init.preserved.length}`,
                ...init.created.map((item) => `  + ${item}`),
                `Скиллы: скопировано ${skills.copied.length}, сохранено ${skills.preserved.length}, удалено ${skills.removed.length}, пропущено ${skills.skipped.length}`,
                "Заполни параметры базы в панели «1С: параметры».",
              ].join("\n"),
            };
          }
          case "skills": {
            const project = await findProject(positionals[0], context.projectId);
            const common = await readCommon();
            const skills = await host.call(
              "connectSkills",
              {
                path: project.path,
                bslflowRoot: common.bslflowSkillsRoot,
                overwrite: true,
              },
              { hostId: project.hostId, timeoutMs: 120_000 },
            );
            bb.realtime.publish(CHANGED, { reason: "skills", projectId: project.projectId });
            if (json) return reply(skills, "");
            return {
              exitCode: skills.ok ? 0 : 1,
              stdout: [
                `Скопировано: ${skills.copied.length}`,
                `Сохранено: ${skills.preserved.length}`,
                `Удалено: ${skills.removed.length}`,
                `Пропущено: ${skills.skipped.length}`,
                ...(skills.error === "" ? [] : [`Ошибка: ${skills.error}`]),
              ].join("\n"),
            };
          }
          case "rlm": {
            const tool = positionals[0];
            if (tool === undefined) return { exitCode: 1, stderr: cliUsage };
            const project = await findProject(values.get("project"), context.projectId);
            let args: Record<string, unknown> = {};
            const rawArgsFile = values.get("args-file");
            const rawArgs = values.get("args");
            try {
              if (rawArgsFile !== undefined && rawArgsFile.trim() !== "") {
                const parsed: unknown = JSON.parse(readFileSync(rawArgsFile, "utf-8"));
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                  return { exitCode: 1, stderr: "аргументы rlm должны быть JSON-объектом" };
                }
                args = parsed as Record<string, unknown>;
              } else if (rawArgs !== undefined && rawArgs.trim() !== "") {
                const parsed: unknown = JSON.parse(rawArgs);
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                  return { exitCode: 1, stderr: "аргументы rlm должны быть JSON-объектом" };
                }
                args = parsed as Record<string, unknown>;
              }
            } catch (error) {
              return {
                exitCode: 1,
                stderr: `не удалось разобрать JSON аргументов: ${errorText(error)}`,
              };
            }
            if (tool === "rlm_start" && args.path === undefined && args.project === undefined) {
              args.path = project.path;
            }
            const result = await host.call(
              "rlmCall",
              { path: project.path, tool, arguments: args },
              { hostId: project.hostId, signal: context.signal, timeoutMs: 300_000 },
            );
            if (json) return reply(result, "");
            if (!result.ok) return { exitCode: 1, stderr: result.error };
            return { exitCode: 0, stdout: result.text };
          }
          case "tools": {
            const project = await findProject(positionals[0], context.projectId);
            const update = flags.has("update");
            const check = flags.has("check") || update;
            if (update) {
              const result = await host.call(
                "toolsEnsure",
                { update: true },
                { hostId: project.hostId, timeoutMs: 900_000 },
              );
              if (json) return reply(result, "");
              return {
                exitCode: result.ok ? 0 : 1,
                stdout: [
                  ...result.log,
                  `BSL Flow: ${result.state.bslflow.installed ? result.state.bslflow.version : "не установлен"}`,
                ].join("\n"),
              };
            }
            const state = check
              ? await host.call("toolsCheck", {}, { hostId: project.hostId, timeoutMs: 180_000 })
              : await host.call("toolsStatus", {}, { hostId: project.hostId, timeoutMs: 60_000 });
            if (json) return reply(state, "");
            const describe = (label: string, info: typeof state.bslflow) =>
              `${label}: ${info.installed ? info.version : "не установлен"}` +
              `${info.latest === "" ? "" : `; последняя ${info.latest}`}` +
              `${info.updateAvailable ? " — есть обновление" : ""}` +
              `${info.error === "" ? "" : `; ошибка: ${info.error}`}`;
            return {
              exitCode: 0,
              stdout: [
                describe("BSL Flow", state.bslflow),
              ].join("\n"),
            };
          }
          case "cleanup": {
            const project = await findProject(positionals[0], context.projectId);            const scan = await host.call(
              "cleanupScan",
              { path: project.path },
              { hostId: project.hostId, timeoutMs: 180_000 },
            );
            const categoriesArg = values.get("categories");
            const explicit = categoriesArg !== undefined && categoriesArg.trim() !== "";
            if (flags.has("scan") || !explicit) {
              if (json) return reply(scan, "");
              const hotCount = scan.categories.reduce(
                (sum, entry) => sum + entry.items.filter((candidate) => candidate.hot).length,
                0,
              );
              return {
                exitCode: 0,
                stdout: [
                  `Проект: ${formatBytes(scan.projectBytes)} (${scan.projectFiles} файлов)`,
                  `Временные и сборочные: ${formatBytes(scan.totalBytes)}`,
                  ...scan.categories.map(
                    (entry) =>
                      `${entry.safe ? "✓" : "!"} ${entry.id}  ${formatBytes(entry.bytes)}  ${entry.title}`,
                  ),
                  ...(hotCount > 0
                    ? [`Изменены меньше часа назад и не удаляются: ${hotCount}`]
                    : []),
                  "Удаление: --categories <ids|all> --yes",
                ].join("\n"),
              };
            }
            const ids =
              categoriesArg.trim() === "all"
                ? scan.categories.map((entry) => entry.id)
                : categoriesArg.split(",").map((value) => value.trim()).filter(Boolean);
            const known = new Set(scan.categories.map((entry) => entry.id));
            const unknown = ids.filter((id) => !known.has(id));
            if (unknown.length > 0) {
              return {
                exitCode: 1,
                stderr: `неизвестные категории: ${unknown.join(", ")}; доступны: ${[...known].join(", ")}`,
              };
            }
            const selectedBytes = scan.categories
              .filter((entry) => ids.includes(entry.id))
              .reduce((sum, entry) => sum + entry.bytes, 0);
            if (!flags.has("yes")) {
              return {
                exitCode: 1,
                stderr: `Будет удалено ${formatBytes(selectedBytes)}. Повтори с --yes, когда решение принято.`,
              };
            }
            const result = await host.call(
              "cleanupRun",
              { path: project.path, categories: ids },
              { hostId: project.hostId, timeoutMs: 600_000 },
            );
            bb.realtime.publish(CHANGED, { reason: "cleanup", projectId: project.projectId });
            if (json) return reply(result, "");
            return {
              exitCode: result.ok ? 0 : 1,
              stdout: [
                `Освобождено: ${formatBytes(result.removedBytes)}`,
                `Удалено: ${result.removed.length}`,
                ...result.errors.map((error) => `Ошибка: ${error}`),
                ...result.skipped.map((entry) => `Пропущено: ${entry.path}: ${entry.reason}`),
              ].join("\n"),
            };
          }
          default:
            return { exitCode: 1, stderr: `Неизвестная команда: ${command}\n\n${cliUsage}` };
        }
      } catch (error) {
        return { exitCode: 1, stderr: errorText(error) };
      }
    },
  });

  // The project parameter block is a standing convention, not a one-off task.
  bb.log.info("1С: параметры проектов загружены.");
  bb.onDispose(() => {
    clearTimeout(warmup);
    bb.log.info("1С: параметры проектов выгружены");
  });
}
