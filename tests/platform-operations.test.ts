import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosticImportSchema, platformClusterRequestSchema, platformRequestSchema } from "../platform-contract.js";
import { DiagnosticReports } from "../lib/diagnostic-reports.js";
import { recordedPlatformVersion } from "../lib/infobases.js";
import { decodePlatformConsole, PlatformJournal, readJUnit, redactLog } from "../lib/platform-journal.js";
import { readPlatformInventory } from "../lib/platform-inventory.js";
import { planEdtOperation, planPlatformOperation } from "../lib/platform-plan.js";
import { parseRacOutput } from "../lib/platform-tools.js";
import { cfuDetails } from "../lib/platform-cfu.js";

test("operation plans bind artifact paths and confirmation to the physical worktree and FILE base", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-platform-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = join(root, "1cv8.exe");
  writeFileSync(platform, "");
  const worktrees = [join(root, "one"), join(root, "two")];
  for (const path of worktrees) {
    mkdirSync(join(path, "ib"), { recursive: true });
    mkdirSync(join(path, "sources"));
    writeFileSync(join(path, "ib", "1Cv8.1CD"), "base");
    writeFileSync(join(path, "sources", "Configuration.xml"), "<root/>");
  }
  const run = (path: string, output = "out/test.cfe") => planPlatformOperation({
    path,
    fallback: platform,
    profile: { name: "testing", kind: "test", infobase: "ib" },
    request: platformRequestSchema.parse({
      action: "build-configuration", profile: "testing", input: "sources", output, extension: "Test",
    }),
    recovery: null,
  });
  const [left, right] = worktrees.map((path) => run(path));
  assert.notEqual(left.preview.confirmation, right.preview.confirmation);
  assert.equal(left.preview.output, join(left.preview.workspace, "out", "test.cfe"));
  assert.equal(right.preview.output, join(right.preview.workspace, "out", "test.cfe"));
  assert.deepEqual(left.stages.map(({ args }) => [args[0], ...args.slice(2, 4)]), [
    ["/LoadConfigFromFiles", "-Extension", "Test"], ["/DumpCfg", "-Extension", "Test"],
  ]);
  writeFileSync(join(worktrees[0], "ib", "1Cv8.1CD"), "changed base");
  assert.notEqual(run(worktrees[0]).preview.confirmation, left.preview.confirmation);
  assert.throws(() => run(worktrees[0], "../other.cfe"), /пределы рабочей копии/);
  assert.throws(() => run(worktrees[0], "ib/output.cfe"), /пределами каталога FILE-базы/);
  assert.throws(() => run(worktrees[0], "out/test.cf"), /\.cfe/);
});

test("a recovery marker survives a new worker and retains ownership", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-platform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = "/Fbase";
  const pending = "179dc753-1202-49ce-b88c-64e5b280b213";
  const other = "9ff196a5-c1a9-467f-b89d-0110fe3c5654";
  new PlatformJournal(dir).mark(target, pending);
  const worker = new PlatformJournal(dir);
  worker.clear(target, other);
  assert.equal(worker.recovery(target), pending);
  worker.clear(target, pending);
  assert.equal(worker.recovery(target), null);
});

test("configuration integrity check runs read-only Designer checks for the selected extension", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-check-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "1cv8.exe"), "");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "1Cv8.1CD"), "");
  const plan = planPlatformOperation({
    path: dir, fallback: join(dir, "1cv8.exe"), recovery: null,
    profile: { name: "qa", kind: "test", infobase: "test" },
    request: platformRequestSchema.parse({ action: "check-config", profile: "qa", extension: "Example" }),
  });
  assert.equal(plan.mutation, false);
  assert.equal(plan.preview.confirmation, null);
  assert.deepEqual(plan.stages, [{
    mode: "DESIGNER", verdict: "platform",
    args: ["/CheckConfig", "-ConfigLogIntegrity", "-IncorrectReferences", "-Extension", "Example"],
  }]);
});

