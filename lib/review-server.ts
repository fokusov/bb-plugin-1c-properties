import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { reviewContract, reviewRecord, strictReviewUnavailable } from "../review-contract.js";

interface ReviewHost {
  head(path: string, hostId: string): Promise<string>;
  evidence(path: string, hostId: string, change: string): Promise<z.infer<typeof reviewContract.reviewEvidence.output>>;
  files(path: string, hostId: string, target: z.infer<typeof reviewRecord.shape.target>): Promise<string[]>;
}

export function registerReview(bb: BbPluginApi, host: ReviewHost): void {
  async function source({ threadId, environmentId }: { threadId: string; environmentId: string }) {
    const [parent, environment] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.environments.get({ environmentId }),
    ]);
    if (parent.environmentId !== environment.id || environment.projectId !== parent.projectId ||
        environment.status !== "ready" || !environment.path) {
      throw new Error("Исходная рабочая копия треда недоступна или была переключена.");
    }
    return { parent, environment, path: environment.path };
  }

  const handlers: PluginRpcHandlers<typeof reviewContract> = {
    async reviewContext(scope) {
      const { path, environment } = await source(scope);
      return { head: await host.head(path, environment.hostId) };
    },
    async reviewEvidence({ change, ...scope }) {
      const { path, environment } = await source(scope);
      return host.evidence(path, environment.hostId, change);
    },
    async reviewStart({ taskId, target, providerId, model, reasoningLevel, serviceTier, brief, threadId, environmentId, requireReadOnly }) {
      if (requireReadOnly) throw new Error(strictReviewUnavailable);
      const { parent, environment, path } = await source({ threadId, environmentId });
      const [files, catalog] = await Promise.all([
        host.files(path, environment.hostId, target),
        bb.sdk.providers.models({ environmentId, providerId }),
      ]);
      const selected = catalog.models.find(({ model: candidate, id }) => candidate === model || id === model);
      if (catalog.modelLoadError || !selected) {
        throw new Error(catalog.modelLoadError?.detail || `Модель ${model} провайдера ${providerId} недоступна в исходном окружении.`);
      }

      const record = reviewRecord.parse({ role: "reviewer", taskId, model, parentThreadId: threadId,
        sourceEnvironmentId: environmentId, reviewMode: "isolated-worktree", target });
      const context = target.kind === "git"
        ? `Сравни зафиксированные ревизии командой git diff ${target.base} ${target.head} -- . ':(exclude).bb/1c-project.json' ':(exclude).dsh/1c-project.json' ':(exclude).bb/1c-platform-profiles.json' ':(exclude,glob)**/*.dt'. Если начальная ревизия недоступна, укажи причину и остановись.`
        : `Прочитай по указанной ревизии артефакты OpenSpec: ${files.join(", ")}.`;
      const child = await bb.sdk.threads.spawn({
        projectId: parent.projectId,
        parentThreadId: threadId,
        parentNotifications: "off",
        visibility: "visible",
        title: `Второе мнение · ${taskId}`,
        environment: { type: "host", hostId: environment.hostId, workspace: {
          type: "managed-worktree", baseBranch: { kind: "named", name: target.head },
        } },
        providerId, model, reasoningLevel, serviceTier, permissionMode: "accept-edits",
        pluginMetadata: { orchestration: record },
        prompt: [
          "Дай независимое второе мнение. Используй только текущий worktree и команды чтения. Не открывай параметры подключения к базам, секреты и дампы. Не меняй файлы, индексы, ветки или внешнее состояние и не запрашивай повышение прав.",
          `Проект: ${parent.projectId}. Задача: ${taskId}. Исходный тред: @thread:${threadId}. Исходное окружение: ${environmentId}.`,
          `Сначала проверь, что git rev-parse HEAD возвращает ${target.head}. При расхождении остановись и сообщи фактическую ревизию.`,
          context,
          "Оставь замечания в этом треде с путём, строкой, серьёзностью и обоснованием. Уточнения будут приходить в этот же тред. Результат предназначен для обсуждения и не является доказательством BSL Flow.",
          `Вопрос и фокус ревью:\n${brief}`,
        ].join("\n\n"),
      });
      return { threadId: child.id };
    },
    async reviewList(scope) {
      const parent = await bb.sdk.threads.get({ threadId: scope.threadId });
      if (parent.environmentId !== scope.environmentId) throw new Error("Исходная рабочая копия треда была переключена.");
      const children = await bb.sdk.threads.list({ parentThreadId: scope.threadId, originPluginId: "1c-properties", limit: 50 });
      if (!children.length) return [];
      const metadata = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: children.map(({ id }) => id) });
      const records = new Map(metadata.threads.map(({ threadId, metadata }) => [threadId, metadata.orchestration]));
      return children.flatMap((child) => {
        const parsed = reviewRecord.safeParse(records.get(child.id));
        if (!parsed.success || parsed.data.parentThreadId !== scope.threadId || parsed.data.sourceEnvironmentId !== scope.environmentId) return [];
        return [{ ...parsed.data, threadId: child.id, title: child.title, status: child.runtime.displayStatus,
          environmentId: child.environmentId }];
      });
    },
  };

  bb.rpc.register(reviewContract, handlers, {
    experimental_discoverable: true,
    experimental_description: "Второе мнение в отдельной рабочей копии BB",
  });
}
