export const meta = {
  name: "orchestrate-approved-plan",
  description:
    "Выполнить утверждённые независимые задачи в подготовленных worktree, интегрировать успешные результаты и проверить их",
  inputSchema: {
    type: "object",
    required: ["taskId", "parentThreadId", "integrationWorktreePath", "integrationBranch", "plan", "tasks"],
    additionalProperties: false,
    properties: {
      taskId: { type: "string", minLength: 1 },
      parentThreadId: { type: "string", minLength: 1 },
      projectId: { type: "string" },
      environmentId: { type: "string" },
      integrationWorktreePath: { type: "string", minLength: 1 },
      integrationBranch: { type: "string", minLength: 1 },
      plan: { type: "string", minLength: 1 },
      verificationCommand: { type: "string" },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["taskId", "role", "title", "worktreePath", "branch", "approvedScope"],
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            role: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            worktreePath: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            approvedScope: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "parentThreadId", "writerResults", "integration"],
    additionalProperties: false,
    properties: {
      taskId: { type: "string" },
      parentThreadId: { type: "string" },
      writerResults: {
        type: "array",
        items: {
          type: "object",
          required: ["taskId", "role", "worktreePath", "branch", "status", "summary"],
          additionalProperties: false,
          properties: {
            taskId: { type: "string" },
            role: { type: "string" },
            worktreePath: { type: "string" },
            branch: { type: "string" },
            status: { enum: ["succeeded", "failed"] },
            summary: { type: "string" },
            filesChanged: { type: "array", items: { type: "string" } },
            error: { type: "string" },
          },
        },
      },
      integration: {
        type: "object",
        required: ["status", "summary", "checks"],
        additionalProperties: false,
        properties: {
          status: { enum: ["succeeded", "failed", "skipped"] },
          summary: { type: "string" },
          checks: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  phases: [
    { title: "Пишущие исполнители", detail: "Независимые задачи в заранее созданных worktree" },
    { title: "Интеграция и проверки", detail: "Сбор успешных изменений и запуск указанных проверок" },
  ],
};

const taskIds = new Set();
const worktreePaths = new Set([args.integrationWorktreePath.toLocaleLowerCase()]);
const branches = new Set([args.integrationBranch]);
for (const task of args.tasks) {
  if (taskIds.has(task.taskId)) throw new Error(`Повторяется taskId: ${task.taskId}`);
  taskIds.add(task.taskId);
  const path = task.worktreePath.toLocaleLowerCase();
  if (worktreePaths.has(path)) throw new Error(`Worktree должен быть отдельным: ${task.worktreePath}`);
  worktreePaths.add(path);
  if (branches.has(task.branch)) throw new Error(`Повторяется branch: ${task.branch}`);
  branches.add(task.branch);
}

const workerSchema = {
  type: "object",
  required: ["taskId", "role", "worktreePath", "branch", "status", "summary", "filesChanged"],
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    role: { type: "string" },
    worktreePath: { type: "string" },
    branch: { type: "string" },
    status: { enum: ["succeeded", "failed"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
};

const writerResults = await parallel(
  args.tasks.map((task) => () =>
    agent(
      [
        `Исполни одну задачу из утверждённого плана. taskId=${task.taskId}; orchestrationTaskId=${args.taskId}; parentThreadId=${args.parentThreadId}; projectId=${args.projectId ?? "не указан"}; environmentId=${args.environmentId ?? "текущий environment"}.`,
        `Твоя роль: ${task.role}. Задача: ${task.title}. Разрешённый объём: ${task.approvedScope}.`,
        `Утверждённый план:\n${args.plan}`,
        `Работай только в подготовленном Git worktree ${task.worktreePath} на ветке ${task.branch}. Сначала проверь корень репозитория, текущую ветку и git status. Не меняй другие worktree и общий исходный каталог. Не коммить, не сливай ветки, ничего не публикуй и не трогай production. Если путь, ветка или чистое состояние не совпадают, остановись и верни status=failed.`,
        "Внеси только изменения в рамках своего scope. В конце проверь `git diff --check`, перечисли изменённые файлы и кратко опиши результат. Верни failed, если реализация или локальная проверка не удались.",
        "Верни структурированный результат с taskId, role, worktreePath, branch, status, summary, filesChanged и при status=failed полем error.",
      ].join("\n\n"),
      {
        label: `${task.role}: ${task.title}`,
        phase: "Пишущие исполнители",
        schema: workerSchema,
      },
    ),
  ),
);

const normalizedResults = writerResults.map((result, index) => {
  if (result === null) {
    const task = args.tasks[index];
    return {
      taskId: task.taskId,
      role: task.role,
      worktreePath: task.worktreePath,
      branch: task.branch,
      status: "failed",
      summary: "Вызов исполнителя завершился без результата; изменения требуют ручной проверки.",
      filesChanged: [],
      error: "Исполнитель не вернул результат или завершился ошибкой после повторных попыток.",
    };
  }
  const task = args.tasks[index];
  const identityMatches =
    result.taskId === task.taskId &&
    result.role === task.role &&
    result.worktreePath === task.worktreePath &&
    result.branch === task.branch;
  if (!identityMatches) {
    return {
      taskId: task.taskId,
      role: task.role,
      worktreePath: task.worktreePath,
      branch: task.branch,
      status: "failed",
      summary: "Ответ исполнителя не совпал с назначенной задачей или worktree; результат не передан интегратору.",
      filesChanged: [],
      error: "Идентификаторы задачи, пути worktree или ветки в ответе не совпали с назначенными.",
    };
  }
  return result;
});

phase("Интеграция и проверки");
const successfulResults = normalizedResults.filter((result) => result.status === "succeeded");
let integration;
if (successfulResults.length === 0) {
  integration = {
    status: "skipped",
    summary: "Нет успешных пишущих задач; интеграция и проверки не запускались.",
    checks: [],
  };
} else {
  try {
    integration = await agent(
      [
        `Ты интегратор задачи ${args.taskId}, родительский тред ${args.parentThreadId}. Утверждённый план:\n${args.plan}`,
        `Твоя рабочая область интеграции: ${args.integrationWorktreePath}, ожидаемая ветка ${args.integrationBranch}. Только этот worktree можно изменять. Сначала проверь репозиторий, фактическую ветку и git status; если ветка не совпадает или есть незапрошенные изменения, верни status=failed. Не перезаписывай существующие пользовательские изменения.`,
        `Успешные результаты отдельных исполнителей:\n${JSON.stringify(successfulResults, null, 2)}`,
        `Проверь diff каждого успешного worktree и интегрируй только изменения в рамках утверждённого плана. Не сливай и не коммить ветки, не публикуй и не меняй production. Если изменения конфликтуют, scope превышен или рабочая область не чистая, не делай рискованный overwrite: верни status=failed и перечисли причину.`,
        `После интеграции выполни git diff --check и ${args.verificationCommand || "минимальные подходящие проверки проекта, явно перечислив команды"}. Не запускай destructive или production-команды. Укажи фактически выполненные проверки и их результат.`,
        "Верни структурированный результат: status (succeeded или failed), summary, checks.",
      ].join("\n\n"),
      {
        label: "Интегратор и проверки",
        phase: "Интеграция и проверки",
        schema: {
          type: "object",
          required: ["status", "summary", "checks"],
          additionalProperties: false,
          properties: {
            status: { enum: ["succeeded", "failed"] },
            summary: { type: "string" },
            checks: { type: "array", items: { type: "string" } },
          },
        },
      },
    );
    if (integration === null) {
      integration = {
        status: "failed",
        summary: "Вызов интегратора завершился без результата.",
        checks: [],
      };
    }
  } catch (error) {
    integration = {
      status: "failed",
      summary: "Вызов интегратора завершился ошибкой.",
      checks: [String(error)],
    };
  }
}

return {
  taskId: args.taskId,
  parentThreadId: args.parentThreadId,
  writerResults: normalizedResults,
  integration,
};
