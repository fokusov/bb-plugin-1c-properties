import { z } from "zod";

export const platformActions = {
  "dump-xml": "Выгрузить конфигурацию или расширение в XML",
  "load-xml": "Загрузить конфигурацию или расширение из XML",
  "dump-binary": "Сохранить конфигурацию или расширение в CF/CFE",
  "load-binary": "Загрузить конфигурацию или расширение из CF/CFE",
  "build-configuration": "Собрать CF/CFE из XML через выбранную базу",
  "unpack-configuration": "Разобрать CF/CFE в XML через выбранную базу",
  "build-external": "Собрать EPF/ERF из XML",
  "unpack-external": "Разобрать EPF/ERF в XML",
  "create-file-base": "Создать FILE-базу",
  "open-enterprise": "Открыть Предприятие",
  "open-designer": "Открыть Конфигуратор",
  "dump-dt": "Выгрузить базу в DT",
  "restore-dt": "Восстановить базу из DT",
  "update-db": "Обновить конфигурацию базы данных",
  "check-syntax": "Проверить синтаксис модулей",
  yaxunit: "Запустить YAxUnit",
  vanessa: "Запустить Vanessa Automation",
} as const;

type PlatformAction = keyof typeof platformActions;
export const platformActionSchema = z.enum(Object.keys(platformActions) as PlatformAction[]);
const field = z.string().trim().min(1).max(4096);
export const profileNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const platformProfileSchema = z.object({
  name: profileNameSchema.refine((value) => value !== "project", "Имя project зарезервировано"),
  kind: z.enum(["dev", "test"]),
  infobase: field.refine(
    (value) => !/(?:^|;)\s*(?:Pwd|Password|Usr|User|UC)\s*=/i.test(value),
    "Укажи адрес базы отдельно от пользователя и ссылки на секрет Env Catalog.",
  ),
  platform: field.optional(),
  user: z.string().trim().max(256).optional(),
  passwordSecret: secretName.optional(),
  unlockCodeSecret: secretName.optional(),
}).strict();

export const platformRequestSchema = z.object({
  action: platformActionSchema,
  profile: profileNameSchema.default("project"),
  input: field.optional(),
  output: field.optional(),
  extension: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,127}$/u).optional(),
  config: field.optional(),
  format: z.enum(["Hierarchical", "Plain"]).default("Hierarchical"),
}).strict();

