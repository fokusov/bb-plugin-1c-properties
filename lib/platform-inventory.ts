import { open, opendir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { PlatformInventoryItem } from "../platform-contract.js";

const maxItems = 400;
const maxEntries = 24_000;
const maxDepth = 7;
const maxXmlReads = 1_000;
const skipped = new Set(["node_modules", "oscript_modules", "vendor"]);
const buildDirectories = new Set([".build", ".artifacts"]);
const binaries = new Map<string, PlatformInventoryItem["kind"]>([
  [".cf", "configuration"], [".cfe", "extension"], [".epf", "processor"], [".erf", "report"], [".dt", "backup"], [".cfu", "update"],
]);

async function readDescriptor(workspace: string, filename: string, limit: number): Promise<string> {
  const resolved = await realpath(filename);
  const suffix = relative(workspace, resolved);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(".." + sep)) return "";
  const file = await open(resolved, "r");
  try {
    if (!(await file.stat()).isFile()) return "";
    const data = Buffer.alloc(limit);
    const { bytesRead } = await file.read(data);
    const raw = data.subarray(0, bytesRead);
    return raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
  } finally {
    await file.close();
  }
}

function descriptor(path: string, text: string, source: "xml" | "edt"): PlatformInventoryItem | null {
  const content = text.replace(/^\uFEFF/, "").replace(/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/, "");
  const root = content.replace(/^<MetaDataObject(?:\s[^>]+)?>\s*/, "");
  const type = /^<(?:[\w.-]+:)?(Configuration|ExternalDataProcessor|ExternalReport)(?=[\s/>])/.exec(root)?.[1];
  const name = /<(?:[\w.-]+:)?(?:Name|name)>\s*([\p{L}\p{N}_]+)\s*<\//u.exec(root)?.[1] ?? null;
  if (type === "Configuration" && /^configuration\.(xml|mdo)$/i.test(basename(path))) {
    const extension = /<(?:[\w.-]+:)?(?:ConfigurationExtensionPurpose|configurationExtensionPurpose)>\s*[^\s<]/.test(root);
    return { path, source, name, kind: extension ? "extension" : "configuration" };
  }
  if (source === "xml" && (type === "ExternalDataProcessor" || type === "ExternalReport")) {
    return { path, source, name, kind: type === "ExternalReport" ? "report" : "processor" };
  }
  return null;
}

export async function readPlatformInventory(root: string, signal?: AbortSignal) {
  const workspace = await realpath(root);
  const queue = [{ path: workspace, depth: 0 }];
  const items: PlatformInventoryItem[] = [];
  let complete = true;
  let visited = 0;
  let xmlReads = 0;
  for (const { path, depth } of queue) {
    signal?.throwIfAborted();
    if (visited >= maxEntries || items.length >= maxItems) break;
    try {
      if (path !== workspace) {
        if (await realpath(path) !== path) { complete = false; continue; }
        // A FILE infobase is runtime data, even if it lives inside the worktree.
        const base = await realpath(join(path, "1Cv8.1CD")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (base) continue;
      }
      for await (const entry of await opendir(path)) {
        signal?.throwIfAborted();
        if (++visited > maxEntries || items.length >= maxItems) { complete = false; break; }
        const filename = join(path, entry.name);
        if (entry.isDirectory()) {
          if (skipped.has(entry.name.toLowerCase()) || (entry.name.startsWith(".") && !buildDirectories.has(entry.name))) continue;
          if (depth < maxDepth) queue.push({ path: filename, depth: depth + 1 });
          else complete = false;
          continue;
        }
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const extension = extname(entry.name).toLowerCase();
        const kind = binaries.get(extension);
        const relativePath = relative(workspace, filename).split(sep).join("/");
        if (kind) {
          items.push({ path: relativePath, kind, source: "binary", name: null });
          continue;
        }
        const isConfiguration = /^configuration\.(xml|mdo)$/i.test(entry.name);
        if (extension !== ".xml" && !isConfiguration) continue;
        if (!isConfiguration && ++xmlReads > maxXmlReads) { complete = false; continue; }
        try {
          const input = await readDescriptor(workspace, filename, isConfiguration ? 128 * 1024 : 8 * 1024);
          const item = descriptor(relativePath, input, extension === ".mdo" ? "edt" : "xml");
          if (item) items.push(item);
        } catch {
          complete = false;
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (path === workspace) throw error;
      complete = false;
    }
  }
  if (visited >= maxEntries || items.length >= maxItems) complete = false;
  items.sort((a, b) => a.path.localeCompare(b.path, "ru"));
  return { workspace, complete, items };
}
