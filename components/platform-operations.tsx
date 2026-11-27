import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_FileLink as FileLink, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../rpc.js";
import {
  isEdtAction, platformActions, platformProfileSchema,
  type PlatformInventoryItem, type PlatformJournalEntry, type PlatformPreview, type PlatformRequest, type PlatformScope,
} from "../platform-contract.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { PlatformTree, runStateLabels as entryLabels, type Command } from "./platform-tree.js";
import { PlatformHostPanel, type HostPanel } from "./platform-host-panel.js";
import "./platform-operations.css";

const selectStyle = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
type Action = PlatformRequest["action"];
const inputs: Partial<Record<Action, string>> = {
  "load-xml": "Каталог XML", "load-binary": "Файл CF/CFE", "build-configuration": "Каталог XML",
  "unpack-configuration": "Файл CF/CFE", "build-external": "Корневой файл XML",
  "unpack-external": "Файл EPF/ERF", "restore-dt": "Файл DT", vanessa: "Файл Vanessa Automation EPF",
  "edt-import": "Каталог XML", "edt-export": "Каталог проекта EDT",
  "build-cfu": "Предыдущий файл поставки CF", "apply-cfu": "Файл обновления CFU",
};
const outputs: Partial<Record<Action, string>> = {
  "dump-xml": "Новый каталог XML", "dump-binary": "Файл CF/CFE", "build-configuration": "Файл CF/CFE",
  "unpack-configuration": "Новый каталог XML", "build-external": "Файл EPF/ERF",
  "unpack-external": "Корневой файл XML", "dump-dt": "Файл DT",
  "edt-import": "Новый каталог проекта EDT", "edt-export": "Новый каталог XML",
  "build-distribution": "Новый файл поставки CF", "build-cfu": "Новый файл обновления CFU",
  "apply-cfu": "Новый файл резервной копии DT",
};
const optionalExtension: readonly Action[] = ["check-syntax", "check-config"];

type Selection =
  | { kind: "command"; command: Command }
  | { kind: "file"; item: PlatformInventoryItem }
  | { kind: "profile"; name: string }
  | { kind: "host"; panel: HostPanel }
  | { kind: "run"; id: string };

function artifactActions(item: PlatformInventoryItem): { input: string; choices: Command[] } {
  const itemExtension = item.kind === "extension";
  const make = (action: Action, label: string): Command => ({
    id: `file-action:${item.path}:${action}`, label, action, extension: itemExtension && !isEdtAction(action) ? true : undefined,
  });
  if (item.source === "edt") {
    const match = /^(?:(.*)\/)?src\/Configuration\/Configuration\.mdo$/i.exec(item.path);
    return match ? { input: match[1] || ".", choices: [make("edt-export", platformActions["edt-export"])] } : { input: item.path, choices: [] };
  }
  if (item.kind === "backup") return { input: item.path, choices: [make("restore-dt", "Восстановить из DT")] };
  if (item.kind === "update") return { input: item.path, choices: [make("apply-cfu", platformActions["apply-cfu"])] };
  if (item.kind === "configuration" || itemExtension) {
    const input = item.source === "xml" ? item.path.split("/").slice(0, -1).join("/") || "." : item.path;
    return { input, choices: item.source === "xml"
      ? [make("build-configuration", `Собрать ${itemExtension ? "CFE" : "CF"}`), make("load-xml", "Загрузить из XML"),
        make("edt-import", platformActions["edt-import"])]
      : [make("unpack-configuration", "Разобрать в XML"), make("load-binary", "Загрузить в базу"),
        ...(!itemExtension ? [make("build-cfu", "Использовать как предыдущую поставку CF")] : [])] };
  }
  const suffix = item.kind === "processor" ? "EPF" : "ERF";
  return { input: item.path, choices: item.source === "xml"
    ? [make("build-external", `Собрать ${suffix}`)]
    : [make("unpack-external", "Разобрать в XML")] };
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{title}{children}</label>;
}

function downloadArtifact(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: name.endsWith(".xml") ? "application/xml" : "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PlatformOperationsPanel({ scope }: { scope: PlatformScope }) {
  return <PlatformWorkbench key={JSON.stringify([scope.projectId, scope.threadId, scope.environmentId])} scope={scope} />;
}

