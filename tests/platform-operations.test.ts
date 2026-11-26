import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosticImportSchema, platformRequestSchema } from "../platform-contract.js";
import { DiagnosticReports } from "../lib/diagnostic-reports.js";
import { recordedPlatformVersion } from "../lib/infobases.js";
import { PlatformJournal, readJUnit, redactLog } from "../lib/platform-journal.js";
import { planPlatformOperation } from "../lib/platform-plan.js";

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
