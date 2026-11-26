import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { editorHostMethod } from "./editor/contract.js";
import { CONFIG_LIMIT } from "./lib/bslflow-fields.js";
import { platformHostMethods } from "./platform-contract.js";
import { reviewChangeId, reviewContract, reviewTarget } from "./review-contract.js";

/** Connection fields stored per project. Mirrors dsh-1c-project-properties. */
export const paramsSchema = z
  .object({
    infobasePath: z.string(),
    user: z.string(),
    password: z.string(),
    platformPath: z.string(),
    unlockCode: z.string(),
    dumpDir: z.string(),
  })
  .strict();

export type ProjectParams = z.infer<typeof paramsSchema>;

export const platformSchema = z
  .object({
    version: z.string(),
    path: z.string(),
  })
  .strict();

export const infobaseSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    kind: z.enum(["file", "server", "unknown"]),
    folder: z.string(),
    app: z.string(),
    source: z.string(),
  })
  .strict();

export const infobaseSourceSchema = z
  .object({
    file: z.string(),
    source: z.string(),
    count: z.number().int(),
  })
  .strict();

export const checkStepSchema = z
  .object({
    label: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })
  .strict();

export const bslflowStateSchema = z
  .object({
    initialized: z.boolean(),
    enabled: z.boolean().nullable(),
    version: z.string(),
    hasAgents: z.boolean(),
    hasOpenspec: z.boolean(),
    hasSentinel: z.boolean(),
  })
  .strict();

export const sourceGitStateSchema = z
  .object({
    available: z.boolean(),
    repository: z.boolean().nullable(),
    detail: z.string(),
  })
  .strict();

export const skillsStateSchema = z
  .object({
    total: z.number().int(),
    bslflow: z.number().int(),
    sourceBslflow: z.string(),
    updatedAt: z.number().nullable(),
  })
  .strict();

export const bslFlowConfigSchema = z.object({
  path: z.string(),
  text: z.string().nullable(),
  revision: z.string().nullable(),
  error: z.string(),
  profile: z.object({
    models: z.array(z.string()),
    providers: z.array(z.string()),
    roles: z.record(z.string(), z.string()),
    error: z.string(),
  }).strict(),
}).strict();
export type BslFlowConfig = z.infer<typeof bslFlowConfigSchema>;
export const bslFlowConfigEdit = { revision: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(CONFIG_LIMIT) };

export const rlmStateSchema = z
  .object({
    installed: z.boolean(),
    running: z.boolean(),
    port: z.number().int().nullable(),
    version: z.string(),
    error: z.string(),
  })
  .strict();

export const cleanupItemSchema = z
  .object({
    path: z.string(),
    kind: z.enum(["dir", "file"]),
    bytes: z.number(),
    files: z.number().int(),
    lastModified: z.number(),
    hot: z.boolean(),
  })
  .strict();

export const cleanupCategorySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    safe: z.boolean(),
    warning: z.string(),
    items: z.array(cleanupItemSchema),
    bytes: z.number(),
    files: z.number().int(),
  })
  .strict();

export const cleanupSkippedSchema = z
  .object({
    path: z.string(),
    reason: z.string(),
  })
  .strict();

export const cleanupScanSchema = z
  .object({
    projectBytes: z.number(),
    projectFiles: z.number().int(),
    totalBytes: z.number(),
    categories: z.array(cleanupCategorySchema),
    scannedAt: z.number(),
    truncated: z.boolean(),
  })
  .strict();

export const toolInfoSchema = z
  .object({
    id: z.literal("bslflow"),
    installed: z.boolean(),
    version: z.string(),
    latest: z.string(),
    updateAvailable: z.boolean(),
    source: z.string(),
    commit: z.string(),
    error: z.string(),
  })
  .strict();

export const toolsStateSchema = z
  .object({
    bslflow: toolInfoSchema,
    checkedAt: z.number().nullable(),
  })
  .strict();

export const operationNameSchema = z.enum(["dump", "load", "extensions"]);

const readinessStatus = z.object({
  status: z.enum(["ready", "missing", "unchecked", "disabled", "error"]),
  detail: z.string(),
}).strict();

