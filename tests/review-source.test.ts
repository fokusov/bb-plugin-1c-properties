import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findReviewEvidence, readReviewHead, verifyReviewSource } from "../lib/review-source.js";

test("review resolves only supported committed artifacts in the selected revision", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-1c-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const change = "openspec/changes/git-review";
  mkdirSync(join(root, change, "specs", "routing"), { recursive: true });
  writeFileSync(join(root, change, "proposal.md"), "# Proposal\n");
  writeFileSync(join(root, change, "specs", "routing", "spec.md"), "# Routing\n");
  writeFileSync(join(root, change, "private.md"), "# Private\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Review artifacts");
  const head = readReviewHead(root);
  writeFileSync(join(root, change, "design.md"), "# Draft\n");

  assert.deepEqual(verifyReviewSource(root, { kind: "openspec", change: "git-review", head }), [
    `${change}/proposal.md`, `${change}/specs/routing/spec.md`,
  ]);
  assert.throws(() => verifyReviewSource(root, { kind: "git", base: head, head: "0".repeat(40) }), /HEAD рабочей копии изменился/u);
  assert.throws(() => verifyReviewSource(root, { kind: "git", base: "0".repeat(40), head }), /Начальная ревизия/u);
  assert.deepEqual(verifyReviewSource(root, { kind: "git", base: head, head }), []);
  assert.equal(findReviewEvidence(root, "git-review"), "unavailable");
  writeFileSync(join(root, "bsl-flow.yaml"), "version: 3\n");
  assert.equal(findReviewEvidence(root, "git-review"), "missing-review");
  writeFileSync(join(root, change, "review.json"), "{}\n");
  assert.equal(findReviewEvidence(root, "git-review"), "review-present");
});