export const platformRunIdSchema = z.uuid();
export const platformPreviewSchema = z.object({
  action: platformActionSchema,
  profile: profileNameSchema,
  kind: z.enum(["dev", "test", "project"]),
  workspace: z.string(),
  target: z.string(),
  platform: z.string(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  extension: z.string().nullable(),
  config: z.string().nullable(),
  format: z.enum(["Hierarchical", "Plain"]),
  confirmation: z.string().nullable(),
  recovery: platformRunIdSchema.nullable(),
  targetState: z.string(),
}).strict();

export const platformArtifactSchema = z.object({
  name: z.string(),
  kind: z.enum(["output", "log", "report"]),
  workspacePath: z.string().nullable(),
}).strict();

export const platformJournalEntrySchema = platformPreviewSchema.omit({ confirmation: true, recovery: true }).extend({
  id: platformRunIdSchema,
  state: z.enum(["running", "launched", "done", "failed", "cancelled", "interrupted"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  revision: z.string().nullable(),
  dirty: z.boolean().nullable(),
  stage: z.number().int(),
  stages: z.number().int(),
  exitCode: z.number().int().nullable(),
  resultCode: z.string().nullable(),
  needsInspection: z.boolean(),
  error: z.string().nullable(),
  counts: z.object({ tests: z.number().int(), failures: z.number().int(), errors: z.number().int(), skipped: z.number().int() }).strict().nullable(),
  artifacts: z.array(platformArtifactSchema),
}).strict();

export const platformSecretRequestSchema = z.object({
  passwordSecret: secretName.optional(),
  unlockCodeSecret: secretName.optional(),
}).strict();

export const platformScopeSchema = z.object({
  projectId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
}).strict();
export type PlatformScope = z.infer<typeof platformScopeSchema>;
export type PlatformRequest = z.infer<typeof platformRequestSchema>;
export type PlatformProfile = z.infer<typeof platformProfileSchema>;
export type PlatformPreview = z.infer<typeof platformPreviewSchema>;
export type PlatformJournalEntry = z.infer<typeof platformJournalEntrySchema>;

export const platformRunOptions = {
  confirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inspected: platformRunIdSchema.optional(),
};
export const platformArtifactNameSchema = z.string().regex(/^(operation\.log|junit-\d+\.xml|bsl-json\.json|apk-junit\.xml)$/);
export const diagnosticToolSchema = z.enum(["bsl-ls", "apk"]);
export const diagnosticImportSchema = z.object({
  tool: diagnosticToolSchema,
  file: field,
  finishedAt: z.iso.datetime({ offset: true }),
  revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i).optional(),
  profile: profileNameSchema.default("project"),
}).strict();
const reportReference = z.object({ id: platformRunIdSchema, name: platformArtifactNameSchema }).strict();
export const diagnosticReportSchema = diagnosticImportSchema.omit({ file: true, revision: true }).extend({
  revision: z.string().nullable(),
  counts: z.object({ errors: z.number().int().nonnegative(), warnings: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative() }).strict(),
  report: reportReference,
}).strict();
export type DiagnosticImport = z.infer<typeof diagnosticImportSchema>;
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

const dashboardEntry = platformJournalEntrySchema.pick({
  id: true, action: true, profile: true, kind: true, state: true, startedAt: true, finishedAt: true,
  revision: true, dirty: true, needsInspection: true, counts: true,
}).extend({ reports: z.array(reportReference) }).strict();
export const platformDashboardContract = {
  platformDashboardV1: {
    input: platformScopeSchema,
    output: z.object({
      version: z.literal(1),
      entries: z.array(dashboardEntry),
    }).strict(),
  },
  platformDashboardV2: {
    input: platformScopeSchema,
    output: z.object({
      version: z.literal(2),
      entries: z.array(dashboardEntry.extend({ platformVersion: z.string().nullable() })),
      diagnostics: z.array(diagnosticReportSchema).max(4),
    }).strict(),
  },
} as const;
export const platformProfilesSchema = z.object({ profiles: z.array(platformProfileSchema), infobases: z.array(z.object({
  name: z.string(), value: z.string(), kind: z.enum(["file", "server"]),
}).strict()) }).strict();
const hostScope = { projectId: z.string().min(1), path: field };
const hostRequest = { ...hostScope, source: field, fallback: z.string(), request: platformRequestSchema };
export const platformHostMethods = {
  platformProfiles: { input: z.object({ ...hostScope, source: field }).strict(), output: platformProfilesSchema },
  platformSaveProfile: { input: z.object({ path: field, profile: platformProfileSchema }).strict(), output: z.array(platformProfileSchema) },
  platformPreview: {
    input: z.object(hostRequest).strict(),
    output: z.object({ preview: platformPreviewSchema, secrets: platformSecretRequestSchema }).strict(),
  },
  platformStart: {
    input: z.object({
      ...hostRequest, ...platformRunOptions,
      password: z.string(), unlockCode: z.string(), secretNames: platformSecretRequestSchema,
    }).strict(),
    output: platformJournalEntrySchema,
  },
  platformJournal: { input: z.object(hostScope).strict(), output: z.array(platformJournalEntrySchema) },
  diagnosticReports: { input: z.object(hostScope).strict(), output: z.array(diagnosticReportSchema).max(4) },
  diagnosticImport: {
    input: z.object({ ...hostScope, report: diagnosticImportSchema }).strict(),
    output: diagnosticReportSchema,
  },
  platformStatus: {
    input: z.object({ ...hostScope, id: platformRunIdSchema }).strict(),
    output: platformJournalEntrySchema.nullable(),
  },
  platformCancel: {
    input: z.object({ ...hostScope, id: platformRunIdSchema }).strict(),
    output: platformJournalEntrySchema.nullable(),
  },
  platformArtifact: {
    input: z.object({ ...hostScope, id: platformRunIdSchema, name: platformArtifactNameSchema }).strict(),
    output: z.object({ text: z.string() }).strict(),
  },
};
