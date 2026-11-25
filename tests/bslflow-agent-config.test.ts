import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("legacy embedded settings still release ownership to bb-unica v0.1.0", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "1c-properties",
    settings: { unicaMode: "embedded" },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.callRpc("unicaOwnership", {}), { version: 1, mode: "external" });
  const { agentTools, rpcMethods } = harness.inspection.registrations;
  assert.ok(agentTools.some(({ name }) => name === "project_1c_params"));
  assert.ok(agentTools.every(({ name }) => !name.startsWith("unica_")));
  assert.deepEqual(rpcMethods.filter((name) => /unica/i.test(name)), ["unicaOwnership"]);
  assert.equal((await harness.behavior.runCli(["unica", "status"])).exitCode, 1);
});

test("saved workflow settings apply to BB agent instructions for that project", async (t) => {
  const snapshot = {
    path: "/source/bsl-flow.yaml", text: "workflow:\n  enabled: false\n",
    revision: "a".repeat(64), error: "", profile: { models: [], providers: [], roles: {}, error: "" },
  };
  let enabled = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "1c-properties",
    agentSkillIds: ["1c-project-properties"],
    experimental_callHostRpc: ({ method }) => {
      assert.equal(method, "saveBslFlowConfig");
      return { ...snapshot, enabled };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("projects.get", async ({ projectId }) => ({
    id: projectId, name: "Fixture", sources: [{ isDefault: true, path: "/source", hostId: "fixture-host" }],
  }));
  harness.sdk.stub("hosts.get", async () => ({ name: "Fixture host" }));
  await plugin(bb);
  const context = makePluginAgentConfigurationContext();
  const save = () => harness.callRpc("saveBslFlowConfig", {
    projectId: context.project.id, revision: snapshot.revision, text: snapshot.text,
  });
  await save();
  const current = await harness.behavior.resolveAgentConfiguration(context);
  assert.match(current.instructions ?? "", /BSL Flow отключён/);
  const another = makePluginAgentConfigurationContext({ project: { ...context.project, id: "another-project" } });
  assert.equal((await harness.behavior.resolveAgentConfiguration(another)).instructions, null);
  enabled = true;
  await save();
  assert.equal((await harness.behavior.resolveAgentConfiguration(context)).instructions, null);
});