function PlatformWorkbench({ scope }: { scope: PlatformScope }) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const { projectId, threadId, environmentId } = scope;
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof loadProfiles>>>();
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof loadInventory>>>();
  const [inventoryStatus, setInventoryStatus] = useState("Читаю рабочую копию…");
  const scan = useRef<AbortController | null>(null);
  const [journal, setJournal] = useState<PlatformJournalEntry[]>([]);
  const [request, setRequest] = useState<PlatformRequest>({ action: "dump-xml", profile: "project", format: "Hierarchical" });
  const [preview, setPreview] = useState<PlatformPreview | null>(null);
  const [checked, setChecked] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const detail = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ name: "", kind: "dev" as "dev" | "test", infobase: "", platform: "", user: "", passwordSecret: "", unlockCodeSecret: "" });
  const [artifact, setArtifact] = useState<{ name: string; text: string } | null>(null);
  const scopeInput = { projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}) };
  const loadProfiles = useCallback(() => rpc.call("platformProfiles", {
    projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}),
  }), [rpc, projectId, threadId, environmentId]);
  const loadInventory = useCallback((signal: AbortSignal) => sdk.plugins.callRpc({
    pluginId: "1c-properties", method: "platformInventory", outputSchema: rpcContract.platformInventory.output,
    input: { projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}) },
    signal,
  }), [sdk, projectId, threadId, environmentId]);
  const refreshInventory = useCallback(() => {
    scan.current?.abort();
    const controller = new AbortController();
    scan.current = controller;
    setInventoryStatus("Читаю рабочую копию…");
    void loadInventory(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setInventory(result);
      setInventoryStatus(result.complete ? "" : "Неполный список. Достигнут лимит поиска или часть файлов недоступна.");
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setInventory(undefined);
        setInventoryStatus(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [loadInventory]);
  const refresh = useCallback(async () => {
    setJournal(await rpc.call("platformJournal", {
      projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}),
    }));
  }, [rpc, projectId, threadId, environmentId]);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const active = journal.find((item) => item.state === "running");
  const priorActive = useRef<string | null>(null);
  const entry = selection?.kind === "run" ? journal.find(({ id }) => id === selection.id) : undefined;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([loadProfiles().then((next) => { if (mounted.current) setProfiles(next); }), refresh()]).catch(fail);
    return () => { mounted.current = false; };
  }, [loadProfiles, refresh]);
  useEffect(() => {
    refreshInventory();
    return () => scan.current?.abort();
  }, [refreshInventory]);
  useEffect(() => {
    if (priorActive.current && priorActive.current !== active?.id) refreshInventory();
    priorActive.current = active?.id ?? null;
  }, [active?.id, refreshInventory]);

  useRealtime("platform-operations", () => { void refresh().catch(fail); });

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void refresh().catch(fail); }, 1500);
    return () => clearInterval(timer);
  }, [active?.id, refresh]);

  function change(patch: Partial<PlatformRequest>) {
    setRequest((previous) => ({ ...previous, ...patch }));
    setChecked(false);
    setPreview(null);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await work(); }
    catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }

  function requestInput() {
    if (selection?.kind === "command" && selection.command.extension && !request.extension?.trim()) {
      throw new Error("Укажи имя расширения.");
    }
    const value = isEdtAction(request.action) ? { ...request, profile: "project", format: "Hierarchical" } : request;
    return Object.fromEntries(Object.entries(value).filter(([, field]) => Boolean(field?.trim()))) as PlatformRequest;
  }

  function choose(next: Selection) {
    setSelection(next);
    setError("");
    setArtifact(null);
    setChecked(false);
    setPreview(null);
    detail.current?.focus();
  }

  function openProfile(name: string) {
    if (busy) return;
    const profile = profiles?.profiles.find((item) => item.name === name);
    setDraft({
      name: profile?.name ?? "", kind: profile?.kind ?? "dev", infobase: profile?.infobase ?? "",
      platform: profile?.platform ?? "", user: profile?.user ?? "", passwordSecret: profile?.passwordSecret ?? "",
      unlockCodeSecret: profile?.unlockCodeSecret ?? "",
    });
    if (name) change({ profile: name });
    choose({ kind: "profile", name });
  }

  function beginCommand(command: Command, input = "", extension = "") {
    if (busy) return;
    change({ action: command.action, input, output: "", config: "", baseProject: "", sha256: "", extension });
    choose({ kind: "command", command });
  }

  const selectedTreeId = selection?.kind === "command" ? selection.command.id
    : selection?.kind === "file" ? `file:${selection.item.path}`
    : selection?.kind === "run" ? `run:${selection.id}`
    : selection?.kind === "profile" ? `profile:${selection.name}`
    : selection?.kind === "host" ? `host:${selection.panel}` : undefined;
  const chosenFile = selection?.kind === "file" ? selection.item : null;
  const fileChoices = chosenFile ? artifactActions(chosenFile) : null;
  const editing = selection?.kind === "profile" && selection.name !== "project";
  const showCommand = selection?.kind === "command";

  function workspaceFile(path: string, label: string) {
    const relativePath = path.replaceAll("\\", "/");
    const target = environmentId ? { kind: "workspace" as const, environmentId, path: relativePath }
      : inventory ? { kind: "host" as const, hostId: inventory.hostId, path: `${inventory.workspace.replace(/[\\/]$/, "")}/${relativePath}` }
      : null;
    return target ? <FileLink target={target} className="break-all text-primary underline underline-offset-2">{label}</FileLink>
      : <span className="break-all">{label}</span>;
  }

  return (
    <section className="platform-workbench grid gap-3">
      <header className="grid min-w-0 gap-1">
        <h3 className="text-sm font-semibold">Операции платформы 1С</h3>
        {inventory && <p className="break-all text-xs text-muted-foreground">Рабочая копия · {inventory.workspace}</p>}
      </header>
      <div className="platform-layout">
      <PlatformTree items={inventory?.items ?? []} inventoryStatus={inventoryStatus} profiles={profiles?.profiles ?? []}
        journal={journal} selected={selectedTreeId} activeProfile={request.profile} busy={busy}
        onCommand={(command) => beginCommand(command)}
        onArtifact={(item) => { if (!busy) choose({ kind: "file", item }); }}
        onProfile={openProfile}
        onHostPanel={(panel) => choose({ kind: "host", panel })}
        onRun={(id) => { if (!busy) choose({ kind: "run", id }); }}
        onRefresh={() => {
          refreshInventory();
          void Promise.all([refresh(), loadProfiles().then(setProfiles)]).catch(fail);
        }} />
      <section ref={detail} tabIndex={-1} className="grid min-w-0 gap-3 rounded-lg border border-border p-3 outline-none"
        aria-label="Детали операции 1С">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!selection && <p className="text-sm text-muted-foreground">Выбери команду, артефакт или запуск в дереве.</p>}
      {selection?.kind === "host" && <PlatformHostPanel panel={selection.panel} scope={scopeInput} />}
      {chosenFile && fileChoices && <div className="grid gap-2 text-sm">
        <h4 className="font-medium">{chosenFile.name ?? chosenFile.path.split("/").at(-1)}</h4>
        <div className="text-xs">{workspaceFile(chosenFile.path, chosenFile.path)}</div>
        <div className="flex flex-wrap gap-2">{fileChoices.choices.map((action) =>
          <Button key={action.id} size="sm" variant="outline" onClick={() => beginCommand(action, fileChoices.input,
            chosenFile.source === "xml" && action.extension ? chosenFile.name ?? "" : "")}>{action.label}</Button>)}</div>
      </div>}
      {selection?.kind === "profile" && selection.name === "project" &&
        <p className="text-sm">Активны параметры подключения проекта. Именованные профили доступны в дереве.</p>}
      {showCommand && <div className="platform-fields">
        <h4 className="text-sm font-medium">{selection.command.label}</h4>
        {!isEdtAction(request.action) && <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field title="Профиль">
              <select className={selectStyle} value={request.profile} disabled={busy} onChange={(event) => change({ profile: event.target.value })}>
                <option value="project">Параметры проекта</option>
                {profiles?.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} ({profile.kind})</option>)}
              </select>
            </Field>
          </div>
        </div>}
        {inputs[request.action] && <Field title={inputs[request.action]!}><Input value={request.input ?? ""} disabled={busy} onChange={(e) => change({ input: e.target.value })} /></Field>}
        {outputs[request.action] && <Field title={outputs[request.action]!}><Input value={request.output ?? ""} disabled={busy} onChange={(e) => change({ output: e.target.value })} /></Field>}
        {(request.action === "apply-cfu" || request.action === "restore-dt") && <Field title={request.action === "apply-cfu"
          ? "Доверенный SHA-256 файла CFU" : "SHA-256 копии DT (при наличии)"}>
          <Input value={request.sha256 ?? ""} spellCheck={false} disabled={busy} onChange={(e) => change({ sha256: e.target.value })} />
        </Field>}
        {isEdtAction(request.action) && <Field title="Базовый проект EDT (для расширения)"><Input value={request.baseProject ?? ""}
          disabled={busy} onChange={(e) => change({ baseProject: e.target.value })} /></Field>}
        {(selection.command.extension || optionalExtension.includes(request.action)) &&
          <Field title="Имя расширения"><Input value={request.extension ?? ""} disabled={busy} onChange={(e) => change({ extension: e.target.value })} /></Field>}
        {["unpack-configuration", "build-configuration", "dump-xml", "load-xml", "unpack-external"].includes(request.action) && (
          <Field title="Формат XML"><select className={selectStyle} value={request.format} disabled={busy}
            onChange={(event) => change({ format: event.target.value as PlatformRequest["format"] })}>
            <option value="Hierarchical">Иерархический</option><option value="Plain">Линейный</option>
          </select></Field>
        )}
        {["yaxunit", "vanessa"].includes(request.action) && <Field title="Настройки тестов JSON"><Input value={request.config ?? ""} disabled={busy} onChange={(e) => change({ config: e.target.value })} /></Field>}
      </div>}
      {editing && (
        <div className="grid gap-2 rounded-md border border-border p-3">
          <h4 className="text-sm font-medium">Профиль платформы</h4>
          <div className="platform-fields">
            <Field title="Тип"><select className={selectStyle} value={draft.kind} disabled={busy}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as typeof draft.kind })}>
              <option value="dev">Разработка</option><option value="test">Тестирование</option>
            </select></Field>
            <Field title="База из списка .v8i"><select className={selectStyle} value={profiles?.infobases.some(({ value }) => value === draft.infobase) ? draft.infobase : ""}
              disabled={busy} onChange={(event) => setDraft({ ...draft, infobase: event.target.value })}>
              <option value="">Указать вручную</option>
              {profiles?.infobases.map((base) => <option key={base.value} value={base.value}>{base.name} ({base.kind})</option>)}
            </select></Field>
            {([
              ["name", "Имя профиля"], ["infobase", "Путь или строка соединения"], ["platform", "Путь к платформе"],
              ["user", "Пользователь"], ["passwordSecret", "Имя секрета пароля в Env Catalog"],
              ["unlockCodeSecret", "Имя секрета кода доступа в Env Catalog"],
            ] as const).map(([key, title]) => (
              <Field key={key} title={title}><Input value={draft[key]} disabled={busy} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></Field>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(async () => {
              const profile = platformProfileSchema.parse(Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim())));
              const next = await rpc.call("platformSaveProfile", { ...scopeInput, profile });
              setProfiles({ profiles: next, infobases: profiles?.infobases ?? [] });
              change({ profile: profile.name });
              choose({ kind: "profile", name: profile.name });
            })}>Сохранить профиль</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelection(null)}>Закрыть</Button>
          </div>
        </div>
      )}
      {showCommand && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => void run(async () => {
          setChecked(false);
          setPreview(null);
          setPreview(await rpc.call("platformPreview", { ...scopeInput, request: requestInput() }));
        })}>Проверить параметры</Button>
      </div>}
      {preview && (
        <section aria-label="Предпросмотр операции" className="grid gap-2 break-all rounded-md border border-border p-3 text-xs">
          <strong>{platformActions[preview.action]}</strong>
          {!isEdtAction(preview.action) && <div>Профиль {preview.profile} ({preview.kind})</div>}
          <div>Рабочая копия {preview.workspace}</div>
          <div>{isEdtAction(preview.action) ? "EDT CLI" : "Платформа"} {preview.platform}</div>
          {!isEdtAction(preview.action) && <div>База {preview.target}</div>}
          <div>{preview.targetState}</div>
          {preview.input && <div>Вход {preview.input}</div>}
          {preview.output && <div>Выход {preview.output}</div>}
          {preview.baseProject && <div>Базовый проект EDT {preview.baseProject}</div>}
          {preview.cfu && <>
            <div>{preview.cfu.current.name} · {preview.cfu.current.vendor} · {preview.cfu.current.version} → {preview.cfu.target.version}</div>
            <div>Допустимые исходные версии {preview.cfu.allowedVersions.join(", ")}</div>
            <div>Проверенный SHA-256 {preview.cfu.sha256}</div>
          </>}
          {preview.sourceSha256 && <div>Проверенный SHA-256 копии DT {preview.sourceSha256}</div>}
          {preview.extension && <div>Расширение {preview.extension}</div>}
          {preview.config && <div>Настройки тестов {preview.config}</div>}
          {preview.confirmation && preview.recovery && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
              Я проверил фактическое состояние базы и отсутствие активного процесса после операции {preview.recovery}.
            </label>
          )}
          <div><Button size="sm" disabled={busy || Boolean(active) || Boolean(preview.confirmation && preview.recovery && !checked)}
            variant={preview.confirmation ? "destructive" : "default"} onClick={() => void run(async () => {
              const next = await rpc.call("platformStart", {
                ...scopeInput, request: requestInput(),
                ...(preview.confirmation ? { confirmation: preview.confirmation } : {}),
                ...(checked && preview.recovery ? { inspected: preview.recovery } : {}),
              });
              choose({ kind: "run", id: next.id });
              await refresh();
              refreshInventory();
            })}>{preview.confirmation ? "Подтвердить и запустить" : "Запустить"}</Button></div>
        </section>
      )}
      {entry && (
        <div className="grid gap-2 rounded-md border border-border p-3 text-xs">
          <h4 className="text-sm font-medium">{platformActions[entry.action]}</h4>
          <div className="break-all">{entry.id} · {isEdtAction(entry.action) ? "EDT" : entry.profile} · {entry.target}</div>
          <div>{entryLabels[entry.state]} · этап {entry.stage}/{entry.stages}{entry.revision && ` · Git ${entry.revision.slice(0, 12)}${entry.dirty ? " + локальные изменения" : ""}`}</div>
          <div>{entry.targetState}</div>
          {entry.cfu && <div className="break-all">{entry.cfu.current.name} · {entry.cfu.current.vendor} · {entry.cfu.current.version} → {entry.cfu.target.version}</div>}
          {entry.error && <p className="text-destructive">{entry.error}</p>}
          {entry.needsInspection && entry.state !== "running" && <p>{isEdtAction(entry.action)
            ? "Проверь содержимое выходного каталога перед повтором." : "Проверь фактическое состояние базы перед повтором."}</p>}
          {entry.counts && <p>Тестов {entry.counts.tests}, падений {entry.counts.failures}, ошибок {entry.counts.errors}, пропущено {entry.counts.skipped}</p>}
          {entry.state === "running" && <div><Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => {
            await rpc.call("platformCancel", { ...scopeInput, id: entry.id });
            await refresh();
          })}>Остановить процесс</Button></div>}
          <div className="flex flex-wrap items-center gap-2">
            {entry.artifacts.map(({ name, kind, workspacePath, sha256 }) => kind === "output"
              ? <div key={name} className="min-w-0">
                {workspacePath ? workspaceFile(workspacePath, workspacePath) : entry.output}
                {sha256 && <div className="break-all text-muted-foreground">SHA-256 {sha256}</div>}
              </div>
              : <Button key={name} size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
                const result = await rpc.call("platformArtifact", { ...scopeInput, id: entry.id, name });
                setArtifact({ name, text: result.text });
              })}>{name}</Button>)}
          </div>
          {artifact && <div className="grid gap-2">
            <div><Button size="sm" variant="outline" onClick={() => downloadArtifact(artifact.name, artifact.text)}>Скачать {artifact.name}</Button></div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">{artifact.text.slice(0, 16_000)}</pre>
          </div>}
        </div>
      )}
      </section>
      </div>
    </section>
  );
}
