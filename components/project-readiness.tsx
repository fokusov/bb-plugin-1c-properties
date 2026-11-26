import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ProjectReadiness } from "../contract.js";
import type { PlatformScope } from "../platform-contract.js";
import type { rpcContract } from "../rpc.js";
import { Button } from "./ui/button.js";

const labels = {
  ready: "Готово",
  unchecked: "Не проверено",
  missing: "Требуется настройка",
  disabled: "Отключено",
  error: "Ошибка",
};

function StatusRow({ title, status, detail }: ProjectReadiness["unica"] & { title: string }) {
  return (
    <div>
      <dt className="font-medium">{title} · {labels[status]}</dt>
      <dd className="break-words text-muted-foreground">{detail}</dd>
    </div>
  );
}

export function ProjectReadinessCard({
  scope, refresh = 0, prepare, busy = false, stage, failure, checkedConnection = false,
}: {
  scope: PlatformScope;
  refresh?: number;
  prepare?: () => void;
  busy?: boolean;
  stage?: string | null;
  failure?: string | null;
  checkedConnection?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId, threadId, environmentId } = scope;
  const [data, setData] = useState<ProjectReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ probeAt?: number }>({});
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setError(null);
    rpc.call("projectReadiness", {
      projectId,
      ...(threadId ? { threadId } : {}),
      ...(environmentId ? { environmentId } : {}),
      probeUnica: request.probeAt === refresh,
    })
      .then(
        (result) => { if (active) setData(result); },
        (cause: unknown) => {
          if (active) {
            setData(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      ).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [rpc, projectId, threadId, environmentId, refresh, request]);

  const files = data?.files;
  const conflict = files?.schema && files.schema !== "bsl-flow";
  const disabled = files?.flow.enabled === false;
  const flowReady = files?.flow.initialized && files.flow.enabled === true && files.skills.bslflow > 0 && files.core.installed;
  const coreRevision = files?.core.commit ? " · " + files.core.commit : " · коммит не подтверждён";
  const flowDetail = !files ? "" : conflict ? "Текущая схема OpenSpec: " + files.schema + ". Проверьте совместимость перед подготовкой."
    : disabled ? "Возобновить работу можно в настройках BSL Flow."
    : flowReady ? "Core " + (files.core.version || files.flow.version || "версия неизвестна") + coreRevision + " · скиллы: " + files.skills.bslflow
    : !files.flow.initialized ? (prepare ? "Запустите подготовку BSL Flow." : "Подготовьте проект в карточке «1С» и перенесите проектные файлы в этот worktree.")
    : files.flow.enabled === null ? "Проверьте bsl-flow.yaml."
    : !files.core.installed ? "Установите Core на машине окружения."
    : "Подключите скиллы BSL Flow для этой рабочей копии.";

  return (
    <section aria-label="Готовность проекта 1С" className="space-y-2 rounded-md border border-border p-3">
      <h3 className="text-sm font-medium">Готовность проекта 1С</h3>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {stage && <p role="status" className="text-xs">{stage}…</p>}
      {failure && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{failure}</p>}
      {!data && checking && <p role="status" className="text-xs">Проверяем состояние проекта…</p>}
      {data && files && <>
        <p className="text-xs text-muted-foreground">{data.hostName} · <code className="break-all">{data.path}</code></p>
        {data.projectPath !== data.path &&
          <p className="text-xs text-muted-foreground">Основной каталог: <code className="break-all">{data.projectPath}</code></p>}
        <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          <StatusRow title="Исходники" status={files.exists && files.hasSources ? "ready" : "missing"}
            detail={!files.exists ? "Каталог недоступен. Проверьте источник проекта."
              : !files.hasSources ? "Выберите каталог с исходниками 1С."
              : files.git.repository ? "Исходники 1С обнаружены в Git."
              : "Исходники 1С обнаружены. Проверьте Git перед подготовкой BSL Flow."} />
          <StatusRow title="BSL Flow" status={conflict ? "error" : disabled ? "disabled" : flowReady ? "ready" : "missing"} detail={flowDetail} />
          <StatusRow title="Редактор" status={data.editor && files.exists ? "ready" : "unchecked"}
            detail={!files.exists ? "Рабочий каталог недоступен."
              : data.editor ? "Встроенный редактор доступен во вкладке «1С» треда."
              : "Активен отдельный bsl-editor. Открытие файлов зависит от его настроек."} />
          <StatusRow title="Unica" {...data.unica} />
          <StatusRow title="OpenSpec CLI" status={files.openspecCli ? "ready" : "missing"}
            detail={files.openspecCli ? "Команда openspec найдена на машине окружения." : "Установите OpenSpec CLI и проверьте PATH машины BB."} />
          <StatusRow title="Ревью" {...files.review} />
          <StatusRow title="Тестовая ИБ" {...data.testBase}
            detail={checkedConnection ? "Подключение к параметрам проекта проверено. Подтвердите назначение базы для тестов." : data.testBase.detail} />
        </dl>
      </>}
      <div className="flex flex-wrap gap-2">
        {prepare && data && files?.exists && files.hasSources && (
          <Button size="sm" onClick={prepare} disabled={busy || Boolean(conflict) || disabled}>
            {failure ? "Повторить подготовку" : flowReady ? "Обновить BSL Flow" : "Подготовить BSL Flow"}
          </Button>
        )}
        {data && ["unchecked", "error", "ready"].includes(data.unica.status) &&
          <Button size="sm" variant="outline" disabled={checking || busy} onClick={() => setRequest({ probeAt: refresh })}>
            Проверить Unica
          </Button>}
        {(data || error) &&
          <Button size="sm" variant="outline" disabled={checking || busy} onClick={() => setRequest({})}>
            Обновить статусы
          </Button>}
      </div>
    </section>
  );
}
