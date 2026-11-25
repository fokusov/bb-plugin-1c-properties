// rlm-tools-bsl lifecycle and MCP proxy.
//
// The engine is a Python package installed with uv into a plugin-owned folder
// on the project's machine. It speaks streamable HTTP MCP on loopback, so the
// bb server never needs a provider-specific MCP configuration: native bb tools
// call this runner through the host entry.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { RlmState } from "../contract.js";

const SERVER_NAME = "rlm-tools-bsl";
const PREFERRED_PORT = 9330;
const START_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 300_000;
const LOG_TAIL_BYTES = 8000;

interface WorkerLease {
  dispose(): void;
}

interface RpcResponse {
  result?: {
    serverInfo?: { version?: string };
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: { result?: unknown };
    isError?: boolean;
  };
  error?: { code?: number; message?: string; data?: unknown };
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function binaryName(): string {
  return isWindows() ? `${SERVER_NAME}.exe` : SERVER_NAME;
}

function findUv(): string {
  const probe = isWindows() ? "where" : "which";
  try {
    const found = spawnSync(probe, ["uv"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (found.status === 0) {
      const value = String(found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
      if (value) return value;
    }
  } catch {
    // Fall through to the known install locations.
  }
  const candidates = [
    join(homedir(), ".local", "bin", isWindows() ? "uv.exe" : "uv"),
    process.env.APPDATA ? join(process.env.APPDATA, "Python", "Python313", "Scripts", isWindows() ? "uv.exe" : "uv") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "uv", isWindows() ? "uv.exe" : "uv") : "",
  ].filter((value) => value !== "");
  return candidates.find((value) => existsSync(value)) ?? "";
}

function choosePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => {
      const fallback = createServer();
      fallback.unref();
      fallback.once("error", () => resolve(0));
      fallback.listen(0, "127.0.0.1", () => {
        const port = (fallback.address() as { port: number }).port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, "127.0.0.1", () => {
      probe.close(() => resolve(preferred));
    });
  });
}

function parseRpc(raw: string): RpcResponse | null {
  const text = raw.trim();
  if (text === "") return null;
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text) as RpcResponse;
    } catch {
      return null;
    }
  }
  // Streamable HTTP replies are server-sent events; take the first JSON event.
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data.startsWith("{")) continue;
    try {
      return JSON.parse(data) as RpcResponse;
    } catch {
      // Try the next event.
    }
  }
  return null;
}

function tailOf(file: string): string {
  try {
    const raw = readFileSync(file);
    return raw.subarray(Math.max(0, raw.length - LOG_TAIL_BYTES)).toString("utf8").trim();
  } catch {
    return "";
  }
}

