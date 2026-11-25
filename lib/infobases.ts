// Installed 1C platforms and the user's infobase lists.
//
// Standard locations: %ProgramFiles%\1cv8, %ProgramFiles(x86)%\1cv8,
// %LOCALAPPDATA%\Programs\1cv8. ibases.v8i lives in %APPDATA%\1C\1CEStart
// (user list) and %PROGRAMDATA%\1C\1CEStart (shared list); additional lists
// are referenced by CommonInfoBases in 1cestart.cfg, which 1C stores as UTF-16LE.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InfobaseInfo, InfobaseSourceInfo, PlatformInfo } from "../contract.js";
import { compareVersions } from "./shared.js";

function configFiles() {
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
  return {
    roaming,
    programData,
    cfgs: [
      join(roaming, "1C", "1CEStart", "1cestart.cfg"),
      join(programData, "1C", "1CEStart", "1cestart.cfg"),
      join(programData, "1C", "1CEStart", "1cescmn.cfg"),
    ],
  };
}

/** Read 1C text: UTF-16LE with BOM, then UTF-8, then windows-1251. */
function readTextFile(file: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return "";
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(raw.subarray(2));
    } catch {
      // Fall through to the 8-bit decoders.
    }
  }
  for (const encoding of ["utf-8", "windows-1251"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch {
      // Try the next encoding.
    }
  }
  return raw.toString("utf8");
}

function expandEnv(value: string): string {
  return String(value).replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

/** Platform install directories declared by 1cestart.cfg. */
function installedLocations(): string[] {
  const dirs: string[] = [];
  for (const cfg of configFiles().cfgs) {
    const match = readTextFile(cfg).match(/^\s*InstalledLocation\s*=\s*(.+)$/mi);
    if (match) dirs.push(expandEnv(match[1].trim()).replace(/[\\/]+$/, ""));
  }
  return dirs;
}

/** External infobase list files referenced by CommonInfoBases. */
function commonInfoBaseFiles(): string[] {
  const files: string[] = [];
  for (const cfg of configFiles().cfgs) {
    const match = readTextFile(cfg).match(/^\s*CommonInfoBases\s*=\s*(.+)$/mi);
    if (!match) continue;
    for (const item of match[1].split(";")) {
      const value = expandEnv(item.trim().replace(/^"|"$/g, ""));
      if (value !== "") files.push(value);
    }
  }
  return files;
}

/** Find every installed platform with `bin\1cv8.exe`, newest first. */
export function detectPlatforms(): PlatformInfo[] {
  const roots = [
    join(process.env.ProgramFiles || "C:\\Program Files", "1cv8"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "1cv8"),
  ];
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Programs", "1cv8"));
  for (const dir of installedLocations()) roots.push(dir);

  const found = new Map<string, string>();
  for (const root of new Set(roots)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = join(root, entry.name, "bin", "1cv8.exe");
      if (existsSync(exe) && !found.has(entry.name)) found.set(entry.name, exe);
    }
  }
  return [...found.entries()]
    .map(([version, path]) => ({ version, path }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Parse a `.v8i` file: `[Name]` sections with Connect=/ID=/Folder=/App=. */
export function parseV8i(text: string, source: string): Array<{
  name: string;
  connect: string;
  folder: string;
  app: string;
  source: string;
}> {
  const entries: Array<{ name: string; connect: string; folder: string; app: string; source: string }> = [];
  let current: { name: string; connect: string; folder: string; app: string; source: string } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      if (current !== null) entries.push(current);
      current = { name: section[1].trim(), connect: "", folder: "", app: "", source };
      continue;
    }
    if (current === null) continue;
    const pair = line.match(/^([A-Za-z]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (key === "connect") current.connect = value;
    else if (key === "folder") current.folder = value;
    else if (key === "app") current.app = value;
  }
  if (current !== null) entries.push(current);
  return entries.filter((entry) => entry.name !== "" && entry.connect !== "");
}

/** Connection string from `.v8i` → the value of the "infobase path" field. */
export function normalizeConnect(connect: string): { value: string; kind: "file" | "server" | "web" | "unknown" } {
  const value = String(connect || "").trim();
  const file = value.match(/^file\s*=\s*"?([^";]+)"?;?$/i);
  if (file) return { value: file[1].trim(), kind: "file" };
  const server = value.match(/srvr\s*=\s*"?([^";]+)"?/i);
  const ref = value.match(/\bref\s*=\s*"?([^";]+)"?/i);
  if (server && ref) {
    return {
      value: `Srvr="${server[1].trim()}";Ref="${ref[1].trim()}";`,
      kind: "server",
    };
  }
  if (/^\s*ws\s*=/i.test(value)) return { value, kind: "web" };
  return { value, kind: "unknown" };
}

/** Combined infobase list: user, shared, and external `.v8i` files. */
export function listInfoBases(): {
  items: InfobaseInfo[];
  webSkipped: number;
  sources: InfobaseSourceInfo[];
} {
  const { roaming, programData } = configFiles();
  const candidates = [
    { file: join(roaming, "1C", "1CEStart", "ibases.v8i"), source: "список пользователя" },
    { file: join(programData, "1C", "1CEStart", "ibases.v8i"), source: "общий список" },
    ...commonInfoBaseFiles().map((file) => ({ file, source: "внешний список" })),
  ];

  const items: InfobaseInfo[] = [];
  const sources: InfobaseSourceInfo[] = [];
  const seen = new Set<string>();
  let webSkipped = 0;

  for (const { file, source } of candidates) {
    if (!existsSync(file)) continue;
    const entries = parseV8i(readTextFile(file), source);
    if (entries.length === 0) continue;
    sources.push({ file, source, count: entries.length });
    for (const entry of entries) {
      const normalized = normalizeConnect(entry.connect);
      if (normalized.kind === "web") {
        webSkipped += 1;
        continue;
      }
      if (normalized.value === "") continue;
      const key = normalized.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        name: entry.name,
        value: normalized.value,
        kind: normalized.kind === "file" || normalized.kind === "server" ? normalized.kind : "unknown",
        folder: entry.folder,
        app: entry.app,
        source,
      });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return { items, webSkipped, sources };
}
