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
  "check-config": "Проверить целостность и ссылки",
  "edt-import": "Импортировать XML в EDT",
  "edt-export": "Экспортировать EDT в XML",
  "build-distribution": "Создать файл поставки CF",
  "build-cfu": "Создать файл обновления CFU",
  "apply-cfu": "Применить обновление CFU с резервной копией",
  yaxunit: "Запустить YAxUnit",
  vanessa: "Запустить Vanessa Automation",
} as const;

type PlatformAction = keyof typeof platformActions;
export const platformActionSchema = z.enum(Object.keys(platformActions) as PlatformAction[]);
export const isEdtAction = (action: PlatformAction) => action === "edt-import" || action === "edt-export";
const field = z.string().trim().min(1).max(4096);
export const platformSha256Schema = z.string().trim().regex(/^[0-9a-f]{64}$/i).transform((value) => value.toLowerCase());
export const configurationIdentitySchema = z.object({
  name: z.string().min(1).max(128), vendor: z.string().max(256), version: z.string().max(128),
}).strict();
export const platformCfuDetailsSchema = z.object({
  sha256: platformSha256Schema,
  current: configurationIdentitySchema,
  target: configurationIdentitySchema,
  allowedVersions: z.array(z.string().min(1).max(128)).min(1).max(250),
}).strict();
export type ConfigurationIdentity = z.infer<typeof configurationIdentitySchema>;
export type PlatformCfuDetails = z.infer<typeof platformCfuDetailsSchema>;
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
  baseProject: field.optional(),
  sha256: platformSha256Schema.optional(),
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
  baseProject: z.string().optional(),
  cfu: platformCfuDetailsSchema.optional(),
  sourceSha256: platformSha256Schema.optional(),
}).strict();

export const platformArtifactSchema = z.object({
  name: z.string(),
  kind: z.enum(["output", "log", "report"]),
  workspacePath: z.string().nullable(),
  sha256: platformSha256Schema.optional(),
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

export const platformInventoryItemSchema = z.object({
  path: z.string(),
  source: z.enum(["xml", "edt", "binary"]),
  kind: z.enum(["configuration", "extension", "processor", "report", "backup", "update"]),
  name: z.string().nullable(),
}).strict();
export const platformInventorySchema = z.object({
  workspace: z.string(),
  complete: z.boolean(),
  items: z.array(platformInventoryItemSchema).max(400),
}).strict();
export type PlatformInventoryItem = z.infer<typeof platformInventoryItemSchema>;

export const platformToolsSchema = z.object({
  oscript: z.string().nullable(),
  opm: z.string().nullable(),
  edt: z.string().nullable(),
  rac: z.string().nullable(),
  ibsrv: z.string().nullable(),
}).strict();

export const platformRasSchema = z.string().trim().max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.\-]*[a-z0-9])?(?::\d{1,5})?$/i, "Укажи адрес RAS в формате хост[:порт].")
  .refine((value) => !value.includes(":") || Number(value.split(":")[1]) >= 1 && Number(value.split(":")[1]) <= 65535, "Порт RAS вне диапазона.");
export const platformClusterRequestSchema = z.object({ endpoint: platformRasSchema, cluster: z.uuid().optional() }).strict();
export const platformClusterSchema = z.object({
  items: z.array(z.object({
    id: z.uuid(), name: z.string(), host: z.string(), port: z.string(),
  }).strict()).max(200),
  sessions: z.array(z.object({
    id: z.uuid(), number: z.string(), infobase: z.string(), user: z.string(),
    host: z.string(), app: z.string(), startedAt: z.string(),
  }).strict()).max(200),
  truncated: z.boolean(),
}).strict();
export type PlatformClusterRequest = z.infer<typeof platformClusterRequestSchema>;

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
const credentials = { password: z.string(), unlockCode: z.string(), secretNames: platformSecretRequestSchema };
export const platformHostMethods = {
  platformProfiles: { input: z.object({ ...hostScope, source: field }).strict(), output: platformProfilesSchema },
  platformSaveProfile: { input: z.object({ path: field, profile: platformProfileSchema }).strict(), output: z.array(platformProfileSchema) },
  platformPreview: {
    input: z.object(hostRequest).strict(),
    output: z.object({ preview: platformPreviewSchema, secrets: platformSecretRequestSchema }).strict(),
  },
  platformCfuPreview: {
    input: z.object({ ...hostRequest, ...credentials }).strict(), output: platformPreviewSchema,
  },
  platformStart: {
    input: z.object({
      ...hostRequest, ...platformRunOptions,
      ...credentials,
    }).strict(),
    output: platformJournalEntrySchema,
  },
  platformJournal: { input: z.object(hostScope).strict(), output: z.array(platformJournalEntrySchema) },
  platformInventory: { input: z.object(hostScope).strict(), output: platformInventorySchema },
  platformTools: { input: z.object({ ...hostScope, source: field, fallback: z.string() }).strict(), output: platformToolsSchema },
  platformCluster: { input: z.object({ ...hostScope, source: field, fallback: z.string(), query: platformClusterRequestSchema }).strict(), output: platformClusterSchema },
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