function responseText(response: RpcResponse): { ok: boolean; text: string; error: string } {
  if (response.error) {
    return { ok: false, text: "", error: response.error.message ?? JSON.stringify(response.error) };
  }
  const result = response.result;
  if (result === undefined) return { ok: false, text: "", error: "MCP вернул пустой ответ" };
  const content = (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  const structured = result.structuredContent?.result;
  const text =
    typeof structured === "string"
      ? structured
      : structured !== undefined
        ? JSON.stringify(structured, null, 2)
        : content;
  return {
    ok: result.isError !== true,
    text,
    error: result.isError === true ? content || "MCP-инструмент вернул ошибку" : "",
  };
}

export class RlmRunner {
  private readonly dir: string;
  private readonly logFile: string;
  private child: ReturnType<typeof spawn> | null = null;
  private port = 0;
  private lease: WorkerLease | null = null;
  private version = "";
  private lastError = "";

  constructor(dataDir: string) {
    this.dir = join(dataDir, "rlm");
    this.logFile = join(this.dir, "logs", "server.log");
  }

  private binary(): string {
    return join(this.dir, "bin", binaryName());
  }

  status(): RlmState {
    const running = this.child !== null && this.child.exitCode === null;
    return {
      installed: existsSync(this.binary()),
      running,
      port: running && this.port > 0 ? this.port : null,
      version: this.version,
      error: running ? "" : this.lastError,
    };
  }

  dispose(): void {
    this.stop();
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    const lease = this.lease;
    this.lease = null;
    if (child !== null && child.exitCode === null) {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          if (isWindows()) {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
              timeout: 15_000,
            });
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // Already gone.
        }
      }
    }
    lease?.dispose();
    this.port = 0;
  }

  private async post(body: unknown, timeoutMs: number): Promise<RpcResponse | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      if (!response.ok && raw.trim() === "") {
        this.lastError = `MCP ответил HTTP ${response.status}`;
        return null;
      }
      return parseRpc(raw);
    } catch (error) {
      this.lastError = `MCP: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  private ensureInstalled(): boolean {
    if (existsSync(this.binary())) return true;
    const uv = findUv();
    if (uv === "") {
      this.lastError =
        "не найден uv. Установи его: powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"";
      return false;
    }
    try {
      mkdirSync(join(this.dir, "logs"), { recursive: true });
      const handle = openSync(this.logFile, "a");
      writeSync(handle, `\n===== ${new Date().toISOString()} uv tool install ${SERVER_NAME}\n`);
      closeSync(handle);
    } catch {
      // The install itself can still proceed.
    }
    const result = spawnSync(uv, ["tool", "install", SERVER_NAME], {
      env: {
        ...process.env,
        UV_TOOL_DIR: join(this.dir, "tool"),
        UV_TOOL_BIN_DIR: join(this.dir, "bin"),
        UV_PYTHON_INSTALL_DIR: join(this.dir, "python"),
        UV_NO_MODIFY_PATH: "1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 600_000,
    });
    if (result.status !== 0 || !existsSync(this.binary())) {
      this.lastError = `не удалось установить ${SERVER_NAME}: ${(result.stderr ?? result.stdout ?? "").trim().slice(-800)}`;
      return false;
    }
    return true;
  }

  /** Start the engine once and keep it alive for the host worker lifetime. */
  async ensure(leaseFactory: () => WorkerLease): Promise<void> {
    if (this.child !== null && this.child.exitCode === null) return;
    this.child = null;
    this.port = 0;
    this.version = "";
    this.lastError = "";

    if (!this.ensureInstalled()) return;

    this.port = await choosePort(PREFERRED_PORT);
    if (this.port === 0) {
      this.lastError = "не удалось выбрать свободный порт для rlm-tools-bsl";
      return;
    }
    mkdirSync(join(this.dir, "logs"), { recursive: true });
    mkdirSync(join(this.dir, "index"), { recursive: true });
    const handle = openSync(this.logFile, "a");
    writeSync(handle, `\n===== ${new Date().toISOString()} rlm-tools-bsl --transport streamable-http --host 127.0.0.1 --port ${this.port}\n`);
    const child = spawn(
      this.binary(),
      ["--transport", "streamable-http", "--host", "127.0.0.1", "--port", String(this.port)],
      {
        cwd: this.dir,
        env: { ...process.env, RLM_INDEX_DIR: join(this.dir, "index") },
        stdio: ["ignore", handle, handle],
        windowsHide: true,
      },
    );
    closeSync(handle);
    this.child = child;
    this.lease = leaseFactory();
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.port = 0;
        if (code !== 0 && code !== null) {
          this.lastError = `rlm-tools-bsl завершился с кодом ${code}. ${tailOf(this.logFile).slice(-800)}`;
        }
        this.lease?.dispose();
        this.lease = null;
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const response = await this.post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "bb-1c-properties", version: "0.1.0" },
          },
        },
        5000,
      );
      if (response?.result !== undefined) {
        this.version = response.result.serverInfo?.version ?? "";
        this.lastError = "";
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.lastError =
      this.lastError ||
      `rlm-tools-bsl не ответил за ${Math.round(START_TIMEOUT_MS / 1000)} с. ${tailOf(this.logFile).slice(-800)}`;
    this.stop();
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    leaseFactory: () => WorkerLease,
  ): Promise<{ ok: boolean; text: string; error: string }> {
    await this.ensure(leaseFactory);
    if (this.child === null || this.child.exitCode !== null || this.port === 0) {
      return { ok: false, text: "", error: this.lastError || "rlm-tools-bsl не запущен" };
    }
    const response = await this.post(
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: tool, arguments: args },
      },
      CALL_TIMEOUT_MS,
    );
    if (response === null) {
      return { ok: false, text: "", error: this.lastError || "MCP не вернул ответ" };
    }
    return responseText(response);
  }
}
