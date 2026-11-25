import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { platformRequestSchema } from "../platform-contract.js";
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