export const readinessFilesSchema = z.object({
  exists: z.boolean(),
  hasSources: z.boolean(),
  git: sourceGitStateSchema,
  schema: z.string(),
  openspecCli: z.boolean(),
  flow: bslflowStateSchema,
  skills: skillsStateSchema,
  core: toolInfoSchema,
  review: readinessStatus,
}).strict();

export const projectReadinessSchema = z.object({
  projectPath: z.string(),
  path: z.string(),
  hostName: z.string(),
  files: readinessFilesSchema,
  editor: z.boolean(),
  unica: readinessStatus,
  testBase: readinessStatus,
}).strict();

export type ProjectReadiness = z.infer<typeof projectReadinessSchema>;

export const jobSchema = z
  .object({
    state: z.enum(["idle", "running", "done", "failed", "cancelled"]),
    operation: operationNameSchema.nullable(),
    label: z.string(),
    path: z.string(),
    title: z.string(),
    dir: z.string(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    elapsedMs: z.number(),
    command: z.string(),
    exitCode: z.number().nullable(),
    resultCode: z.string().nullable(),
    files: z.number().int(),
    version: z.string(),
    log: z.string(),
    error: z.string(),
  })
  .strict();

export const projectStateSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    params: paramsSchema,
    hasFile: z.boolean(),
    legacy: z.boolean(),
    file: z.string(),
    markers: z.array(z.string()),
    sourceGit: sourceGitStateSchema,
    is1c: z.boolean(),
    hasDump: z.boolean(),
    rlmOptIn: z.boolean(),
    platforms: z.array(platformSchema),
    infobases: z.array(infobaseSchema),
    infobasesWebSkipped: z.number().int(),
    infobasesSources: z.array(infobaseSourceSchema),
    bslflow: bslflowStateSchema,
    skills: skillsStateSchema,
    rlm: rlmStateSchema,
    operation: jobSchema,
  })
  .strict();

export type PlatformInfo = z.infer<typeof platformSchema>;
export type InfobaseInfo = z.infer<typeof infobaseSchema>;
export type InfobaseSourceInfo = z.infer<typeof infobaseSourceSchema>;
export type CheckStep = z.infer<typeof checkStepSchema>;
export type OperationName = z.infer<typeof operationNameSchema>;
export type JobSnapshot = z.infer<typeof jobSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type BslFlowState = z.infer<typeof bslflowStateSchema>;
export type SourceGitState = z.infer<typeof sourceGitStateSchema>;
export type SkillsState = z.infer<typeof skillsStateSchema>;
export type RlmState = z.infer<typeof rlmStateSchema>;
export type CleanupItem = z.infer<typeof cleanupItemSchema>;
export type CleanupCategory = z.infer<typeof cleanupCategorySchema>;
export type CleanupSkipped = z.infer<typeof cleanupSkippedSchema>;
export type CleanupScan = z.infer<typeof cleanupScanSchema>;
export type ToolInfo = z.infer<typeof toolInfoSchema>;
export type ToolsState = z.infer<typeof toolsStateSchema>;

export const passportStructureSchema = z.object({
  bslModules: z.number().int().nonnegative(),
  bslLines: z.number().int().nonnegative(),
  objectsByRoot: z.record(z.string(), z.number().int().nonnegative()),
  extensions: z.array(z.object({ root: z.string(), purpose: z.string() }).strict()),
}).strict();