test("CFU plans pin the test target, trusted hash and new backup before updating a base", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-cfu-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = join(root, "1cv8.exe");
  writeFileSync(platform, "");
  writeFileSync(join(root, "update.cfu"), "cfu");
  for (const name of ["one", "two"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "1Cv8.1CD"), "fixture");
  }
  const sha256 = "a".repeat(64);
  const plan = (name: string, kind: "test" | "dev" = "test", extra: Record<string, string | undefined> = {}) => planPlatformOperation({
    path: root, fallback: platform, profile: { name, kind, infobase: name },
    request: platformRequestSchema.parse({ action: "apply-cfu", profile: name, input: "update.cfu", output: "before.dt", sha256, ...extra }),
    recovery: null,
  });
  const first = plan("one");
  assert.deepEqual(first.stages.map(({ args }) => args[0]), ["/DumpCfg", "/DumpDBCfg", "/DumpIB", "/UpdateCfg", "/UpdateDBCfg"]);
  assert.notEqual(first.preview.confirmation, plan("two").preview.confirmation);
  assert.notEqual(first.preview.confirmation, plan("one", "test", { sha256: "b".repeat(64) }).preview.confirmation);
  assert.throws(() => plan("one", "dev"), /test-профиль/);
  assert.throws(() => plan("one", "test", { sha256: undefined }), /доверенный SHA-256/);
  const alias = join(root, "alias.1CD");
  linkSync(join(root, "one", "1Cv8.1CD"), alias);
  assert.throws(() => plan("one"), /отдельным файлом без ссылок/);
  unlinkSync(alias);
  writeFileSync(join(root, "before.dt"), "existing");
  assert.throws(() => plan("one"), /Путь выхода уже существует/);
});

test("CFU metadata matches the installed configuration by exact identity and source version", () => {
  const current = { name: "Configuration", vendor: "Pilot", version: "1.0.1" };
  const target = { ...current, version: "1.0.2" };
  const sha256 = "f".repeat(64);
  assert.deepEqual(cfuDetails(sha256, current, target, [current, { ...current, version: "1.0.0" }]).allowedVersions, ["1.0.1", "1.0.0"]);
  assert.throws(() => cfuDetails(sha256, current, { ...target, vendor: "Other" }, [current]), /Поставщик/);
  assert.throws(() => cfuDetails(sha256, { ...current, version: "0.9.0" }, target, [current]), /Версия базы 0.9.0/);
  assert.throws(() => cfuDetails(sha256, current, target, [{ ...current, name: "Another" }]), /исходных версий/);
});

test("EDT plans resolve paths without an infobase and require a new output and the extension's base project", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "bb-edt-plan-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const worktree = realpathSync.native(temp);
  const source = join(worktree, "XML input");
  const base = join(worktree, "Base EDT");
  mkdirSync(source);
  mkdirSync(join(base, "DT-INF"), { recursive: true });
  mkdirSync(join(base, "src", "Configuration"), { recursive: true });
  writeFileSync(join(base, "src", "Configuration", "Configuration.mdo"), "<Configuration/>");
  writeFileSync(join(base, ".project"), "<projectDescription><name>Base EDT</name></projectDescription>");
  writeFileSync(join(base, "DT-INF", "PROJECT.PMF"), "Runtime-Version: 8.5.1\r\n");
  writeFileSync(join(source, "Configuration.xml"), "<Configuration><ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose></Configuration>");
  const plan = (options: Record<string, string>) => planEdtOperation(worktree, platformRequestSchema.parse({
    action: "edt-import", input: "XML input", output: "EDT result", ...options,
  }), "1cedtcli");
  assert.throws(() => plan({}), /базового проекта/);
  const result = plan({ baseProject: "Base EDT" });
  assert.equal(result.preview.input, source);
  assert.equal(result.preview.output, join(worktree, "EDT result"));
  assert.equal(result.preview.baseProject, base);
  assert.equal(result.baseArg, null);
  assert.equal(result.baseName, "Base EDT");
  assert.equal(result.version, "8.5.1");
  assert.throws(() => plan({ baseProject: "Base EDT", output: "../other worktree" }), /пределы рабочей копии/);
  assert.throws(() => plan({ baseProject: "Base EDT", output: "XML input/result" }), /входной каталог/);
  mkdirSync(join(worktree, "EDT result"));
  assert.throws(() => plan({ baseProject: "Base EDT" }), /выхода уже существует/);
});

