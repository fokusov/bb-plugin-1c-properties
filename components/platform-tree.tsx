import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import {
  platformActions, type PlatformInventoryItem, type PlatformJournalEntry, type PlatformProfile, type PlatformRequest,
} from "../platform-contract.js";
import { Input } from "./ui/input.js";
import type { HostPanel } from "./platform-host-panel.js";

type Action = PlatformRequest["action"];
type Command = { id: string; action: Action; label: string; extension?: true };

const command = (action: Action, label: string = platformActions[action], extension?: true): Command => ({
  id: extension ? `${action}:extension` : action, action, label, extension,
});

const groups = [
  { label: "Запуск", icon: "Play", commands: [command("open-enterprise"), command("open-designer")] },
  { label: "Информационные базы", icon: "Database", commands: [
    command("create-file-base"), command("dump-dt"), command("restore-dt"), command("update-db"),
  ] },
  { label: "Конфигурация", icon: "Box", commands: [
    command("dump-xml", "Выгрузить в XML"), command("load-xml", "Загрузить из XML"),
    command("dump-binary", "Сохранить в CF"), command("load-binary", "Загрузить CF"),
    command("build-configuration", "Собрать CF"), command("unpack-configuration", "Разобрать CF"),
  ] },
  { label: "Расширения", icon: "Puzzle", commands: [
    command("dump-xml", "Выгрузить расширение в XML", true), command("load-xml", "Загрузить расширение из XML", true),
    command("dump-binary", "Сохранить расширение в CFE", true), command("load-binary", "Загрузить CFE", true),
    command("build-configuration", "Собрать CFE", true), command("unpack-configuration", "Разобрать CFE", true),
    command("update-db", "Обновить расширение в базе", true),
  ] },
  { label: "Обработки и отчёты", icon: "FileCode", commands: [command("build-external"), command("unpack-external")] },
  { label: "EDT", icon: "Code2", commands: [command("edt-import"), command("edt-export")] },
  { label: "Поставка и поддержка", icon: "Package", commands: [
    command("build-distribution"), command("build-cfu"), command("apply-cfu"),
  ] },
  { label: "Проверки и тесты", icon: "FlaskConical", commands: [
    command("check-config"), command("check-syntax"), command("yaxunit"), command("vanessa"),
  ] },
];

const allCommands = groups.flatMap(({ commands }) => commands);
const favoritesKey = "1c-properties.platform-favorites";
const kinds: Record<PlatformInventoryItem["kind"], { title: string; icon: string }> = {
  configuration: { title: "Конфигурации", icon: "Box" },
  extension: { title: "Расширения", icon: "Puzzle" },
  processor: { title: "Внешние обработки", icon: "FileCode" },
  report: { title: "Внешние отчёты", icon: "FileText" },
  backup: { title: "Резервные копии DT", icon: "Archive" },
  update: { title: "Обновления CFU", icon: "Package" },
};

export const runStateLabels: Record<PlatformJournalEntry["state"], string> = {
  running: "Выполняется", launched: "Процесс запущен", done: "Готово",
  failed: "Ошибка", cancelled: "Отменено", interrupted: "Связь с процессом потеряна",
};

function savedFavorites(): string[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(favoritesKey) ?? "[]");
    const known = new Set(allCommands.map(({ id }) => id));
    return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  } catch { return []; }
}

export function Branch({ label, icon, children, open }: { label: string; icon: string; children: ReactNode; open?: boolean }) {
  return <details className="platform-branch" open={open}>
    <summary className="platform-row" title={label}>
      <Icon name="ChevronRight" className="platform-chevron size-4 shrink-0" aria-hidden />
      <Icon name={icon} fallback="Layers" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{label}</span>
    </summary>
    <div className="platform-children">{children}</div>
  </details>;
}

function Row({ label, title, icon, selected, disabled, onClick }: {
  label: string; title?: string; icon: string; selected?: boolean; disabled?: boolean; onClick(): void;
}) {
  return <button type="button" className="platform-row platform-leaf" aria-current={selected ? "true" : undefined}
    disabled={disabled} onClick={onClick} title={title ?? label}>
    <Icon name={icon} fallback="Terminal" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="truncate">{label}</span>
  </button>;
}

type FileTree = { files: PlatformInventoryItem[]; folders: Map<string, FileTree> };
function folderTree(items: readonly PlatformInventoryItem[]): FileTree {
  const root: FileTree = { files: [], folders: new Map() };
  for (const item of items) {
    let folder = root;
    for (const segment of item.path.split("/").slice(0, -1)) {
      const next = folder.folders.get(segment) ?? { files: [], folders: new Map() };
      folder.folders.set(segment, next);
      folder = next;
    }
    folder.files.push(item);
  }
  return root;
}

function ArtifactRows({ node, selected, filter, onArtifact }: {
  node: FileTree; selected?: string; filter: boolean; onArtifact(item: PlatformInventoryItem): void;
}) {
  return <>
    {[...node.folders].map(([folder, subtree]) => <Branch key={folder} label={folder} icon="Folder" open={filter || undefined}>
      <ArtifactRows node={subtree} selected={selected} filter={filter} onArtifact={onArtifact} />
    </Branch>)}
    {node.files.map((item) => <Row key={item.path} label={item.name ?? item.path.split("/").at(-1)!} title={item.path}
      icon={item.source === "binary" ? "Package" : item.source === "edt" ? "Code2" : "FileCode"}
      selected={selected === `file:${item.path}`} onClick={() => onArtifact(item)} />)}
  </>;
}

