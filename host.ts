import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { join, resolve } from "node:path";
import { inspectSourceGit } from "./lib/source-git.js";
import { findReviewEvidence, readReviewHead, verifyReviewSource } from "./lib/review-source.js";
import { readPassport } from "./lib/passport.js";
import { hostContract } from "./contract.js";
import type { ProjectReadiness, ProjectState } from "./contract.js";
import { detectPlatforms, listInfoBases } from "./lib/infobases.js";
import { OperationRunner } from "./lib/operations.js";
import { PlatformOperations } from "./lib/platform-operations.js";
import { physicalPath, planPlatformOperation, readPlatformProfiles, savePlatformProfile } from "./lib/platform-plan.js";
import type { PlatformRequest } from "./platform-contract.js";
import {
  clearParams,
  detectProject,
  paramsFile,
  readParams,
  readRlmOptIn,
  saveParams,
  saveRlmOptIn,
} from "./lib/params-store.js";
import { canonical } from "./lib/shared.js";
import {
  connectSkills,
  detectBslFlow,
  initProject,
  readOpenSpecSchema,
  readSkillsState,
} from "./lib/bslflow.js";
import { RlmRunner } from "./lib/rlm.js";
import { loadBslFlowConfig, readWorkflowEnabled, reviewReadiness, saveBslFlowConfig } from "./lib/bslflow-config.js";
import { runCleanup, scanCleanup } from "./lib/cleanup.js";
import {
  hasOpenSpecCli,
  toolsCheck,
  toolsEnsure as ensureTools,
  toolsStatus,
} from "./lib/tools.js";

let runner: OperationRunner | null = null;
let rlm: RlmRunner | null = null;

function getRunner(context: ExperimentalHostRpcContext): OperationRunner {
  if (runner === null) {
    runner = new OperationRunner(
      context.experimental_paths.dataDir,
      context.experimental_paths.tempDir,
    );
  }
  return runner;
}

function operationScope({ projectId, path }: { projectId: string; path: string }): string {
  return PlatformOperations.scope(projectId, physicalPath(resolve(path)));
}

function resolvePlatformPlan(input: { path: string; source: string; fallback: string; request: PlatformRequest }, runner: PlatformOperations) {
  const local = readParams(input.path);
  const params = (local.hasFile ? local : readParams(input.source)).params;
  const profile = input.request.profile === "project"
    ? { name: "project" as const, kind: "project" as const, infobase: params.infobasePath, platform: params.platformPath, user: params.user }
    : readPlatformProfiles(input.source).find(({ name }) => name === input.request.profile);
  if (!profile) throw new Error("Профиль 1С не найден.");
  const saved = profile.kind === "project" ? null : profile;
  const secrets = { passwordSecret: saved?.passwordSecret, unlockCodeSecret: saved?.unlockCodeSecret };
  const plan = planPlatformOperation({ ...input, profile, recovery: null });
  const recovery = runner.recovery(plan.baseArg);
  return {
    plan: recovery ? planPlatformOperation({ ...input, profile, recovery }) : plan,
    secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== undefined)) as typeof secrets,
    user: profile.user ?? "",
    legacyAuth: saved === null ? params : null,
  };
}

function getRlm(context: ExperimentalHostRpcContext): RlmRunner {
  if (rlm === null) {
    rlm = new RlmRunner(context.experimental_paths.dataDir);
  }
  return rlm;
}

