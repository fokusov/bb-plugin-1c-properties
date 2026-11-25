import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { platformJournalEntrySchema, platformRunIdSchema, type PlatformJournalEntry } from "../platform-contract.js";

export function addressKey(value: string): string {
  return createHash("sha256").update(process.platform === "win32" ? value.toLowerCase() : value).digest("hex");
}

export function writeJson(file: string, data: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readBoundedText(file: string, limit: number, tail = false): string {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    if (size > limit && !tail) throw new Error("Размер файла превышает допустимый предел.");
    const data = Buffer.alloc(Math.min(size, limit));
    const length = readSync(fd, data, 0, data.length, tail ? Math.max(0, size - data.length) : 0);
    const raw = data.subarray(0, length);
    if (raw[0] === 0xff && raw[1] === 0xfe) return raw.toString("utf16le").replace(/^\uFEFF/, "");
    try {
      return new TextDecoder("utf8", { fatal: true }).decode(raw);
    } catch {
      return new TextDecoder("windows-1251").decode(raw);
    }
  } finally {
    closeSync(fd);
  }
}

export function redactLog(text: string, secrets: string[]): string {
  let clean = text.replace(/(^|[\s"])(?:\/P|\/UC)(?:"[^"]*"|[^\s;]+)(?=\s|;|$)/g, "$1***")
    .replace(/\b(?:Pwd|Password)\s*=\s*(?:"[^"]*"|[^\s;]+)|Пароль\s*=\s*(?:"[^"]*"|[^\s;]+)/gi, "***");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    clean = clean.replaceAll(secret, "***");
    clean = clean.replaceAll(secret.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"), "***");
  }
  return clean;
}

export function readJUnit(text: string): NonNullable<PlatformJournalEntry["counts"]> {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error("Некорректный отчёт JUnit.");
  const xml = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false }).parse(text);
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const add = (suite: Record<string, unknown>): void => {
    if (!suite || typeof suite !== "object") throw new Error("В отчёте JUnit отсутствует набор тестов.");
    if (suite["@_tests"] === undefined && suite.testsuite) {
      for (const item of [suite.testsuite].flat()) add(item as Record<string, unknown>);
      return;
    }
    for (const key of ["tests", "failures", "errors", "skipped"] as const) {
      const count = suite[`@_${key}`] ?? (key === "skipped" ? suite["@_disabled"] : undefined) ?? (key === "tests" ? NaN : 0);
      if (!/^\d+$/.test(String(count)) || !Number.isSafeInteger(Number(count))) throw new Error("Некорректные счётчики JUnit.");
      counts[key] += Number(count);
    }
  };
  if (xml.testsuites?.testsuite) {
    for (const suite of [xml.testsuites.testsuite].flat()) add(suite);
  } else {
    add(xml.testsuite ?? xml.testsuites);
  }
  if (counts.failures + counts.errors + counts.skipped > counts.tests) throw new Error("Некорректные счётчики JUnit.");
  return counts;
}

export class PlatformJournal {
  constructor(private readonly root: string) {}

  folder(scope: string, id: string): string {
    return join(this.root, scope, platformRunIdSchema.parse(id));
  }

  write(scope: string, entry: PlatformJournalEntry): void {
    const folder = this.folder(scope, entry.id);
    mkdirSync(folder, { recursive: true });
    writeJson(join(folder, "entry.json"), entry);
  }

  read(scope: string, id: string, activeId?: string): PlatformJournalEntry | null {
    const file = join(this.folder(scope, id), "entry.json");
    if (!existsSync(file)) return null;
    const entry = platformJournalEntrySchema.parse(JSON.parse(readBoundedText(file, 128 * 1024)));
    if (entry.state !== "running" || activeId === entry.id) return entry;
    return {
      ...entry, state: "interrupted", needsInspection: entry.needsInspection,
      error: "Хост потерял связь с процессом 1С. Проверь состояние цели и наличие активного процесса.",
    };
  }

  list(scope: string, activeId?: string): PlatformJournalEntry[] {
    const folder = join(this.root, scope);
    if (!existsSync(folder)) return [];
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && platformRunIdSchema.safeParse(entry.name).success)
      .sort((a, b) => b.name.localeCompare(a.name))
      .flatMap(({ name }) => this.read(scope, name, activeId) ?? [])
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50);
  }

  recovery(baseArg: string): string | null {
    const file = this.recoveryFile(baseArg);
    return existsSync(file) ? platformRunIdSchema.parse(JSON.parse(readBoundedText(file, 512))) : null;
  }

  mark(baseArg: string, id: string): void {
    mkdirSync(join(this.root, "recovery"), { recursive: true });
    writeJson(this.recoveryFile(baseArg), id);
  }

  clear(baseArg: string, id: string): void {
    if (this.recovery(baseArg) === id) unlinkSync(this.recoveryFile(baseArg));
  }

  private recoveryFile(baseArg: string): string {
    return join(this.root, "recovery", addressKey(baseArg) + ".json");
  }
}
