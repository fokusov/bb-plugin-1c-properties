import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { BslFlowConfig } from "../contract";
import type { rpcContract } from "../rpc";
import { COUNCIL_ROLES } from "../lib/bslflow-fields";
import { resolveCatalogModel } from "../lib/council-model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Path = Array<string | number>;
type Scalar = string | number | boolean | null;
type Field = { path: Path; value: Scalar };
const councilPath = ["review", "council"];
type CouncilRole = typeof COUNCIL_ROLES[number];
const roleLabels: Record<CouncilRole, string> = {
  brainstorm: "Генерация вариантов",
  intent_critic: "Критик требований",
  architecture_critic: "Архитектурный критик",
  executability_critic: "Критик реализуемости",
  chair: "Председатель",
};
const emptySelection: ExperimentalProviderModelPickerValue = { providerId: "", model: "", reasoningLevel: "" };
const selectClass = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const sections: Record<string, string> = {
  version: "Версия конфигурации", workflow: "Рабочий процесс", features: "Возможности",
  source: "Исходники", environment: "Среда", test_setup: "Подготовка тестов",
  onec: "Операции 1С", verification: "Проверки", policy: "Политика", llm: "Провайдеры и модели", review: "Ревью",
};

function keys(node: unknown) {
  return isMap(node) ? node.items.flatMap(({ key }) => isScalar(key) && typeof key.value === "string" ? [key.value] : []) : [];
}

function fieldList(node: unknown, path: Path): Field[] {
  if (isMap(node)) return keys(node).flatMap((key) => fieldList(node.get(key, true), [...path, key]));
  if (isSeq(node)) return node.items.flatMap((item, index) => fieldList(item, [...path, index]));
  if (!isScalar(node)) return [];
  const value = node.value;
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? [{ path, value }] : [];
}

function FieldInput({ field, edit }: { field: Field; edit: (path: Path, value: unknown) => void }) {
  const { path, value } = field;
  const label = path.join(".");
  const id = useId();
  return (
    <div className="grid items-center gap-1 text-sm sm:grid-cols-2">
      <label htmlFor={id} className="break-all font-mono text-xs">{label}</label>
      {typeof value === "boolean" ? (
        <input id={id} type="checkbox" className="size-4" checked={value} onChange={(event) => edit(path, event.target.checked)} />
      ) : (
        <Input id={id} key={String(value)} defaultValue={value ?? ""} type={typeof value === "number" ? "number" : "text"}
          step={typeof value === "number" ? "any" : undefined} onBlur={(event) => {
            const raw = event.target.value;
            if (raw === String(value ?? "")) return;
            if (typeof value === "number") {
              if (raw !== "" && Number.isFinite(Number(raw))) edit(path, Number(raw));
              else event.target.value = String(value);
            } else edit(path, raw);
          }} />
      )}
    </div>
  );
}