test("RAS targets and cluster IDs are validated and rac fields preserve values with colons", () => {
  const id = "11223344-1122-4321-8123-123456789abc";
  assert.equal(platformClusterRequestSchema.parse({ endpoint: "node-1.local:1545", cluster: id }).endpoint, "node-1.local:1545");
  for (const endpoint of ["--help", "http://localhost:1545", "localhost:65536", "localhost:0", "host;cmd"]) {
    assert.equal(platformClusterRequestSchema.safeParse({ endpoint }).success, false);
  }
  const raw = `session : ${id}\r\nuser-name : "Учебный: пользователь"\r\nstarted-at : 2026-11-27T12:00:00\r\n\r\n`;
  const result = parseRacOutput(raw, "session");
  assert.equal(result.rows[0]["user-name"], "Учебный: пользователь");
  assert.equal(result.rows[0]["started-at"], "2026-11-27T12:00:00");
  assert.equal(result.truncated, false);
  assert.deepEqual(parseRacOutput("", "session").rows, []);
  assert.throws(() => parseRacOutput("Помощь rac", "cluster"), /Формат ответа/);
  assert.equal(parseRacOutput(raw.repeat(201), "session").truncated, true);
  assert.equal(decodePlatformConsole(Buffer.from("8baeaaa0abecadeba920aaaba0e1e2a5e0", "hex")), "Локальный кластер");
});

test("JUnit distinguishes failed and empty runs, and stored logs mask authentication values", () => {
  assert.deepEqual(
    readJUnit('<testsuites><testsuite tests="3" failures="1" skipped="1"/><testsuite tests="2" errors="1"/></testsuites>'),
    { tests: 5, failures: 1, errors: 1, skipped: 1 },
  );
  assert.equal(readJUnit('<testsuite tests="0"/>').tests, 0);
  assert.throws(() => readJUnit("<html/>"), /набор тестов/);
  assert.throws(() => readJUnit('<testsuite tests="1" failures="2"/>'), /счётчики/);
  assert.equal(redactLog('Pwd="unlisted secret" /UCsecret literal pa&amp;ss', ["pa&ss"]), "*** *** literal ***");
  assert.equal(redactLog("C:/Users/Test/.bb/plugins/1c-properties", []), "C:/Users/Test/.bb/plugins/1c-properties");
});

