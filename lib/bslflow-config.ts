import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMap, parseDocument, visit } from "yaml";
import { CONFIG_LIMIT, COUNCIL_ROLES } from "./bslflow-fields.js";

function readFile(file: string, rejectLink: boolean) {
  try {
    const info = lstatSync(file);
    if (rejectLink && !info.isFile()) throw new Error("bsl-flow.yaml должен быть обычным файлом проекта.");
    if (info.size > CONFIG_LIMIT) throw new Error("Файл настроек превышает 256 КБ.");
    const contents = readFileSync(file);
    if (contents.length > CONFIG_LIMIT) throw new Error("Файл настроек превышает 256 КБ.");
    return contents.toString("utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export function parseConfig(text: string) {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) {
    const line = text.slice(0, doc.errors[0].pos[0]).split("\n").length;
    throw new Error(`Некорректный YAML, строка ${line}.`);
  }
  if (!isMap(doc.contents)) throw new Error("В корне bsl-flow.yaml ожидается словарь настроек.");
  return doc;
}

function enabled(doc: ReturnType<typeof parseConfig>) {
  const value = doc.getIn(["workflow", "enabled"]);
  if (value === undefined || value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("workflow.enabled должен содержать true или false.");
}

export function readWorkflowEnabled(projectPath: string) {
  const text = readFile(join(projectPath, "bsl-flow.yaml"), true);
  return text === null ? null : enabled(parseConfig(text));
}

function validateProjectConfig(doc: ReturnType<typeof parseConfig>) {
  enabled(doc);
  visit(doc, {
    Pair(_, pair) {
      const key = String(pair.key);
      const value = String(pair.value ?? "");
      const placeholder = /^\${[A-Za-z_][A-Za-z0-9_]*}$/.test(value);
      const credentialKey = /^(?:token|password|passwd|pwd|unlock[_-]?code|secret|client[_-]?secret|api[_-]?key|authorization|credentials)$/i.test(key);
      if ((credentialKey && value && !placeholder) ||
          /(?:https?:\/\/[^/\s@]+:[^/\s@]+@|(?:^|;)\s*(?:pwd|password)\s*=)/i.test(value)) {
        throw new Error("В bsl-flow.yaml обнаружены учётные данные. Используйте переменные окружения или локальный профиль провайдеров.");
      }
    },
  });
  const council = doc.getIn(["review", "council", "enabled"]);
  if (council !== undefined && ![true, false, "true", "false"].includes(council as boolean | string)) {
    throw new Error("review.council.enabled должен содержать true или false.");
  }
}

const version = (path: string, text: string) => createHash("sha256").update(path).update("\0").update(text).digest("hex");

function profileOptions() {
  const override = process.env.BSL_FLOW_USER_CONFIG?.trim();
  const path = override ? resolve(override) : join(homedir(), ".bsl-flow", "config.yaml");
  const none = { models: [] as string[], providers: [] as string[], roles: {} as Record<string, string>, error: "" };
  try {
    const text = readFile(path, false);
    if (text === null && override) return { ...none, error: "Файл из BSL_FLOW_USER_CONFIG не найден на машине проекта." };
    if (text === null || !text.split("\n").some((line) => /^\s*[^\s#]/.test(line))) return none;
    const doc = parseConfig(text);
    const knownName = /^[A-Za-z0-9_-]+$/;
    const names = (key: string) => {
      const map = doc.getIn(["llm", key], true);
      return isMap(map) ? map.items.map(({ key }) => String(key)).filter((name) => knownName.test(name)) : [];
    };
    for (const role of COUNCIL_ROLES) {
      const model = doc.getIn(["review", "council", "roles", role, "model"]);
      if (typeof model === "string" && knownName.test(model)) none.roles[role] = model;
    }
    return { ...none, models: names("models"), providers: names("providers") };
  } catch {
    return { ...none, error: "Не удалось прочитать пользовательский профиль BSL Flow на машине проекта." };
  }
}

export function loadBslFlowConfig(projectPath: string) {
  const path = join(realpathSync(projectPath), "bsl-flow.yaml");
  const profile = profileOptions();
  try {
    const text = readFile(path, true);
    if (text === null) return { path, text: null, revision: null, error: "", profile };
    const doc = parseConfig(text);
    validateProjectConfig(doc);
    return { path, text, revision: version(path, text), error: "", profile };
  } catch (cause) {
    return { path, text: null, revision: null, error: cause instanceof Error ? cause.message : String(cause), profile };
  }
}

export function saveBslFlowConfig(projectPath: string, expectedRevision: string, text: string) {
  const path = join(realpathSync(projectPath), "bsl-flow.yaml");
  const expectRevision = () => {
    const current = readFile(path, true);
    if (current === null || version(path, current) !== expectedRevision) {
      throw new Error("Файл bsl-flow.yaml изменился. Загрузите свежую версию перед сохранением.");
    }
    return current;
  };
  const current = expectRevision();
  if (Buffer.byteLength(text, "utf8") > CONFIG_LIMIT) throw new Error("Файл настроек превышает 256 КБ.");
  const doc = parseConfig(text);
  validateProjectConfig(doc);
  if (current !== text) {
    const staging = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, text, { flag: "wx", mode: lstatSync(path).mode & 0o777 });
      expectRevision();
      renameSync(staging, path);
    } finally {
      rmSync(staging, { force: true });
    }
  }
  return { path, text, revision: version(path, text), error: "", profile: profileOptions(), enabled: enabled(doc) };
}
