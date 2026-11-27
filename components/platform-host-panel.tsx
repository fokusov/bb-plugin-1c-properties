import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { rpcContract } from "../rpc.js";
import { platformClusterSchema, platformRasSchema, type PlatformScope } from "../platform-contract.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

export type HostPanel = "tools" | "clusters";
type ClusterData = z.infer<typeof platformClusterSchema>;
const tools = [["oscript", "OneScript"], ["opm", "OPM"], ["edt", "EDT CLI"], ["rac", "rac"], ["ibsrv", "ibsrv"]] as const;

export function PlatformHostPanel({ panel, scope }: { panel: HostPanel; scope: PlatformScope }) {
  return panel === "tools" ? <InstalledTools scope={scope} /> : <ClusterBrowser scope={scope} />;
}

function InstalledTools({ scope }: { scope: PlatformScope }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<z.infer<typeof rpcContract.platformTools.output>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const { projectId, threadId, environmentId } = scope;
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void rpc.call("platformTools", { projectId, threadId, environmentId }).then((data) => {
      if (current) setResult(data);
    }, (error: unknown) => {
      if (current) {
        setResult(undefined);
        setError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [rpc, projectId, threadId, environmentId, revision]);
  return <div className="grid gap-2">
    <h4 className="text-sm font-medium">Инструменты хоста</h4>
    {loading && <p role="status" className="text-xs text-muted-foreground">Проверяю установленные инструменты…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {result && <dl className="grid gap-2 text-xs">
      {tools.map(([key, label]) => <div key={key} className="grid min-w-0 gap-0.5">
        <dt className="font-medium">{label}</dt>
        <dd className="break-all text-muted-foreground">{result[key] ?? "Не найден на хосте"}</dd>
      </div>)}
    </dl>}
    <div><Button size="sm" variant="outline" disabled={loading} onClick={() => setRevision(revision + 1)}>Обновить инструменты</Button></div>
  </div>;
}

function ClusterBrowser({ scope }: { scope: PlatformScope }) {
  const rpc = useRpc<typeof rpcContract>();
  const [endpoint, setEndpoint] = useState("");
  const [clusters, setClusters] = useState<ClusterData>();
  const [sessions, setSessions] = useState<ClusterData>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function read(cluster?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("platformCluster", {
        ...scope, query: { endpoint: platformRasSchema.parse(endpoint), ...(cluster ? { cluster } : {}) },
      });
      if (cluster) setSessions(result);
      else setClusters(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  function reset() {
    setClusters(undefined);
    setSessions(undefined);
    setSelected("");
    setError("");
  }

  return <div className="grid gap-3">
    <h4 className="text-sm font-medium">Кластеры и сеансы</h4>
    <label className="grid gap-1 text-xs">Адрес RAS
      <Input value={endpoint} placeholder="host:1545" disabled={busy} onChange={(event) => { setEndpoint(event.target.value); reset(); }} />
    </label>
    <div><Button size="sm" variant="outline" disabled={busy || !endpoint.trim()} onClick={() => { reset(); void read(); }}>Показать кластеры</Button></div>
    {clusters && <div className="grid gap-2 text-xs">
      {clusters.truncated && <p>Показаны первые 200 кластеров.</p>}
      {!clusters.items.length && <p>Кластеры не найдены.</p>}
      {clusters.items.map(({ id, name, host, port }) => <Button key={id} size="sm" variant={selected === id ? "secondary" : "ghost"}
        className="h-auto w-full justify-start whitespace-normal break-all text-left" disabled={busy} onClick={() => {
          setSelected(id);
          setSessions(undefined);
          void read(id);
        }}>
        {name || id} · {host}:{port}
      </Button>)}
    </div>}
    {busy && <p role="status" className="text-xs text-muted-foreground">Читаю данные RAS…</p>}
    {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
    {sessions && <section className="grid gap-2 text-xs" aria-label="Сеансы кластера">
      <h5 className="font-medium">Сеансы{sessions.truncated ? " · первые 200" : ` (${sessions.sessions.length})`}</h5>
      {!sessions.sessions.length && <p>Активных сеансов нет.</p>}
      {sessions.sessions.map((item) => <div key={item.id} className="grid gap-0.5 break-all rounded border p-2">
        <strong>{item.user || "Без имени"} · {item.app || "Неизвестное приложение"}</strong>
        <span>{[item.number && `№ ${item.number}`, item.host, item.startedAt].filter(Boolean).join(" · ")}</span>
        {item.infobase && <span className="text-muted-foreground">ИБ {item.infobase}</span>}
      </div>)}
    </section>}
  </div>;
}