export function BslFlowSettings({ projectId, hostId, sourcePath, initialized, onSaved }: {
  projectId: string;
  hostId: string;
  sourcePath: string;
  initialized: boolean;
  onSaved: (enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [config, setConfig] = useState<BslFlowConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState("");
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [profileName, setProfileName] = useState("");
  const [editingProfile, setEditingProfile] = useState("");
  const [apiProvider, setApiProvider] = useState("");
  const [selection, setSelection] = useState(emptySelection);
  const [targetRole, setTargetRole] = useState<CouncilRole | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null | undefined>(undefined);
  const modelEditor = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => parseDocument(draft, { prettyErrors: false }), [draft]);
  const valid = doc.errors.length === 0 && isMap(doc.contents);
  const groups = keys(doc.contents);
  const group = groups.includes(section) ? section : groups[0] ?? "";
  const models = keys(doc.getIn(["llm", "models"], true));
  const providers = keys(doc.getIn(["llm", "providers"], true));
  const modelNames = [...new Set([...models, ...(config?.profile.models ?? [])])];
  const providerNames = [...new Set([...providers, ...(config?.profile.providers ?? [])])];
  const catalogModel = resolveCatalogModel(selection.providerId, selection.model);
  const dirty = config?.text !== null && config?.text !== undefined && config.text !== draft;

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await rpc.call("bslFlowConfig", { projectId });
      setConfig(next);
      setDraft(next.text ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }, [projectId, rpc]);

  useEffect(() => { void load(); }, [load, initialized]);
  useEffect(() => {
    const controller = new AbortController();
    setEnvironmentId(undefined);
    void sdk.environments.list({ projectId, hostId, path: sourcePath, status: "ready", signal: controller.signal }).then(
      (environments) => {
        if (!controller.signal.aborted) setEnvironmentId(
          environments.find(({ lifecycle }) => lifecycle.phase === "active")?.id ?? null,
        );
      },
      () => { if (!controller.signal.aborted) setEnvironmentId(null); },
    );
    return () => controller.abort();
  }, [sdk, projectId, hostId, sourcePath]);

  function editAll(changes: Array<{ path: Path; value: unknown }>) {
    try {
      const next = parseDocument(draft, { prettyErrors: false });
      for (const { path, value } of changes) {
        if (value === undefined) next.deleteIn(path);
        else next.setIn(path, value);
      }
      const text = next.toString({ lineWidth: 0 });
      const eol = draft.includes("\r\n") ? "\r\n" : "\n";
      setDraft((draft.startsWith("\uFEFF") ? "\uFEFF" : "") + text.replace(/\r?\n/g, eol));
      setError("");
      setMessage("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }
  const edit = (path: Path, value: unknown) => editAll([{ path, value }]);

  async function save() {
    if (!config?.revision || !valid) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await rpc.call("saveBslFlowConfig", { projectId, revision: config.revision, text: draft });
      setConfig(next);
      setDraft(next.text ?? "");
      setMessage("Настройки сохранены.");
      onSaved(next.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  function selectProfile(name: string) {
    const route = doc.getIn(["llm", "models", name, "provider"]);
    setEditingProfile(name);
    setProfileName(name);
    setApiProvider(typeof route === "string" && providerNames.includes(route) ? route : "");
    setSelection(emptySelection);
    setTargetRole(null);
  }

  function selectForRole(role: CouncilRole) {
    const prefix = `council-${role}`;
    let name = prefix;
    for (let suffix = 2; modelNames.includes(name); suffix++) name = `${prefix}-${suffix}`;
    selectProfile("");
    setProfileName(name);
    setTargetRole(role);
    modelEditor.current?.scrollIntoView?.({ block: "nearest" });
  }

  function pickModel(next: ExperimentalProviderModelPickerValue) {
    const hint = resolveCatalogModel(next.providerId, next.model).providerHint;
    if (next.providerId !== selection.providerId || next.model !== selection.model) {
      setApiProvider(providerNames.includes(hint) ? hint : "");
    }
    setSelection(next);
  }

  function applyModel() {
    const name = profileName.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || (name !== editingProfile && modelNames.includes(name))) {
      setError("Укажи новый идентификатор профиля из букв, цифр, дефисов и подчёркиваний.");
      return;
    }
    if (!selection.providerId || !catalogModel.modelId || !providerNames.includes(apiProvider)) return;
    const path = ["llm", "models", name];
    const changes = [
      { path: [...path, "provider"], value: apiProvider },
      { path: [...path, "model"], value: catalogModel.modelId },
    ];
    if (targetRole) changes.push({ path: [...councilPath, "roles", targetRole, "model"], value: name });
    if (editAll(changes)) {
      setEditingProfile(name);
      setTargetRole(null);
      setMessage("Профиль изменён. Сохрани настройки проекта.");
    }
  }

  const workflow = doc.getIn(["workflow", "enabled"]);
  const council = doc.getIn([...councilPath, "enabled"]);
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Настройки BSL Flow</summary>
      <div className="mt-3 space-y-3">
        {config ? <p className="break-all font-mono text-xs text-muted-foreground">{config.path}</p> : null}
        {error || config?.error ? <p role="alert" className="text-sm text-destructive">{error || config?.error}</p> : null}
        {message ? <p role="status" className="text-sm">{message}</p> : null}
        {!config && busy ? <p role="status" className="text-sm">Загружаю настройки…</p> : null}
        {config?.text === null && !config.error ? <p className="text-sm">Инициализируй BSL Flow в этом проекте, чтобы создать файл настроек.</p> : null}
        {config?.text != null ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={raw ? "outline" : "default"} onClick={() => setRaw(false)}>Поля</Button>
              <Button type="button" size="sm" variant={raw ? "default" : "outline"} onClick={() => setRaw(true)}>Весь YAML</Button>
            </div>
            {raw ? (
              <textarea aria-label="bsl-flow.yaml" spellCheck={false} className="min-h-72 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs"
                value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setMessage(""); }} />
            ) : valid ? (
              <fieldset className="space-y-3" disabled={busy}>
                <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border p-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={workflow !== false && workflow !== "false"}
                      onChange={(event) => edit(["workflow", "enabled"], event.target.checked)} />
                    Использовать BSL Flow для проекта
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={council === true || council === "true"}
                      onChange={(event) => edit([...councilPath, "enabled"], event.target.checked)} />
                    Включить Council
                  </label>
                </div>
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Роли Council и профили моделей</summary>
                  <p className="my-2 text-xs text-muted-foreground">Без Council обязательное ревью L и высокого риска блокируется. Профили из пользовательского конфига можно переопределить в проекте.</p>
                  {config.profile.error ? <p role="alert" className="mb-2 text-xs text-destructive">{config.profile.error}</p> : null}
                  <div className="space-y-2">
                    {COUNCIL_ROLES.map((role) => {
                      const path = [...councilPath, "roles", role, "model"];
                      const value = doc.getIn(path);
                      const binding = typeof value === "string" ? value : "";
                      return <div key={role} className="grid items-center gap-2 text-sm sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_auto]">
                        <div>{roleLabels[role]} <code className="block text-xs text-muted-foreground">{role}</code></div>
                        <select aria-label={roleLabels[role]} className={selectClass} value={binding}
                          onChange={(event) => edit(path, event.target.value || undefined)}>
                          <option value="">{config.profile.roles[role] ? `Из профиля: ${config.profile.roles[role]}` : "Профиль модели"}</option>
                          {binding && !modelNames.includes(binding) ? <option value={binding}>{binding} · профиль не найден</option> : null}
                          {modelNames.map((name) => {
                            const model = doc.getIn(["llm", "models", name, "model"]);
                            return <option key={name} value={name}>{typeof model === "string" ? `${name} · ${model}` : name}</option>;
                          })}
                        </select>
                        <Button type="button" size="sm" variant="outline" aria-label={`Выбрать модель BB: ${roleLabels[role]}`}
                          onClick={() => selectForRole(role)}>Выбрать в BB</Button>
                      </div>;
                    })}
                  </div>
                  <div ref={modelEditor} className="mt-3 space-y-2 rounded-md border border-border p-3">
                    <h4 className="text-sm font-medium">{targetRole ? `Модель для роли «${roleLabels[targetRole]}»` : "Профиль модели Council"}</h4>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="space-y-1 text-xs">
                        <span>Профиль BSL Flow</span>
                        <select className={selectClass} value={editingProfile} onChange={(event) => selectProfile(event.target.value)}>
                          <option value="">Новый профиль</option>
                          {modelNames.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </label>
                      {editingProfile ? null : <label className="space-y-1 text-xs">
                        <span>Имя профиля</span>
                        <Input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
                      </label>}
                      <label className="space-y-1 text-xs">
                        <span>API-провайдер Council</span>
                        <select className={selectClass} value={apiProvider} onChange={(event) => setApiProvider(event.target.value)}>
                          <option value="">Выбрать API-провайдера</option>
                          {providerNames.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </label>
                    </div>
                    <ProviderModelPicker value={selection} onChange={pickModel}
                      routing={environmentId ? { kind: "environment", environmentId } : { kind: "host", hostId }}
                      disabled={busy || environmentId === undefined} />
                    <p className="text-xs text-muted-foreground">В профиль сохраняется ID модели. Council вызывает её через выбранный API-провайдер.</p>
                    {!providerNames.length ? <p className="text-xs text-muted-foreground">Добавь API-провайдера в <code>llm.providers</code> на вкладке «Весь YAML».</p> : null}
                    <Button type="button" size="sm" variant="outline"
                      disabled={!(profileName.trim() && selection.providerId && catalogModel.modelId && providerNames.includes(apiProvider))} onClick={applyModel}>
                      {targetRole ? "Назначить модель" : editingProfile ? "Изменить профиль" : "Добавить профиль"}
                    </Button>
                  </div>
                </details>
                {groups.length ? (
                  <>
                    <label className="block space-y-1 text-sm">
                      <span>Раздел настроек</span>
                      <select value={group} className={selectClass} onChange={(event) => setSection(event.target.value)}>
                        {groups.map((name) => <option key={name} value={name}>{Object.hasOwn(sections, name) ? `${sections[name]} · ${name}` : name}</option>)}
                      </select>
                    </label>
                    <div className="space-y-2">
                      {fieldList(doc.getIn([group], true), [group]).map((field) =>
                        <FieldInput key={JSON.stringify(field.path)} field={field} edit={edit} />)}
                    </div>
                  </>
                ) : null}
                <p className="text-xs text-muted-foreground">Чтобы добавить или удалить поля, открой «Весь YAML».</p>
              </fieldset>
            ) : <p role="alert" className="text-sm text-destructive">Исправь структуру в режиме «Весь YAML».</p>}
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {config?.text != null ? <Button type="button" size="sm" disabled={!dirty || !valid || busy} onClick={() => void save()}>
            Сохранить настройки
          </Button> : null}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            {dirty ? "Отменить правки и перечитать" : "Перечитать"}
          </Button>
        </div>
      </div>
    </details>
  );
}
