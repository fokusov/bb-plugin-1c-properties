import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../rpc.js";
import {
  platformActions, platformProfileSchema,
  type PlatformJournalEntry, type PlatformPreview, type PlatformRequest, type PlatformScope,
} from "../platform-contract.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

const selectStyle = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
const actionOptions = Object.entries(platformActions) as [PlatformRequest["action"], string][];
const entryLabels: Record<PlatformJournalEntry["state"], string> = {
  running: "Выполняется", launched: "Процесс запущен", done: "Готово",
  failed: "Ошибка", cancelled: "Отменено", interrupted: "Связь с процессом потеряна",
};
type Action = PlatformRequest["action"];
const inputs: Partial<Record<Action, string>> = {
  "load-xml": "Каталог XML", "load-binary": "Файл CF/CFE", "build-configuration": "Каталог XML",
  "unpack-configuration": "Файл CF/CFE", "build-external": "Корневой файл XML",
  "unpack-external": "Файл EPF/ERF", "restore-dt": "Файл DT", vanessa: "Файл Vanessa Automation EPF",
};
const outputs: Partial<Record<Action, string>> = {
  "dump-xml": "Новый каталог XML", "dump-binary": "Файл CF/CFE", "build-configuration": "Файл CF/CFE",
  "unpack-configuration": "Новый каталог XML", "build-external": "Файл EPF/ERF",
  "unpack-external": "Корневой файл XML", "dump-dt": "Файл DT",
};
const extensions: Action[] = ["dump-xml", "load-xml", "dump-binary", "load-binary", "build-configuration", "unpack-configuration", "update-db", "check-syntax"];

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
  const rpc = useRpc<typeof rpcContract>();
  const { projectId, threadId, environmentId } = scope;
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof loadProfiles>>>();
  const [journal, setJournal] = useState<PlatformJournalEntry[]>([]);
  const [request, setRequest] = useState<PlatformRequest>({ action: "dump-xml", profile: "project", format: "Hierarchical" });
  const [preview, setPreview] = useState<PlatformPreview | null>(null);
  const [checked, setChecked] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "dev" as "dev" | "test", infobase: "", platform: "", user: "", passwordSecret: "", unlockCodeSecret: "" });
  const [artifact, setArtifact] = useState<{ name: string; text: string } | null>(null);
  const scopeInput = { projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}) };
  const loadProfiles = useCallback(() => rpc.call("platformProfiles", {
    projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}),
  }), [rpc, projectId, threadId, environmentId]);
  const refresh = useCallback(async () => {
    setJournal(await rpc.call("platformJournal", {
      projectId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}),
    }));
  }, [rpc, projectId, threadId, environmentId]);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const active = journal.find((item) => item.state === "running");
  const entry = journal.find((item) => item.id === selected) ?? journal[0];
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([loadProfiles().then((next) => { if (mounted.current) setProfiles(next); }), refresh()]).catch(fail);
    return () => { mounted.current = false; };
  }, [loadProfiles, refresh]);

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
    return Object.fromEntries(Object.entries(request).filter(([, value]) => Boolean(value?.trim()))) as PlatformRequest;
  }

  const openProfile = () => {
    const profile = profiles?.profiles.find(({ name }) => name === request.profile);
    setDraft({
      name: profile?.name ?? "", kind: profile?.kind ?? "dev", infobase: profile?.infobase ?? "",
      platform: profile?.platform ?? "", user: profile?.user ?? "", passwordSecret: profile?.passwordSecret ?? "",
      unlockCodeSecret: profile?.unlockCodeSecret ?? "",
    });
    setEditing(true);
  };

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h3 className="text-sm font-medium">Операции платформы 1С</h3>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field title="Операция">
          <select className={selectStyle} value={request.action} disabled={busy} onChange={(event) =>
            change({ action: event.target.value as Action, input: "", output: "", config: "", extension: "" })}>
            {actionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field title="Профиль">
              <select className={selectStyle} value={request.profile} disabled={busy} onChange={(event) => change({ profile: event.target.value })}>
                <option value="project">Параметры проекта</option>
                {profiles?.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} ({profile.kind})</option>)}
              </select>
            </Field>
          </div>
          <Button variant="outline" size="sm" onClick={openProfile} disabled={busy}>{request.profile === "project" ? "Добавить профиль" : "Изменить"}</Button>
        </div>
        {inputs[request.action] && <Field title={inputs[request.action]!}><Input value={request.input ?? ""} disabled={busy} onChange={(e) => change({ input: e.target.value })} /></Field>}
        {outputs[request.action] && <Field title={outputs[request.action]!}><Input value={request.output ?? ""} disabled={busy} onChange={(e) => change({ output: e.target.value })} /></Field>}
        {extensions.includes(request.action) && <Field title="Имя расширения (для CFE)"><Input value={request.extension ?? ""} disabled={busy} onChange={(e) => change({ extension: e.target.value })} /></Field>}
        {["unpack-configuration", "build-configuration", "dump-xml", "load-xml", "unpack-external"].includes(request.action) && (
          <Field title="Формат XML"><select className={selectStyle} value={request.format} disabled={busy}
            onChange={(event) => change({ format: event.target.value as PlatformRequest["format"] })}>
            <option value="Hierarchical">Иерархический</option><option value="Plain">Линейный</option>
          </select></Field>
        )}
        {["yaxunit", "vanessa"].includes(request.action) && <Field title="Настройки тестов JSON"><Input value={request.config ?? ""} disabled={busy} onChange={(e) => change({ config: e.target.value })} /></Field>}
      </div>
      {editing && (
        <div className="grid gap-2 rounded-md border border-border p-3">
          <h4 className="text-sm font-medium">Профиль платформы</h4>
          <div className="grid gap-2 sm:grid-cols-2">
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
              setEditing(false);
            })}>Сохранить профиль</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Закрыть</Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => void run(async () => {
          setChecked(false);
          setPreview(null);
          setPreview(await rpc.call("platformPreview", { ...scopeInput, request: requestInput() }));
        })}>Проверить параметры</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(refresh)}>Обновить журнал</Button>
      </div>
      {preview && (
        <div className="grid gap-2 break-all rounded-md border border-border p-3 text-xs">
          <strong>{platformActions[preview.action]}</strong>
          <div>Профиль {preview.profile} ({preview.kind})</div>
          <div>Рабочая копия {preview.workspace}</div>
          <div>Платформа {preview.platform}</div>
          <div>База {preview.target}</div>
          <div>{preview.targetState}</div>
          {preview.input && <div>Вход {preview.input}</div>}
          {preview.output && <div>Выход {preview.output}</div>}
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
              setSelected(next.id);
              setArtifact(null);
              setPreview(null);
              await refresh();
            })}>{preview.confirmation ? "Подтвердить и запустить" : "Запустить"}</Button></div>
        </div>
      )}
      {entry && (
        <div className="grid gap-2 rounded-md border border-border p-3 text-xs">
          <Field title="Журнал рабочей копии">
            <select className={selectStyle} value={entry.id} onChange={(event) => { setArtifact(null); setSelected(event.target.value); }}>
              {journal.map((item) => <option value={item.id} key={item.id}>{new Date(item.startedAt).toLocaleString("ru")} · {platformActions[item.action]} · {entryLabels[item.state]}</option>)}
            </select>
          </Field>
          <div className="break-all">{entry.id} · {entry.profile} · {entry.target}</div>
          <div>{entryLabels[entry.state]} · этап {entry.stage}/{entry.stages}{entry.revision && ` · Git ${entry.revision.slice(0, 12)}${entry.dirty ? " + локальные изменения" : ""}`}</div>
          <div>{entry.targetState}</div>
          {entry.error && <p className="text-destructive">{entry.error}</p>}
          {entry.needsInspection && entry.state !== "running" && <p>Проверь фактическое состояние базы перед повтором.</p>}
          {entry.counts && <p>Тестов {entry.counts.tests}, падений {entry.counts.failures}, ошибок {entry.counts.errors}, пропущено {entry.counts.skipped}</p>}
          {entry.state === "running" && <div><Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => {
            await rpc.call("platformCancel", { ...scopeInput, id: entry.id });
            await refresh();
          })}>Остановить процесс</Button></div>}
          <div className="flex flex-wrap items-center gap-2">
            {entry.artifacts.map(({ name, kind, workspacePath }) => kind === "output"
              ? <span key={name} className="break-all">{workspacePath ?? entry.output}</span>
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
  );
}
