// BSL Flow Core installation and version checks on the project host.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolInfo, ToolsState } from "../contract.js";
import { bslFlowInitScript, resolveBslFlowRoot } from "./bslflow.js";
import { pathKey } from "./shared.js";

const BSLFLOW_REPO = "https://github.com/fokusov/bsl-flow.git";

interface ToolStateFile {
  updatedAt?: number;
  checkedAt?: number;
  bslflow?: { version?: string; commit?: string; source?: string; installedAt?: string };
  latest?: {
    bslflow?: { version?: string; commit?: string };
  };
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): CommandResult {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function toolExists(name: string): string {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = run(probe, [name], { timeout: 5000 });
  if (!found.ok) return "";
  return found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

function stateFile(dataDir: string): string {
  return join(dataDir, "tools", "state.json");
}

function readStateFile(dataDir: string): ToolStateFile {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(dataDir), "utf-8")) as ToolStateFile;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStateFile(dataDir: string, value: ToolStateFile): void {
  const file = stateFile(dataDir);
  mkdirSync(join(dataDir, "tools"), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  try {
    rmSync(file, { force: true });
  } catch {
    // Missing file is fine.
  }
  renameSync(temporary, file);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function emptyInfo(): ToolInfo {
  return {
    id: "bslflow",
    installed: false,
    version: "",
    latest: "",
    updateAvailable: false,
    source: "",
    commit: "",
    error: "",
  };
}

interface BslFlowMarker {
  version: string;
  skills_root: string;
  installed_at_utc: string;
}

function readBslFlowMarker(skillsRoot: string): BslFlowMarker | null {
  try {
    const marker = join(homedir(), ".bsl-flow", "installed-core.json");
    const parsed = JSON.parse(readFileSync(marker, "utf-8")) as Partial<BslFlowMarker>;
    if (
      typeof parsed.version === "string" && parsed.version !== "" &&
      typeof parsed.installed_at_utc === "string" && parsed.installed_at_utc !== "" &&
      typeof parsed.skills_root === "string" && pathKey(parsed.skills_root) === pathKey(skillsRoot)
    ) return parsed as BslFlowMarker;
  } catch {
    // A missing or invalid receipt cannot identify an installed revision.
  }
  return null;
}

/** Report the Core used by bootstrap, independently of any native CLI in PATH. */
function installedBslFlow(dataDir: string): ToolInfo {
  const info = emptyInfo();
  const skillsRoot = resolveBslFlowRoot("");
  info.source = skillsRoot;
  info.installed = existsSync(bslFlowInitScript(skillsRoot));
  if (!info.installed) return info;
  const marker = readBslFlowMarker(skillsRoot);
  if (marker) {
    info.version = marker.version;
    const installed = readStateFile(dataDir).bslflow;
    if (installed?.version === marker.version && installed.installedAt === marker.installed_at_utc) {
      info.commit = installed.commit ?? "";
    }
  }
  return info;
}

function needsBslFlowUpdate(installed: ToolInfo, latest: { version: string; commit: string }): boolean {
  return latest.version !== "" && latest.commit !== "" &&
    (!installed.installed || installed.version !== latest.version || installed.commit !== latest.commit);
}

export function bslFlowAvailabilityAfterCheck(
  installed: boolean,
  upstreamError: string,
): "available" | "upstream-failed-installed" | "upstream-failed-missing" {
  if (upstreamError === "") return "available";
  return installed ? "upstream-failed-installed" : "upstream-failed-missing";
}

async function latestBslFlow(): Promise<{ version: string; commit: string; error: string }> {
  const remote = run("git", ["ls-remote", BSLFLOW_REPO, "refs/heads/main"], { timeout: 60_000 });
  if (!remote.ok) {
    return { version: "", commit: "", error: `git ls-remote: ${remote.stderr || "нет сети"}` };
  }
  const commit = remote.stdout.split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    return { version: "", commit: "", error: "не удалось определить коммит BSL Flow main" };
  }
  try {
    const version = (await fetchText(`https://raw.githubusercontent.com/fokusov/bsl-flow/${commit}/VERSION`)).trim();
    return { version, commit, error: version === "" ? "не удалось прочитать VERSION" : "" };
  } catch (error) {
    return {
      version: "",
      commit,
      error: `VERSION: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

/** Read installed and cached latest versions without touching the network. */
export function toolsStatus(dataDir: string): ToolsState {
  const state = readStateFile(dataDir);
  const bslflow = installedBslFlow(dataDir);
  const latest = { version: state.latest?.bslflow?.version ?? "", commit: state.latest?.bslflow?.commit ?? "" };
  bslflow.latest = latest.version;
  bslflow.updateAvailable = needsBslFlowUpdate(bslflow, latest);
  return {
    bslflow,
    checkedAt: state.checkedAt ?? null,
  };
}

/** Fetch latest versions from GitHub and remember them for the panel. */
export async function toolsCheck(dataDir: string): Promise<ToolsState> {
  const state = readStateFile(dataDir);
  let bslLatest = { version: "", commit: "", error: "" };
  try {
    bslLatest = await latestBslFlow();
  } catch (error) {
    bslLatest = { version: "", commit: "", error: String(error) };
  }
  state.checkedAt = Date.now();
  state.latest = {
    ...state.latest,
    bslflow: { version: bslLatest.version, commit: bslLatest.commit },
  };
  writeStateFile(dataDir, state);
  const result = toolsStatus(dataDir);
  if (bslLatest.error !== "") result.bslflow.error = bslLatest.error;
  return result;
}

function cloneOrUpdateBslFlow(dataDir: string, commit: string, log: string[]): string | null {
  const dir = join(dataDir, "tools", "bsl-flow");
  if (existsSync(dir) && !isDirectory(join(dir, ".git"))) {
    log.push(`удаляю неполный checkout ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
  if (!isDirectory(join(dir, ".git"))) {
    mkdirSync(join(dataDir, "tools"), { recursive: true });
    log.push(`git clone ${BSLFLOW_REPO}`);
    const clone = run("git", ["clone", "--depth", "1", "--branch", "main", BSLFLOW_REPO, dir], { timeout: 300_000 });
    if (!clone.ok) {
      log.push(`git clone: ${clone.stderr || "ошибка"}`);
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
  }
  if (run("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 15_000 }).stdout !== commit) {
    log.push(`git fetch origin ${commit}`);
    const fetch = run("git", ["-C", dir, "fetch", "--depth", "1", "origin", commit], { timeout: 120_000 });
    if (!fetch.ok) {
      log.push(`git fetch: ${fetch.stderr || "ошибка"}`);
      return null;
    }
  }
  const reset = run("git", ["-C", dir, "reset", "--hard", commit], { timeout: 60_000 });
  if (!reset.ok) {
    log.push(`git reset: ${reset.stderr || "ошибка"}`);
    return null;
  }
  return dir;
}

function installBslFlow(dataDir: string, latest: { version: string; commit: string }, log: string[]): boolean {
  const pwsh = toolExists("pwsh");
  if (pwsh === "") {
    log.push("не найден pwsh — установи PowerShell 7");
    return false;
  }
  if (toolExists("openspec") === "") {
    log.push("не найден openspec — установи OpenSpec CLI");
    return false;
  }
  if (toolExists("git") === "") {
    log.push("не найден git");
    return false;
  }
  const source = cloneOrUpdateBslFlow(dataDir, latest.commit, log);
  if (source === null) return false;
  if (readText(join(source, "VERSION")) !== latest.version) {
    log.push(`VERSION в checkout BSL Flow не соответствует ${latest.commit} (${latest.version})`);
    return false;
  }
  const installer = join(source, "scripts", "Install-BSLFlowCore.ps1");
  if (!existsSync(installer)) {
    log.push(`не найден установщик: ${installer}`);
    return false;
  }
  const skillsRoot = resolveBslFlowRoot("");
  log.push(`Install-BSLFlowCore.ps1 -HostName agents (${latest.version}, ${latest.commit})`);
  const install = run(
    pwsh,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-HostName", "agents"],
    { cwd: source, timeout: 300_000 },
  );
  if (!install.ok) {
    log.push(`установка BSL Flow: ${(install.stderr || install.stdout).slice(-1200)}`);
    return false;
  }
  const marker = readBslFlowMarker(skillsRoot);
  if (marker?.version !== latest.version || !existsSync(bslFlowInitScript(skillsRoot))) {
    log.push("Установка BSL Flow Core не подтверждена: проверь installed-core.json и скрипт bootstrap");
    return false;
  }
  const state = readStateFile(dataDir);
  state.bslflow = { version: latest.version, commit: latest.commit, source: skillsRoot, installedAt: marker.installed_at_utc };
  state.updatedAt = Date.now();
  writeStateFile(dataDir, state);
  return true;
}

/** Install missing tools and, when requested, update outdated ones. */
export async function toolsEnsure(
  dataDir: string,
  update: boolean,
): Promise<{ ok: boolean; log: string[]; state: ToolsState }> {
  const log: string[] = [];
  let ok = true;
  let latest = { version: "", commit: "", error: "" };
  try {
    latest = await latestBslFlow();
  } catch (error) {
    latest = { version: "", commit: "", error: String(error) };
  }

  if (latest.error !== "") log.push(`BSL Flow: проверка обновлений — ${latest.error}`);

  const installed = toolsStatus(dataDir);
  const availability = bslFlowAvailabilityAfterCheck(installed.bslflow.installed, latest.error);
  if (availability === "upstream-failed-missing") {
    ok = false;
  } else if (availability === "upstream-failed-installed") {
    ok = false;
    log.push(`BSL Flow Core ${installed.bslflow.version || "установлен"} сохранён, инициализация прервана: upstream недоступен`);
  } else if (!installed.bslflow.installed || (update && needsBslFlowUpdate(installed.bslflow, latest))) {
    if (!installBslFlow(dataDir, latest, log)) ok = false;
  } else {
    log.push(`BSL Flow Core ${installed.bslflow.version || "установлен"} — обновление не требуется`);
  }

  const state = readStateFile(dataDir);
  state.checkedAt = Date.now();
  state.latest = {
    ...state.latest,
    bslflow: { version: latest.version, commit: latest.commit },
  };
  writeStateFile(dataDir, state);
  return { ok, log, state: toolsStatus(dataDir) };
}
