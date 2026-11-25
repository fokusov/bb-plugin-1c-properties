import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi, PluginHttpHandler } from "@get-bb/plugin-sdk";
import type { EditorConfig, EditorRequest, EditorResponse } from "./contract.js";
import { META_ICON_NAMES } from "./metadata.js";

const readRoutes = [
  "/workspaces", "/config", "/tree", "/search", "/read", "/stat", "/git-status",
  "/git-diff", "/reviewed", "/staged", "/meta/status", "/meta/list", "/meta/search",
  "/git-info", "/find-symbol",
];
const writeRoutes = [
  "/write", "/revert-hunk", "/revert-file", "/reviewed", "/stage", "/stage-all",
  "/commit", "/refresh", "/git-init",
];

// Served path → file under resources/. Monaco's AMD loader resolves modules
// relative to the configured `vs` base, so its files must keep the upstream
// min-build layout (`vs/editor/editor.main.js`, `vs/editor/editor.main.css`,
// `vs/base/worker/workerMain.js`, `vs/base/browser/ui/codicons/...`). A flat
// `vendor/editor.main.js` is not reachable as `vs/editor/editor.main`.
const vendorFiles = new Map([
  ["vendor/vs/loader.js", "application/javascript"],
  ["vendor/vs/editor/editor.main.js", "application/javascript"],
  ["vendor/vs/editor/editor.main.css", "text/css"],
  ["vendor/vs/basic-languages/xml/xml.js", "application/javascript"],
  ["vendor/vs/base/worker/workerMain.js", "application/javascript"],
  ["vendor/vs/base/browser/ui/codicons/codicon/codicon.ttf", "font/ttf"],
  ["vendor/onigasm-esm.js", "application/javascript"],
  ["vendor/monaco-textmate-esm.js", "application/javascript"],
  ["vendor/fast-plist-esm.js", "application/javascript"],
  ["vendor/lru-cache-esm.js", "application/javascript"],
  ["vendor/pseudomap-esm.js", "application/javascript"],
  ["vendor/yallist-esm.js", "application/javascript"],
  ["vendor/onigasm.wasm", "application/wasm"],
]);

function resourcePath(...parts: string[]): string | null {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "resources", ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function asset(path: string[], contentType: string, cacheControl = "no-cache") {
  const file = resourcePath(...path);
  if (!file) return new Response(JSON.stringify({ error: "asset not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  return new Response(new Uint8Array(readFileSync(file)), {
    headers: { "content-type": contentType, "cache-control": cacheControl },
  });
}

export async function editorAvailable(bb: BbPluginApi): Promise<boolean> {
  return !(await bb.sdk.plugins.list()).plugins.some((plugin) => plugin.id === "bsl-editor" && plugin.enabled);
}

export function registerEditorRoutes(
  bb: BbPluginApi,
  readConfig: () => Promise<EditorConfig>,
  requestHost: (input: EditorRequest, hostId: string, signal: AbortSignal) => Promise<EditorResponse>,
) {
  function handler(method: EditorRequest["method"], path: string): PluginHttpHandler {
    return async ({ req }) => {
      try {
        if (!(await editorAvailable(bb))) return Response.json({ error: "Активен отдельный плагин «1С-редактор»" }, { status: 409 });
        const threadId = req.header("x-bb-thread-id");
        const environmentId = req.header("x-bb-environment-id");
        if (!threadId || !environmentId) return Response.json({ error: "Выберите рабочую папку потока" }, { status: 400 });
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== environmentId) {
          return Response.json({ error: "Рабочая папка потока изменилась. Откройте редактор заново." }, { status: 409 });
        }
        const environment = await bb.sdk.environments.get({ environmentId });
        if (!environment.path) return Response.json({ error: "Рабочая папка ещё не готова" }, { status: 409 });
        const result = await requestHost({
          root: environment.path,
          method,
          path: "/bsl" + path + new URL(req.url).search,
          body: method === "POST" ? await req.text() : "",
          config: await readConfig(),
        }, environment.hostId, req.raw.signal);
        return new Response(result.body, { status: result.status, headers: result.headers });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    };
  }

  for (const path of readRoutes) bb.http.route("GET", "/bsl" + path, handler("GET", path));
  for (const path of writeRoutes) bb.http.route("POST", "/bsl" + path, handler("POST", path));
  for (const [file, contentType] of vendorFiles) {
    bb.http.route("GET", `/bsl/${file}`, () => asset(file.split("/"), contentType));
  }
  for (const name of META_ICON_NAMES) {
    bb.http.route("GET", `/bsl/icons/${name}.svg`, () => asset(["icons", `${name}.svg`], "image/svg+xml", "public, max-age=86400"));
  }
  for (const name of ["1c", "1c-query"]) {
    bb.http.route("GET", `/bsl/grammar/${name}`, () => asset(["grammar", `${name}.tmLanguage.json`], "application/json", "public, max-age=3600"));
  }

}
