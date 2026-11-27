import { execFile } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { PlatformClusterRequest } from "../platform-contract.js";
import { platformClusterSchema } from "../platform-contract.js";
import { detectPlatforms } from "./infobases.js";
import { decodePlatformConsole, redactLog } from "./platform-journal.js";
import { compareVersions } from "./shared.js";

const execute = promisify(execFile);
const windows = process.platform === "win32";
const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(isAbsoluteDirectory);
const local = process.env.LOCALAPPDATA;

function isAbsoluteDirectory(path: string | undefined): path is string {
  return Boolean(path && isAbsolute(path));
}

function installed(paths: string[]): string | null {
  for (const path of paths) {
    try {
      const physical = realpathSync.native(path);
      if (statSync(physical).isFile()) return physical;
    } catch {
      // The component might be absent or unreadable on this host.
    }
  }
  return null;
}

function pathCandidates(names: string[]): string[] {
  const directories = (process.env.PATH ?? "").split(delimiter).map((path) => path.trim().replace(/^"|"$/g, ""));
  return directories.filter(isAbsoluteDirectory).flatMap((directory) => names.map((name) => join(directory, name)));
}

function edtInstallations(): string[] {
  const locations = programFiles.map((path) => ({ root: join(path, "1C", "1CE", "components"), suffix: [] as string[] }));
  if (isAbsoluteDirectory(local)) locations.push({ root: join(local, "1C", "1cedtstart", "installations"), suffix: ["1cedt"] });
  const candidates = locations.flatMap(({ root, suffix }) => {
    try {
      return readdirSync(root).flatMap((name) => {
        const version = /^(?:1c-edt-|1C_EDT )(\d+(?:\.\d+)+)/i.exec(name)?.[1];
        return version ? [{ version, path: join(root, name, ...suffix, "1cedtcli.exe") }] : [];
      });
    } catch {
      return [];
    }
  });
  return candidates.sort((a, b) => compareVersions(b.version, a.version)).map(({ path }) => path);
}

export function findEdtCli(): string | null {
  return installed([...pathCandidates([windows ? "1cedtcli.exe" : "1cedtcli"]), ...(windows ? edtInstallations() : [])]);
}

export function platformTools(preferredPlatform: string) {
  const platformBins = [
    ...(isAbsoluteDirectory(preferredPlatform) ? [dirname(preferredPlatform)] : []),
    ...detectPlatforms().map(({ path }) => dirname(path)),
  ];
  const oneScriptBin = programFiles.map((path) => join(path, "OneScript", "bin"));
  const companion = (name: string) => {
    const filename = windows ? name + ".exe" : name;
    return installed([...platformBins.map((bin) => join(bin, filename)), ...pathCandidates([filename])]);
  };
  return {
    oscript: installed([...pathCandidates([windows ? "oscript.exe" : "oscript"]), ...oneScriptBin.map((bin) => join(bin, "oscript.exe"))]),
    opm: installed([...pathCandidates(windows ? ["opm.exe", "opm.bat", "opm.cmd"] : ["opm"]), ...oneScriptBin.map((bin) => join(bin, "opm.bat"))]),
    edt: findEdtCli(),
    rac: companion("rac"),
    ibsrv: companion("ibsrv"),
  };
}

export function parseRacOutput(text: string, key: "cluster" | "session"): { rows: Record<string, string>[]; truncated: boolean } {
  const rows: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const field = /^\s*([a-z][a-z0-9-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const [, name, value] = field;
    if (name === key) {
      if (rows.length >= 200) return { rows, truncated: true };
      current = Object.create(null) as Record<string, string>;
      rows.push(current);
    }
    if (current) current[name] = value.replace(/^"(.*)"$/, "$1").replaceAll('""', '"');
  }
  if (!rows.length && text.trim()) throw new Error("Формат ответа rac не распознан.");
  return { rows, truncated: false };
}

export async function readCluster(rac: string, { endpoint, cluster }: PlatformClusterRequest, signal?: AbortSignal) {
  // RAS access is read-only, with a fixed set of two list calls.
  const mode = cluster ? "session" : "cluster";
  let stdout: Buffer;
  try {
    ({ stdout } = await execute(rac, [mode, "list", ...(cluster ? [`--cluster=${cluster}`] : []), endpoint], {
      windowsHide: true, signal, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: "buffer",
    }));
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as { stderr?: Buffer; stdout?: Buffer; killed?: boolean; code?: string | number };
    const details = (failure.stderr?.length ? decodePlatformConsole(failure.stderr) : failure.stdout?.length ? decodePlatformConsole(failure.stdout) : "").trim().slice(0, 1000);
    throw new Error(`rac ${mode} list · ${endpoint}: ${details ? redactLog(details, []) : failure.killed ? "превышено время ожидания" : `код ${failure.code ?? "неизвестен"}`}`);
  }
  const { rows, truncated } = parseRacOutput(decodePlatformConsole(stdout), mode);
  return platformClusterSchema.parse({
    items: cluster ? [] : rows.map((row) => ({ id: row.cluster, name: row.name ?? "", host: row.host ?? "", port: row.port ?? "" })),
    sessions: cluster ? rows.map((row) => ({
      id: row.session, number: row["session-id"] ?? "", user: row["user-name"] ?? "", infobase: row.infobase ?? "",
      app: row["app-id"] ?? "", host: row.host ?? "", startedAt: row["started-at"] ?? "",
    })) : [],
    truncated,
  });
}