function projectState(projectPath: string, context: ExperimentalHostRpcContext): ProjectState {
  const path = canonical(projectPath);
  const info = readParams(path);
  const markers = detectProject(path);
  const infobases = listInfoBases();
  return {
    path,
    exists: markers.exists,
    params: info.params,
    hasFile: info.hasFile,
    legacy: info.legacy,
    file: paramsFile(path),
    markers: markers.markers,
    sourceGit: inspectSourceGit(path),
    is1c: markers.is1c,
    hasDump: markers.hasDump,
    rlmOptIn: readRlmOptIn(path),
    platforms: detectPlatforms(),
    infobases: infobases.items,
    infobasesWebSkipped: infobases.webSkipped,
    infobasesSources: infobases.sources,
    bslflow: detectBslFlow(path),
    skills: readSkillsState(path),
    rlm: getRlm(context).status(),
    operation: getRunner(context).status(),
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readinessFiles({ path }, context) {
      const { exists, markers } = detectProject(path);
      const schema = readOpenSpecSchema(path);
      return {
        exists, hasSources: markers.length > 0, git: inspectSourceGit(path), schema, openspecCli: hasOpenSpecCli(),
        flow: detectBslFlow(path, schema), skills: readSkillsState(path),
        core: toolsStatus(context.experimental_paths.dataDir).bslflow,
        review: reviewReadiness(path),
      };
    },
    readinessTestBase({ path, source, platform }): ProjectReadiness["testBase"] {
      try {
        const hasTestProfile = readPlatformProfiles(source).some(({ kind }) => kind === "test");
        if (hasTestProfile) {
          return { status: "unchecked", detail: "Есть профиль test. Проверьте подключение к выбранной цели в операциях 1С." };
        }
        const local = readParams(path);
        const { infobasePath, platformPath } = (local.hasFile ? local : readParams(source)).params;
        if (!infobasePath.trim()) {
          return { status: "missing", detail: "Добавьте тестовый профиль или задайте параметры учебной ИБ." };
        }
        return { status: "unchecked", detail: platformPath.trim() || platform.trim()
          ? "Задана база проекта. Проверьте подключение и подтвердите, что база предназначена для тестов."
          : "Задана база проекта. Выберите платформу и проверьте подключение." };
      } catch {
        return { status: "error", detail: "Не удалось прочитать настройки тестового профиля." };
      }
    },
    reviewHead({ path }) { return readReviewHead(path); },
    reviewEvidence({ path, change }) { return findReviewEvidence(path, change); },
    reviewFiles({ path, target }) { return verifyReviewSource(path, target); },
    platformProfiles({ source }) {
      return {
        profiles: readPlatformProfiles(source),
        infobases: listInfoBases().items.flatMap(({ name, value, kind }) => kind === "unknown" ? [] : [{ name, value, kind }]),
      };
    },
    platformSaveProfile({ path, profile }) {
      return savePlatformProfile(path, profile);
    },
    platformPreview(input, context) {
      const { plan, secrets } = resolvePlatformPlan(input, getRunner(context).platform);
      return { preview: plan.preview, secrets };
    },
    platformStart(input, context) {
      const runner = getRunner(context);
      if (runner.legacyRunning) throw new Error("На хосте уже выполняется операция 1С.");
      const { plan, secrets, user, legacyAuth } = resolvePlatformPlan(input, runner.platform);
      if (secrets.passwordSecret !== input.secretNames.passwordSecret || secrets.unlockCodeSecret !== input.secretNames.unlockCodeSecret) {
        throw new Error("Ссылки на секреты изменились. Обнови предпросмотр операции.");
      }
      const lease = context.experimental_retainWorker();
      try {
        return runner.platform.start(operationScope(input), plan, {
          user,
          password: legacyAuth?.password ?? input.password,
          unlockCode: legacyAuth?.unlockCode ?? input.unlockCode,
        }, input.confirmation, input.inspected, lease);
      } catch (error) {
        lease.dispose();
        throw error;
      }
    },
    platformJournal(input, context) {
      return getRunner(context).platform.list(operationScope(input));
    },
    platformStatus(input, context) {
      return getRunner(context).platform.status(operationScope(input), input.id);
    },
    platformCancel(input, context) {
      return getRunner(context).platform.cancel(operationScope(input), input.id);
    },
    platformArtifact(input, context) {
      return { text: getRunner(context).platform.report(operationScope(input), input.id, input.name) };
    },
    passport({ path }) {
      return readPassport(canonical(path));
    },
    async editorRequest(input, context) {
      const { handleHostRequest } = await import("./editor/host-core.js");
      return handleHostRequest({ ...input, dataDir: join(context.experimental_paths.dataDir, "editor") });
    },
    environment(_input, context) {
      const infobases = listInfoBases();
      return {
        platforms: detectPlatforms(),
        infobases: infobases.items,
        infobasesWebSkipped: infobases.webSkipped,
        infobasesSources: infobases.sources,
        operation: getRunner(context).status(),
      };
    },
    projectState({ path }, context) {
      return projectState(path, context);
    },
    saveParams({ path, params }, context) {
      saveParams(canonical(path), params);
      return projectState(path, context);
    },
    clearParams({ path }, context) {
      clearParams(canonical(path));
      return projectState(path, context);
    },
    checkConnection(input, context) {
      return getRunner(context).checkConnection({
        path: canonical(input.path),
        params: input.params,
        platformFallback: input.platformFallback,
      });
    },
    startOperation(input, context) {
      const lease = context.experimental_retainWorker();
      try {
        const job = getRunner(context).start(
          { ...input, path: canonical(input.path) },
          lease,
        );
        return { ok: true, job };
      } catch (error) {
        lease.dispose();
        throw error;
      }
    },
    operationStatus(_input, context) {
      return { ok: true, job: getRunner(context).status() };
    },
    cancelOperation(_input, context) {
      return { ok: true, job: getRunner(context).cancel() };
    },
    initProject({ path, bslflowRoot }) {
      return initProject(canonical(path), bslflowRoot);
    },
    bslFlowConfig({ path }) {
      return loadBslFlowConfig(path);
    },
    workflowEnabled({ path }) {
      return readWorkflowEnabled(path);
    },
    saveBslFlowConfig({ path, revision, text }) {
      return saveBslFlowConfig(path, revision, text);
    },
    connectSkills({ path, bslflowRoot, overwrite }) {
      return connectSkills(canonical(path), { bslflowRoot, overwrite });
    },
    rlmStatus(_input, context) {
      return getRlm(context).status();
    },
    async rlmStart(_input, context) {
      await getRlm(context).ensure(() => context.experimental_retainWorker());
      return getRlm(context).status();
    },
    rlmStop(_input, context) {
      getRlm(context).stop();
      return getRlm(context).status();
    },
    async rlmCall({ tool, arguments: args }, context) {
      return getRlm(context).call(tool, args, () => context.experimental_retainWorker());
    },
    cleanupScan({ path }) {
      return scanCleanup(canonical(path));
    },
    cleanupRun({ path, categories }) {
      return runCleanup(canonical(path), categories);
    },
    toolsStatus(_input, context) {
      return toolsStatus(context.experimental_paths.dataDir);
    },
    toolsCheck(_input, context) {
      return toolsCheck(context.experimental_paths.dataDir);
    },
    async toolsEnsure({ update }, context) {
      return ensureTools(context.experimental_paths.dataDir, update);
    },
    setRlmOptIn({ path, enabled }) {
      return { enabled: saveRlmOptIn(canonical(path), enabled) };
    },
  },
  async dispose() {
    runner?.dispose();
    runner = null;
    rlm?.dispose();
    rlm = null;
  },
});
