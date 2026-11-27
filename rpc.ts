import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { editorAvailabilityMethod } from "./editor/contract.js";
import { platformArtifactNameSchema, platformClusterRequestSchema, platformClusterSchema, platformInventorySchema, platformJournalEntrySchema, platformPreviewSchema, platformProfileSchema, platformProfilesSchema, platformRequestSchema, platformRunIdSchema, platformRunOptions, platformScopeSchema, platformToolsSchema } from "./platform-contract.js";
import {
  bslflowStateSchema,
  bslFlowConfigEdit,
  bslFlowConfigSchema,
  checkStepSchema,
  cleanupScanSchema,
  cleanupSkippedSchema,
  infobaseSchema,
  jobSchema,
  operationNameSchema,
  paramsSchema,
  passportStructureSchema,
  platformSchema,
  projectStateSchema,
  projectReadinessSchema,
  rlmStateSchema,
  sourceGitStateSchema,
  skillsStateSchema,
  toolsStateSchema,
} from "./contract.js";

const passportInput = z.object({ projectId: z.string().min(1), environmentId: z.string().min(1).optional() }).strict();
const passportOutput = z.object({
  sourceId: z.string().nullable(),
  environmentId: z.string().nullable(),
  hostId: z.string(),
  snapshotAt: z.string(),
  configurations: z.array(z.object({ root: z.string(), format: z.string(), name: z.string().nullable(), synonym: z.string().nullable(), version: z.string().nullable() }).strict()),
  ambiguous: z.boolean(),
  configComplete: z.boolean(),
  configError: z.string().nullable(),
  metrics: z.object({ complete: z.boolean(), trackedFiles: z.number().int(), trackedBytes: z.number().int(), byExtension: z.record(z.string(), z.number().int()), reason: z.string().nullable() }).strict(),
}).strict();

export const projectRowSchema = z
  .object({
    projectId: z.string(),
    name: z.string(),
    path: z.string(),
    hostId: z.string(),
    hostName: z.string(),
    exists: z.boolean(),
    hasFile: z.boolean(),
    legacy: z.boolean(),
    is1c: z.boolean(),
    markers: z.array(z.string()),
    sourceGit: sourceGitStateSchema,
    bslflow: bslflowStateSchema,
    skills: skillsStateSchema,
    rlm: rlmStateSchema,
    effectivePlatformPath: z.string(),
    platformFromCommon: z.boolean(),
    platforms: z.array(platformSchema),
    error: z.string().nullable(),
  })
  .strict();

export type ProjectRow = z.infer<typeof projectRowSchema>;

const detailSchema = z.object({ project: projectRowSchema, state: projectStateSchema }).strict();

