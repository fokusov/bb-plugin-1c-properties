import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { diagnosticReportSchema, diagnosticToolSchema, type DiagnosticImport, type DiagnosticReport } from "../platform-contract.js";
import { readBoundedText, readJUnit, writeJson } from "./platform-journal.js";

const maxReportBytes = 4 * 1024 * 1024;
const artifactNames = { "bsl-ls": "bsl-json.json", apk: "apk-junit.xml" } as const;
const bslReportSchema = z.object({
  sourceDir: z.string().min(1),
  fileinfos: z.array(z.object({
    path: z.string().min(1),
    diagnostics: z.array(z.object({
      severity: z.enum(["Error", "Warning", "Information", "Hint"]),
      code: z.string().min(1),
    })),
  })),
});
const indexSchema = z.array(z.object({ digest: z.string(), summary: diagnosticReportSchema }).strict()).max(2);

export function diagnosticArtifact(name: string): boolean {
  return Object.values(artifactNames).some((artifact) => artifact === name);
}

function readCounts(tool: DiagnosticImport["tool"], text: string): DiagnosticReport["counts"] {
  if (tool === "apk") {
    const junit = readJUnit(text);
    return { errors: junit.errors + junit.failures, warnings: null, total: junit.tests };
  }
  const report = bslReportSchema.parse(JSON.parse(text));
  const counts = { errors: 0, warnings: 0, total: 0 };
  for (const file of report.fileinfos) {
    for (const { severity } of file.diagnostics) {
      if (severity === "Error") counts.errors++;
      if (severity === "Warning") counts.warnings++;
      counts.total++;
    }
  }
  return counts;
}

export class DiagnosticReports {
  constructor(private readonly root: string) {}

  list(scope: string): DiagnosticReport[] {
    return diagnosticToolSchema.options.flatMap((tool) => this.readIndex(join(this.root, scope, tool)).map(({ summary }) => summary));
  }

  read(scope: string, id: string, name: string): string {
    const summary = this.list(scope).find(({ report }) => report.id === id && report.name === name);
    if (!summary) throw new Error("Отчёт диагностики в этой рабочей копии не найден.");
    return readBoundedText(join(this.root, scope, summary.tool, summary.report.id, summary.report.name), maxReportBytes);
  }

  import(scope: string, workspace: string, input: DiagnosticImport): DiagnosticReport {
    const requireWithinWorkspace = (path: string) => {
      const suffix = relative(workspace, path);
      if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(".." + sep)) {
        throw new Error("Отчёт находится за пределами выбранной рабочей копии.");
      }
    };
    if (isAbsolute(input.file)) throw new Error("Укажи относительный путь к отчёту.");
    const requestedPath = resolve(workspace, input.file);
    requireWithinWorkspace(requestedPath);
    const path = realpathSync.native(requestedPath);
    requireWithinWorkspace(path);
    if (!statSync(path).isFile()) {
      throw new Error("Укажи файл отчёта относительным путём внутри выбранной рабочей копии.");
    }
    const text = readBoundedText(path, maxReportBytes);
    if (Buffer.byteLength(text) > maxReportBytes) throw new Error("Размер отчёта превышает 4 МиБ в UTF-8.");
    const finishedAt = new Date(input.finishedAt).toISOString();
    if (Date.parse(finishedAt) > Date.now()) throw new Error("Время завершения диагностики указано в будущем.");
    const revision = input.revision?.toLowerCase() ?? null;
    const folder = join(this.root, scope, input.tool);
    const history = this.readIndex(folder);
    const digest = createHash("sha256").update(JSON.stringify([finishedAt, revision, input.profile, text])).digest("hex");
    const existing = history.find((entry) => entry.digest === digest);
    if (existing) return existing.summary;
    if (history.length === 2 && finishedAt < history[1].summary.finishedAt) {
      throw new Error("В журнале уже есть два более новых отчёта этой диагностики.");
    }
    const counts = readCounts(input.tool, text);
    const summary: DiagnosticReport = {
      tool: input.tool, profile: input.profile, finishedAt, revision, counts,
      report: { id: randomUUID(), name: artifactNames[input.tool] },
    };
    const reportFolder = join(folder, summary.report.id);
    mkdirSync(reportFolder, { recursive: true });
    writeFileSync(join(reportFolder, summary.report.name), text, { encoding: "utf8", flag: "wx" });
    const latest = [{ digest, summary }, ...history]
      .sort((a, b) => b.summary.finishedAt.localeCompare(a.summary.finishedAt)).slice(0, 2);
    writeJson(join(folder, "recent.json"), latest);
    return summary;
  }

  private readIndex(folder: string) {
    const path = join(folder, "recent.json");
    return existsSync(path) ? indexSchema.parse(JSON.parse(readBoundedText(path, 16 * 1024))) : [];
  }
}