export const hostContract = defineRpcContract({
  readinessFiles: {
    input: z.object({ path: z.string() }).strict(),
    output: readinessFilesSchema,
  },
  readinessTestBase: {
    input: z.object({ path: z.string(), source: z.string(), platform: z.string() }).strict(),
    output: readinessStatus,
  },
  ...platformHostMethods,
  reviewHead: { input: z.object({ path: z.string().min(1) }), output: z.string() },
  reviewEvidence: { input: z.object({ path: z.string().min(1), change: reviewChangeId }), output: reviewContract.reviewEvidence.output },
  reviewFiles: { input: z.object({ path: z.string().min(1), target: reviewTarget }), output: z.array(z.string()) },
  passport: {
    input: z.object({ path: z.string().min(1), includeStructure: z.boolean().optional() }).strict(),
    output: z.object({
      snapshotAt: z.string(),
      configurations: z.array(z.object({ root: z.string(), format: z.string(), name: z.string().nullable(), synonym: z.string().nullable(), version: z.string().nullable() }).strict()),
      ambiguous: z.boolean(),
      configComplete: z.boolean(),
      configError: z.string().nullable(),
      metrics: z.object({ complete: z.boolean(), trackedFiles: z.number().int(), trackedBytes: z.number().int(), byExtension: z.record(z.string(), z.number().int()), reason: z.string().nullable() }).strict(),
      structure: passportStructureSchema.optional(),
    }).strict(),
  },
  editorRequest: editorHostMethod,
  environment: {
    input: z.object({}).strict(),
    output: z
      .object({
        platforms: z.array(platformSchema),
        infobases: z.array(infobaseSchema),
        infobasesWebSkipped: z.number().int(),
        infobasesSources: z.array(infobaseSourceSchema),
        operation: jobSchema,
      })
      .strict(),
  },
  projectState: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: projectStateSchema,
  },
  saveParams: {
    input: z.object({ path: z.string().min(1), params: paramsSchema }).strict(),
    output: projectStateSchema,
  },
  clearParams: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: projectStateSchema,
  },
  checkConnection: {
    input: z
      .object({
        path: z.string().min(1),
        params: paramsSchema,
        platformFallback: z.string(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        steps: z.array(checkStepSchema),
        version: z.string(),
        error: z.string(),
        elapsedMs: z.number(),
      })
      .strict(),
  },
  startOperation: {
    input: z
      .object({
        path: z.string().min(1),
        operation: operationNameSchema,
        params: paramsSchema,
        platformFallback: z.string(),
        format: z.enum(["Hierarchical", "Plain"]),
        update: z.boolean(),
        updateDb: z.boolean(),
        dynamic: z.boolean(),
        cleanLocks: z.boolean(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), job: jobSchema }).strict(),
  },
  operationStatus: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean(), job: jobSchema }).strict(),
  },
  cancelOperation: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean(), job: jobSchema }).strict(),
  },
  initProject: {
    input: z.object({ path: z.string().min(1), bslflowRoot: z.string() }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        created: z.array(z.string()),
        preserved: z.array(z.string()),
        output: z.string(),
        error: z.string(),
      })
      .strict(),
  },
  bslFlowConfig: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: bslFlowConfigSchema,
  },
  workflowEnabled: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.boolean().nullable(),
  },
  saveBslFlowConfig: {
    input: z.object({ path: z.string().min(1), ...bslFlowConfigEdit }).strict(),
    output: bslFlowConfigSchema.extend({ enabled: z.boolean() }),
  },
  connectSkills: {
    input: z
      .object({
        path: z.string().min(1),
        bslflowRoot: z.string(),
        overwrite: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        copied: z.array(z.string()),
        preserved: z.array(z.string()),
        skipped: z.array(z.string()),
        removed: z.array(z.string()),
        sourceBslflow: z.string(),
        error: z.string(),
      })
      .strict(),
  },
  rlmStatus: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: rlmStateSchema,
  },
  rlmStart: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: rlmStateSchema,
  },
  rlmStop: {
    input: z.object({}).strict(),
    output: rlmStateSchema,
  },
  rlmCall: {
    input: z
      .object({
        path: z.string().min(1),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), text: z.string(), error: z.string() }).strict(),
  },
  cleanupScan: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: cleanupScanSchema,
  },
  cleanupRun: {
    input: z.object({ path: z.string().min(1), categories: z.array(z.string()) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        removedBytes: z.number(),
        removed: z.array(z.string()),
        errors: z.array(z.string()),
        skipped: z.array(cleanupSkippedSchema),
      })
      .strict(),
  },
  toolsStatus: {
    input: z.object({}).strict(),
    output: toolsStateSchema,
  },
  toolsCheck: {
    input: z.object({}).strict(),
    output: toolsStateSchema,
  },
  toolsEnsure: {
    input: z.object({ update: z.boolean() }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        log: z.array(z.string()),
        state: toolsStateSchema,
      })
      .strict(),
  },
  setRlmOptIn: {
    input: z.object({ path: z.string().min(1), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
});

export type HostContract = typeof hostContract;
export type StartOperationInput = z.infer<typeof hostContract.startOperation.input>;
export type CheckConnectionResult = z.infer<typeof hostContract.checkConnection.output>;