export function PlatformTree({ items, inventoryStatus, profiles, journal, selected, activeProfile, busy,
  onCommand, onArtifact, onProfile, onRun, onHostPanel, onRefresh,
}: {
  items: readonly PlatformInventoryItem[];
  inventoryStatus: string;
  profiles: readonly PlatformProfile[];
  journal: readonly PlatformJournalEntry[];
  selected?: string;
  activeProfile: string;
  busy: boolean;
  onCommand(command: Command): void;
  onArtifact(item: PlatformInventoryItem): void;
  onProfile(name: string): void;
  onRun(id: string): void;
  onHostPanel(panel: HostPanel): void;
  onRefresh(): void;
}) {
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(savedFavorites);
  const query = search.trim().toLocaleLowerCase("ru");
  const matches = (value: string) => value.toLocaleLowerCase("ru").includes(query);
  const expandSearch = Boolean(query) || undefined;
  const commandsFor = (list: Command[], parent: string) => list.filter(({ label }) => matches(parent) || matches(label));
  const itemGroups = Object.entries(kinds).map(([kind, group]) => ({
    ...group,
    items: items.filter((item) => item.kind === kind && (matches("Артефакты") || matches(group.title) || matches(`${item.path} ${item.name ?? ""}`))),
  }));
  const profileNames = ["project", ...profiles.map(({ name }) => name)];
  const visibleProfiles = profileNames.filter((name) => matches("Профили запуска") || matches(name === "project" ? "Параметры проекта" : name));
  const runLabel = (entry: PlatformJournalEntry) => `${new Date(entry.startedAt).toLocaleString("ru")} · ${platformActions[entry.action]} · ${runStateLabels[entry.state]}`;
  const runs = journal.filter((entry) => matches("Журнал") || matches(runLabel(entry)));

  function favorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
    setFavorites(next);
    try { localStorage.setItem(favoritesKey, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  }

  function commandRows(list: Command[]) {
    return list.map((item) => <div key={item.id} className="platform-command">
      <Row label={item.label} icon="Terminal" disabled={busy} selected={selected === item.id} onClick={() => onCommand(item)} />
      <button type="button" className="platform-star"
        aria-label={`Избранное: ${item.label}`} aria-pressed={favorites.includes(item.id)}
        title={favorites.includes(item.id) ? "Убрать из избранного" : "В избранное"} onClick={() => favorite(item.id)}>
        <Icon name="Star" className="size-3.5" aria-hidden />
      </button>
    </div>);
  }

  const pinned = commandsFor(allCommands.filter(({ id }) => favorites.includes(id)), "Избранное");
  const showFiles = !query || matches("Артефакты") || itemGroups.some((group) => group.items.length);
  return <nav aria-label="Дерево операций 1С" className="platform-tree">
    <div className="platform-search">
      <Input type="search" aria-label="Поиск команд и артефактов" placeholder="Поиск в дереве"
        value={search} onChange={(event) => setSearch(event.target.value)} />
      <button type="button" className="platform-star" title="Обновить дерево" aria-label="Обновить дерево" onClick={onRefresh}>
        <Icon name="RefreshCw" fallback="RotateCw" className="size-4" aria-hidden />
      </button>
    </div>
    {pinned.length > 0 && <Branch label="Избранное" icon="Star" open>{commandRows(pinned)}</Branch>}
    {groups.map(({ label, icon, commands }) => {
      const visible = commandsFor(commands, label);
      return visible.length > 0 && <Branch key={label} label={label} icon={icon} open={expandSearch || label === "Запуск"}>
        {commandRows(visible)}
      </Branch>;
    })}
    {matches("Инструменты хоста") && <Row label="Инструменты хоста" icon="Wrench" selected={selected === "host:tools"}
      disabled={busy} onClick={() => onHostPanel("tools")} />}
    {matches("Кластеры и сеансы") && <Row label="Кластеры и сеансы" icon="Server" selected={selected === "host:clusters"}
      disabled={busy} onClick={() => onHostPanel("clusters")} />}
    {showFiles && <Branch label={`Артефакты (${items.length})`} icon="Layers" open={expandSearch}>
      {inventoryStatus && <p className="mx-2 my-1 text-xs text-muted-foreground" role="status">{inventoryStatus}</p>}
      {itemGroups.filter((group) => group.items.length > 0).map((group) => <Branch key={group.title}
        label={`${group.title} (${group.items.length})`} icon={group.icon} open={expandSearch}>
        <ArtifactRows node={folderTree(group.items)} filter={Boolean(query)} onArtifact={onArtifact} selected={selected} />
      </Branch>)}
      {!inventoryStatus && items.length === 0 && <p className="mx-2 my-1 text-xs text-muted-foreground">Артефакты в рабочей копии не найдены.</p>}
    </Branch>}
    {(visibleProfiles.length > 0 || matches("Добавить профиль")) && <Branch label="Профили запуска" icon="SlidersHorizontal" open={expandSearch}>
      {visibleProfiles.map((name) => <Row key={name}
        label={`${name === "project" ? "Параметры проекта" : name}${activeProfile === name ? " · активен" : ""}`}
        icon="Database" disabled={busy} selected={selected === `profile:${name}`} onClick={() => onProfile(name)} />)}
      {matches("Добавить профиль") && <Row label="Добавить профиль" icon="Plus" disabled={busy}
        selected={selected === "profile:"} onClick={() => onProfile("")} />}
    </Branch>}
    {(!query || runs.length > 0 || matches("Журнал")) && <Branch label={`Журнал (${journal.length})`} icon="History" open={expandSearch}>
      {runs.map((entry) => <Row key={entry.id} label={runLabel(entry)} icon="Clock"
        selected={selected === `run:${entry.id}`} onClick={() => onRun(entry.id)} />)}
      {!runs.length && <p className="mx-2 my-1 text-xs text-muted-foreground">Операций пока нет.</p>}
    </Branch>}
  </nav>;
}

export type { Command };
