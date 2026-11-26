import { lazy, Suspense, useState } from "react";
import {
  experimental_useRpcQuery,
  useBbContext,
  useSettings,
  type ExperimentalThreadTabProps,
  type PluginAppBuilder,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../rpc.js";
import { PlatformOperationsPanel } from "../components/platform-operations.js";
import { ProjectReadinessCard } from "../components/project-readiness.js";
import { Button } from "../components/ui/button.js";
import "./style.css";

const BslEditor = lazy(() => import("./editor.js").then(({ BslEditor }) => ({ default: BslEditor })));

function useEditorAvailable() {
  const { data } = experimental_useRpcQuery({
    contract: rpcContract,
    method: "editorAvailability",
    input: {},
  });
  return data?.available === true;
}

function ThreadEditor({ threadId, environment }: ExperimentalThreadTabProps) {
  const { projectId } = useBbContext();
  const editorAvailable = useEditorAvailable();
  const [mode, setMode] = useState<"editor" | "operations" | "readiness">("editor");
  if (!environment || !projectId) return null;
  const current = mode === "editor" && !editorAvailable ? "operations" : mode;
  const scope = { projectId, threadId, environmentId: environment.id };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-border px-2 py-1">
        {editorAvailable && <Button size="sm" variant={current === "editor" ? "secondary" : "ghost"} onClick={() => setMode("editor")}>Редактор</Button>}
        <Button size="sm" variant={current === "operations" ? "secondary" : "ghost"} onClick={() => setMode("operations")}>Операции</Button>
        <Button size="sm" variant={current === "readiness" ? "secondary" : "ghost"} onClick={() => setMode("readiness")}>Готовность</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {current === "readiness" ? (
          <div className="p-3"><ProjectReadinessCard key={environment.id} scope={scope} /></div>
        ) : current === "operations" ? (
          <div className="p-3">
            <PlatformOperationsPanel key={environment.id} scope={scope} />
          </div>
        ) : (
          <div className="bsl-editor-root">
            <Suspense fallback="Загрузка редактора 1С…">
              <BslEditor threadId={threadId} environmentId={environment.id} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

function FileEditor({ path, source, experimental_lineRange, Original }: PluginFileOpenerProps) {
  const available = useEditorAvailable();
  const { values } = useSettings();
  if (!available || !values?.interceptChatOpen || source.kind !== "workspace" ||
      !source.threadId || !source.environmentId) return <Original />;
  return (
    <div className="bsl-editor-root">
      <Suspense fallback="Загрузка редактора 1С…">
        <BslEditor threadId={source.threadId} environmentId={source.environmentId}
          path={path} lineRange={experimental_lineRange} />
      </Suspense>
    </div>
  );
}

export function registerEditor(app: PluginAppBuilder) {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "bsl-editor",
    title: "1С",
    icon: "Code2",
    component: ThreadEditor,
    layout: "flush",
    useVisible: ({ environment }) => Boolean(environment),
  });
  app.slots.fileOpener({
    id: "bsl-editor",
    title: "Редактор 1С",
    extensions: ["bsl", "xml"],
    component: FileEditor,
  });
}
