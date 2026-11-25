import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectSourceGit } from "../lib/source-git.js";

test("source Git readiness reads repository state without changing it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-1c-source-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(inspectSourceGit(root).repository, false);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const state = inspectSourceGit(root);
  assert.equal(state.available, true);
  assert.equal(state.repository, true);
});
