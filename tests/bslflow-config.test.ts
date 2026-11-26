import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBslFlowConfig, parseConfig, readWorkflowEnabled, reviewReadiness, saveBslFlowConfig } from "../lib/bslflow-config.js";
import { connectSkills, initProject, readOpenSpecSchema } from "../lib/bslflow.js";

const configText = [
  "# Project comment", "version: 2", "workflow:", "  mode: assisted", "review:", "  council:",
  "    enabled: true # Council comment", "    roles:", "      chair:", "        model: existing",
  "custom:", "  values:", "    - value # Keep this",
].join("\n") + "\n";

function fixture(t: { after(action: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "bb-bslflow-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "bsl-flow.yaml");
  writeFileSync(path, configText);
  return { root, path };
}

test("readiness distinguishes an unprepared checkout from an existing incompatible schema", (t) => {
  const { root } = fixture(t);
  assert.equal(readOpenSpecSchema(root), "");
  const path = join(root, "openspec", "config.yaml");
  mkdirSync(join(root, "openspec"));
  writeFileSync(path, "context: test\n");
  assert.equal(readOpenSpecSchema(root), "схема не указана");
  writeFileSync(path, "schema: 'spec-driven' # Existing OpenSpec\n");
  assert.equal(readOpenSpecSchema(root), "spec-driven");
  assert.equal(readFileSync(path, "utf8"), "schema: 'spec-driven' # Existing OpenSpec\n");
});

test("review configuration is reported separately from verified results", (t) => {
  const { root, path } = fixture(t);
  assert.equal(reviewReadiness(root).status, "missing");
  writeFileSync(path, "review:\n  reviewer:\n    provider: codex_exec\n    model: fixture-model\n");
  const configured = reviewReadiness(root);
  assert.equal(configured.status, "unchecked");
  assert.doesNotMatch(configured.detail, /fixture-model/);
  writeFileSync(path, "workflow:\n  enabled: false\n");
  assert.equal(reviewReadiness(root).status, "disabled");
});

test("workflow and Council can be changed and restored while retaining other settings", (t) => {
  const { root, path } = fixture(t);
  const original = loadBslFlowConfig(root);
  assert.ok(original.revision);
  assert.equal(readWorkflowEnabled(root), true);
  const draft = parseConfig(original.text ?? "");
  draft.setIn(["workflow", "enabled"], false);
  draft.setIn(["review", "council", "enabled"], false);
  draft.setIn(["review", "council", "roles", "chair", "model"], "new-model");
  const off = saveBslFlowConfig(root, original.revision, draft.toString());
  assert.equal(off.enabled, false);
  assert.match(readFileSync(path, "utf8"), /# Project comment[\s\S]*# Council comment[\s\S]*# Keep this/);
  assert.equal(parseConfig(off.text ?? "").getIn(["review", "council", "roles", "chair", "model"]), "new-model");
  assert.match(initProject(root, "").error, /BSL Flow отключён/);
  const skills = connectSkills(root, { bslflowRoot: "", overwrite: true });
  assert.deepEqual(skills.copied, []);
  assert.match(skills.skipped.join(" "), /BSL Flow отключён/);
  assert.ok(off.revision);
  draft.setIn(["workflow", "enabled"], true);
  assert.equal(saveBslFlowConfig(root, off.revision, draft.toString()).enabled, true);
});

test("a stale revision and an identical file in another checkout are rejected", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const snapshot = loadBslFlowConfig(first.root);
  assert.ok(snapshot.revision);
  assert.throws(() => saveBslFlowConfig(second.root, snapshot.revision!, configText), /изменился/);
  const externalChange = configText + "\n# Manual edit\n";
  writeFileSync(first.path, externalChange);
  assert.throws(() => saveBslFlowConfig(first.root, snapshot.revision!, configText), /изменился/);
  assert.equal(readFileSync(first.path, "utf8"), externalChange);
});

test("updating BSL Flow skills preserves legacy Unica skills, references and ownership", (t) => {
  const { root } = fixture(t);
  const manifestPath = join(root, ".bb", "1c-skills.json");
  const oldSkill = join(root, ".bb", "skills", "1c-collision", "SKILL.md");
  const reference = join(root, ".bb", "references", "guide.md");
  const source = join(root, "source");
  for (const path of [join(root, ".bb", "skills", "1c-collision"), join(root, ".bb", "references"),
    join(source, "1c-collision"), join(source, "1c-new")]) mkdirSync(path, { recursive: true });
  const previous = { unicaRoot: "old-source", references: "unica", skills: { "1c-collision": "unica" } };
  writeFileSync(manifestPath, JSON.stringify(previous));
  writeFileSync(oldSkill, "legacy skill");
  writeFileSync(reference, "legacy reference");
  writeFileSync(join(source, "1c-collision", "SKILL.md"), "incoming collision");
  writeFileSync(join(source, "1c-new", "SKILL.md"), "new BSL Flow skill");

  assert.deepEqual(connectSkills(root, { bslflowRoot: source, overwrite: true }).copied, ["1c-new"]);
  assert.equal(readFileSync(oldSkill, "utf8"), "legacy skill");
  assert.equal(readFileSync(reference, "utf8"), "legacy reference");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.unicaRoot, previous.unicaRoot);
  assert.equal(manifest.references, previous.references);
  assert.deepEqual(manifest.skills, { ...previous.skills, "1c-new": "bslflow" });
});

test("the editor rejects invalid YAML and literal credentials before writing", (t) => {
  const { root, path } = fixture(t);
  const snapshot = loadBslFlowConfig(root);
  assert.ok(snapshot.revision);
  assert.throws(() => saveBslFlowConfig(root, snapshot.revision!, "workflow: ["), /Некорректный YAML/);
  const literal = "llm:\n  providers:\n    sample:\n      token: fixture-token\n";
  assert.throws(() => saveBslFlowConfig(root, snapshot.revision!, literal), /учётные данные/);
  assert.equal(readFileSync(path, "utf8"), configText);
  writeFileSync(path, literal);
  const blocked = loadBslFlowConfig(root);
  assert.equal(blocked.text, null);
  assert.match(blocked.error, /учётные данные/);
});
