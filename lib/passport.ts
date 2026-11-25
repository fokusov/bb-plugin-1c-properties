import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { detectConfigRoots, parseMetadataXml } from "../editor/metadata.js";

const MAX_TRACKED_FILES = 20_000;
const MAX_TRACKED_BYTES = 256 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_XML_BYTES = 4 * 1024 * 1024;
const MAX_GIT_LIST_BYTES = 4 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", "bin", "obj", ".bsl-flow", "test-bases", "TestBases"]);
const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".so", ".dylib", ".db", ".sqlite", ".zip", ".7z", ".rar", ".cf", ".cfe", ".epf", ".erf", ".dt", ".bak", ".pdb", ".class", ".jar", ".1cd", ".1cl", ".cfl"]);

type ConfigInfo = { root: string; format: string; name: string | null; synonym: string | null; version: string | null };

function findValue(node: unknown, names: string[]): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const value = findValue(item, names); if (value) return value; }
    return null;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (names.includes(key.split(":").at(-1) ?? key)) {
      if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
      if (value && typeof value === "object") {
        const nested = findValue(value, ["v8:content", "content", "v8:value", "value"]);
        if (nested) return nested;
      }
    }
    const nested = findValue(value, names);
    if (nested) return nested;
  }
  return null;
}

function findConfigurationNode(node: unknown): unknown {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const found = findConfigurationNode(item); if (found) return found; }
    return null;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key.split(":").at(-1) === "Configuration") return value;
  }
  for (const value of Object.values(obj)) { const found = findConfigurationNode(value); if (found) return found; }
  return null;
}

function configDetails(configRoot: string, format: string, sourceRoot: string): ConfigInfo {
  const file = format === "edt"
    ? resolve(configRoot, "Configuration/Configuration.mdo")
    : resolve(configRoot, "Configuration.xml");
  const rootReal = realpathSync(sourceRoot);
  const fileReal = realpathSync(file);
  const rel = relative(rootReal, fileReal);
  if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(rootReal, rel) !== fileReal) throw new Error("configuration path escapes source root");
  const size = statSync(fileReal).size;
  if (size > MAX_CONFIG_XML_BYTES) throw new Error("configuration metadata exceeds 4 MiB limit");
  const fd = openSync(fileReal, "r");
  let xml: string;
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_XML_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_CONFIG_XML_BYTES) throw new Error("configuration metadata exceeds 4 MiB limit");
    xml = buffer.toString("utf8", 0, bytes);
  } finally { closeSync(fd); }
  const doc = parseMetadataXml(xml);
  const configuration = findConfigurationNode(doc);
  return {
    root: relative(sourceRoot, configRoot).split(sep).join("/") || ".",
    format,
    name: findValue(configuration, ["Name"]),
    synonym: findValue(configuration, ["Synonym"]),
    version: findValue(configuration, ["Version"]),
  };
}

function trackedMetrics(root: string): { complete: boolean; trackedFiles: number; trackedBytes: number; byExtension: Record<string, number>; reason: string | null } {
  const byExtension: Record<string, number> = {};
  let trackedFiles = 0;
  let trackedBytes = 0;
  let reason: string | null = null;
  let files: string[];
  try {
    const raw = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer", maxBuffer: MAX_GIT_LIST_BYTES, timeout: 10_000 });
    files = raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return { complete: false, trackedFiles, trackedBytes, byExtension, reason: "git-unavailable-or-file-list-limit" };
  }
  if (files.length > MAX_TRACKED_FILES) return { complete: false, trackedFiles, trackedBytes, byExtension, reason: "tracked-file-count-limit" };
  const base = realpathSync(root);
  for (const name of files) {
    if (trackedFiles >= MAX_TRACKED_FILES) { reason = "tracked-file-count-limit"; break; }
    const full = resolve(base, name);
    const rel = relative(base, full);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) { reason = "tracked-path-outside-source"; break; }
    const parts = rel.split(sep);
    const extension = extname(name).toLowerCase();
    if (parts.some((part) => EXCLUDED_DIRS.has(part)) || BINARY_EXTENSIONS.has(extension)) continue;
    try {
      let cursor = base;
      for (const part of rel.split(sep)) {
        cursor = resolve(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) { reason = "tracked-symlink-skipped"; break; }
      }
      if (reason) break;
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_SINGLE_FILE_BYTES) { reason = "tracked-file-size-limit"; break; }
      if (trackedBytes + st.size > MAX_TRACKED_BYTES) { reason = "tracked-total-size-limit"; break; }
      trackedFiles++;
      trackedBytes += st.size;
      const ext = extension || "[no-extension]";
      byExtension[ext] = (byExtension[ext] ?? 0) + st.size;
    } catch {
      reason = "tracked-file-unreadable";
      break;
    }
  }
  return { complete: reason === null, trackedFiles, trackedBytes, byExtension, reason };
}

export async function readPassport(sourceRoot: string) {
  const root = realpathSync(sourceRoot);
  let configs: ConfigInfo[] = [];
  let configError: string | null = null;
  try {
    const detected = await detectConfigRoots(root);
    configs = detected.roots.map((item) => configDetails(item.dir, item.format, root));
    if (!detected.complete) configError = "configuration-root-scan-limit";
  } catch (error) {
    configError = error instanceof Error ? error.message : "configuration metadata unreadable";
  }
  const metrics = trackedMetrics(root);
  return {
    snapshotAt: new Date().toISOString(),
    configurations: configs,
    ambiguous: configs.length > 1,
    configComplete: configError === null,
    configError,
    metrics,
  };
}