test("diagnostic imports preserve real report counts, keep scope and time, and refuse invalid data", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "bb-quality-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const dir = realpathSync.native(temp);
  const workspace = join(dir, "a");
  mkdirSync(workspace);
  const store = new DiagnosticReports(join(dir, "data"));
  const json = JSON.stringify({ sourceDir: workspace, fileinfos: [{ path: "module.bsl",
    diagnostics: [{ severity: "Error", code: "Missing" }, { severity: "Warning", code: "Other" }, { severity: "Hint", code: "Hint" }] }] });
  writeFileSync(join(workspace, "output.json"), json);
  const input = diagnosticImportSchema.parse({
    tool: "bsl-ls", file: "output.json", revision: "A".repeat(40), finishedAt: "2026-01-01T12:00:00+03:00",
  });
  const first = store.import("scope-a", workspace, input);
  assert.equal(first.finishedAt, "2026-01-01T09:00:00.000Z");
  assert.equal(first.revision, "a".repeat(40));
  assert.deepEqual(first.counts, { errors: 1, warnings: 1, total: 3 });
  assert.equal(store.import("scope-a", workspace, input).report.id, first.report.id);
  assert.equal(store.read("scope-a", first.report.id, first.report.name), json);
  assert.throws(() => store.read("scope-b", first.report.id, first.report.name), /не найден/);
  assert.throws(() => store.import("scope-a", workspace, { ...input, file: "../outside.json" }), /пределами/);
  assert.throws(() => store.import("scope-a", workspace, { ...input, tool: "apk" }), /JUnit/);
  const newer = store.import("scope-a", workspace, { ...input, finishedAt: "2026-01-02T00:00:00Z", revision: undefined });
  assert.deepEqual(store.list("scope-a"), [newer, first]);
  assert.equal(newer.revision, null);
  const junit = '<testsuite tests="4" errors="1" failures="2" skipped="0"/>';
  writeFileSync(join(workspace, "apk.xml"), junit);
  const apk = store.import("scope-a", workspace, { ...input, tool: "apk", file: "apk.xml" });
  assert.deepEqual(apk.counts, { errors: 3, warnings: null, total: 4 });
  assert.equal(store.read("scope-a", apk.report.id, apk.report.name), junit);
});

test("dashboard returns a version only for a recorded installation path", () => {
  assert.equal(recordedPlatformVersion("C:\\Program Files\\1cv8\\8.5.1.1529\\bin\\1cv8.exe"), "8.5.1.1529");
  assert.equal(recordedPlatformVersion("C:/1C/8.3.27.1000/Bin/1cv8c.exe"), "8.3.27.1000");
  assert.equal(recordedPlatformVersion("D:/custom/1cv8.exe"), null);
});

test("artifact inventory describes actual files and isolates working copies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-artifact-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, "a");
  const b = join(root, "b");
  for (const path of [join(a, ".build"), join(a, "Extension"), join(a, "ibes"), join(b, "build"), join(b, "Configuration")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(a, "Extension", "Configuration.xml"),
    '<?xml version="1.0"?><MetaDataObject xmlns="urn:test"><Configuration><Properties><Name>Example</Name><ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose></Properties></Configuration></MetaDataObject>');
  writeFileSync(join(a, "TextReport.xml"), "<MetaDataObject><ExternalReport><Properties><Name>ReportA</Name></Properties></ExternalReport></MetaDataObject>");
  writeFileSync(join(a, "Form.xml"), "<Form><ExternalReport/></Form>");
  writeFileSync(join(a, ".build", "Example.CFE"), "test");
  writeFileSync(join(a, "ibes", "1Cv8.1CD"), "test");
  writeFileSync(join(a, "ibes", "internal.dt"), "test");
  writeFileSync(join(b, "build", "ReportB.erf"), "test");
  writeFileSync(join(b, "Configuration", "Configuration.mdo"), "<mdclass:Configuration><name>Main</name></mdclass:Configuration>");
  symlinkSync(b, join(a, "other-worktree"), process.platform === "win32" ? "junction" : "dir");
  const [left, right] = await Promise.all([readPlatformInventory(a), readPlatformInventory(b)]);
  assert.deepEqual(left.items.map(({ path, kind, source, name }) => [path, kind, source, name]), [
    [".build/Example.CFE", "extension", "binary", null],
    ["Extension/Configuration.xml", "extension", "xml", "Example"],
    ["TextReport.xml", "report", "xml", "ReportA"],
  ]);
  assert.deepEqual(right.items.map(({ path, kind, source, name }) => [path, kind, source, name]), [
    ["build/ReportB.erf", "report", "binary", null],
    ["Configuration/Configuration.mdo", "configuration", "edt", "Main"],
  ]);
  await assert.rejects(readPlatformInventory(a, AbortSignal.abort()), { name: "AbortError" });
});