const checkResultSchema = z
  .object({
    ok: z.boolean(),
    steps: z.array(checkStepSchema),
    version: z.string(),
    error: z.string(),
    elapsedMs: z.number(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  projectReadiness: {
    input: platformScopeSchema.extend({ probeUnica: z.boolean().optional() }),
    output: projectReadinessSchema,
  },
  platformProfiles: { input: platformScopeSchema, output: platformProfilesSchema },
  platformSaveProfile: {
    input: platformScopeSchema.extend({ profile: platformProfileSchema }),
    output: z.array(platformProfileSchema),
  },
  platformPreview: {
    input: platformScopeSchema.extend({ request: platformRequestSchema }),
    output: platformPreviewSchema,
  },
  platformStart: {
    input: platformScopeSchema.extend({ request: platformRequestSchema, ...platformRunOptions }),
    output: platformJournalEntrySchema,
  },
  platformJournal: { input: platformScopeSchema, output: z.array(platformJournalEntrySchema) },
  platformStatus: {
    input: platformScopeSchema.extend({ id: platformRunIdSchema }),
    output: platformJournalEntrySchema.nullable(),
  },
  platformCancel: {
    input: platformScopeSchema.extend({ id: platformRunIdSchema }),
    output: platformJournalEntrySchema.nullable(),
  },
  platformInventory: {
    input: platformScopeSchema,
    output: platformInventorySchema.extend({ hostId: z.string() }),
  },
  platformTools: { input: platformScopeSchema, output: platformToolsSchema.extend({ hostId: z.string() }) },
  platformCluster: { input: platformScopeSchema.extend({ query: platformClusterRequestSchema }), output: platformClusterSchema },
  platformArtifact: {
    input: platformScopeSchema.extend({ id: platformRunIdSchema, name: platformArtifactNameSchema }),
    output: z.object({ text: z.string() }).strict(),
  },
  passport: {
    input: passportInput,
    output: passportOutput,
  },
  passportV2: {
    input: passportInput,
    output: passportOutput.extend({ structure: passportStructureSchema }),
  },
  editorAvailability: editorAvailabilityMethod,
  bslFlowConfig: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: bslFlowConfigSchema,
  },
  saveBslFlowConfig: {
    input: z.object({ projectId: z.string().min(1), ...bslFlowConfigEdit }).strict(),
    output: bslFlowConfigSchema.extend({ enabled: z.boolean() }),
  },
  unicaOwnership: {
    input: z.object({}).strict(),
    output: z.object({
      version: z.literal(1),
      mode: z.literal("external"),
    }).strict(),
  },
  state: {
    input: z.null(),
    output: z
      .object({
        projects: z.array(projectRowSchema),
        common: z
          .object({
            platformPath: z.string(),
            bslflowSkillsRoot: z.string(),
          })
          .strict(),
        paramsRel: z.string(),
        legacyParamsRel: z.string(),
        infobases: z.array(infobaseSchema),
        infobasesWebSkipped: z.number().int(),
        operation: jobSchema,
      })
      .strict(),
  },
  project: {
    input: z.object({ projectId: z.string() }).strict(),
    output: detailSchema,
  },
  saveProject: {
    input: z.object({ projectId: z.string(), params: paramsSchema }).strict(),
    output: detailSchema,
  },
  clearProject: {
    input: z.object({ projectId: z.string() }).strict(),
    output: detailSchema,
  },
  saveCommon: {
    input: z.object({ platformPath: z.string() }).strict(),
    output: z.object({ platformPath: z.string() }).strict(),
  },
  checkConnection: {
    input: z.object({ projectId: z.string(), params: paramsSchema }).strict(),
    output: checkResultSchema,
  },
  startOperation: {
    input: z
      .object({
        projectId: z.string(),
        operation: operationNameSchema,
        params: paramsSchema,
        format: z.enum(["Hierarchical", "Plain"]),
        update: z.boolean(),
        updateDb: z.boolean(),
        dynamic: z.boolean(),
        cleanLocks: z.boolean(),
      })
      .strict(),
    output: z.object({ job: jobSchema }).strict(),
  },
  operation: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ job: jobSchema }).strict(),
  },
  cancelOperation: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ job: jobSchema }).strict(),
  },
  initProject: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        created: z.array(z.string()),
        preserved: z.array(z.string()),
        output: z.string(),
        error: z.string(),
        detail: detailSchema,
      })
      .strict(),
  },
  connectSkills: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        copied: z.array(z.string()),
        preserved: z.array(z.string()),
        skipped: z.array(z.string()),
        removed: z.array(z.string()),
        sourceBslflow: z.string(),
        error: z.string(),
        detail: detailSchema,
      })
      .strict(),
  },
  rlmStatus: {
    input: z.object({ projectId: z.string() }).strict(),
    output: rlmStateSchema,
  },
  rlmStart: {
    input: z.object({ projectId: z.string() }).strict(),
    output: rlmStateSchema,
  },
  rlmStop: {
    input: z.object({ projectId: z.string() }).strict(),
    output: rlmStateSchema,
  },
  cleanupScan: {
    input: z.object({ projectId: z.string() }).strict(),
    output: cleanupScanSchema,
  },
  cleanupRun: {
    input: z.object({ projectId: z.string(), categories: z.array(z.string()) }).strict(),
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
    input: z.object({ projectId: z.string() }).strict(),
    output: toolsStateSchema,
  },
  toolsCheck: {
    input: z.object({ projectId: z.string() }).strict(),
    output: toolsStateSchema,
  },
  toolsEnsure: {
    input: z.object({ projectId: z.string(), update: z.boolean() }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        log: z.array(z.string()),
        state: toolsStateSchema,
      })
      .strict(),
  },
  setRlmOptIn: {
    input: z.object({ projectId: z.string(), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
});

export type RpcContract = typeof rpcContract;
export type ProjectDetail = z.infer<typeof detailSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
